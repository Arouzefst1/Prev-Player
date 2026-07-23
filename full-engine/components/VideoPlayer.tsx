import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FolderOpen, AlertCircle, X, Play, RotateCcw, Music, Subtitles, AudioLines, Check } from 'lucide-react';
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
import {
  initMpv, subscribeMpv, mpvLoad, mpvSetPaused, mpvSeekAbsolute, mpvSetVolume,
  mpvSetMuted, mpvSetSpeed, mpvSetLoop, mpvAddSubtitle, mpvSetSubtitleVisible,
  mpvSetAudioTrack, mpvSetSubtitleTrack,
  type MpvState, type MpvTrack,
} from '../mpv';
import { settingsStore } from '../settings';

/**
 * Minimal HTMLVideoElement-like surface backed by mpv. We point `videoRef` at one
 * of these so the existing player handlers (which read/write
 * videoRef.current.currentTime / volume / paused / play() / pause() …) keep working
 * unchanged — they just drive mpv instead of a <video> tag. Reads come from the
 * latest observed mpv state; writes fire mpv commands (async, fire-and-forget).
 */
interface EngineAdapter {
  play(): void;
  pause(): void;
  readonly paused: boolean;
  currentTime: number;
  readonly duration: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  defaultPlaybackRate: number;
  loop: boolean;
}

interface PlaylistItemInfo {
  id: string;
  name: string;
  thumbnail?: string;
}

interface VideoPlayerProps {
  src: string;
  /** Native file-system path for the mpv engine (mpv can't open asset:// URLs). */
  path?: string;
  videoId?: string;
  subtitlesSrc?: string | null;
  autoPlay?: boolean;
  isAudio?: boolean;
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
  // Background download progress (from "Watch now") → shows an in-player ring.
  downloadProgress?: { bytes: number; total: number } | null;
  // Settings-driven behaviour
  resumeEnabled?: boolean;   // resume from last position (default true)
  defaultVolume?: number;    // starting volume 0–1 (default 1)
  defaultSpeed?: number;     // starting playback speed (default 1)
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
  src, path, videoId, subtitlesSrc, autoPlay = false, isAudio = false,
  onEnded, onChangeVideo, onFileSelect, onPlayStateChange,
  onNext, onPrev, hasNext, hasPrev,
  playlist: playlistInfo, currentIndex: currentPlaylistIndex, onJumpTo,
  onReorderPlaylist,
  startFullscreen,
  onOpenLibrary, showLibraryButton,
  fullscreenContainerRef,
  onVideoRef,
  onGoHome,
  downloadProgress,
  resumeEnabled = true,
  defaultVolume = 1,
  defaultSpeed = 1,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // `videoRef` now points at an mpv-backed adapter instead of a <video> element.
  const videoRef = useRef<EngineAdapter | null>(null);
  // Latest observed mpv state — the adapter's getters read from here.
  const mpvStateRef = useRef<MpvState>({
    paused: true, currentTime: 0, duration: 0, volume: 1, muted: false, speed: 1, ended: false,
    tracks: [], audioId: null, subId: null, videoAspect: null,
  });
  const endedFiredRef = useRef<boolean>(false);
  const lastTimeUiRef = useRef<number>(0); // throttles the on-screen time/seek-bar
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
  const resumePromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstSrcRef = useRef<boolean>(true);

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
  // mpv embedded tracks (audio + subtitle) — the native engine's superpower.
  const [tracks, setTracks] = useState<MpvTrack[]>([]);
  const [audioId, setAudioId] = useState<number | null>(null);
  const [subId, setSubId] = useState<number | null>(null);
  const [trackMenu, setTrackMenu] = useState<null | 'audio' | 'sub'>(null);
  
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
  // MX Player–style resume prompt: the time (sec) we resumed from, or null when hidden.
  const [resumeFrom, setResumeFrom] = useState<number | null>(null);

  // --- Effect: Codec Support Detection ---
  useEffect(() => {
    const support = detectCodecSupport();
    setCodecSupport(support);
    console.log('Detected codec support:', support);
  }, []);

