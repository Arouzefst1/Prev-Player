import React, { useEffect, useState, useRef } from 'react';
import { Play, Pause, Volume2, VolumeX, FastForward, Rewind } from 'lucide-react';
import { OverlayState } from '../utils';

interface ActionOverlayProps {
  overlayState: OverlayState;
}

/**
 * Action overlays drawn as SEPARATE, always-present FIXED LAYERS on top of the video.
 *
 * Each layer is its own container, positioned relative to the player window (never the
 * <video>), so they appear in the exact same spot for a 16:9 movie or a 9:16 short —
 * for a short the side layers simply sit in the black margins. They are always mounted
 * and only fade their opacity in/out, so showing one is reliable even during playback.
 *
 *   • top    → volume / mute
 *   • left   → rewind
 *   • right  → forward
 *   • center → play / pause
 *
 * IMPORTANT: no `backdrop-blur` is used. A backdrop filter over a *playing* video is
 * re-computed every frame by the GPU (even while the layer is invisible/opacity-0),
 * which caused the playback lag and made the indicators paint unreliably. Solid
 * translucent pills avoid that entirely. The component is memoized so the player's
 * time-update re-renders don't touch it.
 */
const ActionOverlay: React.FC<ActionOverlayProps> = React.memo(({ overlayState }) => {
  const { action, id, value } = overlayState;

  // ── Volume / mute layer (top) ──
  const [volVisible, setVolVisible] = useState(false);
  const [volValue, setVolValue] = useState<string | number | undefined>(undefined);
  const [volMuted, setVolMuted] = useState(false);
  const volTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isVolume = action === 'volume-up' || action === 'volume-down';

  useEffect(() => {
    if (!isVolume || !id) return;
    setVolValue(value);
    setVolMuted(value === 'Muted');
    setVolVisible(true);
    if (volTimerRef.current) clearTimeout(volTimerRef.current);
    volTimerRef.current = setTimeout(() => setVolVisible(false), 750);
    return () => {
      if (volTimerRef.current) clearTimeout(volTimerRef.current);
    };
  }, [id, isVolume, value]);

  // ── Skip / play-pause layers (left / right / center) ──
  const [actVisible, setActVisible] = useState(false);
  const [actAction, setActAction] = useState<OverlayState['action']>(null);
  const actTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isAction = !!action && !isVolume;

  useEffect(() => {
    if (!isAction || !id) return;
    setActAction(action);
    setActVisible(true);
    if (actTimerRef.current) clearTimeout(actTimerRef.current);
    actTimerRef.current = setTimeout(() => setActVisible(false), 650);
    return () => {
      if (actTimerRef.current) clearTimeout(actTimerRef.current);
    };
  }, [id, isAction, action]);

  const showRewind = actVisible && (actAction === 'rewind-5' || actAction === 'rewind-10');
  const showForward = actVisible && (actAction === 'forward-5' || actAction === 'forward-10');
  const showPlayPause = actVisible && (actAction === 'play' || actAction === 'pause');

  const fade = 'transition-opacity duration-200 ease-out';
  const pill = 'bg-black/65 rounded-full text-white flex items-center justify-center';

  return (
    <>
      {/* Volume / mute — fixed top-center */}
      <div className={`absolute top-3 sm:top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-none ${fade} ${volVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${pill} gap-2 px-4 py-2`}>
          {volMuted ? <VolumeX size={18} className="flex-shrink-0" /> : <Volume2 size={18} className="flex-shrink-0" />}
          <span className="font-bold text-sm tabular-nums inline-block min-w-[3.5em] text-center">{volValue}</span>
        </div>
      </div>

      {/* Rewind — fixed left */}
      <div className={`absolute top-1/2 left-[9%] -translate-y-1/2 z-30 pointer-events-none ${fade} ${showRewind ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${pill} flex-col p-4 sm:p-5`}>
          <Rewind size={26} className="sm:w-8 sm:h-8" fill="currentColor" />
          <span className="text-xs font-bold mt-0.5 sm:mt-1">{actAction === 'rewind-10' ? '-10s' : '-5s'}</span>
        </div>
      </div>

      {/* Forward — fixed right */}
      <div className={`absolute top-1/2 right-[9%] -translate-y-1/2 z-30 pointer-events-none ${fade} ${showForward ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${pill} flex-col p-4 sm:p-5`}>
          <FastForward size={26} className="sm:w-8 sm:h-8" fill="currentColor" />
          <span className="text-xs font-bold mt-0.5 sm:mt-1">{actAction === 'forward-10' ? '+10s' : '+5s'}</span>
        </div>
      </div>

      {/* Play / pause — fixed center */}
      <div className={`absolute inset-0 flex items-center justify-center z-30 pointer-events-none ${fade} ${showPlayPause ? 'opacity-100' : 'opacity-0'}`}>
        <div className={`${pill} p-5 sm:p-6`}>
          {actAction === 'pause'
            ? <Pause size={34} className="sm:w-12 sm:h-12" fill="currentColor" />
            : <Play size={34} className="sm:w-12 sm:h-12" fill="currentColor" />}
        </div>
      </div>
    </>
  );
});

ActionOverlay.displayName = 'ActionOverlay';

export default ActionOverlay;
