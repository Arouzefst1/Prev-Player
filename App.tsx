import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { Upload, FileVideo, AlertCircle, Library, FolderPlus, ChevronRight, RefreshCw, Share2, Settings, Music } from 'lucide-react';
import { isTypingTarget } from './utils';
import VideoPlayer from './components/VideoPlayer';
import VideoLibrary from './components/VideoLibrary';
import ShareModal from './components/ShareModal';
import DownloadsPanel from './components/DownloadsPanel';
import SettingsModal from './components/SettingsModal';
import PropertiesModal, { type PropertiesTarget } from './components/PropertiesModal';
import { useSettings } from './settings';
import { mpvStop, getMpvState, shutdownMpv, mpvSetPassthrough } from './mpv';
import * as engine from './engine';
import { VIDEO_EXT_LIST, AUDIO_EXT_LIST, MEDIA_EXT_LIST, isMediaPath, isAudioPath } from './formats';
import { actionFor } from './shortcuts';
import { probeDisc, isIsoPath } from './disc';
import * as frames from './frames';
import type { RawMedia } from './media';
import {
  srtToVtt,
  extractVideoThumbnail,
  getVideoDuration,
  isUsableThumbnail,
  videoStore,
  VideoMeta,
  videoOrderStore,
  applyVideoOrder,
  loadVideoProgress,
  saveVideoProgress,
  folderProgressStore,
} from './utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Accepts both video and audio — the full list lives in formats.ts.
const isVideoPath = isMediaPath;

function typeFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
    avi: 'video/x-msvideo', mov: 'video/quicktime', wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv', ogv: 'video/ogg', ogg: 'video/ogg',
    m4v: 'video/mp4', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
    ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t',
    vob: 'video/mpeg', mpg: 'video/mpeg', mpeg: 'video/mpeg',
    // Audio
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
    flac: 'audio/flac', opus: 'audio/opus', oga: 'audio/ogg', weba: 'audio/webm',
    wma: 'audio/x-ms-wma', mka: 'audio/x-matroska', aiff: 'audio/aiff', aif: 'audio/aiff',
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
  /** Native path OR a stream URL — the mpv engine loads this directly. */
  path: string;
  name: string;
  subtitleSrc?: string;
  thumbnail?: string;
  /**
   * Set on a queue you are watching online. The URL isn't known until the
   * engine opens a session for this item, which happens when you reach it —
   * see the lazy-open effect. Cleared once a downloaded copy takes over.
   */
  stream?: { link: string; index: number; sessionId?: string; size?: number };
}

interface DlItem {
  id: string;        // engine transfer id — the key for progress, pause, cancel
  libId: string;     // stable library id (for hand-off / resume)
  name: string;
  link: string;      // engine link this came from…
  index: number;     // …and which file of it
  dest: string;
  bytes: number;
  total: number;
  speed: number;     // bytes/sec, measured by the engine
  eta: number | null;
  /**
   * Set while this is a *save tap* on a live stream rather than a download:
   * bytes come out of the playback buffer, so progress arrives as stream stats
   * and the transfer only becomes an ordinary download when you stop watching.
   */
  streamId?: string;
  status: 'downloading' | 'saving' | 'paused' | 'done' | 'error';
  /** Only true when a published checksum matched — size alone doesn't count. */
  verified?: boolean;
  group?: string;    // folder-share group id
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
  const [shouldAutoPlay, setShouldAutoPlay] = useState(true);
  const [isPlaylistLooping, setIsPlaylistLooping] = useState(false);
  // Live mirrors of the queue state. playNext/playPrev/jumpTo are invoked from a
  // ref held inside the player, so they can't rely on render-time closures.
  const playlistRef = useRef<PlaylistItem[]>([]);
  const currentIndexRef = useRef(0);
  const isPlaylistLoopingRef = useRef(false);
  const [updateBanner, setUpdateBanner] = useState<{ version: string; notes?: string } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'downloading' | 'installing' | 'error'>('idle');
  const [updateProgress, setUpdateProgress] = useState(0); // 0–100, –1 = indeterminate
  const [appVersion, setAppVersion] = useState('');
  const [manualCheck, setManualCheck] = useState<'idle' | 'checking' | 'uptodate' | 'error'>('idle');
  /** What the backend knows about a newer release (see src-tauri/src/updater.rs). */
  type UpdateInfo = { version: string; currentVersion: string; notes?: string; quiet: boolean; downloaded: boolean };
  const updateRef = useRef<UpdateInfo | null>(null);
  const isFullscreenRef = useRef(false);
  const playerWrapperRef = useRef<HTMLDivElement>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

  // --- Settings ---
  const [settings, updateSettings] = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  // Ref mirror so callbacks read the latest settings without being in their deps.
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  // Dolby / DTS to the receiver: applied live, and as mpv's starting value if it
  // hasn't started yet (mpvSetPassthrough never starts it just for this).
  useEffect(() => { mpvSetPassthrough(settings.audioPassthrough).catch(() => {}); }, [settings.audioPassthrough]);

  // Ref mirror of the library so add-handlers can reorder from the freshest list
  // without depending on (and re-creating themselves for) every library change.
  const videoLibraryRef = useRef<VideoMeta[]>([]);
  useEffect(() => { videoLibraryRef.current = videoLibrary; }, [videoLibrary]);
  /** The library has been read from storage; from then on `videoLibraryRef` is the whole of it. */
  const libraryLoadedRef = useRef(false);

  // Merge freshly-added metas into the library and float every "touched" id
  // (newly added OR re-selected existing) to the very top — #1 first-selected.
  // Also persists the new order so the library panel shows the same top-first order.
  const promoteToTop = useCallback((newMetas: VideoMeta[], touchedIds: string[]) => {
    const base = videoLibraryRef.current;
    const merged = [...newMetas, ...base.filter(v => !newMetas.some(n => n.id === v.id))];
    const touched = new Set(touchedIds);
    const promoted = touchedIds
      .map(id => merged.find(v => v.id === id))
      .filter((v): v is VideoMeta => !!v);
    const rest = merged.filter(v => !touched.has(v.id));
    const next = [...promoted, ...rest];
    videoLibraryRef.current = next;
    setVideoLibrary(next);
    videoOrderStore.setOrder(next.map(v => v.id));
  }, []);

  // Id of the currently-playing clip — so we can persist its resume position from
  // outside the player (e.g. when leaving to the home screen or on a reload).
  const currentVideoIdRef = useRef<string | null>(null);
  useEffect(() => { currentVideoIdRef.current = playlist[currentIndex]?.id ?? null; }, [playlist, currentIndex]);

  // ---------------------------------------------------------------------------
  // Where you were in a playlist
  //
  // A folder remembers the video you were on AND the spot inside it, so opening
  // the folder again offers to pick that back up. This is its own bookmark, kept
  // apart from per-video continue-watching: that one ignores the first few
  // seconds and forgets a finished video, while a playlist has to remember the
  // spot exactly as it was.
  // ---------------------------------------------------------------------------

  /** The folder the current queue came from, with the membership it had then. */
  const activeFolderRef = useRef<{ id: string; ids: string[] } | null>(null);
  /** A one-shot position handed to the player when resuming a playlist. */
  const [folderStartAt, setFolderStartAt] = useState<{ videoId: string; time: number } | null>(null);

  const markFolderProgress = useCallback((videoId: string, time: number, duration: number) => {
    const folder = activeFolderRef.current;
    // Only for a video this folder actually holds — so a queue started from
    // somewhere else can never overwrite a folder's bookmark.
    if (!folder || !folder.ids.includes(videoId)) return;
    folderProgressStore.save(folder.id, videoId, time, duration);
  }, []);

  // Stop the native mpv engine — but SAVE the resume position first (reading it
  // straight from the live engine state), so leaving the player never loses your
  // place. `stop` unloads the file, which would otherwise reset the position to 0.
  const stopEngine = useCallback(() => {
    const s = getMpvState();
    const id = currentVideoIdRef.current;
    if (id && s.currentTime > 0 && s.duration > 0) {
      saveVideoProgress(id, s.currentTime, s.duration);
      // Leaving mid-video is exactly when the playlist bookmark matters, and the
      // player's throttled reports can be up to 5s behind. Same numbers, no
      // minimum — see markFolderProgress.
      markFolderProgress(id, s.currentTime, s.duration);
    }
    mpvStop().catch(() => {});
  }, [markFolderProgress]);

