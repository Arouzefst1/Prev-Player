import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FolderOpen, AlertCircle, X, Play } from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import PlayerControls from './PlayerControls';
import ActionOverlay from './ActionOverlay';
import { OverlayState, srtToVtt, detectCodecSupport, saveVideoProgress, loadVideoProgress } from '../utils';

interface PlaylistItemInfo {
  id: string;
  name: string;
  thumbnail?: string;
}

interface VideoPlayerProps {
  src: string;
  videoId?: string;
  subtitlesSrc?: string | null;
  autoPlay?: boolean;
  onEnded?: () => void;
  onChangeVideo?: () => void;
  onFileSelect?: () => void;
  onPlayStateChange?: (playing: boolean) => void;
  // Playlist navigation
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
  // Queue info
  playlist?: PlaylistItemInfo[];
  currentIndex?: number;
  onJumpTo?: (index: number) => void;
  onReorderPlaylist?: (reordered: PlaylistItemInfo[]) => void;
  // Fullscreen preservation
  startFullscreen?: boolean;
  // Library access
  onOpenLibrary?: () => void;
  showLibraryButton?: boolean;
  // External fullscreen container (wraps player + library)
  fullscreenContainerRef?: React.RefObject<HTMLDivElement>;
  // Callback to expose the video element ref to parent
  onVideoRef?: (el: HTMLVideoElement | null) => void;
  // Go back to home screen (Fix #5)
  onGoHome?: () => void;
}

// ============================================================
// QueuePanel — sortable queue using @dnd-kit (pointer events,
// unaffected by Tauri's WebView2 drag-drop interception)
// ============================================================

const SortableQueueItem: React.FC<{
  item: { id: string; name: string; thumbnail?: string };
  index: number;
  currentIndex: number;
  onJumpTo: (i: number) => void;
}> = ({ item, index, currentIndex, onJumpTo }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isSorting, activeIndex, overIndex } = useSortable({ id: item.id });
  const isCurrent = index === currentIndex;
  // Spotify-style drop indicator: keep the list static and show a red line at
  // the edge of the row the dragged item will drop into.
  const showDropLine = isSorting && !isDragging && index === overIndex && activeIndex !== -1 && activeIndex !== overIndex;
  const dropLineAtBottom = activeIndex < overIndex;
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: isDragging ? CSS.Transform.toString(transform) : undefined,
        transition,
        opacity: isDragging ? 0.4 : 1,
        position: 'relative',
        zIndex: isDragging ? 20 : undefined,
      }}
      onClick={() => onJumpTo(index)}
      className={`w-full flex items-center gap-2 p-3 cursor-pointer transition-all duration-200 group ${isCurrent ? 'bg-red-600/15 border-l-2 border-l-red-500' : 'hover:bg-neutral-800/80 border-l-2 border-l-transparent'}`}
    >
      {showDropLine && (
        <span className={`pointer-events-none absolute left-2 right-2 z-30 h-[3px] rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.9)] ${dropLineAtBottom ? 'bottom-0' : 'top-0'}`}>
          <span className="absolute -left-1 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-red-500" />
        </span>
      )}
      <div {...attributes} {...listeners} onClick={(e) => e.stopPropagation()} className="cursor-grab active:cursor-grabbing flex flex-col gap-[2px] p-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <span className="block w-3 h-[2px] bg-neutral-500 rounded" />
        <span className="block w-3 h-[2px] bg-neutral-500 rounded" />
        <span className="block w-3 h-[2px] bg-neutral-500 rounded" />
      </div>
      <span className={`text-xs font-mono w-5 text-right flex-shrink-0 ${isCurrent ? 'text-red-400 font-bold' : 'text-neutral-600'}`}>
        {isCurrent ? '▶' : index + 1}
      </span>
      {item.thumbnail && (
        <div className="w-12 h-8 rounded overflow-hidden flex-shrink-0 bg-neutral-800">
          <img src={item.thumbnail} alt="" className="w-full h-full object-cover" />
        </div>
      )}
      <span className={`text-sm truncate flex-1 ${isCurrent ? 'text-red-400 font-semibold' : 'text-neutral-300 group-hover:text-white'}`}>
        {item.name}
      </span>
    </div>
  );
};

