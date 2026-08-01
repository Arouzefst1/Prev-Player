import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Maximize2, X, Pin, PinOff, RotateCcw, RotateCw, SkipBack, SkipForward, Volume2, Volume1, VolumeX } from 'lucide-react';

type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

interface PipOverlayProps {
  title?: string;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  isPinned: boolean;
  hasNext?: boolean;
  hasPrev?: boolean;
  /**
   * Bumps on every action-overlay trigger (overlayState.id). The full player
   * hides its control bar while a skip/volume pill is on screen so only the pill
   * shows; the mini-player does the same — which also keeps the centred
   * play/pause pill from landing on top of the centred play/pause button.
   */
  actionSignal?: number;
  onPlayPause: () => void;
  onSkip: (seconds: number) => void;
  onSeek: (time: number) => void;
  onSeekStart: () => void;
  onSeekEnd: () => void;
  onVolume: (v: number) => void;
  onToggleMute: () => void;
  onTogglePin: () => void;
  onExpand: () => void;
  onClose: () => void;
  onNext?: () => void;
  onPrev?: () => void;
}

/** Layout density — a 220px mini-player can't wear the same chrome as a 560px one. */
type Density = 'xs' | 'sm' | 'md';

function densityFor(width: number): Density {
  if (width < 265) return 'xs';
  if (width < 380) return 'sm';
  return 'md';
}