  // Keep the most recently *watched* video at the top of the library (most-recent
  // first), the same way newly-added ones bubble up. Fires whenever the current
  // clip changes; skips transient stream items that aren't in the library.
  const lastPromotedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const id = playlist[currentIndex]?.id;
    if (!id || id === lastPromotedIdRef.current) return;
    if (!videoLibraryRef.current.some(v => v.id === id)) return;
    lastPromotedIdRef.current = id;
    promoteToTop([], [id]);
  }, [playlist, currentIndex, promoteToTop]);

  // --- Sharing ---
  const [shareOpen, setShareOpen] = useState(false);
  const [shareTarget, setShareTarget] = useState<{ path: string; name: string } | null>(null);
  const [folderTarget, setFolderTarget] = useState<{ files: { path: string; name: string }[]; name: string } | null>(null);
  const [shareInitialLink, setShareInitialLink] = useState<string | null>(null);
  // App-level PARALLEL download manager. Every received file downloads at once and
  // is tracked here so a persistent panel can show it anywhere (home/library/player)
  // and it survives navigating away. Each item has its own speed sampler.
  const [downloads, setDownloads] = useState<DlItem[]>([]);
  const downloadsRef = useRef<DlItem[]>([]);
  useEffect(() => { downloadsRef.current = downloads; }, [downloads]);
  // Properties panel — opened from the player's ⓘ, or a row in the downloads panel.
  const [propsTarget, setPropsTarget] = useState<PropertiesTarget | null>(null);
  // Live buffer stats for the stream that's open, if any.
  const [streamStats, setStreamStats] = useState<{ id: string; buffered: number; cached: number; fetches: number } | null>(null);
  // What mpv itself reports while a stream is starting: whether the picture is
  // actually advancing, and if not, whether it's decoding in software.
  const [mpvDiag, setMpvDiag] = useState<{
    moving: boolean; paused: boolean; hwdec?: string; codec?: string; cacheAhead?: number; dropped?: number;
  }>({ moving: false, paused: true });
  useEffect(() => {
    let last = -1;
    const t = setInterval(() => {
      const s = getMpvState();
      setMpvDiag({
        moving: s.currentTime > 0 && s.currentTime !== last,
        paused: s.paused,
        hwdec: s.hwdec, codec: s.videoCodec, cacheAhead: s.cacheAhead, dropped: s.droppedFrames,
      });
      last = s.currentTime;
    }, 1000);
    return () => clearInterval(t);
  }, []);
  // Folder-share groups awaiting an "import as folder?" prompt once all parts finish.
  const dlGroupsRef = useRef<Map<string, { name: string; libIds: string[]; total: number }>>(new Map());
  const [toast, setToast] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    setToast({ msg, action });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), action ? 6000 : 2500);
  }, []);
  const openReceive = useCallback(() => { setShareTarget(null); setFolderTarget(null); setShareInitialLink(null); setShareOpen(true); }, []);
  const shareVideo = useCallback((v: VideoMeta) => { setFolderTarget(null); setShareTarget({ path: v.path, name: v.name }); setShareOpen(true); }, []);
  const hasInLibrary = useCallback((name: string) => videoLibrary.some(v => v.name === name), [videoLibrary]);

  // Auto-expire old GitHub shares on launch so nothing lingers in the cloud.
  useEffect(() => { import('./share').then(m => m.cleanupExpiredShares().catch(() => {})); }, []);

  // ---------------------------------------------------------------------------
  // Silent updates
  //
  // Fixes shouldn't cost the user a dialog, a restart, or even a glance. An update
  // found by the automatic checks is downloaded in the background and installed
  // the moment the app is closed — silently, and without relaunching, so the next
  // launch is simply the new version. A small release (patch bump) says nothing
  // at all; a bigger one gets a toast with a "Restart now" shortcut. A manual
  // check still shows the dialog, since that one the user asked for.
  //
  // The backend (src-tauri/src/updater.rs) holds the downloaded package and runs
  // the installer; `update_install` exits the process on success.

  /** The release sitting in memory, installed quietly when the app is closed. */
  const readyUpdateRef = useRef<UpdateInfo | null>(null);
  const installingRef = useRef(false);

  // "Update now": fetch (or reuse) the package with the dialog's progress bar,
  // install it silently and come back up in the new version.
  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;
    let unlisten: (() => void) | null = null;
    try {
      setUpdateStatus('downloading');
      setUpdateProgress(update.downloaded ? 100 : -1);
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<{ downloaded: number; total: number | null }>('update-progress', ({ payload }) => {
        setUpdateProgress(payload.total ? Math.min(100, Math.round((payload.downloaded / payload.total) * 100)) : -1);
      });
      const fetched = await tauriInvoke<UpdateInfo | null>('update_check', { download: true });
      if (!fetched) throw new Error('the release is no longer available');
      readyUpdateRef.current = null; // being installed right now, not on close
      setUpdateProgress(100);
      setUpdateStatus('installing');
      // Save the position and take mpv down first: the process is about to be
      // replaced, and a child mpv would otherwise outlive it.
      stopEngine();
      await shutdownMpv();
      await tauriInvoke('update_install', { relaunch: true }); // exits; the installer relaunches
    } catch (e) {
      console.error('[updater] update failed:', e);
      setUpdateStatus('error');
    } finally {
      unlisten?.();
      installingRef.current = false;
    }
  }, [stopEngine]);

  // Ask the Tauri updater whether a newer (signed) release exists; show the dialog if so.
  // Shared by the startup auto-check and the manual "Check for updates" button — so a user
  // who clicked "Later" can re-trigger it anytime. The updater fetches latest.json from the
  // GitHub endpoint and verifies its signature against the bundled public key. When found,
  // the dialog's "Update Now" downloads + installs + relaunches (no manual installer).
  const runUpdateCheck = useCallback(async (manual: boolean): Promise<'found' | 'none' | 'failed'> => {
    if (manual) setManualCheck('checking');
    try {
      // Automatic checks download straight away; a manual one only looks, and the
      // dialog's "Update Now" fetches with a progress bar.
      const info = await tauriInvoke<UpdateInfo | null>('update_check', { download: !manual });
      if (info) {
        console.info(`[updater] update available: v${info.version}${info.quiet ? ' (quiet)' : ''}`);
        updateRef.current = info;
        setUpdateStatus('idle');
        setUpdateProgress(0);
        if (manual) {
          setUpdateBanner({ version: info.version, notes: info.notes });
          setManualCheck('idle');
          // The update dialog sits below the settings modal, so get out of its way.
          setShowSettings(false);
        } else if (info.downloaded) {
          const announce = !info.quiet && readyUpdateRef.current?.version !== info.version;
          readyUpdateRef.current = info;
          if (announce) {
            showToast(`PREV Player v${info.version} is ready — it installs when you close the app`, {
              label: 'Restart now',
              run: () => { setUpdateBanner({ version: info.version, notes: info.notes }); installUpdate(); },
            });
          }
        }
        return 'found';
      }
      console.info('[updater] already on the latest version');
      if (manual) {
        setManualCheck('uptodate');
        setTimeout(() => setManualCheck('idle'), 3000);
      }
      return 'none';
    } catch (e) {
      // Offline, manifest not published yet, or running in a plain browser. Logged
      // rather than swallowed — a silent catch is why a broken check looked identical
      // to "no update available".
      console.warn('[updater] check failed:', e);
      if (manual) {
        setManualCheck('error');
        setTimeout(() => setManualCheck('idle'), 3000);
      }
      return 'failed';
    }
  }, [installUpdate, showToast]);

  // Keep looking while the app stays open: a player left running for days would
  // otherwise never see a release. Every 6 hours is plenty — a check is one small
  // request, and a release already in memory is not downloaded twice.
  useEffect(() => {
    const timer = setInterval(() => {
      if (settingsRef.current.autoCheckUpdates) runUpdateCheck(false);
    }, 6 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [runUpdateCheck]);

  // Install on the way out. Closing the window is the one moment an install can't
  // interrupt anything, so a release downloaded earlier is applied right here —
  // silently, and WITHOUT relaunching: the user closed the app, so it stays closed.
  // Listening for the close request means the window no longer closes by itself;
  // it is destroyed once the install has been handed off (or if there was nothing
  // to do). mpv is shut down first so it can't outlive the app.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const off = await win.onCloseRequested(async (event) => {
          const ready = readyUpdateRef.current;
          if (!ready) return; // nothing pending: the window closes as usual
          event.preventDefault();
          readyUpdateRef.current = null;
          try {
            stopEngine();
            await shutdownMpv();
            await tauriInvoke('update_install', { relaunch: false }); // exits the process
          } catch (e) {
            console.warn('[updater] install on close failed — closing normally:', e);
          }
          await win.destroy().catch(() => {});
        });
        if (disposed) off(); else unlisten = off;
      } catch (e) {
        console.warn('[updater] could not hook the window close:', e);
      }
    })();
    return () => { disposed = true; unlisten?.(); };
  }, [stopEngine]);

  useEffect(() => {
    // Grab the running version for display, then auto-check shortly after launch.
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        setAppVersion(await getVersion());
      } catch {}
    })();

    // Only auto-check at launch when the user hasn't turned it off.
    if (!settingsRef.current.autoCheckUpdates) return;

    // The first attempt lands 4s in, when the network stack may still be coming up
    // after a cold boot — and a single silent attempt is indistinguishable from the
    // feature being dead. Retry with a backoff, and stop the moment one lands.
    const delays = [4000, 20000, 60000];
    let attempt = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled) return;
      const result = await runUpdateCheck(false);
      if (cancelled || result !== 'failed') return;
      attempt += 1;
      if (attempt < delays.length) timer = setTimeout(tick, delays[attempt]);
      else console.warn('[updater] giving up on the launch check for this session');
    };
    timer = setTimeout(tick, delays[0]);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [runUpdateCheck]);

  // ---------------------------------------------------------------------------
  // Boot: load library from IndexedDB, handle initial files from CLI args
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const boot = async () => {
      // Load persisted library — in the saved order, not IndexedDB's (random-id)
      // key order. promoteToTop persists whatever order this list is in, so
      // loading it unsorted reshuffled the whole library the first time a video
      // was opened.
      let metas: VideoMeta[] = [];
      try {
        metas = applyVideoOrder(await videoStore.getAllMeta(), videoOrderStore.getOrder());
        videoLibraryRef.current = metas;
        setVideoLibrary(metas);
      } catch {}
      libraryLoadedRef.current = true;

      // Backfill real file sizes for older entries saved with size 0. `stat` reads
      // only the file's metadata (the size), so this never copies the file or uses
      // extra storage. Runs in the background and updates the UI as it resolves.
      const needSize = metas.filter(m => !m.size);
      if (needSize.length > 0) {
        (async () => {
          try {
            const { stat } = await import('@tauri-apps/plugin-fs');
            for (const m of needSize) {
              try {
                const size = (await stat(m.path)).size;
                if (size && size !== m.size) {
                  await videoStore.updateMeta(m.id, { size });
                  setVideoLibrary(prev => prev.map(v => (v.id === m.id ? { ...v, size } : v)));
                }
              } catch {}
            }
          } catch {}
        })();
      }

      // Entries added before the frame engine (or whose probe never ran) get a
      // real thumbnail, length and format now — quietly, one at a time.
      // So do entries whose thumbnail never rendered (an audio file once came out
      // as an empty "data:," image).
      const unprobed = metas.filter(m => (!m.probed || (m.thumbnail && !isUsableThumbnail(m.thumbnail))) && !m.disc && !/^https?:/i.test(m.path));
      if (unprobed.length > 0) enqueueMetaExtraction(unprobed.map(m => ({ path: m.path, id: m.id })), true);

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
            // With discs on, folders and ISOs go through too: a Blu-ray / DVD among them plays.
            const videos = dropped.filter(p => isVideoPath(p) || settingsRef.current.discPlayback);
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
  // Background metadata extraction (thumbnail + duration + format)
  // Runs sequentially off the critical path; thumbnails fill in after playback starts.
  //
  // The headless mpv (frames.ts) does it: it opens MKV, HEVC, AV1, DTS, TrueHD —
  // everything the player plays — and tone-maps HDR thumbnails. The WebView's
  // <video> is only a fallback for a build without mpv, since it can't open most
  // of those. Each file is probed once (`probed`), even when that fails.
  // ---------------------------------------------------------------------------
  const metaQueueRef = useRef<Promise<void>>(Promise.resolve());
  const metaPendingRef = useRef(0);

  const enqueueMetaExtraction = useCallback((items: { path: string; id: string }[], gentle = false, delayMs = 0) => {
    if (items.length === 0) return;
    metaPendingRef.current += items.length;
    metaQueueRef.current = metaQueueRef.current.then(async () => {
      // A file that was just opened to watch is looked at after it has started
      // playing, so the two never compete for the disk and the decoder.
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      const { stat } = await import('@tauri-apps/plugin-fs');
      for (const { path, id } of items) {
        let thumbnail: string | undefined;
        let duration: number | undefined;
        let size: number | undefined;
        let media: RawMedia | undefined;
        try {
          const p = await frames.probe(path);
          thumbnail = p.thumbnail;
          duration = p.duration;
          media = frames.mediaOfProbe(p);
        } catch {
          // The WebView can't draw a picture from audio, so audio gets no thumbnail
          // here (the library shows a music tile) — only its length.
          const fileUrl = convertFileSrc(path);
          if (!isAudioPath(path)) { try { thumbnail = await extractVideoThumbnail(fileUrl); } catch {} }
          try { duration = await getVideoDuration(fileUrl); } catch {}
        }
        if (thumbnail && !isUsableThumbnail(thumbnail)) thumbnail = undefined;
        // Real file size straight from the file-system metadata — reads the size
        // only, never the bytes, so it does NOT copy the file / use extra storage.
        try { size = (await stat(path)).size; } catch {}
        const patch = {
          // Empty clears an unusable stored thumbnail; the library then draws its placeholder.
          thumbnail: thumbnail ?? '',
          ...(duration !== undefined ? { duration } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(media ? { media } : {}),
          probed: true,
        };
        try { await videoStore.updateMeta(id, patch); } catch {}
        setVideoLibrary(prev => prev.map(v => (v.id === id ? { ...v, ...patch } : v)));
        metaPendingRef.current -= 1;
        // A backfill of an existing library breathes between files, so it never
        // competes with a video that's playing.
        if (gentle) await new Promise(r => setTimeout(r, 400));
      }
      // Nothing left to look at: let the headless mpv go.
      if (metaPendingRef.current <= 0) frames.releaseFrames('library');
    });
  }, []);

  /**
   * What a list of dropped / picked paths holds that can play: media files as
   * they are, plus — with discs on — Blu-ray / DVD ISOs and folders, named
   * after the disc and filed under the folder that holds BDMV / VIDEO_TS.
   */
  const intake = useCallback(async (paths: string[]): Promise<{ path: string; name?: string; disc?: 'bluray' | 'dvd' }[]> => {
    const out: { path: string; name?: string; disc?: 'bluray' | 'dvd' }[] = [];
    for (const p of paths) {
      if (isVideoPath(p)) { out.push({ path: p }); continue; }
      if (!settingsRef.current.discPlayback) continue;
      const d = await probeDisc(p);
      if (d && !out.some(o => o.path === d.root)) out.push({ path: d.root, name: d.label, disc: d.kind });
    }
    return out;
  }, []);

  // ---------------------------------------------------------------------------
  // Core: add file paths to the library and build a playlist for immediate playback
  // ---------------------------------------------------------------------------
  const handleFilePaths = useCallback(async (paths: string[]) => {
    // A prevplayer:// deep-link (from clicking a share link) arrives here as an
    // "argument" — route it to the receive flow instead of treating it as a file.
    const link = paths.find(p => typeof p === 'string' && p.trim().toLowerCase().startsWith('prevplayer://'));
    if (link) { setShareTarget(null); setFolderTarget(null); setShareInitialLink(link.trim()); setShareOpen(true); return; }

    const entries = await intake(paths);
    if (entries.length === 0) {
      setError(!settingsRef.current.discPlayback && paths.some(isIsoPath)
        ? 'Blu-ray and DVD images play once “Blu-ray & DVD” is on in Settings › Playback.'
        : 'No playable video files found.');
      return;
    }
    setError(null);

    const { convertFileSrc } = await import('@tauri-apps/api/core');

    // Deduplicate against existing library (by path). Once loaded, the library
    // is in memory — reading it back from storage (every thumbnail included)
    // only held up playback.
    const allMetas = libraryLoadedRef.current ? videoLibraryRef.current : await videoStore.getAllMeta();
    const byPath = new Map(allMetas.map(m => [m.path, m]));
    const seenInBatch = new Map<string, string>(); // path -> id

    const playlistItems: PlaylistItem[] = [];
    const newMetas: VideoMeta[] = [];

    for (const { path: p, name: label, disc } of entries) {
      const existing = byPath.get(p);
      if (existing) {
        playlistItems.push({ id: existing.id, src: convertFileSrc(p), path: p, name: existing.name, thumbnail: existing.thumbnail });
        continue;
      }
      // Dedupe within this batch
      let id = seenInBatch.get(p);
      if (!id) { id = genId(); seenInBatch.set(p, id); }
      const name = label ?? p.replace(/\\/g, '/').split('/').pop() ?? p;
      // A disc has nothing for the frame engine to read, so it counts as probed.
      const meta: VideoMeta = { id, name, path: p, size: 0, addedAt: Date.now(), type: disc ? 'video' : typeFromPath(p), ...(disc ? { disc, probed: true } : {}) };
      newMetas.push(meta);
      playlistItems.push({ id, src: convertFileSrc(p), path: p, name });
    }

    // Instant playback — no waiting on any storage. Close the library so the
    // player is visible (this flow can be triggered from inside the library via
    // "Play videos when added").
    setPlaylist(playlistItems);
    setCurrentIndex(0);
    setShouldAutoPlay(true);
    setShowLibrary(false);

    // Selected several files at once → play them in order + offer to save as a folder.
    if (playlistItems.length > 1) {
      const batchIds = playlistItems.map(pi => pi.id);
      showToast(`Playing ${playlistItems.length} videos in order`, {
        label: 'Save as folder',
        run: () => saveIdsAsFolderRef.current(batchIds),
      });
    }

    if (newMetas.length > 0) {
      // Persist metadata (path only — no blob) to IndexedDB
      for (const meta of newMetas) {
        try {
          await videoStore.save({ id: meta.id, name: meta.name, path: meta.path, size: 0, addedAt: meta.addedAt, type: meta.type, disc: meta.disc, probed: meta.probed });
        } catch {}
      }
      // Background: extract thumbnail + duration, once the video is playing.
      enqueueMetaExtraction(newMetas.filter(m => !m.disc).map(m => ({ path: m.path, id: m.id })), false, 3000);
    }

    // Show new videos AND bubble every selected file (new or already-owned) to the
    // top of the library, so opening from Explorer always lands it at #1.
    const touchedIds = Array.from(new Set(playlistItems.map(pi => pi.id)));
    promoteToTop(newMetas, touchedIds);
  }, [enqueueMetaExtraction, showToast, promoteToTop, intake]);

  // Add paths to library only (no auto-play), used from the library panel
  const handleAddToLibraryOnly = useCallback(async (paths: string[]): Promise<string[]> => {
    const entries = await intake(paths);
    if (entries.length === 0) return [];

    const allMetas = await videoStore.getAllMeta();
    const byPath = new Map(allMetas.map(m => [m.path, m]));
    const newMetas: VideoMeta[] = [];
    const touchedIds: string[] = []; // existing + new, in selection order

    for (const { path: p, name: label, disc } of entries) {
      const existing = byPath.get(p);
      if (existing) { touchedIds.push(existing.id); continue; }
      const id = genId();
      const name = label ?? p.replace(/\\/g, '/').split('/').pop() ?? p;
      newMetas.push({ id, name, path: p, size: 0, addedAt: Date.now(), type: disc ? 'video' : typeFromPath(p), ...(disc ? { disc, probed: true } : {}) });
      byPath.set(p, newMetas[newMetas.length - 1]);
      touchedIds.push(id);
    }

    if (newMetas.length > 0) {
      for (const m of newMetas) {
        try { await videoStore.save({ ...m }); } catch {}
      }
      enqueueMetaExtraction(newMetas.filter(m => !m.disc).map(m => ({ path: m.path, id: m.id })));
    }

    // New videos appear — and re-selected ones bubble up — at the top of the library.
    promoteToTop(newMetas, Array.from(new Set(touchedIds)));
    return touchedIds;
  }, [enqueueMetaExtraction, promoteToTop, intake]);

  // Import a whole folder: use Tauri's native folder dialog + FS to list video files
  const handleAddFolderFromPC = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const folderPath = await open({ directory: true, multiple: false, title: 'Select Folder to Import' });
    if (!folderPath || typeof folderPath !== 'string') return;

    // A Blu-ray / DVD folder is one film, not a folder of clips.
    if (settingsRef.current.discPlayback && await probeDisc(folderPath)) {
      setError(null);
      await handleAddToLibraryOnly([folderPath]);
      setVideoLibrary(prev => [...prev]);
      return;
    }

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
      filters: [
        { name: 'Media Files', extensions: settingsRef.current.discPlayback ? [...MEDIA_EXT_LIST, 'iso'] : MEDIA_EXT_LIST },
        { name: 'Video Files', extensions: VIDEO_EXT_LIST },
        { name: 'Audio Files', extensions: AUDIO_EXT_LIST },
        ...(settingsRef.current.discPlayback ? [{ name: 'Blu-ray / DVD images', extensions: ['iso'] }] : []),
      ],
      title: 'Add Media Files',
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    // "Play videos when added" setting: hand off to the play flow (adds + plays),
    // otherwise just add them to the library (still floated to the top).
    if (settingsRef.current.playOnAdd) {
      await handleFilePaths(paths as string[]);
    } else {
      await handleAddToLibraryOnly(paths as string[]);
    }
  }, [handleAddToLibraryOnly, handleFilePaths]);

  // Open native file-picker, play selected files immediately
  const handleOpenFilesViaDialog = useCallback(async () => {
    const wasFullscreen = !!document.fullscreenElement;
    if (wasFullscreen) { try { await document.exitFullscreen(); } catch {} }

    const { open } = await import('@tauri-apps/plugin-dialog');
    const result = await open({
      multiple: true,
      filters: [
        { name: 'Media Files', extensions: settingsRef.current.discPlayback ? [...MEDIA_EXT_LIST, 'iso'] : MEDIA_EXT_LIST },
        { name: 'Video Files', extensions: VIDEO_EXT_LIST },
        { name: 'Audio Files', extensions: AUDIO_EXT_LIST },
        ...(settingsRef.current.discPlayback ? [{ name: 'Blu-ray / DVD images', extensions: ['iso'] }] : []),
      ],
      title: 'Open Media Files',
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
      filters: [
        { name: 'Media Files', extensions: settingsRef.current.discPlayback ? [...MEDIA_EXT_LIST, 'iso'] : MEDIA_EXT_LIST },
        { name: 'Video Files', extensions: VIDEO_EXT_LIST },
        { name: 'Audio Files', extensions: AUDIO_EXT_LIST },
        ...(settingsRef.current.discPlayback ? [{ name: 'Blu-ray / DVD images', extensions: ['iso'] }] : []),
      ],
      title: 'Add Media to Folder',
    });
    if (!result) return;
    const paths = Array.isArray(result) ? result : [result];
    const ids = await handleAddToLibraryOnly(paths as string[]);

    // Link the newly-added videos to the folder
    const { folderStore } = await import('./utils');
    ids.forEach(id => folderStore.addVideo(folderId, id));

    setVideoLibrary(prev => [...prev]);
  }, [handleAddToLibraryOnly]);

  // ---------------------------------------------------------------------------
  // Play from library
  // ---------------------------------------------------------------------------
  const playFromLibrary = useCallback(async (video: VideoMeta) => {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const src = convertFileSrc(video.path);
    activeFolderRef.current = null; // a single video isn't a folder's queue
    setPlaylist([{ id: video.id, src, path: video.path, name: video.name, thumbnail: video.thumbnail }]);
    setCurrentIndex(0);
    setShowLibrary(false);
    setShouldAutoPlay(true);
  }, []);

  // Watch received shares by streaming their CDN URLs directly (no download).
  const watchUrls = useCallback((items: { url: string; name: string }[], startIndex: number) => {
    if (items.length === 0) return;
    const pl: PlaylistItem[] = items.map((it, i) => ({ id: `stream-${i}-${genId()}`, src: it.url, path: it.url, name: it.name }));
    setPlaylist(pl);
    setCurrentIndex(Math.min(startIndex, pl.length - 1));
    setShowLibrary(false);
    setShouldAutoPlay(true);
  }, []);

  // Open an already-owned library video by file name (used when a received share
  // is already present locally — no need to re-download).
  const openByName = useCallback((name: string) => {
    const v = videoLibrary.find(x => x.name === name);
    if (v) playFromLibrary(v);
  }, [videoLibrary, playFromLibrary]);

  // A received file finished downloading → sync it into the library, then play it.
  const importDownloaded = useCallback(async (localPath: string, name: string) => {
    let meta = videoLibrary.find(v => v.name === name);
    if (!meta) {
      const id = genId();
      meta = { id, name, path: localPath, size: 0, addedAt: Date.now(), type: typeFromPath(name) };
      try { await videoStore.save({ id, name, path: localPath, size: 0, addedAt: Date.now(), type: meta.type }); } catch {}
      const created = meta;
      setVideoLibrary(prev => [created, ...prev.filter(v => v.id !== id)]);
      // Backfill real file size + thumbnail + duration (was showing 0 MB / no thumb).
      enqueueMetaExtraction([{ path: localPath, id }]);
    }
    // Tell the user where it landed.
    const folder = localPath.replace(/[\\/][^\\/]+$/, '');
    showToast(`Saved to ${folder}`, { label: 'Open folder', run: async () => {
      try { const { revealItemInDir } = await import('@tauri-apps/plugin-opener'); await revealItemInDir(localPath); } catch {}
    }});
    await playFromLibrary(meta);
  }, [videoLibrary, playFromLibrary, enqueueMetaExtraction, showToast]);

  // Kick off a download for every file listed. The engine owns the transfer —
  // parallel workers, a chunk map on disk, resume, per-chunk verification — so
  // all this does is queue them and mirror what comes back into the panel.
  // `group` (with a folder name) makes them offer an "import as folder?" prompt
  // once every part finishes.
  const startDownloads = useCallback(async (
    link: string,
    files: { index: number; name: string; size: number }[],
    dir: string,
    group?: { id: string; name: string },
  ) => {
    const fresh = files.filter(f => !videoLibraryRef.current.some(v => v.name === f.name));
    if (fresh.length === 0) { showToast('Already in your library'); return; }
    if (group) dlGroupsRef.current.set(group.id, { name: group.name, libIds: [], total: fresh.length });

    try {
      const started = await engine.download(link, fresh.map(f => f.index), dir);
      setDownloads(prev => [
        ...started.map((s, i) => ({
          id: s.id, libId: genId(), name: s.name, link, index: fresh[i].index, dest: s.dest,
          bytes: 0, total: s.size, speed: 0, eta: null,
          status: 'downloading' as const, group: group?.id,
        })),
        ...prev,
      ]);
    } catch (e: any) {
      showToast(e?.message || String(e));
    }
  }, [showToast]);

  /** Point the player at a share and stream it. Nothing is written to disk. */
  const watchOnline = useCallback((link: string, files: { index: number; name: string }[]) => {
    if (files.length === 0) return;
    // Unload whatever mpv still has open first. A streamed item has no URL for
    // the moment it takes the session to open, and mpv keeps reporting the old
    // file's duration in that gap — so you'd see the previous video's timeline
    // sitting under a black frame.
    stopEngine();
    setPlaylist(files.map(f => ({
      id: genId(), src: '', path: '', name: f.name, stream: { link, index: f.index },
    })));
    setCurrentIndex(0);
    currentIndexRef.current = 0;
    setShowLibrary(false);
    setShouldAutoPlay(true);
  }, [stopEngine]);

  // A streamed queue holds descriptors, not URLs. The session for an item is
  // opened when you actually reach it: opening all of them up front would mean
  // one prefetching buffer per file in the share, which for a season of a show
  // is how you run the machine out of memory doing nothing.
  useEffect(() => {
    const item = playlist[currentIndex];
    if (!item?.stream || item.path) return;
    let dropped = false;
    (async () => {
      try {
        const h = await engine.watch(item.stream!.link, item.stream!.index);
        if (dropped) { engine.stopWatch(h.id).catch(() => {}); return; }
        // The size comes back with the handle and is the only place a save can
        // learn what "finished" means — stream stats report bytes, not a total.
        setPlaylist(prev => prev.map(p => (p.id === item.id
          ? { ...p, src: h.url, path: h.url, stream: { ...p.stream!, sessionId: h.id, size: h.size } }
          : p)));
      } catch (e: any) {
        if (dropped) return;
        // Nothing to play and nothing to wait for: drop the item so the queue
        // moves on instead of sitting on "Opening stream…" forever.
        showToast(e?.message || `Couldn’t open “${item.name}”`);
        setCurrentIndex(i => Math.max(0, Math.min(i, playlistRef.current.length - 2)));
        setPlaylist(prev => prev.filter(p => p.id !== item.id));
      }
    })();
    return () => { dropped = true; };
  }, [playlist, currentIndex, showToast]);

  /**
   * A transfer landed on disk: into the library, out of "in progress", and any
   * copy still streaming hands over to the local file. Same libId, so the resume
   * position carries across and it seeks back to where you were.
   */
  const completeTransfer = useCallback(async (row: DlItem, dest: string, verified: boolean) => {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const meta: VideoMeta = { id: row.libId, name: row.name, path: dest, size: 0, addedAt: Date.now(), type: typeFromPath(row.name) };
    try { await videoStore.save({ ...meta }); } catch {}
    setVideoLibrary(prev => prev.some(v => v.name === row.name) ? prev : [meta, ...prev]);
    enqueueMetaExtraction([{ path: dest, id: row.libId }]);
    setDownloads(prev => prev.map(d => (d.id === row.id
      ? { ...d, bytes: d.total || d.bytes, dest, status: 'done', speed: 0, streamId: undefined, verified }
      : d)));
    // Hand a copy that's still streaming over to the finished local file — but
    // only for a real download. A save was fed by the buffer of the very video
    // you're watching, so swapping the source would reload mpv mid-playback to
    // show you the identical bytes.
    if (!row.streamId) {
      setPlaylist(prev => prev.map(it => (it.stream && it.name === row.name
        ? { ...it, src: convertFileSrc(dest), path: dest, id: row.libId, stream: undefined }
        : it)));
    }

    // Folder group: once every part is in, offer to import them as a folder.
    if (!row.group) { showToast(`Saved “${row.name}”`); return; }
    const g = dlGroupsRef.current.get(row.group);
    if (!g) return;
    g.libIds.push(row.libId);
    if (g.libIds.length < g.total) return;
    const ids = [...g.libIds]; const gname = g.name;
    dlGroupsRef.current.delete(row.group);
    showToast(`Saved “${gname}” (${ids.length} files)`, {
      label: 'Import as folder',
      run: async () => {
        const { folderStore } = await import('./utils');
        folderStore.save({ id: genId(), name: gname, videoIds: ids, createdAt: Date.now() });
        setVideoLibrary(prev => [...prev]);
        showToast(`Imported folder “${gname}”`);
      },
    });
  }, [enqueueMetaExtraction, showToast]);

  // A save reports bytes written, not throughput, so its speed is sampled here
  // from consecutive stream-stats ticks (one every 500ms).
  const saveSpeedRef = useRef<Map<string, { t: number; b: number }>>(new Map());
  // Guards against a second stats tick firing a settle that's already in flight.
  const settlingRef = useRef<Set<string>>(new Set());

  /**
   * Close the save tap on a stream. If watching covered the whole file it is
   * already complete; otherwise the engine hands back a resumable transfer and
   * fetches only the parts playback never reached — which is the entire point of
   * saving out of the buffer rather than re-downloading.
   */
  const settleSave = useCallback(async (streamId: string) => {
    const row = downloadsRef.current.find(d => d.streamId === streamId);
    if (!row || settlingRef.current.has(streamId)) return;
    settlingRef.current.add(streamId);
    saveSpeedRef.current.delete(streamId);
    try {
      const outcome = await engine.stopSaving(streamId);
      if (outcome.outcome === 'completed') {
        await completeTransfer(row, outcome.path, false);
      } else if (outcome.outcome === 'resumable') {
        setDownloads(prev => prev.map(d => (d.id === row.id
          ? { ...d, status: 'downloading', streamId: undefined } : d)));
        await engine.finishSave(row.id); // reports as an ordinary download from here
      } else {
        setDownloads(prev => prev.filter(d => d.id !== row.id));
      }
    } catch {
      setDownloads(prev => prev.map(d => (d.id === row.id ? { ...d, status: 'error', streamId: undefined } : d)));
    } finally {
      settlingRef.current.delete(streamId);
    }
  }, [completeTransfer]);

  // Free the buffer of a stream you have moved away from — another item in the
  // queue, a downloaded copy taking over, or the player being closed. A save in
  // progress is settled first: the session has to still exist to be asked.
  const liveStreamRef = useRef<string | null>(null);
  useEffect(() => {
    const id = playlist[currentIndex]?.stream?.sessionId ?? null;
    const previous = liveStreamRef.current;
    liveStreamRef.current = id;
    if (!previous || previous === id) return;
    settleSave(previous).finally(() => { engine.stopWatch(previous).catch(() => {}); });
  }, [playlist, currentIndex, settleSave]);

  /** Where downloads go: the folder from Settings, or ask (defaulting to Downloads). */
  const resolveDownloadDir = useCallback(async (): Promise<string | null> => {
    const custom = settingsRef.current.downloadPath;
    if (custom && custom.trim()) return custom;
    const def = await engine.downloadDir();
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, title: 'Save video to…', defaultPath: def });
      if (picked === null) return null; // cancelled
      return typeof picked === 'string' ? picked : def;
    } catch {
      return def;
    }
  }, []);

  /**
   * Keep the video that's streaming right now. A live session saves out of its
   * own buffer, so the hour you have already watched is written to disk rather
   * than fetched again — and playback isn't interrupted either way.
   */
  const downloadCurrentStream = useCallback(async () => {
    const cur = playlistRef.current[currentIndexRef.current];
    if (!cur?.stream) return;
    const dir = await resolveDownloadDir();
    if (!dir) return;
    try {
      const id = cur.stream.sessionId
        ? await engine.saveStream(cur.stream.sessionId, dir)
        : (await engine.download(cur.stream.link, [cur.stream.index], dir))[0]?.id;
      if (!id) return;
      const streamId = cur.stream.sessionId;
      if (streamId) saveSpeedRef.current.set(streamId, { t: Date.now(), b: 0 });
      setDownloads(prev => prev.some(d => d.id === id) ? prev : [{
        id, libId: cur.id, name: cur.name, link: cur.stream!.link, index: cur.stream!.index,
        dest: '', bytes: 0, total: cur.stream!.size ?? 0, speed: 0, eta: null,
        streamId, status: (streamId ? 'saving' : 'downloading') as DlItem['status'],
      }, ...prev]);
      showToast(streamId ? `Keeping “${cur.name}” as you watch` : `Saving “${cur.name}”`);
    } catch (e: any) {
      showToast(e?.message || String(e));
    }
  }, [resolveDownloadDir, showToast]);

  /** Play a download from the panel — the finished file, or its source while it runs. */
  const playDownload = useCallback(async (d: DlItem) => {
    if (d.status === 'done') {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      setPlaylist([{ id: d.libId, src: convertFileSrc(d.dest), path: d.dest, name: d.name }]);
    } else {
      // The .partial isn't playable, but the source it came from is — and it
      // streams out of the same range-serving URL the download is using.
      stopEngine(); // don't leave the last file's timeline showing while it opens
      setPlaylist([{ id: d.libId, src: '', path: '', name: d.name, stream: { link: d.link, index: d.index } }]);
    }
    setCurrentIndex(0);
    currentIndexRef.current = 0;
    setShowLibrary(false);
    setShouldAutoPlay(true);
  }, [stopEngine]);

  // Transfers outlive the app: the chunk map is on disk, so a download the user
  // quit on comes back as a resumable row instead of silently disappearing.
  useEffect(() => {
    engine.transfers().then(rows => {
      const open = rows.filter(r => r.state !== 'completed' && r.state !== 'cancelled');
      if (open.length === 0) return;
      setDownloads(prev => [
        ...open
          .filter(r => !prev.some(d => d.id === r.id))
          .map(r => ({
            id: r.id, libId: genId(), name: r.name, link: r.url, index: 0, dest: r.dest,
            bytes: r.chunksTotal ? Math.round((r.chunksDone / r.chunksTotal) * r.total) : 0,
            total: r.total, speed: 0, eta: null,
            status: (r.state === 'running' ? 'downloading' : r.state === 'failed' ? 'error' : 'paused') as DlItem['status'],
          })),
        ...prev,
      ]);
    }).catch(() => {});
  }, []);

  // One listener drives every transfer and every open stream. The engine reports
  // measured throughput and ETA, so nothing here has to sample or guess.
  useEffect(() => {
    let un = () => {};
    (async () => {
      un = await engine.onEngineEvent(async (ev) => {
        if (ev.kind === 'downloadProgress') {
          setDownloads(prev => prev.map(d => (d.id === ev.id
            ? { ...d, bytes: ev.transferred, total: ev.total || d.total, speed: ev.speedBps, eta: ev.etaSecs, status: 'downloading' }
            : d)));
          return;
        }
        // A save tap writes out of the playback buffer, so its progress arrives
        // on the stream's own stats rather than as a download — and as a byte
        // count, so throughput has to be sampled here.
        if (ev.kind === 'streamStats') {
          // Also the only window into a stream that isn't playing: if these keep
          // climbing while the picture stays black, the engine is delivering and
          // the player is what's stuck — and the other way round.
          setStreamStats({ id: ev.id, buffered: ev.bufferedAhead, cached: ev.cachedBytes, fetches: ev.fetches });
          if (!ev.saving) return;
          const mark = saveSpeedRef.current.get(ev.id);
          const now = Date.now();
          let speed: number | null = null;
          if (mark && now > mark.t) {
            const dt = (now - mark.t) / 1000;
            if (dt >= 0.4) {
              speed = Math.max(0, (ev.savedBytes - mark.b) / dt);
              saveSpeedRef.current.set(ev.id, { t: now, b: ev.savedBytes });
            }
          } else if (!mark) {
            saveSpeedRef.current.set(ev.id, { t: now, b: ev.savedBytes });
          }
          setDownloads(prev => prev.map(d => (d.streamId === ev.id
            ? { ...d, bytes: ev.savedBytes, status: 'saving', speed: speed ?? d.speed }
            : d)));

          // Everything is on disk. Close the tap now rather than waiting for the
          // user to leave the video — otherwise a file that finished saving in
          // ten seconds sits at "keeping" until they navigate away.
          const row = downloadsRef.current.find(d => d.streamId === ev.id);
          if (row && row.total > 0 && ev.savedBytes >= row.total) void settleSave(ev.id);
          return;
        }
        if (ev.kind !== 'downloadState') return;

        // A loopback transfer can finish before the row tracking it has landed
        // in state. Give the row a moment to appear rather than dropping the
        // completion, which would strand it at "downloading" forever.
        let item = downloadsRef.current.find(d => d.id === ev.id);
        if (!item) {
          await new Promise(r => setTimeout(r, 400));
          item = downloadsRef.current.find(d => d.id === ev.id);
          if (!item) return;
        }

        if (ev.state === 'paused') {
          setDownloads(prev => prev.map(d => (d.id === ev.id ? { ...d, status: 'paused', speed: 0 } : d)));
          return;
        }
        if (ev.state === 'failed') {
          setDownloads(prev => prev.map(d => (d.id === ev.id ? { ...d, status: 'error', speed: 0 } : d)));
          showToast(`Couldn’t download “${item.name}”${ev.error ? ': ' + ev.error : ''}`);
          return;
        }
        if (ev.state === 'cancelled') {
          setDownloads(prev => prev.filter(d => d.id !== ev.id));
          return;
        }
        if (ev.state !== 'completed') return; // queued / running / verifying

        await completeTransfer(item, ev.path || item.dest, ev.verification === 'verified');
      });
    })();
    return () => un();
  }, [completeTransfer, settleSave, showToast]);

  // Download controls (per item). The engine is the source of truth for state —
  // these only ask, and the event above is what actually moves the row.
  const pauseDownload = useCallback(async (id: string) => {
    const row = downloadsRef.current.find(d => d.id === id);
    if (row?.streamId) {
      // Pausing a save just closes the tap. What it wrote is kept, and the
      // record it leaves behind is an ordinary paused transfer from then on —
      // so Resume fetches the rest over HTTP instead of via playback.
      setDownloads(prev => prev.map(d => (d.id === id
        ? { ...d, status: 'paused', speed: 0, streamId: undefined } : d)));
      await engine.stopSaving(row.streamId).catch(() => {});
      return;
    }
    engine.pause(id).catch(() => {});
  }, []);
  const resumeDownload = useCallback((id: string) => {
    setDownloads(prev => prev.map(d => (d.id === id ? { ...d, status: 'downloading' } : d)));
    engine.resume(id).catch(() => {
      setDownloads(prev => prev.map(d => (d.id === id ? { ...d, status: 'error' } : d)));
    });
  }, []);
  const cancelDownload = useCallback(async (id: string) => {
    const row = downloadsRef.current.find(d => d.id === id);
    setDownloads(prev => prev.filter(d => d.id !== id));
    // A save has to let go of the partial file before the transfer behind it can
    // be thrown away, so the tap is closed first and only then cancelled.
    if (row?.streamId) await engine.stopSaving(row.streamId).catch(() => {});
    engine.cancel(id).catch(() => {});
  }, []);
  const dismissDownload = useCallback((id: string) => {
    setDownloads(prev => prev.filter(d => d.id !== id));
  }, []);

  // Share a whole folder (its videos) via the share modal.
  const handleShareFolder = useCallback((videoIds: string[], name: string) => {
    const files = videoIds
      .map(id => videoLibrary.find(v => v.id === id))
      .filter((v): v is VideoMeta => !!v)
      .map(v => ({ path: v.path, name: v.name }));
    if (files.length === 0) return;
    setShareTarget(null); setShareInitialLink(null);
    setFolderTarget({ files, name });
    setShareOpen(true);
  }, [videoLibrary]);

  // Append a video to the play queue without interrupting what's playing.
  const addToQueue = useCallback(async (video: VideoMeta) => {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const item: PlaylistItem = { id: video.id, src: convertFileSrc(video.path), path: video.path, name: video.name, thumbnail: video.thumbnail };
    // Decide from the live queue and then apply. React may invoke a state updater
    // more than once, so setCurrentIndex/showToast must not live inside one —
    // appending must never disturb the position you're already playing from.
    const prev = playlistRef.current;
    if (prev.some(p => p.id === video.id)) { showToast('Already in queue'); return; }
    if (prev.length === 0) {
      playlistRef.current = [item];
      currentIndexRef.current = 0;
      setPlaylist([item]);
      setCurrentIndex(0);
      setShouldAutoPlay(true);
      showToast(`Playing “${video.name}”`);
      return;
    }
    const next = [...prev, item];
    playlistRef.current = next;
    setPlaylist(next);
    showToast(`Added to queue (${next.length})`);
  }, [showToast]);

  // Save an explicit set of video IDs as a named folder (WebView2 lacks
  // window.prompt, so we use a default name the user can rename in Folders).
  const saveIdsAsFolder = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const { folderStore } = await import('./utils');
    const name = `Queue ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    folderStore.save({ id: genId(), name, videoIds: ids, createdAt: Date.now() });
    setVideoLibrary(prev => [...prev]); // nudge folders re-render
    showToast(`Saved “${name}” — rename it in Folders`);
  }, [showToast]);
  const saveIdsAsFolderRef = useRef(saveIdsAsFolder);
  useEffect(() => { saveIdsAsFolderRef.current = saveIdsAsFolder; }, [saveIdsAsFolder]);

  // Bookmark the queue straight from the queue panel, under a name the user typed.
  // We remember WHICH videos were saved (membership, not order) so the panel stops
  // offering to save the same queue over and over — adding or removing one brings
  // the offer back, reordering doesn't.
  const [savedQueueSig, setSavedQueueSig] = useState<string | null>(null);
  // Set when the queue was launched straight from a library folder; while the
  // queue still matches it, there is nothing worth bookmarking.
  const [queueOriginSig, setQueueOriginSig] = useState<string | null>(null);
  const queueSignature = useMemo(
    () => playlist.map(p => p.id).sort().join('|'),
    [playlist],
  );
  const queueSaved = savedQueueSig !== null && savedQueueSig === queueSignature;
  const queueIsUntouchedFolder = queueOriginSig !== null && queueOriginSig === queueSignature;

  const saveQueueAsFolder = useCallback(async (name: string) => {
    const ids = playlist.map(p => p.id);
    if (ids.length === 0) return;
    const { folderStore } = await import('./utils');
    const folderName = name.trim() || 'Untitled queue';
    folderStore.save({ id: genId(), name: folderName, videoIds: ids, createdAt: Date.now() });
    setVideoLibrary(prev => [...prev]); // nudge folders re-render
    setSavedQueueSig([...ids].sort().join('|'));
    showToast(`Saved “${folderName}” to Folders`, {
      label: 'Open',
      run: () => { setShowLibrary(true); },
    });
  }, [playlist, showToast]);

  // Play an entire folder/playlist, optionally starting at a specific index
  const playFolder = useCallback(async (videoIds: string[], shuffle: boolean, loop: boolean, startIndex = 0, folderId?: string) => {
    if (videoIds.length === 0) return;
    // Remember which folder this queue is, so the bookmark has somewhere to go.
    // Carrying the membership along means a later save can check the video still
    // belongs here, without having to clear this on every other playback path.
    activeFolderRef.current = folderId ? { id: folderId, ids: [...videoIds] } : null;
    setIsPlaylistLooping(loop);
    // This queue IS a library folder — there's nothing to bookmark until the
    // user adds something to it. (Membership, so shuffling doesn't count.)
    setQueueOriginSig([...videoIds].sort().join('|'));

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
        items.push({ id, src: convertFileSrc(meta.path), path: meta.path, name: meta.name, thumbnail: meta.thumbnail });
      }
    }
    if (items.length > 0) {
      setPlaylist(items);
      // On shuffle the start position is meaningless; otherwise honour the request.
      // `startIndex` counts into the FOLDER, while the queue skips ids the library
      // no longer has — so translate through the id, or a folder with a missing
      // entry starts on the wrong video (and a resume lands on the wrong one).
      const wantedId = videoIds[startIndex];
      const resolved = wantedId ? items.findIndex(i => i.id === wantedId) : -1;
      setCurrentIndex(shuffle ? 0 : (resolved >= 0 ? resolved : Math.min(startIndex, items.length - 1)));
      setShouldAutoPlay(true);
      setShowLibrary(false);
    }
  }, [videoLibrary]);

  /**
   * "Resume playlist": open the folder at the video it was left on and carry on
   * from that exact spot. Never shuffled — resuming means continuing the order
   * you were in, and the rest of the folder plays on from there.
   */
  const resumeFolder = useCallback(async (folderId: string, videoIds: string[], loop: boolean) => {
    const mark = folderProgressStore.get(folderId, videoIds);
    if (!mark) return;
    const index = videoIds.indexOf(mark.videoId);
    if (index < 0) return;
    // Right at the end there's nothing left to resume — start that video over
    // rather than opening it on its last moments (which just hits the end).
    const time = mark.duration > 0 && mark.time >= mark.duration - 1 ? 0 : mark.time;
    setFolderStartAt(time > 0 ? { videoId: mark.videoId, time } : null);
    await playFolder(videoIds, false, loop, index, folderId);
  }, [playFolder]);

  const deleteFromLibrary = useCallback(async (id: string) => {
    await videoStore.delete(id);
    setVideoLibrary(prev => prev.filter(v => v.id !== id));
  }, []);

  // ---------------------------------------------------------------------------
  // Library open/close (pause/resume video)
  // ---------------------------------------------------------------------------
  // Whether closing the library should start playback again. Kept in its own ref
  // because the flag this used to read (`shouldAutoPlay`) also mirrors every live
  // play-state change — mpv's echo of the pause below overwrote it within a tick, so
  // the resume decision ended up reading "it was paused" every single time.
  const resumeAfterLibraryRef = useRef(false);

  const openLibrary = useCallback(() => {
    const el = videoElRef.current;
    if (el) {
      resumeAfterLibraryRef.current = !el.paused;
      // Pause unconditionally. `el.paused` reports mpv's last echoed state, which
      // lags a beat behind a just-issued play/pause — gating the pause on it let the
      // video (and its audio) keep running behind the library.
      el.pause();
    }
    setShowLibrary(true);
  }, []);

  const closeLibrary = useCallback(() => {
    setShowLibrary(false);
    const el = videoElRef.current;
    if (el && resumeAfterLibraryRef.current) el.play().catch(() => {});
    resumeAfterLibraryRef.current = false;
  }, []);

  // ---------------------------------------------------------------------------
  // Playlist navigation
  // ---------------------------------------------------------------------------
  useEffect(() => {
    playlistRef.current = playlist;
    currentIndexRef.current = currentIndex;
    isPlaylistLoopingRef.current = isPlaylistLooping;
  });

  // Safety net: never leave the index pointing past the end of the queue (a
  // removal, or any future advance bug, would otherwise render an undefined item).
  useEffect(() => {
    if (playlist.length > 0 && currentIndex > playlist.length - 1) {
      setCurrentIndex(playlist.length - 1);
    }
  }, [playlist.length, currentIndex]);

  // These are driven from the player's end-of-file callback, which holds them in
  // a ref — so they must never depend on values captured at render time. Reading
  // the queue and position from refs (and writing the position back immediately)
  // means two calls in the same tick can't both pass a stale bounds check and
  // advance twice, and the index can never run past the end of the queue.
  const playNext = useCallback(() => {
    isFullscreenRef.current = !!document.fullscreenElement;
    const len = playlistRef.current.length;
    const cur = currentIndexRef.current;
    let next: number | null = null;
    if (cur < len - 1) next = cur + 1;
    else if (isPlaylistLoopingRef.current && len > 0) next = 0;
    if (next === null) return;
    currentIndexRef.current = next;
    setCurrentIndex(next);
    setShouldAutoPlay(true);
  }, []);

  const playPrev = useCallback(() => {
    isFullscreenRef.current = !!document.fullscreenElement;
    const cur = currentIndexRef.current;
    if (cur <= 0) return;
    currentIndexRef.current = cur - 1;
    setCurrentIndex(cur - 1);
    setShouldAutoPlay(true);
  }, []);

  const jumpTo = useCallback((index: number) => {
    isFullscreenRef.current = !!document.fullscreenElement;
    if (index < 0 || index >= playlistRef.current.length) return;
    currentIndexRef.current = index;
    setCurrentIndex(index);
    setShouldAutoPlay(true);
  }, []);

  const handleReorderPlaylist = useCallback((reordered: { id: string; name: string; thumbnail?: string }[]) => {
    const currentId = playlist[currentIndex]?.id;
    const newPlaylist = reordered
      .map(item => playlist.find(p => p.id === item.id))
      // Not `p.src`: a streamed item has no URL until its session opens.
      .filter((p): p is PlaylistItem => !!p);
    setPlaylist(newPlaylist);
    const newIdx = newPlaylist.findIndex(p => p.id === currentId);
    if (newIdx >= 0) setCurrentIndex(newIdx);
  }, [playlist, currentIndex]);

  // Reorder the in-memory library too: promoteToTop saves its order from this
  // list, so leaving it stale undid a drag the next time any video was opened.
  const handleReorderVideos = useCallback((orderedIds: string[]) => {
    videoOrderStore.setOrder(orderedIds);
    const next = applyVideoOrder(videoLibraryRef.current, orderedIds);
    videoLibraryRef.current = next;
    setVideoLibrary(next);
  }, []);

  const handleVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
  }, []);

  const handleGoHome = useCallback(() => {
    // Stop the native mpv engine (saving resume position first) — otherwise the file
    // keeps playing audibly after the player UI is gone, since mpv is a separate
    // process behind the WebView.
    stopEngine();
    setPlaylist([]);
    setCurrentIndex(0);
    setShowLibrary(false);
    setError(null);
  }, [stopEngine]);

  // A hard refresh (F5 / Ctrl+R / Ctrl+Shift+R) reloads the WebView and resets the
  // UI to the home screen, but the native mpv process survives and keeps playing —
  // you hear audio with no visible player. Intercept those shortcuts and do a clean
  // in-app reset (save position + stop mpv + go home) instead of a raw reload.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isRefresh =
        e.key === 'F5' ||
        ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'));
      if (!isRefresh) return;
      e.preventDefault();
      handleGoHome();
    };
    // Capture phase so we run before the player's own key handlers.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleGoHome]);

  // ---------------------------------------------------------------------------
  // Fullscreen escape hatch for the home screen.
  //
  // f / Esc / double-click all live inside VideoPlayer, so going home while
  // fullscreen unmounts every way out and traps the window — there's no title
  // bar to reach either. These handlers take over exactly when the player isn't
  // mounted, so they can never double-toggle against the player's own.
  // ---------------------------------------------------------------------------
  const setWindowFullscreen = useCallback(async (next: boolean | 'toggle') => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const isFs = await win.isFullscreen();
      const target = next === 'toggle' ? !isFs : next;
      if (target !== isFs) await win.setFullscreen(target);
      isFullscreenRef.current = target;
    } catch {}
  }, []);

  useEffect(() => {
    if (playlist.length > 0) return; // the player owns these keys while mounted
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.key === 'Escape') {
        setWindowFullscreen(false);
      } else if (actionFor(e) === 'fullscreen') {
        e.preventDefault();
        setWindowFullscreen('toggle');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playlist.length, setWindowFullscreen]);

  // Double-click anywhere on the home screen toggles fullscreen, matching the
  // player. WebView2 reports e.detail as 1 even on the second click, so the two
  // clicks are timed rather than counted (same approach as VideoPlayer).
  const lastHomeClickRef = useRef(0);
  const handleHomeClick = useCallback((e: React.MouseEvent) => {
    if (playlist.length > 0) return;
    // Only empty space toggles — double-clicking a button, card or field should
    // do what that control does, not resize the window out from under it.
    const el = e.target as HTMLElement | null;
    if (el?.closest('button, a, input, select, textarea, label, [role="button"]')) return;
    const now = Date.now();
    if (now - lastHomeClickRef.current < 300) {
      lastHomeClickRef.current = 0;
      setWindowFullscreen('toggle');
    } else {
      lastHomeClickRef.current = now;
    }
  }, [playlist.length, setWindowFullscreen]);

  // Fallback: if the WebView reloads for any other reason, save the position and
  // dispatch a stop to the (still-running) mpv process on the way out so audio
  // never outlives the page.
  useEffect(() => {
    window.addEventListener('beforeunload', stopEngine);
    window.addEventListener('pagehide', stopEngine);
    return () => {
      window.removeEventListener('beforeunload', stopEngine);
      window.removeEventListener('pagehide', stopEngine);
    };
  }, [stopEngine]);

  // How far into the resume video the user got — drives the home-card progress bar.
  const resumePercent = lastVideo && lastVideo.duration
    ? Math.min(100, Math.max(0, ((loadVideoProgress(lastVideo.id) ?? 0) / lastVideo.duration) * 100))
    : 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  // The dialog's "Update Now": download + install, then relaunch into the new version.
  const handleInstallUpdate = installUpdate;

  const dismissUpdate = () => {
    setUpdateBanner(null);
    setUpdateStatus('idle');
    setUpdateProgress(0);
  };

  const isUpdating = updateStatus === 'downloading' || updateStatus === 'installing';

  return (
    <div
      className={`w-screen h-screen ${playlist.length > 0 ? 'bg-transparent' : 'bg-neutral-900'} text-white overflow-hidden flex flex-col font-sans`}
      onClick={handleHomeClick}
    >
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
        <div ref={playerWrapperRef} className="relative w-full h-full flex bg-transparent">
          <div className="relative flex-1 h-full bg-transparent">
            <VideoPlayer
              videoId={playlist[currentIndex].id}
              src={playlist[currentIndex].src}
              path={playlist[currentIndex].path}
              downloadProgress={(() => {
                const cur = playlist[currentIndex];
                const d = cur && downloads.find(x => x.status !== 'done' && (x.libId === cur.id || x.name === cur.name));
                return d ? { bytes: d.bytes, total: d.total } : null;
              })()}
              subtitlesSrc={playlist[currentIndex].subtitleSrc}
              autoPlay={shouldAutoPlay}
              isAudio={isAudioPath(playlist[currentIndex].name)}
              resumeEnabled={settings.resumePlayback}
              onProgress={markFolderProgress}
              startAt={folderStartAt}
              onStartAtUsed={() => setFolderStartAt(null)}
              defaultVolume={settings.defaultVolume}
              defaultSpeed={settings.defaultSpeed}
              pipAutoplayQueue={settings.pipAutoplayQueue}
              playlistLooping={isPlaylistLooping}
              onPlaylistLoopChange={setIsPlaylistLooping}
              onSaveQueue={queueIsUntouchedFolder ? undefined : saveQueueAsFolder}
              queueSaved={queueSaved}
              inputSuspended={showLibrary || showSettings}
              // Offered only while watching a stream that isn't already being
              // kept — "Watch online" saves nothing, this is how you keep it.
              onDownloadCurrent={(() => {
                const cur = playlist[currentIndex];
                if (!cur?.stream) return undefined;
                if (downloads.some(d => d.name === cur.name && d.status !== 'error')) return undefined;
                return downloadCurrentStream;
              })()}
              onShowInfo={() => {
                const cur = playlist[currentIndex];
                if (!cur) return;
                const lib = videoLibrary.find(v => v.id === cur.id || v.path === cur.path);
                setPropsTarget({
                  name: cur.name,
                  path: cur.stream ? cur.path : (lib?.path ?? cur.path),
                  size: lib?.size,
                  streaming: !!cur.stream,
                });
              }}
              onEnded={settings.autoplayNext ? playNext : undefined}
              onChangeVideo={openLibrary}
              onFileSelect={handleOpenFilesViaDialog}
              onPlayStateChange={playing => setShouldAutoPlay(playing)}
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
            {/* The gap between reaching a streamed item and its session being
                open, and then the gap before it has buffered anything. Usually a
                blink — but when a big file won't start, this is the difference
                between "the engine isn't delivering" and "the player is stuck",
                so it shows what the buffer is actually doing. */}
            {(() => {
              const cur = playlist[currentIndex];
              if (!cur?.stream) return null;
              // Never over another surface, and never while the user is simply
              // paused — a still picture then is what they asked for, not a stall.
              if (showLibrary || showSettings || mpvDiag.paused) return null;
              const live = cur.stream.sessionId && streamStats?.id === cur.stream.sessionId
                ? streamStats : null;
              // Only hide it once the picture is genuinely moving. A file that
              // opened but sits at 0:00 is exactly the case worth explaining.
              if (cur.path && live && live.buffered > 0 && mpvDiag.moving) return null;
              const mb = (b: number) => `${(b / (1024 * 1024)).toFixed(1)} MB`;
              return (
                <div className="absolute inset-0 z-[200] flex items-center justify-center pointer-events-none">
                  <div className="flex flex-col items-center gap-1.5 rounded-xl bg-black/75 px-5 py-3">
                    <div className="flex items-center gap-2.5 text-sm text-neutral-100">
                      <RefreshCw size={15} className="animate-spin text-red-400" />
                      {!cur.path ? 'Opening stream…' : 'Buffering…'}
                    </div>
                    {live && (
                      <div className="text-[11px] text-neutral-400 tabular-nums">
                        {mb(live.buffered)} ahead · {mb(live.cached)} held · {live.fetches} fetched
                      </div>
                    )}
                    {/* Which side is struggling: the transfer, or the decoder. */}
                    <div className="text-[11px] text-neutral-500 tabular-nums">
                      {mpvDiag.codec ?? '—'} · hwdec {mpvDiag.hwdec ?? '—'}
                      {mpvDiag.cacheAhead != null && ` · ${mpvDiag.cacheAhead.toFixed(1)}s demuxed`}
                      {!!mpvDiag.dropped && ` · ${mpvDiag.dropped} dropped`}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          {showLibrary && (
            <VideoLibrary
              videos={videoLibrary}
              onPlayVideo={playFromLibrary}
              onDeleteVideo={deleteFromLibrary}
              onShareVideo={shareVideo}
              onShareFolder={handleShareFolder}
              onAddToQueue={addToQueue}
              onGoHome={handleGoHome}
              onClose={closeLibrary}
              onAddVideos={handleAddFilesViaDialog}
              onReorderVideos={handleReorderVideos}
              onPlayFolder={playFolder}
              onResumeFolder={resumeFolder}
              onAddToFolder={handleAddToFolder}
              onAddFolderFromPC={handleAddFolderFromPC}
              defaultView={settings.defaultView}
              onOpenSettings={() => setShowSettings(true)}
            />
          )}
        </div>
      ) : (
        /* Home Screen */
        <div className="relative flex-1 flex flex-col items-center justify-center p-4 sm:p-6 bg-neutral-900 overflow-y-auto custom-scrollbar">
          {/* Settings */}
          <button
            onClick={() => setShowSettings(true)}
            className="absolute top-4 right-4 z-20 p-2.5 rounded-full bg-neutral-800/70 hover:bg-neutral-700 text-neutral-400 hover:text-white ring-1 ring-white/5 transition-all active:scale-95"
            title="Settings"
          >
            <Settings size={20} />
          </button>
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
            {settings.rememberLastVideo && lastVideo && (
              <div className="mb-6">
                <p className="flex items-center gap-1.5 text-[11px] font-semibold text-neutral-500 uppercase tracking-[0.15em] mb-2.5">
                  <span className="w-1 h-1 rounded-full bg-red-500" /> Resume Watching
                </p>
                <button
                  onClick={() => playFromLibrary(lastVideo)}
                  className="w-full group flex items-center gap-4 p-3 rounded-2xl bg-neutral-800/60 ring-1 ring-white/5 hover:bg-neutral-800 hover:ring-red-500/30 transition-all duration-300"
                >
                  <div className="relative w-28 h-[68px] flex-shrink-0 rounded-xl overflow-hidden bg-neutral-700">
                    {isUsableThumbnail(lastVideo.thumbnail) ? (
                      <img src={lastVideo.thumbnail} alt={lastVideo.name} className="w-full h-full object-cover" />
                    ) : isAudioPath(lastVideo.path || lastVideo.name) ? (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-red-950/70 via-neutral-900 to-neutral-950">
                        <Music size={18} className="text-red-300/80" />
                      </div>
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

            {/* Open a shared link (receive) */}
            <button
              onClick={openReceive}
              className="flex items-center justify-center gap-2 w-full mt-3 px-4 py-3.5 rounded-2xl font-medium text-sm text-neutral-200 bg-neutral-800/80 hover:bg-neutral-700 ring-1 ring-white/5 transition-all active:scale-[0.98]"
            >
              <Share2 size={18} />
              <span>Share &amp; Receive</span>
            </button>

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

            {/* Check for updates */}
            <div className="mt-6 flex flex-col items-center gap-1">
              <button
                onClick={() => runUpdateCheck(true)}
                disabled={manualCheck === 'checking'}
                className="flex items-center gap-2 text-xs font-medium text-neutral-400 hover:text-white transition-colors disabled:opacity-60"
              >
                <RefreshCw size={13} className={manualCheck === 'checking' ? 'animate-spin' : ''} />
                {manualCheck === 'checking'
                  ? 'Checking for updates…'
                  : manualCheck === 'uptodate'
                    ? "You're on the latest version"
                    : manualCheck === 'error'
                      ? "Couldn't check — tap to retry"
                      : 'Check for updates'}
              </button>
              {appVersion && <span className="text-[11px] text-neutral-600">PREV Player v{appVersion}</span>}
            </div>
          </div>
        </div>
      )}

      {/* Library Modal (from home screen) */}
      {showLibrary && playlist.length === 0 && (
        <VideoLibrary
          videos={videoLibrary}
          onPlayVideo={playFromLibrary}
          onDeleteVideo={deleteFromLibrary}
          onShareVideo={shareVideo}
          onShareFolder={handleShareFolder}
          onAddToQueue={addToQueue}
          onGoHome={handleGoHome}
          onClose={closeLibrary}
          onAddVideos={handleAddFilesViaDialog}
          onReorderVideos={handleReorderVideos}
          onPlayFolder={playFolder}
          onResumeFolder={resumeFolder}
          onAddToFolder={handleAddToFolder}
          onAddFolderFromPC={handleAddFolderFromPC}
          defaultView={settings.defaultView}
          onOpenSettings={() => setShowSettings(true)}
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

      {/* Toast (queue / save-as-folder / share confirmations) */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[280] flex items-center gap-3 bg-neutral-900/95 border border-neutral-700 rounded-full pl-4 pr-2 py-2 shadow-xl shadow-black/50 animate-[fadeIn_0.15s_ease]">
          <span className="text-sm text-neutral-200 whitespace-nowrap">{toast.msg}</span>
          {toast.action && (
            <button
              onClick={() => { toast.action!.run(); setToast(null); }}
              className="text-xs font-semibold text-white bg-gradient-to-r from-red-600 to-purple-600 hover:from-red-500 hover:to-purple-500 rounded-full px-3 py-1.5 transition-colors"
            >
              {toast.action.label}
            </button>
          )}
          <button onClick={() => setToast(null)} className="p-1 text-neutral-500 hover:text-white"><span className="text-lg leading-none">×</span></button>
        </div>
      )}

      {/* Share / receive modal */}
      <ShareModal
        open={shareOpen}
        onClose={() => { setShareOpen(false); setShareInitialLink(null); }}
        shareTarget={shareTarget}
        folderTarget={folderTarget}
        initialLink={shareInitialLink}
        onWatchOnline={watchOnline}
        onDownload={startDownloads}
        hasInLibrary={hasInLibrary}
        onOpenByName={openByName}
      />

      {/* Persistent parallel-download panel — visible on home, library and player */}
      <DownloadsPanel
        downloads={downloads}
        onPause={pauseDownload}
        onResume={resumeDownload}
        onCancel={cancelDownload}
        onDismiss={dismissDownload}
        onPlay={playDownload}
        onShowInfo={(d) => setPropsTarget({
          name: d.name,
          path: d.dest || d.link,
          size: d.total || undefined,
          // A finished row has a real file; anything else has only a source.
          streaming: d.status !== 'done' || !d.dest,
        })}
        currentPath={playlist[currentIndex]?.path ?? null}
        currentName={playlist[currentIndex]?.name ?? null}
      />

      {/* Properties — codec, resolution, frame rate, and where the file lives */}
      <PropertiesModal
        open={!!propsTarget}
        onClose={() => setPropsTarget(null)}
        target={propsTarget}
      />

      {/* Settings modal */}
      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onChange={updateSettings}
        appVersion={appVersion}
        updateState={manualCheck}
        onCheckUpdates={() => runUpdateCheck(true)}
      />
    </div>
  );
}

export default App;
