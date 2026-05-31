import React, { useState, useCallback, useEffect, useRef } from 'react';
import type { Update } from '@tauri-apps/plugin-updater';
import { Upload, FileVideo, AlertCircle, Library, FolderPlus, ChevronRight } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import VideoLibrary from './components/VideoLibrary';
import {
  srtToVtt,
  extractVideoThumbnail,
  getVideoDuration,
  videoStore,
  VideoMeta,
  videoOrderStore,
  loadVideoProgress,
} from './utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ogv', '.ogg',
  '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts', '.vob', '.mpg', '.mpeg',
]);

const VIDEO_EXT_LIST = ['mp4','webm','mkv','avi','mov','wmv','flv','ogv','ogg','m4v','3gp','3g2','ts','mts','m2ts','vob','mpg','mpeg'];

function isVideoPath(p: string): boolean {
  const ext = '.' + p.split('.').pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

function typeFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', mov: 'video/quicktime', wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv', ogv: 'video/ogg', ogg: 'video/ogg',
    m4v: 'video/mp4', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
    ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t',
    vob: 'video/mpeg', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  };
  return map[ext] ?? 'video/mp4';
}

/** Convert a native file-system path to a URL playable by the <video> element via Tauri's asset protocol. */
async function toPlaybackUrl(filePath: string): Promise<string> {
  const { convertFileSrc } = await import('@tauri-apps/api/core');
  return convertFileSrc(filePath);
}

const genId = () => Math.random().toString(36).substr(2, 9);

interface PlaylistItem {
  id: string;
  src: string;
  name: string;
  subtitleSrc?: string;
  thumbnail?: string;
}

