import React, { useEffect, useState, useRef } from 'react';
import { Play, Pause, Volume2, VolumeX, FastForward, Rewind } from 'lucide-react';
import { OverlayState } from '../utils';

interface ActionOverlayProps {
  overlayState: OverlayState;
}

/**
 * Action overlays drawn as SEPARATE fixed layers on top of the video — volume (top),
 * rewind (left), forward (right), play/pause (center). Each is positioned relative to
 * the player window, never the <video>, so they look identical on a 16:9 movie or a
 * 9:16 short (side layers fall in the black margins for a short).
 *
 * SINGLE source of truth: one `shown` action + one `visible` flag + one timer, all keyed
 * on `overlayState.id`. Only the current action's layer is shown, and a new press hides
 * the previous one instantly. (The old design used a separate timer per layer; switching
 * layers cleared the other's hide-timer and early-returned, so the previous overlay got
 * stuck on-screen — that's fixed here.) No backdrop-blur (it lagged over playing video);
 * memoized so the player's time-update re-renders don't touch it.
 */
const ActionOverlay: React.FC<ActionOverlayProps> = React.memo(({ overlayState }) => {
  const { action, id, value } = overlayState;

  const [visible, setVisible] = useState(false);
  const [shown, setShown] = useState<{ action: OverlayState['action']; value?: string | number }>({ action: null });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!action || !id) return;
    setShown({ action, value });
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    const isVol = action === 'volume-up' || action === 'volume-down';
    timerRef.current = setTimeout(() => setVisible(false), isVol ? 800 : 600);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [id, action, value]);

  const a = shown.action;
  const isVolume = a === 'volume-up' || a === 'volume-down';
  const isRewind = a === 'rewind-5' || a === 'rewind-10';
  const isForward = a === 'forward-5' || a === 'forward-10';
  const isPlayPause = a === 'play' || a === 'pause';
  const muted = shown.value === 'Muted';

  const pill = 'bg-black/65 rounded-full text-white flex items-center justify-center';
  // Only the ACTIVE layer gets a transition. An inactive layer drops the transition so it
  // snaps to opacity-0 instantly the moment another action takes over — this stops two
  // overlays from being visible together during what would otherwise be a 200ms cross-fade.
  const layer = (active: boolean) =>
    `${active ? 'transition-opacity duration-200 ease-out' : ''} ${visible && active ? 'opacity-100' : 'opacity-0'}`;

  return (
    <>
      {/* Volume / mute — fixed top-center */}
      <div className={`absolute top-3 sm:top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none ${layer(isVolume)}`}>
        <div className={`${pill} gap-2 px-4 py-2`}>
          {muted ? <VolumeX size={18} className="flex-shrink-0" /> : <Volume2 size={18} className="flex-shrink-0" />}
          <span className="font-bold text-sm tabular-nums inline-block min-w-[3.5em] text-center">{shown.value}</span>
        </div>
      </div>

      {/* Rewind — fixed left */}
      <div className={`absolute top-1/2 left-[9%] -translate-y-1/2 z-30 pointer-events-none ${layer(isRewind)}`}>
        <div className={`${pill} flex-col p-4 sm:p-5`}>
          <Rewind size={26} className="sm:w-8 sm:h-8" fill="currentColor" />
          <span className="text-xs font-bold mt-0.5 sm:mt-1">{a === 'rewind-10' ? '-10s' : '-5s'}</span>
        </div>
      </div>

      {/* Forward — fixed right */}
      <div className={`absolute top-1/2 right-[9%] -translate-y-1/2 z-30 pointer-events-none ${layer(isForward)}`}>
        <div className={`${pill} flex-col p-4 sm:p-5`}>
          <FastForward size={26} className="sm:w-8 sm:h-8" fill="currentColor" />
          <span className="text-xs font-bold mt-0.5 sm:mt-1">{a === 'forward-10' ? '+10s' : '+5s'}</span>
        </div>
      </div>

      {/* Play / pause — fixed center */}
      <div className={`absolute inset-0 flex items-center justify-center z-30 pointer-events-none ${layer(isPlayPause)}`}>
        <div className={`${pill} p-5 sm:p-6`}>
          {a === 'pause'
            ? <Pause size={34} className="sm:w-12 sm:h-12" fill="currentColor" />
            : <Play size={34} className="sm:w-12 sm:h-12" fill="currentColor" />}
        </div>
      </div>
    </>
  );
});

ActionOverlay.displayName = 'ActionOverlay';

export default ActionOverlay;
