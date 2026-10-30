import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, Captions, MoreVertical, Download as DownloadIcon, Info, Gauge, Activity, ChevronRight } from 'lucide-react';
import { formatTime } from '../utils';
import { useSettings } from '../settings';
import SpeedPanel from './SpeedPanel';
import SeekPreview, { PREVIEW_WIDTH } from './SeekPreview';
import { useShortcutKeys, withKey } from '../shortcuts';
import LoopButton, { type LoopMode } from './LoopButton';

interface PlayerControlsProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  visible: boolean;
  playbackSpeed: number;
  hasSubtitles: boolean;
  subtitlesEnabled: boolean;
  /** off → play once; all → repeat the queue; one → repeat this video. */
  loopMode: LoopMode;
  /** A queue exists, so the loop button offers all three modes. */
  hasQueueToLoop?: boolean;
  onPlayPause: () => void;
  /** A drag on the seek bar began. */
  onScrubStart: () => void;
  /** The drag is at `time` — a quick (keyframe) seek is fine. */
  onScrub: (time: number) => void;
  /** Let go (or a click) at `time` — land exactly there. */
  onScrubEnd: (time: number) => void;
  onVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onSpeedChange: (speed: number) => void;
  onToggleSubtitles: () => void;
  onToggleLoop: () => void;
  onTogglePip: () => void;
  isPip: boolean;
  isFullscreen: boolean;
  isRemainingTimeMode: boolean;
  onToggleTimeDisplay: () => void;
  // Playlist navigation
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
  // Queue
  onToggleQueue?: () => void;
  showQueue?: boolean;
  /** Save the streaming video to disk. Absent unless it's a stream worth keeping. */
  onDownload?: () => void;
  /** Open the Properties panel for whatever is playing. */
  onShowInfo?: () => void;
  /** Local file behind the seek-bar preview; undefined for streams (time only). */
  previewPath?: string;
  /** Chapter starts — titles in the preview, gaps in the bar. */
  chapters?: { title?: string; time: number }[];
  /** Picture width / height, so preview frames keep their shape. */
  videoAspect?: number | null;
  statsOpen?: boolean;
  onToggleStats?: () => void;
  /** The key that toggles stats, shown in the menu ("I"). */
  statsKey?: string;
}