const STORAGE_LAST_VIDEO = 'prevplayer_last_video';

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [videoLibrary, setVideoLibrary] = useState<VideoMeta[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [lastVideo, setLastVideo] = useState<VideoMeta | null>(null);
  const [wasPlayingBeforeLibrary, setWasPlayingBeforeLibrary] = useState(true);
  const [isPlaylistLooping, setIsPlaylistLooping] = useState(false);
  const [updateBanner, setUpdateBanner] = useState<{ version: string; notes?: string } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'downloading' | 'installing' | 'error'>('idle');
  const [updateProgress, setUpdateProgress] = useState(0); // 0–100, –1 = indeterminate
  const updateRef = useRef<Update | null>(null);
  const isFullscreenRef = useRef(false);
  const playerWrapperRef = useRef<HTMLDivElement>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  // Ask the Tauri updater whether a newer (signed) release exists; show a banner if so.
  // The updater fetches the `latest.json` manifest from the configured GitHub endpoint
  // and verifies its signature against the bundled public key.
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (update) {
          updateRef.current = update;
          setUpdateBanner({ version: update.version, notes: update.body });
        }
      } catch {
        // Offline, manifest not published yet, or running in a plain browser — ignore.
      }
    };
    const t = setTimeout(checkUpdate, 4000); // wait for app to settle
    return () => clearTimeout(t);
  }, []);

  // ---------------------------------------------------------------------------
  // Boot: load library from IndexedDB, handle initial files from CLI args
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const boot = async () => {
      // Load persisted library
      let metas: VideoMeta[] = [];
      try {
        metas = await videoStore.getAllMeta();
        setVideoLibrary(metas);
      } catch {}

      // Restore last-played video reference
      const lastRaw = localStorage.getItem(STORAGE_LAST_VIDEO);
      if (lastRaw) {
        try {
          const last: VideoMeta = JSON.parse(lastRaw);
          if (metas.some(v => v.id === last.id)) setLastVideo(last);
          else localStorage.removeItem(STORAGE_LAST_VIDEO);
        } catch { localStorage.removeItem(STORAGE_LAST_VIDEO); }
      }

      // Check for files passed on the command line (file-association double-click)
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const paths = await invoke<string[]>('get_initial_files');
        if (paths.length > 0) handleFilePaths(paths);
      } catch {}

      // Listen for files forwarded from a second-instance launch
      try {
        const { listen } = await import('@tauri-apps/api/event');
        listen<string[]>('open-files', event => {
          if (event.payload?.length) handleFilePaths(event.payload);
        });
      } catch {}

      // Tauri window-level drag-drop: provides native file paths (unlike HTML drop which gives no path)
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        getCurrentWebview().onDragDropEvent(event => {
          const p = event.payload as any;
          if (p.type === 'enter' || p.type === 'over') {
            setIsDragging(true);
          } else if (p.type === 'drop') {
            setIsDragging(false);
            const dropped: string[] = p.paths ?? [];
            const videos = dropped.filter(isVideoPath);
            if (videos.length) handleFilePaths(videos);
          } else {
            // 'leave' / cancelled
            setIsDragging(false);
          }
        });
      } catch {}
    };

    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disable the WebView's default browser context menu app-wide so right-click
  // never shows browser options (gives a native-app feel) — except inside text
  // fields, where the native menu is kept so right-click copy/paste still works.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest('input, textarea, [contenteditable]') as HTMLElement | null;
      const isTextField =
        !!el &&
        (el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range'));
      if (!isTextField) e.preventDefault();
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, []);

  // Save last-played video whenever the current playlist item changes
  useEffect(() => {
    if (playlist.length > 0 && playlist[currentIndex]) {
      const libraryEntry = videoLibrary.find(v => v.id === playlist[currentIndex].id);
      if (libraryEntry) {
        setLastVideo(libraryEntry);
        localStorage.setItem(STORAGE_LAST_VIDEO, JSON.stringify(libraryEntry));
      }
    }
  }, [playlist, currentIndex, videoLibrary]);

  // ---------------------------------------------------------------------------
  // Background metadata extraction (thumbnail + duration)
  // Runs sequentially off the critical path; thumbnails fill in after playback starts.
  // ---------------------------------------------------------------------------
  const metaQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueMetaExtraction = useCallback((items: { path: string; id: string }[]) => {
    if (items.length === 0) return;
    metaQueueRef.current = metaQueueRef.current.then(async () => {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      for (const { path, id } of items) {
        const fileUrl = convertFileSrc(path);
        let thumbnail: string | undefined;
        let duration: number | undefined;
        try { thumbnail = await extractVideoThumbnail(fileUrl); } catch {}
        try { duration = await getVideoDuration(fileUrl); } catch {}
        if (thumbnail || duration !== undefined) {
          try { await videoStore.updateMeta(id, { thumbnail, duration }); } catch {}
          setVideoLibrary(prev => prev.map(v =>
            v.id === id
              ? { ...v, ...(thumbnail ? { thumbnail } : {}), ...(duration !== undefined ? { duration } : {}) }
              : v
          ));
        }
      }
    });
  }, []);

  // ---------------------------------------------------------------------------
  // Core: add file paths to the library and build a playlist for immediate playback
  // ---------------------------------------------------------------------------
  const handleFilePaths = useCallback(async (paths: string[]) => {
    const videoPaths = paths.filter(isVideoPath);
    if (videoPaths.length === 0) { setError('No playable video files found.'); return; }
    setError(null);

    const { convertFileSrc } = await import('@tauri-apps/api/core');

    // Deduplicate against existing library (by path)
    const allMetas = await videoStore.getAllMeta();
    const byPath = new Map(allMetas.map(m => [m.path, m]));
    const seenInBatch = new Map<string, string>(); // path -> id

    const playlistItems: PlaylistItem[] = [];
    const newMetas: VideoMeta[] = [];

    for (const p of videoPaths) {
      const existing = byPath.get(p);
      if (existing) {
        playlistItems.push({ id: existing.id, src: convertFileSrc(p), name: existing.name, thumbnail: existing.thumbnail });
        continue;
      }
      // Dedupe within this batch
      let id = seenInBatch.get(p);
      if (!id) { id = genId(); seenInBatch.set(p, id); }
      const name = p.replace(/\\/g, '/').split('/').pop() ?? p;
      const meta: VideoMeta = { id, name, path: p, size: 0, addedAt: Date.now(), type: typeFromPath(p) };
      newMetas.push(meta);
      playlistItems.push({ id, src: convertFileSrc(p), name });
    }

    // Instant playback — no waiting on any storage
    setPlaylist(playlistItems);
    setCurrentIndex(0);
    setWasPlayingBeforeLibrary(true);

    if (newMetas.length > 0) {
      // Show optimistically in library right away
      setVideoLibrary(prev => [...newMetas.filter(m => !prev.some(e => e.id === m.id)), ...prev]);
      // Persist metadata (path only — no blob) to IndexedDB
      for (const meta of newMetas) {
        try {
          await videoStore.save({ id: meta.id, name: meta.name, path: meta.path, size: 0, addedAt: meta.addedAt, type: meta.type });
        } catch {}
      }
      // Background: extract thumbnail + duration
      enqueueMetaExtraction(newMetas.map(m => ({ path: m.path, id: m.id })));
    }
  }, [enqueueMetaExtraction]);

  // Add paths to library only (no auto-play), used from the library panel
  const handleAddToLibraryOnly = useCallback(async (paths: string[]) => {
    const videoPaths = paths.filter(isVideoPath);
    if (videoPaths.length === 0) return;

    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const allMetas = await videoStore.getAllMeta();
    const byPath = new Map(allMetas.map(m => [m.path, m]));
    const newMetas: VideoMeta[] = [];

    for (const p of videoPaths) {
      if (byPath.has(p)) continue;
      const id = genId();
      const name = p.replace(/\\/g, '/').split('/').pop() ?? p;
      newMetas.push({ id, name, path: p, size: 0, addedAt: Date.now(), type: typeFromPath(p) });
    }

    if (newMetas.length > 0) {
      setVideoLibrary(prev => [...newMetas, ...prev]);
      for (const m of newMetas) {
        try { await videoStore.save({ ...m }); } catch {}
      }
      enqueueMetaExtraction(newMetas.map(m => ({ path: m.path, id: m.id })));
    }
    // Nudge state so VideoLibrary refreshes folders list
    setVideoLibrary(prev => [...prev]);
  }, [enqueueMetaExtraction]);

  // Import a whole folder: use Tauri's native folder dialog + FS to list video files
  const handleAddFolderFromPC = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const folderPath = await open({ directory: true, multiple: false, title: 'Select Folder to Import' });
    if (!folderPath || typeof folderPath !== 'string') return;

    let entries: any[] = [];
    try {
      const { readDir } = await import('@tauri-apps/plugin-fs');
      entries = await readDir(folderPath);
    } catch {
      setError('Could not read folder contents.');
      return;
    }

    const sep = folderPath.includes('/') ? '/' : '\\';
    const videoPaths = entries
      .filter((e: any) => !e.isDirectory && e.name && isVideoPath(e.name))
      .map((e: any) => e.path ?? `${folderPath}${sep}${e.name}`)
      .sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    if (videoPaths.length === 0) { setError('No playable video files found in this folder.'); return; }
    setError(null);

    const folderName = folderPath.replace(/\\/g, '/').split('/').pop() ?? 'Imported Folder';

    await handleAddToLibraryOnly(videoPaths);

    // Create a folder entry in the library with the real folder name
    const { folderStore } = await import('./utils');
    const allMetas = await videoStore.getAllMeta();
    const byPath = new Map(allMetas.map(m => [m.path, m]));
    const videoIds = videoPaths.map(p => byPath.get(p)?.id).filter(Boolean) as string[];
    if (videoIds.length) {
      folderStore.save({ id: genId(), name: folderName, videoIds, createdAt: Date.now() });
    }

    setVideoLibrary(prev => [...prev]);
  }, [handleAddToLibraryOnly]);

  // Open native file-picker and add selected videos to library (no auto-play)
  const handleAddFilesViaDialog = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: true,
      filters: [{ name: 'Video Files', extensions: VIDEO_EXT_LIST }],
      title: 'Add Video Files',
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    await handleAddToLibraryOnly(paths as string[]);
  }, [handleAddToLibraryOnly]);

  // Open native file-picker, play selected files immediately
  const handleOpenFilesViaDialog = useCallback(async () => {
    const wasFullscreen = !!document.fullscreenElement;
    if (wasFullscreen) { try { await document.exitFullscreen(); } catch {} }

    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: true,
      filters: [{ name: 'Video Files', extensions: VIDEO_EXT_LIST }],
      title: 'Open Video Files',
    });

    if (result) {
      const paths = Array.isArray(result) ? result : [result];
      await handleFilePaths(paths as string[]);
    }

    // Restore fullscreen after dialog closes
    if (wasFullscreen && playerWrapperRef.current && !document.fullscreenElement) {
      setTimeout(() => playerWrapperRef.current?.requestFullscreen().catch(() => {}), 100);
    }
  }, [handleFilePaths]);

  // Add files to a specific folder via dialog
  const handleAddToFolder = useCallback(async (folderId: string) => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: true,
      filters: [{ name: 'Video Files', extensions: VIDEO_EXT_LIST }],
      title: 'Add Videos to Folder',
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    await handleAddToLibraryOnly(paths as string[]);

    // Link the newly-added videos to the folder
    const allMetas = await videoStore.getAllMeta();
    const byPath = new Map(allMetas.map(m => [m.path, m]));
    const { folderStore } = await import('./utils');
    (paths as string[]).filter(isVideoPath).forEach(p => {
      const meta = byPath.get(p);
      if (meta) folderStore.addVideo(folderId, meta.id);
    });

    setVideoLibrary(prev => [...prev]);
  }, [handleAddToLibraryOnly]);

  // ---------------------------------------------------------------------------
  // Play from library
  // ---------------------------------------------------------------------------
  const playFromLibrary = useCallback(async (video: VideoMeta) => {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const src = convertFileSrc(video.path);
    setPlaylist([{ id: video.id, src, name: video.name, thumbnail: video.thumbnail }]);
    setCurrentIndex(0);
    setShowLibrary(false);
    setWasPlayingBeforeLibrary(true);
  }, []);

  // Play an entire folder/playlist, optionally starting at a specific index
  const playFolder = useCallback(async (videoIds: string[], shuffle: boolean, loop: boolean, startIndex = 0) => {
    if (videoIds.length === 0) return;
    setIsPlaylistLooping(loop);

    let ids = [...videoIds];
    if (shuffle) {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
    }

    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const items: PlaylistItem[] = [];
    for (const id of ids) {
      const meta = videoLibrary.find(v => v.id === id);
      if (meta?.path) {
        items.push({ id, src: convertFileSrc(meta.path), name: meta.name, thumbnail: meta.thumbnail });
      }
    }
    if (items.length > 0) {
      setPlaylist(items);
      // On shuffle the start position is meaningless; otherwise honour the requested index
      setCurrentIndex(shuffle ? 0 : Math.min(startIndex, items.length - 1));
      setWasPlayingBeforeLibrary(true);
      setShowLibrary(false);
    }
  }, [videoLibrary]);

  const deleteFromLibrary = useCallback(async (id: string) => {
    await videoStore.delete(id);
    setVideoLibrary(prev => prev.filter(v => v.id !== id));
  }, []);

  // ---------------------------------------------------------------------------
  // Library open/close (pause/resume video)
  // ---------------------------------------------------------------------------
  const openLibrary = useCallback(() => {
    const el = videoElRef.current;
    if (el && !el.paused) { setWasPlayingBeforeLibrary(true); el.pause(); }
    setShowLibrary(true);
  }, []);

  const closeLibrary = useCallback(() => {
    setShowLibrary(false);
    const el = videoElRef.current;
    if (el && wasPlayingBeforeLibrary) el.play().catch(() => {});
  }, [wasPlayingBeforeLibrary]);

  // ---------------------------------------------------------------------------
  // Playlist navigation
  // ---------------------------------------------------------------------------
  const playNext = () => {
    isFullscreenRef.current = !!document.fullscreenElement;
    if (currentIndex < playlist.length - 1) { setCurrentIndex(i => i + 1); setWasPlayingBeforeLibrary(true); }
    else if (isPlaylistLooping && playlist.length > 0) { setCurrentIndex(0); setWasPlayingBeforeLibrary(true); }
  };

  const playPrev = () => {
    isFullscreenRef.current = !!document.fullscreenElement;
    if (currentIndex > 0) { setCurrentIndex(i => i - 1); setWasPlayingBeforeLibrary(true); }
  };

  const jumpTo = (index: number) => {
    isFullscreenRef.current = !!document.fullscreenElement;
    if (index >= 0 && index < playlist.length) { setCurrentIndex(index); setWasPlayingBeforeLibrary(true); }
  };

  const handleReorderPlaylist = useCallback((reordered: { id: string; name: string; thumbnail?: string }[]) => {
    const currentId = playlist[currentIndex]?.id;
    const newPlaylist = reordered
      .map(item => playlist.find(p => p.id === item.id))
      .filter((p): p is PlaylistItem => !!p?.src);
    setPlaylist(newPlaylist);
    const newIdx = newPlaylist.findIndex(p => p.id === currentId);
    if (newIdx >= 0) setCurrentIndex(newIdx);
  }, [playlist, currentIndex]);

  const handleReorderVideos = useCallback((orderedIds: string[]) => {
    videoOrderStore.setOrder(orderedIds);
  }, []);

  const handleVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
  }, []);

  const handleGoHome = useCallback(() => {
    setPlaylist([]);
    setCurrentIndex(0);
    setShowLibrary(false);
    setError(null);
  }, []);

  // How far into the resume video the user got — drives the home-card progress bar.
  const resumePercent = lastVideo && lastVideo.duration
    ? Math.min(100, Math.max(0, ((loadVideoProgress(lastVideo.id) ?? 0) / lastVideo.duration) * 100))
    : 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  // Download + install the pending update, then relaunch into the new version.
  const handleInstallUpdate = async () => {
    const update = updateRef.current;
    if (!update || updateStatus === 'downloading' || updateStatus === 'installing') return;
    try {
      setUpdateStatus('downloading');
      setUpdateProgress(0);
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            setUpdateProgress(total > 0 ? 0 : -1); // -1 => indeterminate (no length header)
            break;
          case 'Progress':
            downloaded += event.data.chunkLength ?? 0;
            if (total > 0) setUpdateProgress(Math.min(100, Math.round((downloaded / total) * 100)));
            break;
          case 'Finished':
            setUpdateProgress(100);
            setUpdateStatus('installing');
            break;
        }
      });
      // Installer ran successfully — restart so the user lands on the new build.
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    } catch (e) {
      console.error('Update failed:', e);
      setUpdateStatus('error');
    }
  };

  const dismissUpdate = () => {
    setUpdateBanner(null);
    setUpdateStatus('idle');
    setUpdateProgress(0);
  };

  const isUpdating = updateStatus === 'downloading' || updateStatus === 'installing';

  return (
    <div className="w-screen h-screen bg-neutral-900 text-white overflow-hidden flex flex-col font-sans">
      {/* Update dialog — modal, shown once when a newer version is found */}
      {updateBanner && (
        <div className="fixed inset-0 z-[300] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6 animate-[fadeIn_0.2s_ease]">
          <div
            className="border border-neutral-700/60 rounded-2xl p-6 w-full max-w-sm shadow-2xl shadow-black/60 animate-[fadeIn_0.25s_ease]"
            style={{ background: 'rgb(24,24,27)' }}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-red-500 to-purple-600 flex items-center justify-center shadow-lg shadow-red-500/20 flex-shrink-0">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7"/>
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-white text-base">Update Available</h3>
                <p className="text-sm text-neutral-400">PREV Player v{updateBanner.version}</p>
              </div>
            </div>
            <p className={`text-sm leading-relaxed mb-6 ${updateStatus === 'error' ? 'text-red-400' : 'text-neutral-300'}`}>
              {updateStatus === 'error'
                ? "Couldn't install the update. Check your internet connection and try again."
                : 'A new version of PREV Player is ready. Update now to get the latest features and improvements.'}
            </p>

            {isUpdating ? (
              <div className="mb-1">
                <div className="h-2 w-full bg-neutral-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full bg-gradient-to-r from-red-500 to-purple-500 transition-all duration-200 ${updateProgress < 0 ? 'animate-pulse w-1/3' : ''}`}
                    style={updateProgress >= 0 ? { width: `${updateProgress}%` } : undefined}
                  />
                </div>
                <p className="text-xs text-neutral-400 mt-2 text-center">
                  {updateStatus === 'installing'
                    ? 'Installing… the app will restart automatically'
                    : updateProgress < 0
                      ? 'Downloading…'
                      : `Downloading… ${updateProgress}%`}
                </p>
              </div>
            ) : (
              <div className="flex gap-3">
                <button
                  onClick={dismissUpdate}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-neutral-700 hover:bg-neutral-600 text-sm font-medium text-neutral-200 transition-colors active:scale-[0.97]"
                >
                  Later
                </button>
                <button
                  onClick={handleInstallUpdate}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-gradient-to-r from-red-600 to-purple-600 hover:from-red-500 hover:to-purple-500 text-sm font-bold text-white transition-all shadow-lg shadow-red-600/20 active:scale-[0.97]"
                >
                  {updateStatus === 'error' ? 'Retry' : 'Update Now'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {playlist.length > 0 ? (
        <div ref={playerWrapperRef} className="relative w-full h-full flex bg-black">
          <div className="relative flex-1 h-full bg-black">
            <VideoPlayer
              key={playlist[currentIndex].id}
              videoId={playlist[currentIndex].id}
              src={playlist[currentIndex].src}
              subtitlesSrc={playlist[currentIndex].subtitleSrc}
              autoPlay={wasPlayingBeforeLibrary}
              onEnded={playNext}
              onChangeVideo={openLibrary}
              onFileSelect={handleOpenFilesViaDialog}
              onPlayStateChange={playing => setWasPlayingBeforeLibrary(playing)}
              onNext={playNext}
              onPrev={playPrev}
              hasNext={currentIndex < playlist.length - 1 || isPlaylistLooping}
              hasPrev={currentIndex > 0}
              playlist={playlist.map(p => ({ id: p.id, name: p.name, thumbnail: p.thumbnail }))}
              currentIndex={currentIndex}
              onJumpTo={jumpTo}
              onReorderPlaylist={handleReorderPlaylist}
              startFullscreen={isFullscreenRef.current}
              onOpenLibrary={() => { showLibrary ? closeLibrary() : openLibrary(); }}
              showLibraryButton={!showLibrary}
              fullscreenContainerRef={playerWrapperRef}
              onVideoRef={handleVideoRef}
              onGoHome={handleGoHome}
            />
          </div>

          {showLibrary && (
            <VideoLibrary
              videos={videoLibrary}
              onPlayVideo={playFromLibrary}
              onDeleteVideo={deleteFromLibrary}
              onClose={closeLibrary}
              onAddVideos={handleAddFilesViaDialog}
              onReorderVideos={handleReorderVideos}
              onPlayFolder={playFolder}
              onAddToFolder={handleAddToFolder}
              onAddFolderFromPC={handleAddFolderFromPC}
            />
          )}
        </div>
      ) : (
        /* Home Screen */
        <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-6 bg-neutral-900 overflow-y-auto custom-scrollbar">
          <div className="w-full max-w-md py-8">
            {/* Logo & Title */}
            <div className="text-center mb-8 sm:mb-10">
              <div className="relative w-16 h-16 sm:w-20 sm:h-20 mx-auto mb-5">
                <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-red-500 to-purple-600 blur-xl opacity-40" />
                <div className="relative w-full h-full rounded-2xl bg-gradient-to-br from-red-500 to-purple-600 flex items-center justify-center shadow-xl shadow-red-500/20">
                  <FileVideo size={34} className="sm:w-10 sm:h-10 text-white" strokeWidth={1.8} />
                </div>
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight bg-gradient-to-r from-red-500 via-pink-500 to-purple-500 bg-clip-text text-transparent">
                PREV Player
              </h1>
              <p className="text-neutral-500 text-sm sm:text-base mt-2">Your personal video player</p>
            </div>

            {/* Resume Watching */}
            {lastVideo && (
              <div className="mb-6">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-neutral-500 uppercase tracking-[0.15em] mb-2.5">
                  <span className="w-1 h-1 rounded-full bg-red-500" /> Resume Watching
                </p>
                <button
                  onClick={() => playFromLibrary(lastVideo)}
                  className="w-full group flex items-center gap-4 p-3 rounded-2xl bg-neutral-800/60 ring-1 ring-white/5 hover:bg-neutral-800 hover:ring-red-500/30 transition-all duration-300"
                >
                  <div className="relative w-28 h-[68px] flex-shrink-0 rounded-xl overflow-hidden bg-neutral-700">
                    {lastVideo.thumbnail ? (
                      <img src={lastVideo.thumbnail} alt={lastVideo.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-neutral-800">
                        <FileVideo size={18} className="text-neutral-600" />
                      </div>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/40 transition-colors">
                      <div className="w-9 h-9 rounded-full bg-white/95 flex items-center justify-center shadow-lg transition-transform group-hover:scale-110">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="#dc2626"><polygon points="6,4 20,12 6,20" /></svg>
                      </div>
                    </div>
                    {resumePercent > 0 && (
                      <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                        <div className="h-full bg-red-500" style={{ width: `${resumePercent}%` }} />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 text-left">
                    <h3 className="text-sm sm:text-base font-semibold text-white truncate group-hover:text-red-400 transition-colors">
                      {lastVideo.name}
                    </h3>
                    <p className="text-xs text-neutral-500 mt-1">
                      {resumePercent > 0 ? `${Math.round(resumePercent)}% watched · tap to continue` : 'Tap to continue'}
                    </p>
                  </div>
                  <ChevronRight size={20} className="text-neutral-600 group-hover:text-red-400 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
                </button>
              </div>
            )}

            {/* Primary action */}
            <button
              onClick={handleOpenFilesViaDialog}
              className="flex items-center justify-center gap-2.5 w-full px-6 py-4 rounded-2xl font-semibold text-sm sm:text-base text-white bg-red-600 hover:bg-red-500 shadow-lg shadow-red-600/25 hover:shadow-red-500/40 transition-all active:scale-[0.98]"
            >
              <Upload size={20} />
              <span>Open Videos</span>
            </button>

            {/* Secondary actions */}
            <div className={`grid gap-3 mt-3 ${videoLibrary.length > 0 ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <button
                onClick={handleAddFolderFromPC}
                className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl font-medium text-sm text-neutral-200 bg-neutral-800/80 hover:bg-neutral-700 ring-1 ring-white/5 transition-all active:scale-[0.98]"
              >
                <FolderPlus size={18} />
                <span>Import Folder</span>
              </button>

              {videoLibrary.length > 0 && (
                <button
                  onClick={openLibrary}
                  className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl font-medium text-sm text-neutral-200 bg-neutral-800/80 hover:bg-neutral-700 ring-1 ring-white/5 transition-all active:scale-[0.98]"
                >
                  <Library size={18} />
                  <span>Library ({videoLibrary.length})</span>
                </button>
              )}
            </div>

            {error && (
              <div className="mt-5 flex items-center text-red-400 bg-red-400/10 px-4 py-3 rounded-xl text-sm">
                <AlertCircle size={16} className="mr-2 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Footer hint */}
            <p className="mt-8 flex items-center justify-center gap-2 text-center text-neutral-600 text-xs">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Drag &amp; drop videos anywhere to play
            </p>
          </div>
        </div>
      )}

      {/* Library Modal (from home screen) */}
      {showLibrary && playlist.length === 0 && (
        <VideoLibrary
          videos={videoLibrary}
          onPlayVideo={playFromLibrary}
          onDeleteVideo={deleteFromLibrary}
          onClose={closeLibrary}
          onAddVideos={handleAddFilesViaDialog}
          onReorderVideos={handleReorderVideos}
          onPlayFolder={playFolder}
          onAddToFolder={handleAddToFolder}
          onAddFolderFromPC={handleAddFolderFromPC}
        />
      )}

      {/* Drag-and-drop overlay — only while files are actively dragged over the
          window (ChatGPT-style). Covers both the home screen and the player. */}
      {isDragging && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 sm:p-10 bg-neutral-950/80 backdrop-blur-sm pointer-events-none animate-[fadeIn_0.15s_ease]">
          <div className="flex flex-col items-center justify-center gap-5 w-full max-w-2xl h-full max-h-[55vh] rounded-3xl border-2 border-dashed border-red-500/70 bg-red-500/[0.06] text-center px-6">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-red-500 to-purple-600 flex items-center justify-center shadow-2xl shadow-red-500/30 animate-bounce-slow">
              <Upload size={36} className="text-white" />
            </div>
            <div>
              <p className="text-2xl font-bold text-white">Drop to play</p>
              <p className="text-neutral-400 text-sm mt-1.5">Release your video files anywhere</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
