import React from 'react';

/**
 * off  — play through once and stop
 * all  — when the queue reaches the end, start it again from the top
 * one  — repeat the current video forever
 */
export type LoopMode = 'off' | 'all' | 'one';

/** Off → All → One → Off, the order every mainstream player uses. */
export function nextLoopMode(mode: LoopMode, hasQueue: boolean): LoopMode {
  if (!hasQueue) return mode === 'one' ? 'off' : 'one'; // no queue → nothing to repeat but this file
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}

export const loopModeLabel = (mode: LoopMode, hasQueue: boolean): string =>
  mode === 'off' ? 'Loop: Off'
    : mode === 'one' ? (hasQueue ? 'Repeat this video' : 'Loop: On')
      : 'Repeat queue';

interface LoopButtonProps {
  mode: LoopMode;
  /** With no queue this is a plain on/off loop — no mode badge. */
  hasQueue: boolean;
  onCycle: () => void;
  size?: number;
  className?: string;
}

/**
 * The original loop glyph and its flip animation, unchanged. The only thing a
 * queue adds is a "1" badge in the empty middle for repeat-one, so a single
 * video looks exactly like it always did.
 */
const LoopButton: React.FC<LoopButtonProps> = ({ mode, hasQueue, onCycle, size = 20, className = '' }) => {
  const active = mode !== 'off';
  const showOneBadge = hasQueue && mode === 'one';

  return (
    <button
      onClick={onCycle}
      title={`${loopModeLabel(mode, hasQueue)} (l)`}
      aria-label={loopModeLabel(mode, hasQueue)}
      className={`p-1 transition-all duration-300 active:scale-95 relative ${
        active ? 'text-red-500' : 'text-white/50 hover:text-white'
      } ${className}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`transition-transform duration-500 ${active ? 'rotate-0' : 'rotate-180'}`}
      >
        <path d="M17 2l4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="M7 22l-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
        {/* Repeat-one badge — queue only, sits in the empty middle of the loop. */}
        {showOneBadge && (
          <g className="loop-one-pop">
            <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />
            <text
              x="12"
              y="12"
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="7"
              fontWeight="700"
              fill="#000"
              stroke="none"
              style={{ fontFamily: 'inherit' }}
            >
              1
            </text>
          </g>
        )}
      </svg>
      {/* Active indicator dot */}
      {active && (
        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
      )}
    </button>
  );
};

export default LoopButton;
