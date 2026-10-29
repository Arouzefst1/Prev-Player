import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Repeat, Repeat1, Activity, PictureInPicture2, Maximize, Minimize, Info, Check, Disc3 } from 'lucide-react';
import type { LoopMode } from './LoopButton';
import type { DiscTitle } from '../disc';

// ---------------------------------------------------------------------------
// Right-click on the picture: loop, Stats for nerds, and the window controls,
// in the same glass as the player's settings menu. Opens at the pointer, kept
// inside the player; any click elsewhere, Esc, or a choice closes it. A click
// away only closes the menu — a see-through backdrop takes it, so it doesn't
// also pause the video underneath.
// ---------------------------------------------------------------------------

interface Props {
  /** Pointer position, relative to the player. */
  x: number;
  y: number;
  loopMode: LoopMode;
  hasQueue: boolean;
  onLoop: (mode: LoopMode) => void;
  statsOpen: boolean;
  onToggleStats: () => void;
  statsKey?: string;
  loopKey?: string;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onTogglePip: () => void;
  onShowInfo?: () => void;
  /** A Blu-ray folder's titles, longest (the film) first. */
  discTitles?: DiscTitle[];
  discTitle?: number;
  onPickDiscTitle?: (playlist: number) => void;
  onClose: () => void;
}

const clock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

const Item: React.FC<{
  icon: React.ReactNode; label: string; hint?: string; checked?: boolean; onClick: () => void;
}> = ({ icon, label, hint, checked, onClick }) => (
  <button
    role="menuitem"
    onClick={onClick}
    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-white hover:bg-white/10 active:scale-[0.98] transition text-left"
  >
    <span className="w-[18px] flex justify-center text-white/80 shrink-0">{icon}</span>
    <span className="text-[13px] font-medium flex-1">{label}</span>
    {hint && <kbd className="text-[10px] font-semibold text-white/50 border border-white/15 rounded px-1.5 py-0.5">{hint}</kbd>}
    <span className="w-4 flex justify-center shrink-0">{checked && <Check size={15} className="text-red-500" />}</span>
  </button>
);

const PlayerContextMenu: React.FC<Props> = ({
  x, y, loopMode, hasQueue, onLoop, statsOpen, onToggleStats, statsKey, loopKey,
  isFullscreen, onToggleFullscreen, onTogglePip, onShowInfo, discTitles, discTitle, onPickDiscTitle, onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Flip left / up when the menu would run past the player's edge.
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement?.getBoundingClientRect();
    if (!el || !box) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPos({
      left: x + w + 8 > box.width ? Math.max(8, x - w) : x,
      top: y + h + 8 > box.height ? Math.max(8, y - h) : y,
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [onClose]);

  const pick = (fn: () => void) => () => { fn(); onClose(); };

  return (
    <>
    {/* Right-clicking the backdrop bubbles to the player, which reopens the menu there. */}
    <div
      className="absolute inset-0 z-[59]"
      onMouseDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClose(); } }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
    <div
      ref={ref}
      role="menu"
      className={`absolute z-[60] ${discTitles && discTitles.length > 1 ? 'w-[268px]' : 'w-[248px]'} rounded-xl border border-white/10 shadow-2xl shadow-black/60 p-1.5 select-none animate-[fadeIn_0.12s_ease-out]`}
      style={{ left: pos.left, top: pos.top, background: 'linear-gradient(165deg, rgba(24,24,28,0.72), rgba(8,8,10,0.8))' }}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Item
        icon={<Repeat1 size={16} />}
        label="Loop"
        hint={loopKey}
        checked={loopMode === 'one'}
        onClick={pick(() => onLoop(loopMode === 'one' ? 'off' : 'one'))}
      />
      {hasQueue && (
        <Item
          icon={<Repeat size={16} />}
          label="Loop queue"
          checked={loopMode === 'all'}
          onClick={pick(() => onLoop(loopMode === 'all' ? 'off' : 'all'))}
        />
      )}
      <Item icon={<Activity size={16} />} label="Stats for nerds" hint={statsKey} checked={statsOpen} onClick={pick(onToggleStats)} />
      <div className="h-px bg-white/10 my-1 mx-2" />
      <Item icon={<PictureInPicture2 size={16} />} label="Mini player" onClick={pick(onTogglePip)} />
      <Item
        icon={isFullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        onClick={pick(onToggleFullscreen)}
      />
      {onShowInfo && <Item icon={<Info size={16} />} label="Properties" onClick={pick(onShowInfo)} />}
      {discTitles && discTitles.length > 1 && onPickDiscTitle && (
        <>
          <div className="h-px bg-white/10 my-1 mx-2" />
          <p className="px-3 pt-1 pb-0.5 text-[10px] uppercase tracking-wider text-white/45">Disc titles</p>
          <div className="max-h-48 overflow-auto custom-scrollbar">
            {discTitles.map((t, i) => (
              <Item
                key={t.playlist}
                icon={<Disc3 size={16} />}
                label={i === 0 ? 'Main feature' : `Title ${t.playlist}`}
                hint={clock(t.seconds)}
                checked={discTitle === t.playlist}
                onClick={pick(() => onPickDiscTitle(t.playlist))}
              />
            ))}
          </div>
        </>
      )}
    </div>
    </>
  );
};

export default PlayerContextMenu;
