import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FolderOpen } from 'lucide-react';
import PlayerControls from './PlayerControls';
import ActionOverlay from './ActionOverlay';
import { OverlayState, srtToVtt } from '../utils';

interface VideoPlayerProps {
  src: string;
  subtitlesSrc?: string | null;
  autoPlay?: boolean;
  onEnded?: () => void;
  onChangeVideo?: (files: FileList) => void;
}

const VideoPlayer: React.FC<VideoPlayerProps> = ({ src, subtitlesSrc, autoPlay = false, onEnded, onChangeVideo }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastTapRef = useRef<number>(0);
  const spaceHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpaceHeldRef = useRef<boolean>(false);
  const savedSpeedRef = useRef<number>(1);
  const touchStartRef = useRef<number>(0);
  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTouchHoldRef = useRef<boolean>(false);

  // Player State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);
  
  // UI State
  const [showControls, setShowControls] = useState(true);
  const [overlayState, setOverlayState] = useState<OverlayState>({ action: null, id: 0 });
  const [showSpeedOverlay, setShowSpeedOverlay] = useState(false);
  const [showTimeToggle, setShowTimeToggle] = useState(false);
  const [isRemainingTimeMode, setIsRemainingTimeMode] = useState(false);

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

  const triggerOverlay = (action: OverlayState['action'], value?: string | number) => {
    setOverlayState({ action, value, id: Date.now() });
  };

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
    
    // Hide controls after 5 seconds of inactivity if playing
    if (isPlaying) {
        controlsTimeoutRef.current = setTimeout(() => {
            setShowControls(false);
        }, 5000);
    }
  }, [isPlaying]);

  const togglePlay = useCallback(() => {
    if (!videoRef.current) return;
    
    // Ensure container is focused so keyboard shortcuts keep working
    containerRef.current?.focus();

    if (videoRef.current.paused) {
      videoRef.current.play();
      setIsPlaying(true);
      triggerOverlay('play');
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
      triggerOverlay('pause');
      // Keep controls visible when paused
      setShowControls(true);
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    }
  }, []);

  const handleVolumeChange = useCallback((newVolume: number, showOverlay = true) => {
    if (!videoRef.current) return;
    const clamped = Math.max(0, Math.min(1, newVolume));
    videoRef.current.volume = clamped;
    setVolume(clamped);
    if (clamped > 0) setIsMuted(false);
    
    if (showOverlay) {
        if (newVolume > volume) triggerOverlay('volume-up', `${Math.round(clamped * 100)}%`);
        else if (newVolume < volume) triggerOverlay('volume-down', `${Math.round(clamped * 100)}%`);
    }
  }, [volume]);

  const skip = useCallback((amount: number) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime += amount;
    
    if (Math.abs(amount) === 5) {
        triggerOverlay(amount > 0 ? 'forward-5' : 'rewind-5');
    } else {
        triggerOverlay(amount > 0 ? 'forward-10' : 'rewind-10');
    }
    
    resetControlsTimer();
  }, [resetControlsTimer]);

  const changeSpeed = useCallback((newSpeed: number) => {
      if (!videoRef.current) return;
      videoRef.current.playbackRate = newSpeed;
      setPlaybackSpeed(newSpeed);
      // No overlay for manual speed changes
  }, []);

  const seekToPercentage = useCallback((percent: number) => {
      if (!videoRef.current) return;
      const newTime = videoRef.current.duration * (percent / 100);
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
      resetControlsTimer();
  }, [resetControlsTimer]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  // Double-tap to toggle fullscreen
  const handleDoubleTap = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const now = Date.now();
    const DOUBLE_TAP_DELAY = 300; // ms
    
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      // Double tap detected
      e.preventDefault();
      toggleFullscreen();
      lastTapRef.current = 0; // Reset
    } else {
      lastTapRef.current = now;
    }
  }, [toggleFullscreen]);

  // Mobile touch hold for 2x speed
  const handleTouchStart = useCallback(() => {
    touchStartRef.current = Date.now();
    isTouchHoldRef.current = false;

    // Start hold detection timer - 500ms hold activates 2x speed
    holdTimeoutRef.current = setTimeout(() => {
      isTouchHoldRef.current = true;
      savedSpeedRef.current = videoRef.current?.playbackRate || 1;
      if (videoRef.current) {
        videoRef.current.playbackRate = 2;
        setPlaybackSpeed(2);
      }
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
        videoRef.current.playbackRate = savedSpeedRef.current;
        setPlaybackSpeed(savedSpeedRef.current);
      }
      setShowSpeedOverlay(false);
    }
  }, []);

  // Handle file selection for changing video
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && onChangeVideo) {
      onChangeVideo(e.target.files);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  }, [onChangeVideo]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // --- Event Listeners ---

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (autoPlay) {
        video.play().catch(() => {});
        setIsPlaying(true);
    }

    const onTimeUpdate = () => {
      if (!isDragging) {
        setCurrentTime(video.currentTime);
      }
    };
    const onLoadedMetadata = () => {
      setDuration(video.duration);
    };
    const handleEnded = () => {
        setIsPlaying(false);
        setShowControls(true);
        if (onEnded) onEnded();
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('ended', handleEnded);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('ended', handleEnded);
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

      resetControlsTimer();

      // Handle spacebar - hold for 2x speed, tap for play/pause
      if (e.code === 'Space') {
        if (e.repeat) return; // Ignore key repeat
        
        // Start hold detection timer
        spaceHoldTimeoutRef.current = setTimeout(() => {
          // Hold detected - activate 2x speed
          isSpaceHeldRef.current = true;
          savedSpeedRef.current = videoRef.current?.playbackRate || 1;
          if (videoRef.current) {
            videoRef.current.playbackRate = 2;
            setPlaybackSpeed(2);
          }
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
          skip(5);
          break;
        case 'ArrowLeft':
          skip(-5);
          break;
        case 'l':
        case 'L':
          skip(10);
          break;
        case 'j':
        case 'J':
          skip(-10);
          break;
        case 'ArrowUp':
          handleVolumeChange(volume + 0.05);
          break;
        case 'ArrowDown':
          handleVolumeChange(volume - 0.05);
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
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
          changeSpeed(Math.min(2, playbackSpeed + 0.25));
          break;
        case '<': // Shift + ,
          changeSpeed(Math.max(0.25, playbackSpeed - 0.25));
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
            videoRef.current.playbackRate = savedSpeedRef.current;
            setPlaybackSpeed(savedSpeedRef.current);
          }
          setShowSpeedOverlay(false);
        } else {
          // Was a tap, not a hold - toggle play/pause directly
          if (videoRef.current) {
            if (videoRef.current.paused) {
              videoRef.current.play();
              setIsPlaying(true);
              triggerOverlay('play');
            } else {
              videoRef.current.pause();
              setIsPlaying(false);
              triggerOverlay('pause');
            }
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      if (spaceHoldTimeoutRef.current) clearTimeout(spaceHoldTimeoutRef.current);
    };
  }, [togglePlay, skip, volume, toggleFullscreen, isMuted, resetControlsTimer, handleVolumeChange, playbackSpeed, changeSpeed, subtitlesEnabled, seekToPercentage]);


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
      className="relative w-full h-full bg-black group overflow-hidden flex flex-col justify-center select-none outline-none"
      tabIndex={0} // Allow focus
      onContextMenu={(e) => e.preventDefault()}
    >
      <video
        ref={videoRef}
        src={src}
        className="w-full h-full object-contain pointer-events-auto cursor-pointer"
        onClick={(e) => {
          handleDoubleTap(e);
          // Only toggle play on single tap (after timeout to check for double tap)
          setTimeout(() => {
            if (lastTapRef.current !== 0) {
              togglePlay();
              lastTapRef.current = 0;
            }
          }, 300);
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

      {/* Hidden file input for changing video */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* 2x Speed Overlay Animation - only shows when holding spacebar */}
      {showSpeedOverlay && (
        <div className="absolute top-2 sm:top-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-black/70 backdrop-blur-sm px-3 sm:px-4 py-1.5 sm:py-2 rounded-full shadow-lg">
            <span className="text-white font-bold text-sm sm:text-lg">2x</span>
          </div>
        </div>
      )}

      {/* Change Video Button - Top Left (shows/hides with controls) */}
      {onChangeVideo && (
        <button
          onClick={openFilePicker}
          className={`absolute left-2 sm:left-4 top-2 sm:top-4 z-30 bg-black/60 hover:bg-black/80 text-white p-1.5 sm:p-2 rounded-full backdrop-blur-md transition-all duration-300 hover:scale-110 group active:scale-95 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          title="Change Video"
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
        isFullscreen={isFullscreen}
        isRemainingTimeMode={isRemainingTimeMode}
        onToggleTimeDisplay={toggleTimeDisplay}
      />
    </div>
  );
};

export default VideoPlayer;