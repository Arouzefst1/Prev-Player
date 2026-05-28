import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Upload, FileVideo, AlertCircle, List, X, Trash2, FolderOpen, History, Play, Library } from 'lucide-react';
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

interface PlaylistItem {
  id: string;
  src: string;       // blob URL for playback
  name: string;
  subtitleSrc?: string;
  file?: File;
  thumbnail?: string;
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
  const [wasPlayingBeforeLibrary, setWasPlayingBeforeLibrary] = useState(true);
  const [isPlaylistLooping, setIsPlaylistLooping] = useState(false);
  const isFullscreenRef = useRef(false);
  const playerWrapperRef = useRef<HTMLDivElement>(null);
  const videoPlayerRef = useRef<{ isPlaying: boolean }>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);

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

  // Add video to IndexedDB library with metadata
  const addToLibrary = useCallback(async (file: File): Promise<VideoMeta> => {
    // Check if already exists
    const exists = await videoStore.exists(file.name, file.size);
    if (exists) {
      const metas = await videoStore.getAllMeta();
      const existing = metas.find(v => v.name === file.name && v.size === file.size)!;
      return existing;
    }

    const id = Math.random().toString(36).substr(2, 9);
    
    // Create a blob URL for thumbnail/duration extraction
    const blobUrl = URL.createObjectURL(file);
    
    let thumbnail: string | undefined;
    let duration: number | undefined;

    // Extract thumbnail
    try {
      thumbnail = await extractVideoThumbnail(blobUrl);
    } catch (e) {
      console.log('Failed to extract thumbnail');
    }

    // Get duration
    try {
      duration = await getVideoDuration(blobUrl);
    } catch (e) {
      console.log('Failed to get duration');
    }

    // Clean up temp blob URL
    URL.revokeObjectURL(blobUrl);

    // Store the actual blob in IndexedDB
    await videoStore.save({
      id,
      name: file.name,
      blob: file,   // File extends Blob, so this works directly
      thumbnail,
      size: file.size,
      addedAt: Date.now(),
      duration,
      type: file.type,
    });

    const meta: VideoMeta = {
      id,
      name: file.name,
      thumbnail,
      size: file.size,
      addedAt: Date.now(),
      duration,
      type: file.type,
    };

    // Update state
    setVideoLibrary(prev => [meta, ...prev]);

    return meta;
  }, []);

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

  // Handle file selection - add to library AND auto-play the first selected video
  const handleFileSelect = async (files: FileList | File[]) => {
    const videoFiles = Array.from(files).filter(f => isVideoFile(f));
    
    if (videoFiles.length === 0) {
      setError("No playable video files found.");
      return;
    }

    setIsLoading(true);
    setError(null);

    // Add all videos to library
    const addedMetas: VideoMeta[] = [];
    for (const file of videoFiles) {
      const meta = await addToLibrary(file);
      addedMetas.push(meta);
    }

    // Auto-play: create blob URLs and set playlist
    const playlistItems: PlaylistItem[] = [];
    for (const file of videoFiles) {
      const meta = addedMetas.find(m => m.name === file.name && m.size === file.size);
      if (meta) {
        // Create a fresh blob URL directly from the File object for immediate playback
        const blobUrl = URL.createObjectURL(file);
        playlistItems.push({
          id: meta.id,
          src: blobUrl,
          name: meta.name,
        });
      }
    }

    if (playlistItems.length > 0) {
      setPlaylist(playlistItems);
      setCurrentIndex(0);
      setWasPlayingBeforeLibrary(true);
    }

    setIsLoading(false);
  };

  // Handle adding files to library only (no auto-play), used from library panel
  const handleAddToLibraryOnly = async (files: FileList | File[]) => {
    const videoFiles = Array.from(files).filter(f => isVideoFile(f));
    if (videoFiles.length === 0) {
      setError("No playable video files found.");
      return;
    }

    setIsLoading(true);
    setError(null);

    for (const file of videoFiles) {
      await addToLibrary(file);
    }

    setIsLoading(false);
  };

  // Handle importing a whole folder from PC:
  // 1. Scans for video files  2. Adds them to library  3. Creates a folder entry with the real folder name
  const handleAddFolderFromPC = useCallback(async (files: FileList | File[]) => {
    const allFiles = Array.from(files);
    const videoFiles = allFiles.filter(f => isVideoFile(f));
    if (videoFiles.length === 0) {
      setError('No playable video files found in this folder.');
      return;
    }

    // Extract the top-level folder name from webkitRelativePath (e.g. "MyVideos/clip.mp4" → "MyVideos")
    let folderName = 'Imported Folder';
    const firstPath = (allFiles[0] as any).webkitRelativePath as string | undefined;
    if (firstPath) {
      const parts = firstPath.split('/');
      if (parts.length >= 2) folderName = parts[0];
    }

    setIsLoading(true);
    setError(null);

    // Add all videos to library and collect their IDs
    const addedIds: string[] = [];
    for (const file of videoFiles) {
      const meta = await addToLibrary(file);
      addedIds.push(meta.id);
    }

    // Create a folder with the real name and link the videos
    const { folderStore } = await import('./utils');
    const folderId = Math.random().toString(36).substr(2, 9);
    folderStore.save({ id: folderId, name: folderName, videoIds: addedIds, createdAt: Date.now() });

    // Force a state refresh so VideoLibrary's folder-reload effect fires after the folder is saved
    setVideoLibrary(prev => [...prev]);

    setIsLoading(false);
  }, [addToLibrary]);

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

    setIsLoading(true);
    for (const file of videoFiles) {
      const meta = await addToLibrary(file);
      // Also add to the folder
      const { folderStore } = await import('./utils');
      folderStore.addVideo(folderId, meta.id);
    }
    setIsLoading(false);
  }, [addToLibrary]);

  // Store reference to video element for pause/resume
  const handleVideoRef = useCallback((el: HTMLVideoElement | null) => {
    videoElRef.current = el;
  }, []);

  return (
    <div className="w-screen h-screen bg-neutral-900 text-white overflow-hidden flex flex-col font-sans">
      {/* Loading Overlay */}
      {isLoading && (
        <div className="fixed inset-0 bg-black/70 z-[100] flex items-center justify-center backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-3 border-white/20 border-t-red-500 rounded-full animate-spin" />
            <p className="text-neutral-300 text-sm">Loading video...</p>
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

              {/* View Library */}
              {videoLibrary.length > 0 && (
                <button
                  onClick={openLibrary}
                  className="group relative flex items-center justify-center gap-2 w-full px-6 sm:px-8 py-3 sm:py-4 font-semibold text-sm sm:text-base text-white bg-neutral-800 hover:bg-neutral-700 rounded-lg transition-all active:scale-95"
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