  // Mirror frequently-changing props/state into refs so the mount-once mpv
  // subscription always sees current values (the player isn't remounted per video).
  const isDraggingRef = useRef(false);
  const videoIdRef = useRef(videoId);
  const onEndedRef = useRef(onEnded);
  const onPlayStateChangeRef = useRef(onPlayStateChange);
  const resumeEnabledRef = useRef(resumeEnabled);
  useEffect(() => { isDraggingRef.current = isDragging; }, [isDragging]);
  useEffect(() => {
    videoIdRef.current = videoId;
    onEndedRef.current = onEnded;
    onPlayStateChangeRef.current = onPlayStateChange;
    resumeEnabledRef.current = resumeEnabled;
  });

  // --- Effect: Initialize the mpv engine + build the <video>-like adapter. ---
  useEffect(() => {
    // The adapter translates the player's HTMLVideoElement-style calls into mpv.
    const adapter: EngineAdapter = {
      play() { mpvSetPaused(false); },
      pause() { mpvSetPaused(true); },
      get paused() { return mpvStateRef.current.paused; },
      get currentTime() { return mpvStateRef.current.currentTime; },
      set currentTime(t: number) { mpvSeekAbsolute(t); },
      get duration() { return mpvStateRef.current.duration; },
      get volume() { return mpvStateRef.current.volume; },
      set volume(v: number) { mpvSetVolume(v); },
      get muted() { return mpvStateRef.current.muted; },
      set muted(m: boolean) { mpvSetMuted(m); },
      set playbackRate(r: number) { mpvSetSpeed(r); },
      get playbackRate() { return mpvStateRef.current.speed; },
      set defaultPlaybackRate(_r: number) { /* mpv re-applies speed per file */ },
      get defaultPlaybackRate() { return mpvStateRef.current.speed; },
      set loop(l: boolean) { mpvSetLoop(l); },
      get loop() { return false; },
    };
    videoRef.current = adapter;
    onVideoRef?.(adapter as any);

    let unsub = () => {};
    initMpv().then((ok) => {
      if (!ok) return; // not in Tauri (plain browser) — nothing to drive
      unsub = subscribeMpv((s) => {
        const prevPaused = mpvStateRef.current.paused;
        mpvStateRef.current = s; // always exact — the adapter's getters read this

        // mpv pushes time-pos dozens of times a second. Re-rendering the whole
        // player that often is what made the UI lag, so the *display* time is
        // throttled to ~6 Hz. Everything else only re-renders when it changes,
        // because React bails out on identical values.
        const tNow = performance.now();
        if (!isDraggingRef.current && (tNow - lastTimeUiRef.current > 160 || s.currentTime === 0)) {
          lastTimeUiRef.current = tNow;
          setCurrentTime(s.currentTime);
        }
        setDuration(s.duration);
        setIsPlaying(!s.paused);
        setVolume(s.volume);
        setIsMuted(s.muted);
        setPlaybackSpeed(s.speed);
        setTracks(s.tracks);
        setAudioId(s.audioId);
        setSubId(s.subId);

        if (prevPaused !== s.paused) {
          onPlayStateChangeRef.current?.(!s.paused);
          // Capture the position the moment playback pauses (covers short views and
          // pausing right before leaving), not only on the 5s tick.
          if (s.paused && videoIdRef.current && s.currentTime > 0 && s.duration > 0) {
            lastProgressSaveRef.current = Date.now();
            saveVideoProgress(videoIdRef.current, s.currentTime, s.duration);
          }
        }

        // Throttled resume-progress save (during playback).
        const now = Date.now();
        if (now - lastProgressSaveRef.current > 5000 && videoIdRef.current && s.currentTime > 0 && s.duration > 0) {
          lastProgressSaveRef.current = now;
          saveVideoProgress(videoIdRef.current, s.currentTime, s.duration);
        }

        // End-of-file → advance the playlist (once per file).
        if (s.ended && !endedFiredRef.current) {
          endedFiredRef.current = true;
          setIsPlaying(false);
          setShowControls(true);
          onEndedRef.current?.();
        } else if (!s.ended) {
          endedFiredRef.current = false;
        }
      });
    });

    return () => {
      unsub();
      onVideoRef?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Effect: Apply the user's default volume / speed once mpv is ready. ---
  // mpv keeps these as global properties across files, so setting them once at
  // startup makes every clip start at the chosen volume/speed.
  useEffect(() => {
    let cancelled = false;
    initMpv().then((ok) => {
      if (!ok || cancelled) return;
      mpvSetVolume(defaultVolume).catch(() => {});
      mpvSetSpeed(defaultSpeed).catch(() => {});
      userSpeedRef.current = defaultSpeed;
      savedSpeedRef.current = defaultSpeed;
      setVolume(defaultVolume);
      setPlaybackSpeed(defaultSpeed);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Resume-from-last-position is handled inside the file-load effect below, right
  // after mpv has the file open — that's the only moment a seek reliably lands.)

  // Clear the resume-prompt timer on unmount.
  useEffect(() => () => {
    if (resumePromptTimerRef.current) clearTimeout(resumePromptTimerRef.current);
  }, []);

  // --- Effect: Load the current file into mpv whenever the path changes. ---
  // mpv stays alive across videos (no remount); we just `loadfile` the new clip.
  useEffect(() => {
    // Reset per-video state so resume/error/progress apply to the new clip.
    hasRestoredProgressRef.current = false;
    lastProgressSaveRef.current = 0;
    endedFiredRef.current = false;
    if (resumePromptTimerRef.current) clearTimeout(resumePromptTimerRef.current);
    setResumeFrom(null);
    setHasError(false);
    setErrorMessage('');
    setCurrentTime(0);
    setDuration(0);

    if (!path) return;
    let cancelled = false;
    (async () => {
      const ok = await initMpv();
      if (!ok || cancelled) return;

      // Resolve the resume position BEFORE loading, so mpv opens the file AT it
      // (a seek fired after load gets dropped on some setups; the start option won't).
      let startAt = 0;
      if (resumeEnabledRef.current && videoId) {
        const saved = loadVideoProgress(videoId);
        if (saved && saved >= 5) startAt = saved;
      }

      try {
        await mpvLoad(path, startAt);
      } catch (e: any) {
        if (cancelled) return;
        console.error('mpv load failed:', e);
        const msg = typeof e === 'string' ? e : (e?.message ?? String(e));
        setHasError(true);
        setErrorMessage(`Couldn't open this ${path.startsWith('http') ? 'stream' : 'file'}. ${msg}`);
        return;
      }
      if (cancelled) return;

      // Offer "Start over" since we resumed partway in.
      if (startAt > 0) {
        setCurrentTime(startAt);
        setResumeFrom(startAt);
        if (resumePromptTimerRef.current) clearTimeout(resumePromptTimerRef.current);
        resumePromptTimerRef.current = setTimeout(() => setResumeFrom(null), 5000);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // "Start over" → restart from the beginning and dismiss the prompt.
  const handleStartOver = useCallback(() => {
    if (resumePromptTimerRef.current) clearTimeout(resumePromptTimerRef.current);
    setResumeFrom(null);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      setCurrentTime(0);
      videoRef.current.play();
    }
  }, []);

  // --- Effect: Flush playback position on hide/unmount. ---
  // Continuous saving happens in the mpv subscription; here we just make sure the
  // latest position is persisted when the window is hidden or the player unmounts.
  useEffect(() => {
    const flush = () => {
      const s = mpvStateRef.current;
      if (videoIdRef.current && s.currentTime > 0 && s.duration > 0) {
        saveVideoProgress(videoIdRef.current, s.currentTime, s.duration);
      }
    };
    const onVisibilityChange = () => { if (document.hidden) flush(); };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      flush();
    };
  }, []);

  // --- Effect: Subtitle visibility (mpv). ---
  // mpv auto-loads subtitle tracks embedded in the container; we just toggle their
  // visibility. (External .srt sidecar loading via mpvAddSubtitle is a later pass —
  // it needs the subtitle's native path, not an asset URL.)
  useEffect(() => {
    mpvSetSubtitleVisible(subtitlesEnabled).catch(() => {});
  }, [subtitlesEnabled, path]);

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

  // Fullscreen for the native engine uses the Tauri WINDOW (not DOM
  // requestFullscreen): the OS window goes fullscreen so mpv's child surface
  // resizes with it, and there's no opaque DOM ::backdrop hiding the video.
  const toggleFullscreen = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setIsFullscreen(next);
    } catch (e) {
      console.error('fullscreen error', e);
    }
  }, []);

  const exitFullscreen = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setFullscreen(false);
      setIsFullscreen(false);
    } catch {}
  }, []);

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

  // --- Picture-in-Picture (native engine) ---
  // Browser PiP only works with a <video> element, which we no longer have. We
  // emulate PiP by shrinking the whole OS window to a small, borderless,
  // always-on-top mini-player in the bottom-right corner (mpv keeps rendering as
  // the window resizes). Toggling again restores the previous size/position.
  const prePipRef = useRef<{ w: number; h: number; x: number; y: number; fs: boolean } | null>(null);
  const pipAspectRef = useRef<number>(16 / 9);
  const togglePip = useCallback(async () => {
    try {
      const winApi = await import('@tauri-apps/api/window');
      const win = winApi.getCurrentWindow();

      if (prePipRef.current) {
        // Exit mini-player → restore EXACTLY what it was (fullscreen or windowed).
        const p = prePipRef.current;
        prePipRef.current = null;
        setIsPip(false);
        await win.setAlwaysOnTop(false);
        await win.setDecorations(true);
        if (p.fs) {
          await win.setFullscreen(true);
        } else {
          await win.setSize(new winApi.PhysicalSize(p.w, p.h));
          await win.setPosition(new winApi.PhysicalPosition(p.x, p.y));
        }
        return;
      }

      // Enter mini-player. Remember whether we were fullscreen + the window rect.
      const wasFs = await win.isFullscreen();
      await win.setFullscreen(false);
      const size = await win.innerSize();      // PhysicalSize
      const pos = await win.outerPosition();    // PhysicalPosition
      prePipRef.current = { w: size.width, h: size.height, x: pos.x, y: pos.y, fs: wasFs };

      const mon = await winApi.currentMonitor();
      const sf = mon?.scaleFactor ?? 1;
      // Size the window to the VIDEO's aspect ratio so there are no black bars.
      const aspect = mpvStateRef.current.videoAspect || 16 / 9;
      pipAspectRef.current = aspect;
      const miniW = Math.round(440 * sf);
      const miniH = Math.round(miniW / aspect);
      await win.setDecorations(false);
      await win.setResizable(true);
      await win.setAlwaysOnTop(true);
      await win.setSize(new winApi.PhysicalSize(miniW, miniH));
      if (mon) {
        const margin = Math.round(24 * sf);
        const x = mon.position.x + mon.size.width - miniW - margin;
        const y = mon.position.y + mon.size.height - miniH - margin - Math.round(48 * sf);
        await win.setPosition(new winApi.PhysicalPosition(x, y));
      }
      setIsPip(true);
    } catch (e) {
      console.error('PiP (mini-window) error', e);
    }
  }, []);

  // While in PiP, keep the window locked to the video's aspect ratio as the user
  // resizes it — so it stays borderless (no letterbox) and both axes scale together.
  useEffect(() => {
    if (!isPip) return;
    let unlisten = () => {};
    let correcting = false;
    (async () => {
      const winApi = await import('@tauri-apps/api/window');
      const win = winApi.getCurrentWindow();
      unlisten = await win.onResized(({ payload }) => {
        if (correcting) return;
        const aspect = pipAspectRef.current || 16 / 9;
        const w = payload.width;
        const expectedH = Math.round(w / aspect);
        if (Math.abs(payload.height - expectedH) > 2) {
          correcting = true;
          win.setSize(new winApi.PhysicalSize(w, expectedH)).finally(() => {
            setTimeout(() => { correcting = false; }, 60);
          });
        }
      });
    })();
    return () => unlisten();
  }, [isPip]);

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



  // NOTE: playback state (time, duration, ended, play/pause) is driven by the mpv
  // property subscription in the init effect above — no <video> event listeners.

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
        case 'Escape':
          // Tauri window fullscreen doesn't auto-exit on Esc like DOM fullscreen.
          if (isFullscreen) exitFullscreen();
          else if (showQueue) setShowQueue(false);
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
            // Toggle subtitles on/off (drives mpv sub-visibility via the effect).
            setSubtitlesEnabled(prev => !prev);
            break;
        case '>': { // Shift + . — faster by the configurable step
          const step = settingsStore.get().speedStep ?? 0.5;
          changeSpeed(Math.min(4, +(playbackSpeed + step).toFixed(2)), true);
          break;
        }
        case '<': { // Shift + , — slower by the configurable step
          const step = settingsStore.get().speedStep ?? 0.5;
          changeSpeed(Math.max(0.25, +(playbackSpeed - step).toFixed(2)), true);
          break;
        }
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
  }, [togglePlay, skip, volume, toggleFullscreen, exitFullscreen, togglePip, isFullscreen, showQueue, isMuted, isPlaying, resetControlsTimer, handleVolumeChange, playbackSpeed, changeSpeed, subtitlesEnabled, seekToPercentage, triggerOverlay, toggleLoop, isLooping]);

  // Mouse side buttons (back/forward) → previous/next video, or seek ±10s if none.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); if (hasPrev) onPrev?.(); else skip(-10); }
      else if (e.button === 4) { e.preventDefault(); if (hasNext) onNext?.(); else skip(10); }
    };
    // Some builds fire history nav on these; block it and take over.
    const block = (e: MouseEvent) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousedown', block);
    return () => { window.removeEventListener('mouseup', onMouseUp); window.removeEventListener('mousedown', block); };
  }, [hasPrev, hasNext, onPrev, onNext, skip]);


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
      className={`relative w-full h-full bg-transparent group overflow-hidden flex flex-col justify-center select-none outline-none ${showControls ? '' : 'cursor-none'}`}
      tabIndex={0} // Allow focus
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Transparent click-surface. The actual picture is rendered by the mpv
          engine BEHIND the (transparent) WebView; this layer only captures
          clicks/taps for play-pause + double-click fullscreen. */}
      <div
        className={`absolute inset-0 w-full h-full pointer-events-auto ${isPip ? 'cursor-move' : (showControls ? 'cursor-pointer' : 'cursor-none')}`}
        onPointerDown={(e) => {
          // In PiP the whole body drags the borderless window — but only once the
          // pointer actually moves, so a plain click still toggles play/pause.
          if (!isPip || e.button !== 0) return;
          const sx = e.clientX, sy = e.clientY;
          const move = (me: PointerEvent) => {
            if (Math.abs(me.clientX - sx) + Math.abs(me.clientY - sy) > 6) {
              cleanup();
              import('@tauri-apps/api/window').then(w => w.getCurrentWindow().startDragging().catch(() => {}));
            }
          };
          const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', cleanup); };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', cleanup);
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
            // Double-click: exit PiP if in PiP, else toggle fullscreen.
            lastClickMsRef.current = 0; // reset so a triple-click doesn't re-trigger
            if (isPip) togglePip(); else toggleFullscreen();
          } else {
            lastClickMsRef.current = now;
            // Defer so the 2nd click of a double-click can still cancel this
            singleClickTimerRef.current = setTimeout(() => {
              singleClickTimerRef.current = null;
              togglePlay();
            }, 300);
          }
        }}
        onTouchStart={() => { handleTouchStart(); }}
        onTouchEnd={() => { handleTouchEnd(); }}
        onTouchCancel={() => { handleTouchEnd(); }}
      />

      {/* Audio poster — audio files have no picture, so show a music visual */}
      {isAudio && !hasError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[5] bg-gradient-to-br from-neutral-900 via-black to-neutral-900">
          <div className={`flex items-center justify-center w-28 h-28 sm:w-36 sm:h-36 rounded-full bg-white/5 border border-white/10 ${isPlaying ? 'animate-pulse' : ''}`}>
            <Music size={56} className="text-white/70 sm:w-16 sm:h-16" />
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

      {/* Resume prompt (MX Player–style): video already continues from where it
          was left; this lets the user jump back to the start. Auto-hides after 5s. */}
      {resumeFrom !== null && (
        <div className="absolute right-3 sm:right-4 bottom-20 sm:bottom-24 z-30 animate-fade-in pointer-events-auto">
          <button
            onClick={handleStartOver}
            className="flex items-center gap-1.5 bg-black/80 hover:bg-black/90 text-white text-xs sm:text-sm font-medium rounded-full px-3 sm:px-4 py-2 shadow-lg border border-white/10 transition-colors active:scale-95"
            title="Start from the beginning"
          >
            <RotateCcw size={14} className="shrink-0" />
            Start over
          </button>
        </div>
      )}

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

      {/* In-player download progress ring (background download from "Watch now") */}
      {downloadProgress && (() => {
        const pct = downloadProgress.total ? Math.min(100, Math.round((downloadProgress.bytes / downloadProgress.total) * 100)) : 0;
        const r = 9; const circ = 2 * Math.PI * r;
        return (
          <div className="absolute left-2 sm:left-4 top-14 sm:top-16 z-30 flex items-center gap-2 bg-black/70 rounded-full pl-1.5 pr-3 py-1.5 shadow-lg">
            <svg width="24" height="24" viewBox="0 0 24 24" className="-rotate-90">
              <circle cx="12" cy="12" r={r} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="3" />
              <circle cx="12" cy="12" r={r} fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"
                strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)} style={{ transition: 'stroke-dashoffset 0.3s' }} />
            </svg>
            <span className="text-white text-[11px] font-medium whitespace-nowrap">
              {downloadProgress.total ? `Downloading ${pct}%` : 'Downloading…'}
            </span>
          </div>
        );
      })()}

      {/* Click-away for the track menus */}
      {trackMenu && <div className="fixed inset-0 z-30" onClick={() => setTrackMenu(null)} />}

      {/* Audio + Subtitle track menus — mpv exposes embedded tracks (WebView couldn't). */}
      {(() => {
        const audioTracks = tracks.filter(t => t.type === 'audio');
        const subTracks = tracks.filter(t => t.type === 'sub');
        if (audioTracks.length < 2 && subTracks.length === 0) return null;
        const label = (t: MpvTrack, i: number) => t.title || [t.lang, t.codec].filter(Boolean).join(' · ') || `Track ${i + 1}`;
        return (
          <div className={`absolute top-2 right-12 sm:top-4 sm:right-16 z-40 flex items-center gap-1 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
            {audioTracks.length > 1 && (
              <div className="relative">
                <button onClick={() => setTrackMenu(m => m === 'audio' ? null : 'audio')} title="Audio track" className="bg-black/60 hover:bg-black/70 text-white p-1.5 sm:p-2 rounded-full transition-colors">
                  <AudioLines size={18} className="sm:w-5 sm:h-5" />
                </button>
                {trackMenu === 'audio' && (
                  <div className="absolute top-full right-0 mt-2 w-56 max-h-64 overflow-auto custom-scrollbar bg-black/90 rounded-xl p-1.5 shadow-xl border border-white/10 z-50">
                    <p className="text-[10px] uppercase tracking-wider text-neutral-500 px-2 py-1">Audio</p>
                    {audioTracks.map((t, i) => (
                      <button key={t.id} onClick={() => { mpvSetAudioTrack(t.id); setTrackMenu(null); }}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-sm text-left text-neutral-200 hover:bg-white/10">
                        <span className="truncate">{label(t, i)}</span>
                        {audioId === t.id && <Check size={15} className="text-red-400 shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {subTracks.length > 0 && (
              <div className="relative">
                <button onClick={() => setTrackMenu(m => m === 'sub' ? null : 'sub')} title="Subtitles" className={`bg-black/60 hover:bg-black/70 p-1.5 sm:p-2 rounded-full transition-colors ${subId !== null ? 'text-red-400' : 'text-white'}`}>
                  <Subtitles size={18} className="sm:w-5 sm:h-5" />
                </button>
                {trackMenu === 'sub' && (
                  <div className="absolute top-full right-0 mt-2 w-56 max-h-64 overflow-auto custom-scrollbar bg-black/90 rounded-xl p-1.5 shadow-xl border border-white/10 z-50">
                    <p className="text-[10px] uppercase tracking-wider text-neutral-500 px-2 py-1">Subtitles</p>
                    <button onClick={() => { mpvSetSubtitleTrack(null); setTrackMenu(null); }}
                      className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-sm text-left text-neutral-200 hover:bg-white/10">
                      <span>Off</span>{subId === null && <Check size={15} className="text-red-400 shrink-0" />}
                    </button>
                    {subTracks.map((t, i) => (
                      <button key={t.id} onClick={() => { mpvSetSubtitleTrack(t.id); setTrackMenu(null); }}
                        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-sm text-left text-neutral-200 hover:bg-white/10">
                        <span className="truncate">{label(t, i)}</span>
                        {subId === t.id && <Check size={15} className="text-red-400 shrink-0" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

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
            
            {/* Retry Button — reload the current file into mpv */}
            <button
              onClick={() => {
                setHasError(false);
                setErrorMessage('');
                if (path) mpvLoad(path).catch(() => {});
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

            {/* The mpv engine decodes every common format, so a "codec support"
                list here would be misleading — a failure means the file/stream
                couldn't be opened (moved, deleted, or the share went offline). */}
            <p className="text-[11px] text-neutral-500 leading-relaxed">
              The mpv engine plays virtually every format. This usually means the file was
              moved or deleted — or, for a shared link, the sender stopped sharing.
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default VideoPlayer;