const QueuePanel: React.FC<{
  playlist: { id: string; name: string; thumbnail?: string }[];
  currentIndex: number;
  onJumpTo: (i: number) => void;
  onReorder: (items: { id: string; name: string; thumbnail?: string }[]) => void;
  onClose: () => void;
}> = ({ playlist, currentIndex, onJumpTo, onReorder, onClose }) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  return (
    <div className="absolute top-0 right-0 bottom-0 w-80 max-w-[85%] bg-black/95 z-50 flex flex-col border-l border-neutral-800 animate-[slideInRight_0.25s_ease]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
        <div>
          <h3 className="text-sm font-bold text-white">Queue</h3>
          <p className="text-xs text-neutral-500">{playlist.length} videos</p>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors">
          <X size={18} className="text-neutral-400" />
        </button>
      </div>
      <div className="flex-1 overflow-auto custom-scrollbar">
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragEnd={(event: DragEndEvent) => {
            const { active, over } = event;
            if (!over || active.id === over.id) return;
            const oldIdx = playlist.findIndex(p => p.id === active.id);
            const newIdx = playlist.findIndex(p => p.id === over.id);
            if (oldIdx >= 0 && newIdx >= 0) onReorder(arrayMove(playlist, oldIdx, newIdx));
          }}>
          <SortableContext items={playlist.map(p => p.id)} strategy={verticalListSortingStrategy}>
            {playlist.map((item, i) => (
              <SortableQueueItem key={item.id} item={item} index={i} currentIndex={currentIndex} onJumpTo={onJumpTo} />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
};

// ============================================================

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src, videoId, subtitlesSrc, autoPlay = false, onEnded, onChangeVideo, onFileSelect, onPlayStateChange,
  onNext, onPrev, hasNext, hasPrev,
  playlist: playlistInfo, currentIndex: currentPlaylistIndex, onJumpTo,
  onReorderPlaylist,
  startFullscreen,
  onOpenLibrary, showLibraryButton,
  fullscreenContainerRef,
  onVideoRef,
  onGoHome,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClickMsRef = useRef(0);

  const spaceHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpaceHeldRef = useRef<boolean>(false);
  const savedSpeedRef = useRef<number>(1);
  const userSpeedRef = useRef<number>(1);
  const touchStartRef = useRef<number>(0);
  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTouchHoldRef = useRef<boolean>(false);
  const hasRestoredProgressRef = useRef<boolean>(false);
  const lastProgressSaveRef = useRef<number>(0);

  // Player State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPip, setIsPip] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  const [isLooping, setIsLooping] = useState(false);
  
  // UI State
  const [showControls, setShowControls] = useState(true);
  const [overlayState, setOverlayState] = useState<OverlayState>({ action: null, id: 0 });
  const [showSpeedOverlay, setShowSpeedOverlay] = useState(false);
  const [speedOverlayValue, setSpeedOverlayValue] = useState('');
  const [showTimeToggle, setShowTimeToggle] = useState(false);
  const [isRemainingTimeMode, setIsRemainingTimeMode] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const overlayCounterRef = useRef(0);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [codecSupport, setCodecSupport] = useState<Record<string, boolean>>({});

  // --- Effect: Codec Support Detection ---
  useEffect(() => {
    const support = detectCodecSupport();
    setCodecSupport(support);
    console.log('Detected codec support:', support);
  }, []);

  // --- Effect: Expose video ref to parent ---
  useEffect(() => {
    onVideoRef?.(videoRef.current);
    return () => onVideoRef?.(null);
  }, [onVideoRef]);

  // --- Effect: Restore saved playback position once metadata is loaded ---
  useEffect(() => {
    if (!videoRef.current || !videoId || !duration || hasRestoredProgressRef.current) return;
    hasRestoredProgressRef.current = true;
    const saved = loadVideoProgress(videoId);
    if (saved && saved >= 5 && saved < duration - 5) {
      videoRef.current.currentTime = saved;
      setCurrentTime(saved);
    }
  }, [duration, videoId]);

  // --- Effect: Persist playback position (resume-where-you-left-off) ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !videoId) return;

    const save = () => {
      if (video.currentTime > 0 && video.duration > 0) {
        saveVideoProgress(videoId, video.currentTime, video.duration);
      }
    };

    const onTimeUpdate = () => {
      // Throttle: at most once every 5s while playing
      const now = Date.now();
      if (now - lastProgressSaveRef.current > 5000) {
        lastProgressSaveRef.current = now;
        save();
      }
    };
    const onPause = () => save();
    const onPageHide = () => save();
    const onVisibilityChange = () => {
      if (document.hidden) save();
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('pause', onPause);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('pause', onPause);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Save on unmount (e.g. switching to a different video or closing the player)
      save();
    };
  }, [videoId]);

  // --- Effect: Subtitles ---
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Clear existing tracks
    const oldTracks = video.querySelectorAll('track');
    oldTracks.forEach(t => t.remove());

    if (subtitlesSrc) {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = 'English';
        track.srclang = 'en';
        track.src = subtitlesSrc;
        track.default = subtitlesEnabled;
        video.appendChild(track);
        
        if (track.track) {
            track.track.mode = subtitlesEnabled ? 'showing' : 'hidden';
        }
    }
  }, [subtitlesSrc, subtitlesEnabled]);

  // --- Helpers ---
  const formatTime = (seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const getRemainingTime = (): number => {
    return Math.max(0, duration - currentTime);
  };

  const triggerOverlay = useCallback((action: OverlayState['action'], value?: string | number) => {
    overlayCounterRef.current += 1;
    setOverlayState({ action, value, id: overlayCounterRef.current });
  }, []);

  const toggleTimeDisplay = () => {
    setIsRemainingTimeMode(!isRemainingTimeMode);
    setShowTimeToggle(true);
    setTimeout(() => setShowTimeToggle(false), 2000);
  };

  const resetControlsTimer = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }

    // Hide controls after 3 seconds of inactivity if playing
    if (isPlaying) {
        controlsTimeoutRef.current = setTimeout(() => {
            setShowControls(false);
        }, 3000);
    }
  }, [isPlaying]);

  // Keep the hide-controls timer in sync with isPlaying. Fixes the case where
  // togglePlay/autoplay flips isPlaying to true AFTER resetControlsTimer already
  // ran with isPlaying=false (so no hide-timer was scheduled and the controls
  // would stay visible until the next user interaction).
  useEffect(() => {
    if (!isPlaying) return;
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => setShowControls(false), 3000);
    return () => {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
    };
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    
    // Ensure container is focused so keyboard shortcuts keep working
    containerRef.current?.focus();

    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
      onPlayStateChange?.(true);
      triggerOverlay('play');
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
      onPlayStateChange?.(false);
      triggerOverlay('pause');
      // Keep controls visible when paused
      setShowControls(true);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    }
  }, [onPlayStateChange, triggerOverlay]);

  const handleVolumeChange = useCallback((newVolume: number, showOverlay = true, showControls = true) => {
    if (!videoRef.current) return;
    const clamped = Math.max(0, Math.min(1, newVolume));
    videoRef.current.volume = clamped;
    setVolume(clamped);
    if (clamped > 0) setIsMuted(false);
    
    if (showOverlay) {
        if (newVolume > volume) triggerOverlay('volume-up', `${Math.round(clamped * 100)}%`);
        else if (newVolume < volume) triggerOverlay('volume-down', `${Math.round(clamped * 100)}%`);
    }
    if (showControls) resetControlsTimer();
  }, [volume, resetControlsTimer, triggerOverlay]);

  const skip = useCallback((amount: number, showControlsBar = true) => {
    if (!videoRef.current) return;
    const newTime = Math.max(0, Math.min(videoRef.current.duration || Infinity, videoRef.current.currentTime + amount));
    videoRef.current.currentTime = newTime;
    setCurrentTime(newTime);
    
    if (Math.abs(amount) === 5) {
        triggerOverlay(amount > 0 ? 'forward-5' : 'rewind-5');
    } else {
        triggerOverlay(amount > 0 ? 'forward-10' : 'rewind-10');
    }
    
    if (showControlsBar) resetControlsTimer();
  }, [resetControlsTimer, triggerOverlay]);

  const changeSpeed = useCallback((newSpeed: number, showOverlay = false) => {
      if (!videoRef.current) return;
      videoRef.current.playbackRate = newSpeed;
      setPlaybackSpeed(newSpeed);
      userSpeedRef.current = newSpeed;
      if (showOverlay) {
        setSpeedOverlayValue(newSpeed === 1 ? 'Normal' : newSpeed + 'x');
        setShowSpeedOverlay(true);
        setTimeout(() => setShowSpeedOverlay(false), 800);
      }
  }, []);

  const seekToPercentage = useCallback((percent: number) => {
      if (!videoRef.current) return;
      const newTime = videoRef.current.duration * (percent / 100);
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
      resetControlsTimer();
  }, [resetControlsTimer]);

  // The element to fullscreen — prefer the external container (wraps player + library)
  const getFullscreenEl = useCallback(() => {
    return fullscreenContainerRef?.current || containerRef.current;
  }, [fullscreenContainerRef]);

  const toggleFullscreen = useCallback(() => {
    const el = getFullscreenEl();
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, [getFullscreenEl]);

  // Track fullscreen changes (e.g. browser exits fullscreen when file dialog opens)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = !!document.fullscreenElement;
      setIsFullscreen(isFs);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Re-enter fullscreen on mount when switching videos while in fullscreen
  useEffect(() => {
    if (startFullscreen && !document.fullscreenElement) {
      const timer = setTimeout(() => {
        const el = fullscreenContainerRef?.current || containerRef.current;
        el?.requestFullscreen().catch(() => {});
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [startFullscreen, fullscreenContainerRef]);

  // Delegate file opening to App.tsx (which handles the Tauri dialog + fullscreen restore)
  const handleOpenFileDialog = useCallback(() => {
    onFileSelect?.();
  }, [onFileSelect]);

  const toggleLoop = useCallback(() => {
    if (!videoRef.current) return;
    const newLoop = !isLooping;
    videoRef.current.loop = newLoop;
    setIsLooping(newLoop);
  }, [isLooping]);

  // --- Picture-in-Picture (native, borderless, auto-sized to video) ---
  const wasFullscreenBeforePipRef = useRef(false);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        // Remember fullscreen state before PiP (PiP exits fullscreen)
        wasFullscreenBeforePipRef.current = !!document.fullscreenElement;
        await video.requestPictureInPicture();
      }
    } catch (err) {
      console.error('PiP error:', err);
    }
  }, []);

  // Sync PiP state; on leave restore the Tauri window and re-enter fullscreen if applicable
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onEnterPip = () => setIsPip(true);

    const onLeavePip = async () => {
      setIsPip(false);
      const restoreFullscreen = wasFullscreenBeforePipRef.current;
      wasFullscreenBeforePipRef.current = false;
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await win.show();
        await win.unminimize();
        await win.setFocus();
        // setFullscreen via Tauri API — doesn't require a user-gesture unlike requestFullscreen()
        if (restoreFullscreen) await win.setFullscreen(true);
      } catch {
        // Fallback for non-Tauri environments
        if (restoreFullscreen) {
          setTimeout(() => {
            (fullscreenContainerRef?.current || containerRef.current)?.requestFullscreen().catch(() => {});
          }, 200);
        }
      }
    };

    video.addEventListener('enterpictureinpicture', onEnterPip);
    video.addEventListener('leavepictureinpicture', onLeavePip);
    return () => {
      video.removeEventListener('enterpictureinpicture', onEnterPip);
      video.removeEventListener('leavepictureinpicture', onLeavePip);
    };
  }, [fullscreenContainerRef]);

  // Mobile touch hold for 2x speed
  const handleTouchStart = useCallback(() => {
    touchStartRef.current = Date.now();
    isTouchHoldRef.current = false;

    // Start hold detection timer - 500ms hold activates 2x speed
    holdTimeoutRef.current = setTimeout(() => {
      isTouchHoldRef.current = true;
      savedSpeedRef.current = userSpeedRef.current;
      if (videoRef.current) {
        videoRef.current.playbackRate = 2;
        setPlaybackSpeed(2);
      }
      setSpeedOverlayValue('2x');
      setShowSpeedOverlay(true);
    }, 500);
  }, []);

  const handleTouchEnd = useCallback(() => {
    // Clear hold timeout
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }

    // If was holding for 2x, restore speed
    if (isTouchHoldRef.current) {
      isTouchHoldRef.current = false;
      if (videoRef.current) {
        videoRef.current.playbackRate = userSpeedRef.current;
        setPlaybackSpeed(userSpeedRef.current);
      }
      setShowSpeedOverlay(false);
    }
  }, []);



  // --- Event Listeners ---

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (autoPlay) {
        video.play().catch(() => {});
        setIsPlaying(true);
        onPlayStateChange?.(true);
    }

    const onTimeUpdate = () => {
      if (!isDragging) {
        setCurrentTime(video.currentTime);
      }
    };
    const onLoadedMetadata = () => {
      setDuration(video.duration);
      // Optimize buffering for large files (4K/8K)
      if (video.duration > 3600) {
        // Video longer than 1 hour - likely a large file
        video.preload = 'auto';
      }
    };
    const handleEnded = () => {
        setIsPlaying(false);
        setShowControls(true);
        if (onEnded) onEnded();
    };

    // Handle video errors
    const handleError = () => {
      setHasError(true);
      if (video.error) {
        let message = 'Failed to load video. ';
        switch(video.error.code) {
          case video.error.MEDIA_ERR_ABORTED:
            message += 'Loading was aborted.';
            break;
          case video.error.MEDIA_ERR_NETWORK:
            message += 'Network error. Check your file.';
            break;
          case video.error.MEDIA_ERR_DECODE:
            message += 'Codec not supported by browser.';
            break;
          case video.error.MEDIA_ERR_SRC_NOT_SUPPORTED:
            message += 'Format not supported.';
            break;
          default:
            message += 'Unknown error.';
        }
        setErrorMessage(message);
      }
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    // Progressive buffering monitoring for large files
    const onProgress = () => {
      if (video.buffered.length > 0) {
        // Buffering is working - browser handles large file buffering automatically
      }
    };
    video.addEventListener('progress', onProgress);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('error', handleError);
    };
  }, [isDragging, autoPlay, onEnded]);

  // KEYBOARD CONTROLS
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in a text input
      if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'text') return;

      // Prevent default for control keys
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
          e.preventDefault();
      }

      // Don't show bottom controls when adjusting volume/mute or using arrow-key skip — only the center overlay should appear
      const isOverlayOnlyKey = e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.key === 'm' || e.key === 'M';
      if (!isOverlayOnlyKey) {
        resetControlsTimer();
      } else if (isPlaying) {
        // Actively hide bottom controls when using overlay-only keys during playback
        setShowControls(false);
        if (controlsTimeoutRef.current) {
          clearTimeout(controlsTimeoutRef.current);
          controlsTimeoutRef.current = null;
        }
      }

      // Handle spacebar - hold for 2x speed, tap for play/pause
      if (e.code === 'Space') {
        if (e.repeat) return; // Ignore key repeat
        
        // Start hold detection timer
        spaceHoldTimeoutRef.current = setTimeout(() => {
          // Hold detected - activate 2x speed
          isSpaceHeldRef.current = true;
          savedSpeedRef.current = userSpeedRef.current;
          if (videoRef.current) {
            videoRef.current.playbackRate = 2;
            setPlaybackSpeed(2);
          }
          setSpeedOverlayValue('2x');
          setShowSpeedOverlay(true);
        }, 200);
        return;
      }

      switch (e.key) {
        case 'k':
        case 'K':
          togglePlay();
          break;
        case 'ArrowRight':
          skip(5, false);
          break;
        case 'ArrowLeft':
          skip(-5, false);
          break;
        case 'l':
        case 'L':
          toggleLoop();
          break;
        case 'j':
        case 'J':
          skip(-10);
          break;
        case 'ArrowUp':
          handleVolumeChange(volume + 0.05, true, false);
          break;
        case 'ArrowDown':
          handleVolumeChange(volume - 0.05, true, false);
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'p':
        case 'P':
          togglePip();
          break;
        case 'q':
        case 'Q':
          if (playlistInfo && playlistInfo.length > 1) {
            setShowQueue(q => !q);
          }
          break;
        case 'n':
        case 'N':
          if (hasNext) onNext?.();
          break;
        case 'b':
        case 'B':
          if (hasPrev) onPrev?.();
          break;
        case 'm':
        case 'M':
            if (videoRef.current) {
                const nextState = !isMuted;
                videoRef.current.muted = nextState;
                setIsMuted(nextState);
                triggerOverlay(nextState ? 'volume-down' : 'volume-up', nextState ? 'Muted' : 'Unmuted');
            }
            break;
        case 'c':
        case 'C':
            setSubtitlesEnabled(prev => !prev);
            break;
        case '>': // Shift + .
          changeSpeed(Math.min(2, playbackSpeed + 0.25), true);
          break;
        case '<': // Shift + ,
          changeSpeed(Math.max(0.25, playbackSpeed - 0.25), true);
          break;
        default:
           // Number keys 0-9
           if (!isNaN(parseInt(e.key))) {
               seekToPercentage(parseInt(e.key) * 10);
           }
           break;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        
        // Clear hold timeout
        if (spaceHoldTimeoutRef.current) {
          clearTimeout(spaceHoldTimeoutRef.current);
          spaceHoldTimeoutRef.current = null;
        }
        
        // If was holding for 2x, restore speed
        if (isSpaceHeldRef.current) {
          isSpaceHeldRef.current = false;
          if (videoRef.current) {
            videoRef.current.playbackRate = userSpeedRef.current;
            setPlaybackSpeed(userSpeedRef.current);
          }
          setShowSpeedOverlay(false);
        } else {
          // Was a tap, not a hold - toggle play/pause directly
          if (videoRef.current) {
            if (videoRef.current.paused) {
              videoRef.current.play();
              setIsPlaying(true);
              onPlayStateChange?.(true);
              triggerOverlay('play');
            } else {
              videoRef.current.pause();
              setIsPlaying(false);
              onPlayStateChange?.(false);
              triggerOverlay('pause');
            }
          }
        }
      }
    };

    // Fix: When window loses focus (e.g., user clicks library/folder), reset 2x speed
    const handleWindowBlur = () => {
      // Clear spacebar hold
      if (spaceHoldTimeoutRef.current) {
        clearTimeout(spaceHoldTimeoutRef.current);
        spaceHoldTimeoutRef.current = null;
      }
      if (isSpaceHeldRef.current) {
        isSpaceHeldRef.current = false;
        if (videoRef.current) {
          videoRef.current.playbackRate = userSpeedRef.current;
          setPlaybackSpeed(userSpeedRef.current);
        }
        setShowSpeedOverlay(false);
      }
      // Clear touch hold
      if (holdTimeoutRef.current) {
        clearTimeout(holdTimeoutRef.current);
        holdTimeoutRef.current = null;
      }
      if (isTouchHoldRef.current) {
        isTouchHoldRef.current = false;
        if (videoRef.current) {
          videoRef.current.playbackRate = userSpeedRef.current;
          setPlaybackSpeed(userSpeedRef.current);
        }
        setShowSpeedOverlay(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    // Also listen on container blur for when focus moves to another element
    const container = containerRef.current;
    container?.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      container?.removeEventListener('blur', handleWindowBlur);
      if (spaceHoldTimeoutRef.current) clearTimeout(spaceHoldTimeoutRef.current);
    };
  }, [togglePlay, skip, volume, toggleFullscreen, togglePip, isMuted, isPlaying, resetControlsTimer, handleVolumeChange, playbackSpeed, changeSpeed, subtitlesEnabled, seekToPercentage, triggerOverlay, toggleLoop, isLooping]);


  // Mouse activity monitoring
  useEffect(() => {
    const handleMouseMove = () => {
      resetControlsTimer();
    };

    const container = containerRef.current;
    if (container) {
        container.addEventListener('mousemove', handleMouseMove);
        container.addEventListener('click', handleMouseMove);
        container.addEventListener('touchstart', handleMouseMove);
    }

    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
      if (container) {
          container.removeEventListener('mousemove', handleMouseMove);
          container.removeEventListener('click', handleMouseMove);
          container.removeEventListener('touchstart', handleMouseMove);
      }
    };
  }, [resetControlsTimer]);


  // --- Handlers for Control Bar ---
  
  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    setCurrentTime(time);
    if (videoRef.current) {
        videoRef.current.currentTime = time; 
    }
  };

  const handleSeekStart = () => {
    setIsDragging(true);
  };

  const handleSeekEnd = (e: React.MouseEvent | React.TouchEvent) => {
    setIsDragging(false);
    // CRITICAL FIX: Blur the input and focus the container to ensure Spacebar toggles play instead of interacting with the slider
    (e.target as HTMLInputElement).blur();
    containerRef.current?.focus();
  };

  return (
    <div
      ref={containerRef}
      className={`relative w-full h-full bg-black group overflow-hidden flex flex-col justify-center select-none outline-none ${showControls ? '' : 'cursor-none'}`}
      tabIndex={0} // Allow focus
      onContextMenu={(e) => e.preventDefault()}
    >
      <video
        ref={videoRef}
        src={src}
        className={`w-full h-full object-contain pointer-events-auto ${showControls ? 'cursor-pointer' : 'cursor-none'}`}
        preload="metadata"
        controlsList="nodownload"
        autoPlay={autoPlay}
        style={{
          backfaceVisibility: 'hidden',
          transform: 'translateZ(0)',
          willChange: 'auto'
        }}
        onError={(e) => {
          const error = videoRef.current?.error;
          let errorMsg = 'Unable to load video';
          if (error) {
            if (error.code === error.MEDIA_ERR_ABORTED) errorMsg = 'Video loading aborted';
            else if (error.code === error.MEDIA_ERR_NETWORK) errorMsg = 'Network error loading video. Check that the file exists.';
            else if (error.code === error.MEDIA_ERR_DECODE) errorMsg = 'Codec/decoding error. This video may use a codec not supported by your browser (e.g. HEVC). Try Chrome or install the HEVC codec extension.';
            else if (error.code === error.MEDIA_ERR_SRC_NOT_SUPPORTED) errorMsg = 'Video format not supported by this browser. Try a different browser or re-encode the file as H.264 MP4.';
          }
          console.error('Video error:', errorMsg, error);
          setHasError(true);
          setErrorMessage(errorMsg);
        }}
        onCanPlay={() => {
          setHasError(false);
          setErrorMessage('');
        }}
        onLoadedMetadata={() => {
          setDuration(videoRef.current?.duration || 0);
        }}
        onClick={() => {
          // Timestamp-based double-click detection — e.detail is unreliable in
          // Tauri's WebView2 (always returns 1), so we measure elapsed time instead.
          const now = Date.now();
          const elapsed = now - lastClickMsRef.current;

          if (singleClickTimerRef.current) {
            clearTimeout(singleClickTimerRef.current);
            singleClickTimerRef.current = null;
          }

          if (elapsed < 300) {
            // Two clicks within 300 ms → double-click: fullscreen only
            lastClickMsRef.current = 0; // reset so a triple-click doesn't re-trigger
            toggleFullscreen();
          } else {
            lastClickMsRef.current = now;
            // Defer so the 2nd click of a double-click can still cancel this
            singleClickTimerRef.current = setTimeout(() => {
              singleClickTimerRef.current = null;
              togglePlay();
            }, 300);
          }
        }}
        onTouchStart={() => {
          handleTouchStart();
        }}
        onTouchEnd={() => {
          handleTouchEnd();
        }}
        onTouchCancel={() => {
          handleTouchEnd();
        }}
      />

      {/* Error Display */}
      {hasError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-50">
          <div className="text-center">
            <p className="text-red-400 text-lg mb-2">⚠️ Playback Error</p>
            <p className="text-white">{errorMessage}</p>
          </div>
        </div>
      )}



      {/* Speed Overlay Animation - shows when holding spacebar OR changing speed with Shift+>/< */}
      {showSpeedOverlay && (
        <div className="absolute top-2 sm:top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-black/70 px-4 sm:px-5 py-1.5 sm:py-2 rounded-full shadow-lg">
            <span className="text-white font-bold text-sm sm:text-lg">{speedOverlayValue}</span>
          </div>
        </div>
      )}

      {/* Open File Button - Top Left (shows/hides with controls) */}
      {onFileSelect && (
        <button
          onClick={handleOpenFileDialog}
          className={`absolute left-2 sm:left-4 top-2 sm:top-4 z-30 bg-black/70 hover:bg-black/80 text-white p-1.5 sm:p-2 rounded-full transition-all duration-300 hover:scale-110 group active:scale-95 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          title="Open Video File"
        >
          <FolderOpen size={18} className="sm:w-5 sm:h-5 group-hover:text-red-400 transition-colors" />
        </button>
      )}

      {/* Overlay Animations */}
      <ActionOverlay overlayState={overlayState} />

      {/* Bottom Controls */}
      <PlayerControls
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        isMuted={isMuted}
        visible={showControls}
        playbackSpeed={playbackSpeed}
        hasSubtitles={!!subtitlesSrc}
        subtitlesEnabled={subtitlesEnabled}
        isLooping={isLooping}
        onPlayPause={togglePlay}
        onSeek={handleSeekChange}
        onSeekStart={handleSeekStart}
        onSeekEnd={handleSeekEnd}
        onVolumeChange={(e) => handleVolumeChange(parseFloat(e.target.value), false)}
        onToggleMute={() => {
            if (videoRef.current) {
                const nextMute = !isMuted;
                videoRef.current.muted = nextMute;
                setIsMuted(nextMute);
            }
        }}
        onToggleFullscreen={toggleFullscreen}
        onSpeedChange={changeSpeed}
        onToggleSubtitles={() => setSubtitlesEnabled(!subtitlesEnabled)}
        onToggleLoop={toggleLoop}
        onTogglePip={togglePip}
        isPip={isPip}
        isFullscreen={isFullscreen}
        isRemainingTimeMode={isRemainingTimeMode}
        onToggleTimeDisplay={toggleTimeDisplay}
        onNext={onNext}
        onPrev={onPrev}
        hasNext={hasNext}
        hasPrev={hasPrev}
        onToggleQueue={playlistInfo && playlistInfo.length > 1 ? () => setShowQueue(q => !q) : undefined}
        showQueue={showQueue}
      />

      {/* Queue Panel */}
      {showQueue && playlistInfo && playlistInfo.length > 1 && (
        <QueuePanel
          playlist={playlistInfo}
          currentIndex={currentPlaylistIndex ?? 0}
          onJumpTo={onJumpTo ?? (() => {})}
          onReorder={onReorderPlaylist ?? (() => {})}
          onClose={() => setShowQueue(false)}
        />
      )}

      {/* Library Button (visible when controls are shown, including fullscreen) */}
      {showLibraryButton && onOpenLibrary && (
        <button
          onClick={onOpenLibrary}
          className={`absolute top-2 right-2 sm:top-4 sm:right-4 z-40 bg-black/60 hover:bg-black/70 text-white p-1.5 sm:p-2 rounded-full transition-all duration-300 active:scale-95 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          title="Video Library"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-5 sm:h-5">
            <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
          </svg>
        </button>
      )}

      {/* Error Display with Codec Support */}
      {hasError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-sm z-40">
          <div className="bg-neutral-900 border border-red-500/50 rounded-lg p-4 sm:p-6 max-w-md mx-auto">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle size={20} className="text-red-500" />
              <h3 className="font-bold text-red-50">Video Error</h3>
            </div>
            <p className="text-sm text-neutral-300 mb-4">{errorMessage}</p>
            
            {/* Retry Button */}
            <button
              onClick={() => {
                setHasError(false);
                setErrorMessage('');
                if (videoRef.current) {
                  videoRef.current.load();
                  videoRef.current.play().catch(() => {});
                }
              }}
              className="w-full mb-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors active:scale-95"
            >
              Try Again
            </button>

            {/* Choose Another Video (Fix #5) */}
            {onChangeVideo && (
              <button
                onClick={() => {
                  setHasError(false);
                  setErrorMessage('');
                  onChangeVideo();
                }}
                className="w-full mb-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white text-sm font-medium rounded-lg transition-colors active:scale-95 border border-neutral-700"
              >
                Choose Another Video
              </button>
            )}

            {/* Go Home (Fix #5) */}
            {onGoHome && (
              <button
                onClick={() => {
                  setHasError(false);
                  setErrorMessage('');
                  onGoHome();
                }}
                className="w-full mb-4 px-4 py-2 bg-neutral-800/60 hover:bg-neutral-700 text-neutral-300 text-sm font-medium rounded-lg transition-colors active:scale-95 border border-neutral-700/50"
              >
                Go Home
              </button>
            )}

            {/* Codec Support Info */}
            <div className="bg-neutral-800 rounded p-3 text-xs">
              <p className="font-semibold text-neutral-400 mb-2">Supported Formats:</p>
              <div className="space-y-1 text-neutral-400">
                {Object.entries(codecSupport).slice(0, 8).map(([codec, supported]) => (
                  <div key={codec} className="flex items-center gap-2">
                    <span className={supported ? 'text-green-500' : 'text-red-500'}>
                      {supported ? '✓' : '✗'}
                    </span>
                    <span className="capitalize">{codec}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;