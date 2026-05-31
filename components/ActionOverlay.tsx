import React, { useEffect, useState, useRef } from 'react';
import { Play, Pause, Volume2, FastForward, Rewind } from 'lucide-react';
import { OverlayState } from '../utils';

interface ActionOverlayProps {
  overlayState: OverlayState;
}

/**
 * Overlay for skip / play-pause / volume actions.
 *
 * Volume: always-mounted div with CSS opacity transitions (smooth, no flicker).
 * Skip / Play-Pause: rendered with `key={id}` so React remounts on every trigger.
 *   The CSS animation (`animate-ping-once` with `forwards` fill) auto-hides after 0.6s.
 *   No useEffect, no state, no timers needed for skip overlays.
 */
const ActionOverlay: React.FC<ActionOverlayProps> = ({ overlayState }) => {
  const { action, id, value } = overlayState;

  // ── Volume overlay (always mounted, opacity transitions) ──
  const [volVisible, setVolVisible] = useState(false);
  const [volValue, setVolValue] = useState<string | number | undefined>(undefined);
  const volTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isVolume = action === 'volume-up' || action === 'volume-down';

  useEffect(() => {
    if (!isVolume || !id) return;
    setVolVisible(true);
    setVolValue(value);
    if (volTimerRef.current) clearTimeout(volTimerRef.current);
    volTimerRef.current = setTimeout(() => setVolVisible(false), 700);
  }, [id, isVolume, value]);

  // Determine if we have a valid skip/play/pause action to show
  const isSkipOrPlayPause = action && !isVolume && id;

  return (
    <>
      {/* Volume Overlay — always in DOM, opacity transition */}
      {isVolume && (
        <div
          className={`absolute top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none transition-all duration-200 ease-out ${
            volVisible ? 'opacity-100 scale-100' : 'opacity-0 scale-90'
          }`}
        >
          <div className="bg-black/70 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 text-white">
            <Volume2 size={18} className="flex-shrink-0" />
            <span className="font-bold text-sm tabular-nums inline-block min-w-[3.5em] text-center">{volValue}</span>
          </div>
        </div>
      )}

      {/* Skip / Play-Pause — key-remount, CSS animation auto-hides via `forwards` fill */}
      {isSkipOrPlayPause && (
        <SkipOverlayInner key={id} action={action} value={value} />
      )}
    </>
  );
};

/**
 * Stateless inner component. Remounted on each trigger via `key={id}`.
 * The `animate-ping-once` CSS class plays the animation once and stays at
 * opacity:0 thanks to `animation-fill-mode: forwards`. No timers needed.
 */
const SkipOverlayInner: React.FC<{ action: NonNullable<OverlayState['action']>; value?: string | number }> = ({ action, value }) => {
  // Skip indicators are anchored to fixed points just left/right of the window
  // centre (40% / 60%), NOT to the window edges. This keeps them on-content for
  // any aspect ratio — including 9:16 shorts, whose video strip is too narrow for
  // edge-anchored overlays (those would land in the black pillarbox bars).
  // The centering transform lives on the outer div; the inner badge owns the
  // `animate-ping-once` scale animation so the two transforms don't clash.
  if (action === 'forward-5' || action === 'forward-10') {
    return (
      <div className="absolute top-1/2 left-[60%] -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30">
        <div className="bg-black/40 backdrop-blur-sm p-4 sm:p-6 rounded-full animate-ping-once flex flex-col items-center justify-center text-white">
          <FastForward size={28} className="sm:w-10 sm:h-10" fill="currentColor" />
          <span className="text-xs font-bold mt-0.5 sm:mt-1">{action === 'forward-5' ? '+5s' : '+10s'}</span>
        </div>
      </div>
    );
  }

  if (action === 'rewind-5' || action === 'rewind-10') {
    return (
      <div className="absolute top-1/2 left-[40%] -translate-x-1/2 -translate-y-1/2 pointer-events-none z-30">
        <div className="bg-black/40 backdrop-blur-sm p-4 sm:p-6 rounded-full animate-ping-once flex flex-col items-center justify-center text-white">
          <Rewind size={28} className="sm:w-10 sm:h-10" fill="currentColor" />
          <span className="text-xs font-bold mt-0.5 sm:mt-1">{action === 'rewind-5' ? '-5s' : '-10s'}</span>
        </div>
      </div>
    );
  }

  // Play / Pause center overlay
  const Icon = action === 'pause' ? Pause : Play;
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
      <div className="bg-black/50 backdrop-blur-sm p-4 sm:p-6 rounded-full animate-ping-once flex flex-col items-center justify-center text-white">
        <Icon size={36} className="sm:w-12 sm:h-12 text-white drop-shadow-lg" fill="currentColor" />
        {value && <span className="text-xs font-bold mt-1">{value}</span>}
      </div>
    </div>
  );
};

export default ActionOverlay;