const fmt = (s: number): string => {
  if (!s || !isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
    : `${m}:${sec.toString().padStart(2, '0')}`;
};

/**
 * The mini-player's own control surface — this is what makes PiP *PiP* rather
 * than a shrunken app window. It replaces the full player chrome entirely while
 * the window is small, and adapts what it shows to how small that is.
 *
 * The layer is pointer-events-none by default so anything NOT a control (the
 * gradients, the empty middle) falls through to the drag surface underneath —
 * grab the picture anywhere to move the window, click a button to use it.
 */
const PipOverlay: React.FC<PipOverlayProps> = ({
  title, isPlaying, currentTime, duration, volume, isMuted, isPinned,
  hasNext, hasPrev, actionSignal,
  onPlayPause, onSkip, onSeek, onSeekStart, onSeekEnd, onVolume, onToggleMute,
  onTogglePin, onExpand, onClose, onNext, onPrev,
}) => {
  const [density, setDensity] = useState<Density>(() => densityFor(window.innerWidth));
  const [hovered, setHovered] = useState(false);
  const [volOpen, setVolOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  /** True while an action pill (skip / volume / play-pause) is on screen. */
  const [pillShowing, setPillShowing] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-tier the layout as the user resizes the mini-player.
  useEffect(() => {
    const onResize = () => setDensity(densityFor(window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Controls follow the pointer: visible while the cursor is over the window (or
  // while paused / scrubbing), gone a moment after it leaves or goes still.
  // These have to be window-level listeners — this layer is pointer-events-none
  // so the picture underneath stays draggable, which means React's own pointer
  // handlers on the root would never fire.
  const wake = useCallback(() => {
    setHovered(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setHovered(false), 2200);
  }, []);

  useEffect(() => {
    const sleep = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      setHovered(false);
      setVolOpen(false);
    };
    window.addEventListener('pointermove', wake);
    window.addEventListener('blur', sleep);
    document.documentElement.addEventListener('mouseleave', sleep);
    return () => {
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('blur', sleep);
      document.documentElement.removeEventListener('mouseleave', sleep);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [wake]);

  // Yield the screen to the action pill, exactly like the full player hides its
  // control bar for arrow-key skips and volume changes. Without this the centred
  // play/pause pill stacks on the centred play/pause button.
  useEffect(() => {
    if (!actionSignal) return;
    setPillShowing(true);
    setVolOpen(false);
    if (pillTimer.current) clearTimeout(pillTimer.current);
    // Outlast ActionOverlay's own hide timer (600ms, 800ms for volume).
    pillTimer.current = setTimeout(() => setPillShowing(false), 900);
    return () => { if (pillTimer.current) clearTimeout(pillTimer.current); };
  }, [actionSignal]);

  const visible = !pillShowing && (hovered || !isPlaying || scrubbing);
  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  const startResize = useCallback((direction: ResizeDirection) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    import('@tauri-apps/api/window')
      .then((w) => w.getCurrentWindow().startResizeDragging(direction))
      .catch(() => {});
  }, []);

  // Sizing tokens per density tier.
  const t = {
    xs: { main: 30, side: 0, icon: 15, chip: 'h-6 w-6', pad: 'px-1.5', text: 'text-[9px]', bar: 'h-[3px]' },
    sm: { main: 38, side: 20, icon: 16, chip: 'h-7 w-7', pad: 'px-2', text: 'text-[10px]', bar: 'h-[3px]' },
    md: { main: 46, side: 24, icon: 18, chip: 'h-8 w-8', pad: 'px-2.5', text: 'text-[11px]', bar: 'h-1' },
  }[density];

  // opacity-0 still receives clicks, so faded-out chrome has to give up its
  // pointer events explicitly — otherwise an invisible "close" button sits over
  // the top-right of the picture and an invisible play button over the middle,
  // swallowing the plain clicks that are supposed to reach the drag surface.
  const pe = visible ? 'pointer-events-auto' : 'pointer-events-none';
  const chipBtn = `${pe} flex items-center justify-center rounded-full bg-black/55 text-white/85 hover:bg-black/75 hover:text-white transition-colors active:scale-90 ${t.chip}`;
  const fade = 'transition-opacity duration-200 ease-out';

  return (
    <div className={`absolute inset-0 z-40 pointer-events-none select-none ${visible ? 'cursor-default' : 'cursor-none'}`}>
      {/* Hairline frame — an undecorated window needs an edge to read as a panel. */}
      <div className="absolute inset-0 ring-1 ring-inset ring-white/15 pointer-events-none" />

      {/* No scrims — the picture stays fully visible behind the chrome. Legibility
          comes from each control carrying its own pill/shadow instead. */}
      {/* ---- Top bar: title + window actions ---- */}
      <div className={`absolute inset-x-0 top-0 flex items-center gap-1 ${t.pad} py-1.5 ${fade} ${visible ? 'opacity-100' : 'opacity-0'}`}>
        {density !== 'xs' && (
          <span
            className={`flex-1 truncate text-white font-medium ${t.text}`}
            style={{ textShadow: '0 1px 4px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.8)' }}
            title={title}
          >
            {title}
          </span>
        )}
        <div className={`flex items-center gap-1 ${density === 'xs' ? 'ml-auto' : ''}`}>
          {density !== 'xs' && (
            <button
              onClick={onTogglePin}
              className={`${chipBtn} ${isPinned ? 'text-red-400' : ''}`}
              title={isPinned ? 'Unpin (stop staying on top)' : 'Pin on top'}
            >
              {isPinned ? <Pin size={t.icon - 3} /> : <PinOff size={t.icon - 3} />}
            </button>
          )}
          <button onClick={onExpand} className={chipBtn} title="Back to full player (p)">
            <Maximize2 size={t.icon - 3} />
          </button>
          <button onClick={onClose} className={`${chipBtn} hover:bg-red-600/80`} title="Close mini player (Esc)">
            <X size={t.icon - 3} />
          </button>
        </div>
      </div>

      {/* ---- Centre transport ---- */}
      <div className={`absolute inset-0 flex items-center justify-center gap-2 sm:gap-3 ${fade} ${visible ? 'opacity-100' : 'opacity-0'}`}>
        {density === 'md' && hasPrev && (
          <button onClick={onPrev} className={`${pe} text-white/75 hover:text-white transition-colors active:scale-90`} title="Previous (b)">
            <SkipBack size={t.side} fill="currentColor" />
          </button>
        )}
        <button
          onClick={() => onSkip(-10)}
          className={`${pe} text-white/85 hover:text-white transition-colors active:scale-90`}
          title="Back 10s (j)"
        >
          <RotateCcw size={density === 'xs' ? 18 : 22} strokeWidth={2.2} />
        </button>
        <button
          onClick={onPlayPause}
          className={`${pe} flex items-center justify-center rounded-full bg-black/55 hover:bg-black/75 text-white transition-colors active:scale-95 shadow-lg`}
          style={{ width: t.main, height: t.main }}
          title={isPlaying ? 'Pause (space)' : 'Play (space)'}
        >
          {isPlaying
            ? <Pause size={t.main * 0.45} fill="currentColor" />
            : <Play size={t.main * 0.45} fill="currentColor" className="ml-[2px]" />}
        </button>
        <button
          onClick={() => onSkip(10)}
          className={`${pe} text-white/85 hover:text-white transition-colors active:scale-90`}
          title="Forward 10s (l)"
        >
          <RotateCw size={density === 'xs' ? 18 : 22} strokeWidth={2.2} />
        </button>
        {density === 'md' && hasNext && (
          <button onClick={onNext} className={`${pe} text-white/75 hover:text-white transition-colors active:scale-90`} title="Next (n)">
            <SkipForward size={t.side} fill="currentColor" />
          </button>
        )}
      </div>

      {/* ---- Bottom: scrubber + time + volume ---- */}
      <div className={`absolute inset-x-0 bottom-0 ${t.pad} pb-1.5 ${fade} ${visible ? 'opacity-100' : 'opacity-0'}`}>
        {/* Scrubber */}
        <div className={`relative group/bar w-full ${t.bar} mb-1 flex items-center`}>
          {/* Slightly darker track than the full player's — with no scrim behind
              it, a pale bar would disappear over a bright frame. */}
          <div
            className={`absolute w-full ${t.bar} bg-white/30 rounded-full overflow-hidden`}
            style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.6)' }}
          >
            <div className="h-full bg-red-600 rounded-full" style={{ width: `${progress}%` }} />
          </div>
          <div
            className="pointer-events-none absolute h-2.5 w-2.5 bg-red-500 rounded-full shadow top-1/2 -translate-y-1/2 -ml-[5px] scale-0 group-hover/bar:scale-100 transition-transform"
            style={{ left: `${progress}%`, transform: scrubbing ? 'translateY(-50%) scale(1)' : undefined }}
          />
          <input
            type="range"
            min={0}
            max={duration || 100}
            step="any"
            value={currentTime}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            onPointerDown={(e) => { e.stopPropagation(); setScrubbing(true); onSeekStart(); }}
            onPointerUp={() => { setScrubbing(false); onSeekEnd(); }}
            onPointerCancel={() => { setScrubbing(false); onSeekEnd(); }}
            className={`${pe} absolute inset-0 w-full h-3 -my-1 opacity-0 cursor-pointer`}
            title="Seek"
          />
        </div>

        {/* Time + volume row */}
        <div className="flex items-center gap-1.5">
          {/* Its own little backdrop, so the numbers stay readable now that the
              full-width scrim is gone — without dimming the picture behind them. */}
          <span
            className={`${t.text} text-white tabular-nums font-medium whitespace-nowrap bg-black/55 rounded-md px-1.5 py-0.5`}
          >
            {fmt(currentTime)}
            {density !== 'xs' && <span className="text-white/60"> / {fmt(duration)}</span>}
          </span>

          {/* Speaker + slider share one pill so the slider has something to sit on. */}
          <div
            className={`${pe} ml-auto flex items-center gap-1 bg-black/55 rounded-full pl-1 pr-0.5 py-0.5`}
            onPointerEnter={() => setVolOpen(true)}
            onPointerLeave={() => setVolOpen(false)}
          >
            {/* Volume slider slides out of the speaker on hover. */}
            <div
              className="overflow-hidden transition-all duration-200 ease-out flex items-center"
              style={{ width: volOpen && density !== 'xs' ? (density === 'md' ? 68 : 48) : 0 }}
            >
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={isMuted ? 0 : volume}
                onChange={(e) => onVolume(parseFloat(e.target.value))}
                onPointerDown={(e) => e.stopPropagation()}
                className={`${pe} w-full h-1 rounded-full appearance-none cursor-pointer accent-white bg-white/30 mx-1`}
                title="Volume"
              />
            </div>
            <button onClick={onToggleMute} className={`${pe} flex items-center justify-center text-white/90 hover:text-white transition-colors active:scale-90`} title={isMuted ? 'Unmute (m)' : 'Mute (m)'}>
              {isMuted || volume === 0
                ? <VolumeX size={t.icon} className="text-red-400" />
                : volume < 0.5 ? <Volume1 size={t.icon} /> : <Volume2 size={t.icon} />}
            </button>
          </div>
        </div>
      </div>

      {/* ---- Resize grips ----
          The window is undecorated, so there's no OS frame to grab. These
          invisible strips hand the drag straight to the compositor, and the
          aspect lock in VideoPlayer keeps the ratio honest as it moves. */}
      <div onPointerDown={startResize('NorthWest')} className="pointer-events-auto absolute left-0 top-0 h-3.5 w-3.5 cursor-nwse-resize" />
      <div onPointerDown={startResize('NorthEast')} className="pointer-events-auto absolute right-0 top-0 h-3.5 w-3.5 cursor-nesw-resize" />
      <div onPointerDown={startResize('SouthWest')} className="pointer-events-auto absolute left-0 bottom-0 h-3.5 w-3.5 cursor-nesw-resize" />
      <div onPointerDown={startResize('SouthEast')} className="pointer-events-auto absolute right-0 bottom-0 h-4 w-4 cursor-nwse-resize" />
      <div onPointerDown={startResize('North')} className="pointer-events-auto absolute inset-x-3.5 top-0 h-[3px] cursor-ns-resize" />
      <div onPointerDown={startResize('South')} className="pointer-events-auto absolute inset-x-4 bottom-0 h-[3px] cursor-ns-resize" />
      <div onPointerDown={startResize('West')} className="pointer-events-auto absolute inset-y-3.5 left-0 w-[3px] cursor-ew-resize" />
      <div onPointerDown={startResize('East')} className="pointer-events-auto absolute inset-y-4 right-0 w-[3px] cursor-ew-resize" />
    </div>
  );
};

export default React.memo(PipOverlay);