const PlayerControls: React.FC<PlayerControlsProps> = ({
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  visible,
  playbackSpeed,
  hasSubtitles,
  subtitlesEnabled,
  loopMode,
  hasQueueToLoop,
  onPlayPause,
  onScrubStart,
  onScrub,
  onScrubEnd,
  onVolumeChange,
  onToggleMute,
  onToggleFullscreen,
  onSpeedChange,
  onToggleSubtitles,
  onToggleLoop,
  onTogglePip,
  isPip,
  isFullscreen,
  isRemainingTimeMode,
  onToggleTimeDisplay,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  onToggleQueue,
  showQueue,
  onDownload,
  onShowInfo,
  previewPath,
  chapters,
  videoAspect,
  statsOpen,
  onToggleStats,
  statsKey,
}) => {
  // null → closed; 'menu' → Speed / Stats for nerds; 'speed' → the speed panel.
  const [settingsView, setSettingsView] = useState<null | 'menu' | 'speed'>(null);
  const showSettings = settingsView !== null;
  const settingsRef = useRef<HTMLDivElement>(null);

  // The seek bar follows the pointer itself, not the player: while hovering or
  // dragging, the fill, the dot, the preview card, the line joining them and the
  // time all come from where the pointer is, in the same frame. (Driving them
  // from the player's time made each move wait for a seek and a re-render of the
  // whole player, so they trailed the cursor.) Pointer capture keeps a drag going
  // when the pointer wanders off the bar.
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  /** Where a drag is, in px from the bar's left; null when not dragging. */
  const [scrubX, setScrubX] = useState<number | null>(null);
  const scrubRef = useRef<number | null>(null);
  const frame = useRef(0);
  const pendingX = useRef<number | null>(null);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarWidth(el.offsetWidth));
    ro.observe(el);
    setBarWidth(el.offsetWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const xOf = (clientX: number) => {
    const r = barRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? Math.max(0, Math.min(r.width, clientX - r.left)) : 0;
  };
  const timeOf = (x: number) => (barWidth > 0 && duration ? (x / barWidth) * duration : 0);

  /** One state update per frame, however fast the pointer reports. */
  const follow = (x: number) => {
    pendingX.current = x;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const px = pendingX.current;
      if (px === null) return;
      setHoverX(px);
      if (scrubRef.current !== null) {
        scrubRef.current = px;
        setScrubX(px);
        onScrub(timeOf(px));
      }
    });
  };

  const endScrub = (x: number) => {
    if (scrubRef.current === null) return;
    scrubRef.current = null;
    setScrubX(null);
    onScrubEnd(timeOf(x));
  };

  // The controls fading out mid-hover would leave a card floating over the video.
  useEffect(() => {
    if (visible) return;
    setHoverX(null);
    if (scrubRef.current !== null) endScrub(scrubRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const scrubbing = scrubX !== null;
  const shownTime = scrubbing ? timeOf(scrubX!) : currentTime;
  const progressPercent = duration ? Math.min(100, (shownTime / duration) * 100) : 0;
  const preview = (() => {
    const x = scrubX ?? hoverX;
    if (!duration || barWidth <= 0 || x === null) return null;
    const time = timeOf(x);
    const half = previewPath ? PREVIEW_WIDTH / 2 : 36;
    const chapter = chapters?.reduce<string | undefined>((found, c) => (c.time <= time ? c.title ?? found : found), undefined);
    return { time, chapter, left: Math.max(half, Math.min(barWidth - half, x)), x };
  })();
  const [appSettings] = useSettings();
  const speedStep = appSettings.speedStep ?? 0.5;
  const keys = useShortcutKeys();

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
    return Math.max(0, duration - shownTime);
  };

  // Close settings when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsView(null);
      }
    };

    if (showSettings) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSettings]);

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 sm:px-4 pb-2 sm:pb-4 pt-8 sm:pt-14 transition-all duration-200 ease-out z-20 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
    >
      {/* Progress Bar Container */}
      <div
        ref={barRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration || 0)}
        aria-valuenow={Math.round(shownTime)}
        className="relative group w-full h-2 sm:h-4 mb-1.5 sm:mb-2 cursor-pointer flex items-center touch-none select-none"
        onPointerDown={(e) => {
          if (e.button !== 0 || !duration) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const x = xOf(e.clientX);
          scrubRef.current = x;
          setScrubX(x);
          setHoverX(x);
          onScrubStart();
          onScrub(timeOf(x));
        }}
        onPointerMove={(e) => follow(xOf(e.clientX))}
        onPointerUp={(e) => endScrub(xOf(e.clientX))}
        onPointerCancel={() => { if (scrubRef.current !== null) endScrub(scrubRef.current); }}
        onPointerLeave={() => { if (scrubRef.current === null) { pendingX.current = null; setHoverX(null); } }}
      >
        {preview && (
          <SeekPreview
            path={previewPath}
            time={preview.time}
            duration={duration}
            left={preview.left}
            chapter={preview.chapter}
            aspect={videoAspect ?? 16 / 9}
          />
        )}
        {/* The line joining the card to the exact spot on the bar. */}
        {preview && (
          <div
            className="pointer-events-none absolute bottom-1/2 w-[2px] -translate-x-1/2 rounded-full bg-gradient-to-b from-white/70 to-white/30 z-20"
            style={{ left: preview.x, height: 'calc(50% + 12px)' }}
          />
        )}

        {/* Track Background */}
        <div className="absolute w-full h-1 group-hover:h-1.5 transition-[height] duration-150 bg-white/30 rounded-full overflow-hidden">
            {/* How far the pointer reaches — a lighter band ahead of the playhead */}
            {preview && !scrubbing && (
              <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: preview.x }} />
            )}
             {/* Played */}
            <div
                className="h-full bg-red-600 relative"
                style={{ width: `${progressPercent}%` }}
            />
            {/* Chapter breaks */}
            {duration > 0 && chapters?.map(c => c.time > 0.5 && c.time < duration - 0.5 && (
              <div key={c.time} className="absolute inset-y-0 w-[3px] -ml-[1.5px] bg-black/70" style={{ left: `${(c.time / duration) * 100}%` }} />
            ))}
        </div>

        {/* Hover dot: where a click would land */}
        {preview && !scrubbing && (
          <div
            className="pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-white shadow-[0_0_6px_rgba(0,0,0,0.6)] z-20"
            style={{ left: preview.x }}
          />
        )}

        {/* Thumb: the playhead (follows the pointer exactly while dragging — no easing) */}
        <div
            className={`pointer-events-none absolute h-2 sm:h-3 w-2 sm:w-3 bg-red-600 rounded-full shadow-[0_0_10px_rgba(220,38,38,0.8)] top-1/2 -translate-y-1/2 -ml-1 sm:-ml-1.5 transition-transform duration-100 group-hover:scale-100 ${scrubbing ? 'scale-150' : 'scale-0'}`}
            style={{ left: `${progressPercent}%` }}
        />
      </div>

      {/* Buttons Row - Responsive Layout */}
      <div className="flex items-center justify-between flex-wrap gap-1.5 sm:gap-4">
        {/* Left Controls */}
        <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
          {/* Previous Track */}
          {hasPrev && (
            <button
              onClick={onPrev}
              className="text-white/70 hover:text-white transition-colors p-1 active:scale-90"
              title="Previous"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="sm:w-6 sm:h-6">
                <rect x="3" y="5" width="3" height="14" rx="1" />
                <polygon points="21,5 9,12 21,19" />
              </svg>
            </button>
          )}

          <button
            onClick={onPlayPause}
            className="text-white hover:text-gray-200 transition-colors p-1 sm:p-1.5 active:scale-95"
            title={withKey(isPlaying ? 'Pause' : 'Play', keys.playPause)}
          >
            {isPlaying ? <Pause size={24} className="sm:w-7 sm:h-7" fill="currentColor" /> : <Play size={24} className="sm:w-7 sm:h-7" fill="currentColor" />}
          </button>

          {/* Next Track */}
          {hasNext && (
            <button
              onClick={onNext}
              className="text-white/70 hover:text-white transition-colors p-1 active:scale-90"
              title="Next"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="sm:w-6 sm:h-6">
                <polygon points="3,5 15,12 3,19" />
                <rect x="18" y="5" width="3" height="14" rx="1" />
              </svg>
            </button>
          )}

          {/* Volume Controls - Animated SVG */}
          <div className="flex items-center gap-1 sm:gap-2 group/vol relative">
            <button onClick={onToggleMute} className="text-white hover:text-gray-200 transition-colors p-1 active:scale-95">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="sm:w-6 sm:h-6 transition-transform duration-150">
                {/* Speaker body */}
                <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white" />
                {isMuted || volume === 0 ? (
                  /* X mark for muted */
                  <>
                    <line x1="16" y1="9" x2="22" y2="15" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
                    <line x1="22" y1="9" x2="16" y2="15" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
                  </>
                ) : (
                  /* Animated wave arcs based on volume level */
                  <>
                    <path
                      d="M15.5 8.5a3.5 3.5 0 010 7"
                      stroke="white"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="transition-all duration-300"
                      style={{
                        opacity: volume > 0 ? 1 : 0,
                        transform: volume > 0 ? 'scaleY(1)' : 'scaleY(0)',
                        transformOrigin: 'center',
                      }}
                    />
                    <path
                      d="M17.5 6.5a6.5 6.5 0 010 11"
                      stroke="white"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="transition-all duration-300"
                      style={{
                        opacity: volume > 0.33 ? 1 : 0,
                        transform: volume > 0.33 ? 'scaleY(1)' : 'scaleY(0)',
                        transformOrigin: 'center',
                      }}
                    />
                    <path
                      d="M19.5 4.5a9.5 9.5 0 010 15"
                      stroke="white"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="transition-all duration-300"
                      style={{
                        opacity: volume > 0.66 ? 1 : 0,
                        transform: volume > 0.66 ? 'scaleY(1)' : 'scaleY(0)',
                        transformOrigin: 'center',
                      }}
                    />
                  </>
                )}
              </svg>
            </button>
            <div className="hidden sm:flex w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300 ease-out items-center">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={onVolumeChange}
                className="w-20 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-white mx-2"
              />
            </div>
          </div>

          {/* Loop — plain on/off for a single video; cycles off → repeat queue
              → repeat one once there's a queue to repeat (see LoopButton). */}
          <LoopButton mode={loopMode} hasQueue={!!hasQueueToLoop} onCycle={onToggleLoop} size={22} />

          {/* Time Display - Next to Volume */}
          <button 
            onClick={onToggleTimeDisplay}
            className="text-white hover:text-gray-200 transition-colors p-1 sm:p-1.5 active:scale-95 text-xs sm:text-sm font-medium whitespace-nowrap"
            title="Click to toggle remaining time"
          >
            {isRemainingTimeMode ? (
              <span className="flex items-center gap-1">
                <span className="text-red-400">-</span>
                {formatTime(getRemainingTime())}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                {formatTime(shownTime)} <span className="text-neutral-400">/</span> {formatTime(duration)}
              </span>
            )}
          </button>
        </div>

        {/* Right Controls - Collapsible on Mobile */}
        <div className="flex items-center gap-1.5 sm:gap-4 relative">
          
          {/* Caption Toggle - Always visible if subtitles exist */}
          {hasSubtitles && (
            <button 
                onClick={onToggleSubtitles}
                className={`transition-colors p-1 active:scale-95 ${subtitlesEnabled ? 'text-white border-b-2 border-red-600' : 'text-white/70 hover:text-white'}`}
                title={withKey('Subtitles/CC', keys.subtitles)}
            >
                <Captions size={18} className="sm:w-6 sm:h-6" />
            </button>
          )}

          {/* Codec, resolution, frame rate, and where the file actually lives. */}
          {onShowInfo && (
            <button
              onClick={onShowInfo}
              className="text-white/70 hover:text-white transition-colors p-1 active:scale-95"
              title="Properties"
            >
              <Info size={18} className="sm:w-6 sm:h-6" />
            </button>
          )}

          {/* Save this stream — only offered while watching one that isn't kept yet. */}
          {onDownload && (
            <button
              onClick={onDownload}
              className="text-white/70 hover:text-white transition-colors p-1 active:scale-95"
              title="Save this video to your library"
            >
              <DownloadIcon size={18} className="sm:w-6 sm:h-6" />
            </button>
          )}

          {/* Settings Menu — Playback speed, then Stats for nerds */}
          <div className="relative" ref={settingsRef}>
            <button
                onClick={() => setSettingsView(v => (v ? null : 'menu'))}
                className={`transition-colors p-1 active:scale-95 ${showSettings ? 'text-white rotate-45' : 'text-white/70 hover:text-white'}`}
                title="Settings"
            >
                <Settings size={18} className="sm:w-6 sm:h-6 transition-transform duration-300" />
            </button>
            
            {settingsView === 'menu' && (
              <div
                className="absolute bottom-full right-0 mb-3 w-[280px] max-w-[calc(100vw-24px)] rounded-2xl border border-white/10 shadow-2xl shadow-black/60 p-1.5 z-50 animate-fade-in select-none"
                style={{ background: 'linear-gradient(165deg, rgba(24,24,28,0.66), rgba(8,8,10,0.74))' }}
              >
                <button
                  onClick={() => setSettingsView('speed')}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-white hover:bg-white/10 active:scale-[0.98] transition"
                >
                  <Gauge size={18} className="text-white/80 shrink-0" />
                  <span className="text-sm font-medium flex-1 text-left">Playback speed</span>
                  <span className="text-xs text-white/60 tabular-nums">{playbackSpeed === 1 ? 'Normal' : `${playbackSpeed.toFixed(2)}x`}</span>
                  <ChevronRight size={16} className="text-white/50" />
                </button>
                {onToggleStats && (
                  <button
                    onClick={() => { onToggleStats(); setSettingsView(null); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-white hover:bg-white/10 active:scale-[0.98] transition"
                  >
                    <Activity size={18} className="text-white/80 shrink-0" />
                    <span className="text-sm font-medium flex-1 text-left">Stats for nerds</span>
                    {statsKey && (
                      <kbd className="text-[10px] font-semibold text-white/60 border border-white/15 rounded px-1.5 py-0.5">{statsKey}</kbd>
                    )}
                    <span className={`relative w-8 h-[18px] rounded-full transition-colors ${statsOpen ? 'bg-red-600' : 'bg-white/20'}`}>
                      <span className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-all ${statsOpen ? 'left-[16px]' : 'left-[2px]'}`} />
                    </span>
                  </button>
                )}
              </div>
            )}
            {settingsView === 'speed' && (
                <SpeedPanel
                    speed={playbackSpeed}
                    step={speedStep}
                    onChange={onSpeedChange}
                    onClose={() => setSettingsView('menu')}
                />
            )}
          </div>

          {/* Queue Toggle */}
          {onToggleQueue && (
            <button
              onClick={onToggleQueue}
              className={`transition-colors p-1 active:scale-95 ${showQueue ? 'text-red-500' : 'text-white/70 hover:text-white'}`}
              title={withKey('Queue', keys.queue)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-6 sm:h-6">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" strokeWidth="3" strokeLinecap="round" />
                <line x1="3" y1="12" x2="3.01" y2="12" strokeWidth="3" strokeLinecap="round" />
                <line x1="3" y1="18" x2="3.01" y2="18" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </button>
          )}

          {/* Picture-in-Picture Button */}
          <button
            onClick={onTogglePip}
            className={`transition-colors p-1 active:scale-95 ${isPip ? 'text-red-500' : 'text-white/70 hover:text-white'}`}
            title={withKey('Picture-in-Picture', keys.pip)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-6 sm:h-6">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <rect x="12" y="9" width="8" height="6" rx="1" ry="1" fill={isPip ? 'currentColor' : 'none'} strokeWidth="1.5" />
            </svg>
          </button>

          <button
            onClick={onToggleFullscreen}
            className="text-white/70 hover:text-white transition-colors p-1 active:scale-95"
            title={withKey('Fullscreen', keys.fullscreen)}
          >
            {isFullscreen ? <Minimize size={18} className="sm:w-6 sm:h-6" /> : <Maximize size={18} className="sm:w-6 sm:h-6" />}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PlayerControls;