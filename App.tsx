import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, FileVideo, AlertCircle, List, X, Trash2, FolderOpen, History, Play, Library, FolderPlus } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import VideoLibrary from './components/VideoLibrary';
import { srtToVtt, extractVideoThumbnail, getVideoDuration, videoStore, VideoMeta, videoOrderStore } from './utils';

// Supported video extensions for folder scanning
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ogv', '.ogg',
  '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts', '.vob', '.mpg', '.mpeg',
]);

function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}

const genId = () => Math.random().toString(36).substr(2, 9);

interface PlaylistItem {
  id: string;
  src: string;       // blob URL for playback
  name: string;
  subtitleSrc?: string;
  file?: File;
  thumbnail?: string;
}

interface ResolvedFile {
  file: File;
  id: string;
  name: string;
  isNew: boolean;    // false = already in the library (skip re-saving)
}

const STORAGE_LAST_VIDEO = 'prevplayer_last_video';

function App() {
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [videoLibrary, setVideoLibrary] = useState<VideoMeta[]>([]);
  const [showLibrary, setShowLibrary] = useState(false);
  const [lastVideo, setLastVideo] = useState<VideoMeta | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState<number>(-1); // -1 = indeterminate, 0-100 = percentage
  const [wasPlayingBeforeLibrary, setWasPlayingBeforeLibrary] = useState(true);
  const [isPlaylistLooping, setIsPlaylistLooping] = useState(false);
  const isFullscreenRef = useRef(false);
  const playerWrapperRef = useRef<HTMLDivElement>(null);
  const videoPlayerRef = useRef<{ isPlaying: boolean }>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const homeFolderInputRef = useRef<HTMLInputElement>(null);

  // Load library from IndexedDB on mount
  useEffect(() => {
    const loadLibrary = async () => {
      let metas: VideoMeta[] = [];
      try {
        metas = await videoStore.getAllMeta();
        setVideoLibrary(metas);
      } catch (e) {
        console.log('Failed to load library from IndexedDB');
      }

      // Load last video metadata from localStorage (just metadata, not blob)
      const lastVid = localStorage.getItem(STORAGE_LAST_VIDEO);
      if (lastVid) {
        try {
          const last: VideoMeta = JSON.parse(lastVid);
          // Verify it still exists in IndexedDB
          if (metas.some(v => v.id === last.id)) {
            setLastVideo(last);
          } else {
            // Stale entry, clear it
            localStorage.removeItem(STORAGE_LAST_VIDEO);
          }
        } catch (e) {
          console.log('Failed to load last video');
          localStorage.removeItem(STORAGE_LAST_VIDEO);
        }
      }
    };

    loadLibrary();
  }, []);

  // Save last played video metadata
  useEffect(() => {
    if (playlist.length > 0 && playlist[currentIndex]) {
      const video = playlist[currentIndex];
      // Find in library
      const libraryEntry = videoLibrary.find(v => v.id === video.id);
      if (libraryEntry) {
        setLastVideo(libraryEntry);
        localStorage.setItem(STORAGE_LAST_VIDEO, JSON.stringify(libraryEntry));
      }
    }
  }, [playlist, currentIndex, videoLibrary]);

  // Resolve a batch of files against the library with a SINGLE metadata read for the
  // whole batch (not one read per file, which made Edge crawl). Returns a stable id +
  // display name for each file and flags which ones are new.
  const resolveFiles = useCallback(async (files: File[]): Promise<ResolvedFile[]> => {
    const metas = await videoStore.getAllMeta();
    const index = new Map<string, VideoMeta>();
    for (const m of metas) index.set(`${m.name}::${m.size}`, m);

    const seenInBatch = new Map<string, string>(); // name::size -> id, to dedupe duplicates within one selection
    return files.map(file => {
      const key = `${file.name}::${file.size}`;
      const found = index.get(key);
      if (found) return { file, id: found.id, name: found.name, isNew: false };
      const dupId = seenInBatch.get(key);
      if (dupId) return { file, id: dupId, name: file.name, isNew: false };
      const id = genId();
      seenInBatch.set(key, id);
      return { file, id, name: file.name, isNew: true };
    });
  }, []);

  // Show new videos in the library list immediately, before their blobs finish saving.
  const addOptimistic = useCallback((resolved: ResolvedFile[]) => {
    const newMetas: VideoMeta[] = resolved
      .filter(r => r.isNew)
      .map(r => ({ id: r.id, name: r.file.name, size: r.file.size, addedAt: Date.now(), type: r.file.type }));
    if (newMetas.length > 0) setVideoLibrary(prev => [...newMetas, ...prev]);
  }, []);

  // Extract thumbnail + duration OFF the critical path. Runs sequentially in the
  // background so a slow-to-decode file (common in Edge) never blocks the UI or the
  // progress overlay; thumbnails just fill in afterward.
  const metaQueueRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueMetaExtraction = useCallback((items: { file: File; id: string }[]) => {
    if (items.length === 0) return;
    metaQueueRef.current = metaQueueRef.current.then(async () => {
      for (const { file, id } of items) {
        const blobUrl = URL.createObjectURL(file);
        let thumbnail: string | undefined;
        let duration: number | undefined;
        try { thumbnail = await extractVideoThumbnail(blobUrl); } catch (e) {}
        try { duration = await getVideoDuration(blobUrl); } catch (e) {}
        URL.revokeObjectURL(blobUrl);
        if (thumbnail || duration) {
          try { await videoStore.updateMeta(id, { thumbnail, duration }); } catch (e) {}
          setVideoLibrary(prev => prev.map(v => v.id === id ? {
            ...v, ...(thumbnail ? { thumbnail } : {}), ...(duration ? { duration } : {}),
          } : v));
        }
      }
    });
  }, []);

  // Persist new files' blobs to IndexedDB while driving the circular progress ring,
  // then hand metadata extraction to the background queue. Existing files are a no-op
  // (no overlay), so re-adding a library video is instant.
  const persistNew = useCallback(async (resolved: ResolvedFile[]) => {
    const newOnes = resolved.filter(r => r.isNew);
    if (newOnes.length === 0) return;

    setIsLoading(true);
    setLoadingProgress(0);
    for (let i = 0; i < newOnes.length; i++) {
      const { file, id } = newOnes[i];
      try {
        await videoStore.save({
          id, name: file.name, blob: file,
          size: file.size, addedAt: Date.now(), type: file.type,
        });
      } catch (e) {
        console.error('Failed to save video to IndexedDB:', e);
      }
      setLoadingProgress(Math.round(((i + 1) / newOnes.length) * 100));
    }
    setIsLoading(false);
    setLoadingProgress(-1);

    enqueueMetaExtraction(newOnes.map(r => ({ file: r.file, id: r.id })));
  }, [enqueueMetaExtraction]);

  // Play video from library - gets blob URL from IndexedDB
  const playFromLibrary = useCallback(async (video: VideoMeta) => {
    // Capture the current playing state before switching videos
    const shouldAutoPlay = wasPlayingBeforeLibrary;
    setIsLoading(true);
    try {
      const blobUrl = await videoStore.getBlobUrl(video.id);
      if (!blobUrl) {
        setError('Video data not found. It may have been cleared from storage.');
        setIsLoading(false);
        return;
      }

      const playlistItem: PlaylistItem = {
        id: video.id,
        src: blobUrl,
        name: video.name,
      };

      setPlaylist([playlistItem]);
      setCurrentIndex(0);
      setShowLibrary(false);
      // Preserve the playing state — if video was paused before library opened, new video stays paused
      setWasPlayingBeforeLibrary(shouldAutoPlay);
    } catch (e) {
      setError('Failed to load video from library.');
    }
    setIsLoading(false);
  }, [wasPlayingBeforeLibrary]);

  // Delete from library (IndexedDB)
  const deleteFromLibrary = useCallback(async (id: string) => {
    await videoStore.delete(id);
    setVideoLibrary(prev => prev.filter(v => v.id !== id));
  }, []);

  // Handle file selection - add to library AND auto-play the selected videos.
  // INSTANT: plays immediately, then saves blobs (with the progress ring) and extracts metadata in the background.
  const handleFileSelect = async (files: FileList | File[]) => {
    const videoFiles = Array.from(files).filter(f => isVideoFile(f));
    if (videoFiles.length === 0) {
      setError("No playable video files found.");
      return;
    }
    setError(null);

    const resolved = await resolveFiles(videoFiles);

    // INSTANT: start playback straight from the in-memory File objects — no waiting on IndexedDB.
    setPlaylist(resolved.map(r => ({ id: r.id, src: URL.createObjectURL(r.file), name: r.name })));
    setCurrentIndex(0);
    setWasPlayingBeforeLibrary(true);

    // Show new videos in the library now, then persist + extract in the background.
    addOptimistic(resolved);
    await persistNew(resolved);
  };

  // Handle adding files to library only (no auto-play), used from the library panel.
  const handleAddToLibraryOnly = async (files: FileList | File[]) => {
    const videoFiles = Array.from(files).filter(f => isVideoFile(f));
    if (videoFiles.length === 0) {
      setError("No playable video files found.");
      return;
    }
    setError(null);

    const resolved = await resolveFiles(videoFiles);
    addOptimistic(resolved);
    await persistNew(resolved);
  };

  // Handle importing a whole folder from PC:
  // 1. Scans for video files  2. Adds them to library  3. Creates a folder entry with the real folder name
  const handleAddFolderFromPC = useCallback(async (files: FileList | File[]) => {
    const allFiles = Array.from(files);
    let videoFiles = allFiles.filter(f => isVideoFile(f));
    if (videoFiles.length === 0) {
      setError('No playable video files found in this folder.');
      return;
    }

    // Sort by filename to maintain consistent, predictable order (Fix #3)
    videoFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    // Extract the top-level folder name from webkitRelativePath (e.g. "MyVideos/clip.mp4" → "MyVideos")
    let folderName = 'Imported Folder';
    const firstPath = (allFiles[0] as any).webkitRelativePath as string | undefined;
    if (firstPath) {
      const parts = firstPath.split('/');
      if (parts.length >= 2) folderName = parts[0];
    }

    setError(null);

    const resolved = await resolveFiles(videoFiles);
    addOptimistic(resolved);

    // Create a folder with the real name and link every video (new or pre-existing), preserving order.
    const { folderStore } = await import('./utils');
    folderStore.save({ id: genId(), name: folderName, videoIds: resolved.map(r => r.id), createdAt: Date.now() });

    // Persist blobs (progress ring) + background metadata, then nudge state so the folder list refreshes.
    await persistNew(resolved);
    setVideoLibrary(prev => [...prev]);
  }, [resolveFiles, addOptimistic, persistNew]);

  // Pause video when library opens
  const openLibrary = useCallback(() => {
    // Capture the play state before pausing
    const videoEl = videoElRef.current;
    if (videoEl && !videoEl.paused) {
      setWasPlayingBeforeLibrary(true);
      videoEl.pause();
    }
    setShowLibrary(true);
  }, []);

  const closeLibrary = useCallback(() => {
    setShowLibrary(false);
    // Resume if was playing before
    const videoEl = videoElRef.current;
    if (videoEl && wasPlayingBeforeLibrary) {
      videoEl.play().catch(() => {});
    }
  }, [wasPlayingBeforeLibrary]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleFileSelect(e.target.files);
    }
  };

  const playNext = () => {
    isFullscreenRef.current = !!document.fullscreenElement;
    if (currentIndex < playlist.length - 1) {
      setCurrentIndex(prev => prev + 1);
      setWasPlayingBeforeLibrary(true);
    } else if (isPlaylistLooping && playlist.length > 0) {
      setCurrentIndex(0);
      setWasPlayingBeforeLibrary(true);
    }
  };

  const playPrev = () => {
    isFullscreenRef.current = !!document.fullscreenElement;
    if (currentIndex > 0) {
      setCurrentIndex(prev => prev - 1);
      setWasPlayingBeforeLibrary(true);
    }
  };

  const jumpTo = (index: number) => {
    isFullscreenRef.current = !!document.fullscreenElement;
    if (index >= 0 && index < playlist.length) {
      setCurrentIndex(index);
      setWasPlayingBeforeLibrary(true);
    }
  };

  // Handle queue reorder from the player
  const handleReorderPlaylist = useCallback((reordered: { id: string; name: string; thumbnail?: string }[]) => {
    // Find the currently playing video to maintain playback position
    const currentId = playlist[currentIndex]?.id;
    const newPlaylist = reordered.map(item => {
      const existing = playlist.find(p => p.id === item.id);
      return existing || { id: item.id, src: '', name: item.name, thumbnail: item.thumbnail };
    }).filter(p => p.src); // Only keep items that have valid sources
    
    setPlaylist(newPlaylist);
    // Maintain current video position after reorder
    const newIndex = newPlaylist.findIndex(p => p.id === currentId);
    if (newIndex >= 0) setCurrentIndex(newIndex);
  }, [playlist, currentIndex]);

  // Play a folder/playlist of videos
  const playFolder = useCallback(async (videoIds: string[], shuffle: boolean, loop: boolean) => {
    if (videoIds.length === 0) return;
    setIsLoading(true);
    setIsPlaylistLooping(loop);

    let orderedIds = [...videoIds];
    if (shuffle) {
      // Fisher-Yates shuffle
      for (let i = orderedIds.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [orderedIds[i], orderedIds[j]] = [orderedIds[j], orderedIds[i]];
      }
    }

    const playlistItems: PlaylistItem[] = [];
    for (const id of orderedIds) {
      try {
        const blobUrl = await videoStore.getBlobUrl(id);
        if (blobUrl) {
          const meta = videoLibrary.find(v => v.id === id);
          playlistItems.push({
            id,
            src: blobUrl,
            name: meta?.name || 'Unknown',
            thumbnail: meta?.thumbnail,
          });
        }
      } catch (e) {
        console.error('Failed to load video', id);
      }
    }

    if (playlistItems.length > 0) {
      setPlaylist(playlistItems);
      setCurrentIndex(0);
      setWasPlayingBeforeLibrary(true);
      setShowLibrary(false);
    }
    setIsLoading(false);
  }, [videoLibrary]);

  // Reorder handler for library
  const handleReorderVideos = useCallback((orderedIds: string[]) => {
    videoOrderStore.setOrder(orderedIds);
  }, []);

  // Add videos from PC to a specific folder (import to library + add to folder, no auto-play)
  const handleAddToFolder = useCallback(async (files: FileList | File[], folderId: string) => {
    const videoFiles = Array.from(files).filter(f => isVideoFile(f));
    if (videoFiles.length === 0) return;

    const resolved = await resolveFiles(videoFiles);
    addOptimistic(resolved);

    const { folderStore } = await import('./utils');
    resolved.forEach(r => folderStore.addVideo(folderId, r.id));

    await persistNew(resolved);
    setVideoLibrary(prev => [...prev]);
  }, [resolveFiles, addOptimistic, persistNew]);

  // Store reference to video element for pause/resume
  const handleVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
  }, []);

  // Go Home — clears playlist and returns to home screen (Fix #5)
  const handleGoHome = useCallback(() => {
    setPlaylist([]);
    setCurrentIndex(0);
    setShowLibrary(false);
    setError(null);
  }, []);

  return (
    <div className="w-screen h-screen bg-neutral-900 text-white overflow-hidden flex flex-col font-sans">
      {/* Loading Overlay — Modern Circular Progress Ring */}
      {isLoading && (
        <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center backdrop-blur-md">
          <div className="flex flex-col items-center gap-4">
            {/* Circular Progress Ring */}
            <div className="relative w-20 h-20">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 80 80">
                {/* Background ring */}
                <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="6" />
                {/* Progress ring */}
                <circle
                  cx="40" cy="40" r="34" fill="none"
                  stroke="url(#progressGradient)" strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 34}`}
                  strokeDashoffset={loadingProgress >= 0
                    ? `${2 * Math.PI * 34 * (1 - loadingProgress / 100)}`
                    : `${2 * Math.PI * 34 * 0.75}`
                  }
                  className={loadingProgress < 0 ? 'animate-spin origin-center' : 'transition-all duration-300 ease-out'}
                  style={loadingProgress < 0 ? { animationDuration: '1.2s' } : {}}
                />
                <defs>
                  <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#ef4444" />
                    <stop offset="100%" stopColor="#a855f7" />
                  </linearGradient>
                </defs>
              </svg>
              {/* Percentage text */}
              {loadingProgress >= 0 && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-white font-bold text-lg tabular-nums">{loadingProgress}%</span>
                </div>
              )}
            </div>
            <p className="text-neutral-400 text-sm font-medium tracking-wide">
              {loadingProgress >= 0 ? 'Processing videos...' : 'Loading...'}
            </p>
          </div>
        </div>
      )}

      {playlist.length > 0 ? (
        <div ref={playerWrapperRef} className="relative w-full h-full flex bg-black">
          {/* Main Player Area */}
          <div className="relative flex-1 h-full bg-black">
            <VideoPlayer
              key={playlist[currentIndex].id}
              videoId={playlist[currentIndex].id}
              src={playlist[currentIndex].src}
              subtitlesSrc={playlist[currentIndex].subtitleSrc}
              autoPlay={wasPlayingBeforeLibrary}
              onEnded={playNext}
              onChangeVideo={() => openLibrary()}
              onFileSelect={(files) => handleFileSelect(files)}
              onPlayStateChange={(playing) => setWasPlayingBeforeLibrary(playing)}
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

          {/* Library Modal */}
          {showLibrary && (
            <VideoLibrary
              videos={videoLibrary}
              onPlayVideo={playFromLibrary}
              onDeleteVideo={deleteFromLibrary}
              onClose={closeLibrary}
              onAddVideos={handleAddToLibraryOnly}
              onReorderVideos={handleReorderVideos}
              onPlayFolder={playFolder}
              onAddToFolder={handleAddToFolder}
              onAddFolderFromPC={handleAddFolderFromPC}
            />
          )}
        </div>
      ) : (
        /* Home Screen - Clean and Simple */
        <div 
          className={`flex-1 flex flex-col items-center justify-center p-4 sm:p-6 transition-colors duration-300 ${isDragging ? 'bg-neutral-800' : 'bg-neutral-900'}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        >
          <div className="w-full max-w-2xl">
            {/* Logo & Title */}
            <div className="text-center mb-8 sm:mb-12">
              <div className="bg-neutral-800 w-16 h-16 sm:w-20 sm:h-20 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg">
                <FileVideo size={40} className="sm:w-12 sm:h-12 text-red-500" />
              </div>
              <h1 className="text-4xl sm:text-5xl font-bold mb-2 bg-gradient-to-r from-red-500 to-purple-600 bg-clip-text text-transparent">
                PREV Player
              </h1>
              <p className="text-neutral-400 text-sm sm:text-base">
                Your personal video library
              </p>
            </div>

            {/* Last Video Card - Compact */}
            {lastVideo && (
              <div className="mb-6 sm:mb-8">
                <p className="text-xs text-neutral-500 uppercase tracking-wider mb-3">Resume Watching</p>
                <button
                  onClick={() => playFromLibrary(lastVideo)}
                  className="w-full group relative overflow-hidden rounded-lg bg-neutral-800 hover:bg-neutral-750 transition-all duration-300 hover:scale-105"
                >
                  <div className="flex gap-3 sm:gap-4 p-3 sm:p-4">
                    {/* Thumbnail */}
                    <div className="relative w-16 h-16 sm:w-20 sm:h-20 flex-shrink-0 rounded overflow-hidden bg-neutral-700">
                      {lastVideo.thumbnail ? (
                        <img
                          src={lastVideo.thumbnail}
                          alt={lastVideo.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-neutral-800">
                          <Play size={16} className="text-neutral-600 fill-neutral-600" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-all" />
                    </div>

                    {/* Info */}
                    <div className="flex-1 flex flex-col justify-center min-w-0">
                      <h3 className="text-sm sm:text-base font-semibold text-white truncate group-hover:text-red-400 transition-colors text-left">
                        {lastVideo.name}
                      </h3>
                      <p className="text-xs text-neutral-500 text-left">
                        Click to continue
                      </p>
                    </div>

                    {/* Play Icon */}
                    <div className="flex items-center justify-center">
                      <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-red-600 group-hover:bg-red-700 flex items-center justify-center transition-all transform group-hover:scale-110">
                        <Play size={18} className="text-white fill-white ml-0.5" />
                      </div>
                    </div>
                  </div>
                </button>
              </div>
            )}

            {/* Action Buttons */}
            <div className="space-y-3">
              {/* Browse Videos */}
              <label className="group relative flex items-center justify-center gap-2 w-full px-6 sm:px-8 py-3 sm:py-4 font-semibold text-sm sm:text-base text-white bg-red-600 rounded-lg hover:bg-red-700 hover:shadow-lg hover:shadow-red-500/30 cursor-pointer transition-all active:scale-95">
                <Upload size={20} className="sm:w-6 sm:h-6" />
                <span>Browse & Add Videos</span>
                <input 
                  type="file" 
                  multiple
                  accept="video/*" 
                  onChange={handleInputChange}
                  className="hidden" 
                />
              </label>

              {/* Import Folder — Fix #1 */}
              <input
                ref={homeFolderInputRef}
                type="file"
                // @ts-ignore webkitdirectory is non-standard
                webkitdirectory=""
                directory=""
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) handleAddFolderFromPC(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => homeFolderInputRef.current?.click()}
                className="group relative flex items-center justify-center gap-2 w-full px-6 sm:px-8 py-3 sm:py-4 font-semibold text-sm sm:text-base text-white bg-neutral-800 hover:bg-neutral-700 hover:shadow-lg rounded-lg cursor-pointer transition-all active:scale-95"
              >
                <FolderPlus size={20} className="sm:w-6 sm:h-6" />
                <span>Import Folder</span>
              </button>

              {/* View Library */}
              {videoLibrary.length > 0 && (
                <button
                  onClick={openLibrary}
                  className="group relative flex items-center justify-center gap-2 w-full px-6 sm:px-8 py-3 sm:py-4 font-semibold text-sm sm:text-base text-neutral-300 bg-neutral-800/60 hover:bg-neutral-700 rounded-lg transition-all active:scale-95 border border-neutral-700/50"
                >
                  <Library size={20} className="sm:w-6 sm:h-6" />
                  <span>Library ({videoLibrary.length})</span>
                </button>
              )}
            </div>

            {/* Drop Zone */}
            {!isDragging && (
              <div className="mt-8 sm:mt-12 pt-8 border-t border-neutral-800">
                <p className="text-center text-neutral-500 text-sm mb-4">
                  Or drag and drop videos here
                </p>
                <div className={`border-2 border-dashed rounded-lg p-6 sm:p-8 text-center transition-all ${isDragging ? 'border-red-500 bg-red-500/10' : 'border-neutral-700'}`}>
                  <p className="text-neutral-400 text-sm">
                    All your videos will be saved to the library
                  </p>
                </div>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="mt-6 flex items-center text-red-400 bg-red-400/10 px-4 py-3 rounded-lg animate-pulse text-sm">
                <AlertCircle size={16} className="mr-2 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
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
          onAddVideos={handleAddToLibraryOnly}
          onReorderVideos={handleReorderVideos}
          onPlayFolder={playFolder}
          onAddToFolder={handleAddToFolder}
          onAddFolderFromPC={handleAddFolderFromPC}
        />
      )}
    </div>
  );
}

export default App;
