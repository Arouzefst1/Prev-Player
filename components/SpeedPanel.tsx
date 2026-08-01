import React from 'react';
import { ChevronLeft, Minus, Plus } from 'lucide-react';

interface SpeedPanelProps {
  /** Current playback speed. */
  speed: number;
  /** How much the +/− buttons nudge (from settings). */
  step: number;
  /** Apply a new speed to mpv. */
  onChange: (speed: number) => void;
  /** Close the panel (back arrow / done). */
  onClose: () => void;
}

// Range the slider spans. mpv accepts arbitrary rates, but we keep a sane window
// that still reaches the 3× preset shown in the design.
const MIN = 0.25;
const MAX = 4;
const FINE = 0.05; // slider granularity → allows precise values like 3.20×
const PRESETS = [1, 1.25, 1.5, 2, 3];

// Snap to the fine grid and clamp so we never hand mpv a junk float.
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, Math.round(v / FINE) * FINE));
const fmtBig = (s: number) => `${s.toFixed(2)}x`;
const fmtChip = (p: number) => (Number.isInteger(p) ? p.toFixed(1) : String(p));

/**
 * YouTube-style "Playback speed" panel: a back-arrow header, a big live readout,
 * a fine slider with a heart thumb flanked by −/+ nudge buttons, and preset chips.
 * It floats over the transparent WebView, so the mpv video shows through the glass.
 */
const SpeedPanel: React.FC<SpeedPanelProps> = ({ speed, step, onChange, onClose }) => {
  const pct = ((speed - MIN) / (MAX - MIN)) * 100;

  return (
    <div
      className="absolute bottom-full right-0 mb-3 w-[320px] max-w-[calc(100vw-24px)] rounded-2xl border border-white/10 shadow-2xl shadow-black/60 p-4 z-50 animate-fade-in select-none"
      style={{ background: 'linear-gradient(165deg, rgba(24,24,28,0.66), rgba(8,8,10,0.74))' }}
    >
      {/* Header — the back arrow closes the panel */}
      <button
        onClick={onClose}
        className="flex items-center gap-1.5 text-white/90 hover:text-white -ml-1 mb-3 active:scale-95 transition"
      >
        <ChevronLeft size={20} />
        <span className="text-sm font-medium">Playback speed</span>
      </button>

      {/* Big live readout */}
      <div className="flex items-center justify-center mb-3">
        <span className="text-white text-2xl font-bold tabular-nums">{fmtBig(speed)}</span>
      </div>

      {/* Slider with −/+ nudge buttons (they step by the configurable amount) */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => onChange(clamp(speed - step))}
          disabled={speed <= MIN + 0.0001}
          className="w-9 h-9 shrink-0 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-default flex items-center justify-center text-white active:scale-90 transition"
          title={`Slower (−${step}×)`}
        >
          <Minus size={18} />
        </button>
        <input
          type="range"
          min={MIN}
          max={MAX}
          step={FINE}
          value={speed}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="speed-slider flex-1 cursor-pointer"
          style={{ ['--pct' as string]: `${pct}%` } as React.CSSProperties}
        />
        <button
          onClick={() => onChange(clamp(speed + step))}
          disabled={speed >= MAX - 0.0001}
          className="w-9 h-9 shrink-0 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30 disabled:cursor-default flex items-center justify-center text-white active:scale-90 transition"
          title={`Faster (+${step}×)`}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Preset chips */}
      <div className="flex items-stretch justify-between gap-1.5 pb-4">
        {PRESETS.map((p) => {
          const active = Math.abs(speed - p) < 0.001;
          return (
            <div key={p} className="relative flex-1">
              <button
                onClick={() => onChange(p)}
                className={`w-full rounded-full py-1.5 text-xs font-semibold transition active:scale-95 ${
                  active ? 'bg-white text-black' : 'bg-white/10 text-white/90 hover:bg-white/20'
                }`}
              >
                {fmtChip(p)}
              </button>
              {p === 1 && (
                <span className="absolute left-0 right-0 top-full mt-1 text-center text-[10px] text-white/45">
                  Normal
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SpeedPanel;
