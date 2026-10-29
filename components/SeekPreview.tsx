import React, { useEffect, useRef, useState } from 'react';
import { grabFrame, storyboard } from '../frames';

// ---------------------------------------------------------------------------
// The frame under the pointer on the seek bar (YouTube-style), with the time
// and the chapter it falls in — for every second of the video.
//
// Frames come from the frame engine (engine/crates/prev-frames):
//  - A storyboard: for a video cheap enough to decode end to end, one
//    low-priority pass when it opens fills in every second at once.
//  - On demand, for anything else: the keyframe first (tens of ms, close
//    enough while the pointer sweeps), then the exact frame for that second
//    as soon as the pointer stays — on a long-GOP or single-keyframe file the
//    keyframe alone would show one picture for many seconds.
// Only one on-demand request is ever in flight, and the newest position wins,
// so sweeping the bar never builds up a queue.
// ---------------------------------------------------------------------------

/** Exact frames kept per video (~25 KB each); oldest go first. */
const CACHE_LIMIT = 1500;

interface Frames {
  path: string;
  /** Second → the frame at that second. */
  exact: Map<number, string>;
  /** Second → the keyframe before it, shown until the exact one arrives. */
  near: Map<number, string>;
  /** No picture at all (audio, cover-less): the time pill alone. */
  frameless: boolean;
  board?: Promise<void>;
}

let current: Frames | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());

/** The frames for `path`, dropping the previous video's. */
function framesOf(path: string): Frames {
  if (current?.path !== path) current = { path, exact: new Map(), near: new Map(), frameless: false };
  return current;
}

function keep(map: Map<number, string>, second: number, url: string) {
  if (map.size >= CACHE_LIMIT) map.delete(map.keys().next().value!);
  map.set(second, url);
}

/**
 * Start the storyboard for a video that just opened — it also warms up the
 * preview engine on that file, so the first hover doesn't pay for opening it.
 */
export function prefetchPreviews(path: string): void {
  const f = framesOf(path);
  if (f.board) return;
  f.board = storyboard(path)
    .then(board => {
      if (!board || current !== f) return;
      board.frames.forEach((url, i) => {
        const second = Math.round(i * board.step);
        if (!f.exact.has(second)) keep(f.exact, second, url);
      });
      notify();
    })
    .catch(() => {});
}

/** An exact frame within two seconds of `second`, nearest first. */
function closeBy(exact: Map<number, string>, second: number): string | undefined {
  for (const d of [1, -1, 2, -2]) {
    const url = exact.get(second + d);
    if (url) return url;
  }
  return undefined;
}

const pump = { busy: false, path: '', next: null as number | null };

async function request(path: string, second: number) {
  pump.path = path;
  pump.next = second;
  if (pump.busy) return;
  pump.busy = true;
  try {
    while (pump.next !== null) {
      const [p, sec] = [pump.path, pump.next];
      pump.next = null;
      const f = framesOf(p);
      if (f.frameless || f.exact.has(sec)) continue;

      // 1. The keyframe: quick, and good enough while the pointer is moving —
      //    unless an exact frame a second away already stands in for it.
      if (!f.near.has(sec) && !closeBy(f.exact, sec)) {
        const url = await grabFrame(p, sec, 'preview', false).catch(() => undefined);
        if (url === null && f.exact.size === 0) { f.frameless = true; notify(); continue; }
        if (url) { keep(f.near, sec, url); notify(); }
        if (pump.next !== null && pump.next !== sec) continue; // already elsewhere
      }
      // 2. The exact second, now that the pointer has stayed.
      const url = await grabFrame(p, sec, 'preview', true).catch(() => undefined);
      if (url) { keep(f.exact, sec, url); notify(); }
    }
  } finally {
    pump.busy = false;
  }
}

const fmt = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

interface Props {
  /** Local file to preview; undefined (a stream) shows the time alone. */
  path?: string;
  time: number;
  duration: number;
  /** Horizontal centre, in px from the bar's left edge, already kept on-screen. */
  left: number;
  chapter?: string;
  /** Picture width / height, so the frame isn't letterboxed in a 16:9 box. */
  aspect: number;
}

/** Card width in px; the frame's height follows the picture. */
export const PREVIEW_WIDTH = 192;

const SeekPreview: React.FC<Props> = ({ path, time, duration, left, chapter, aspect }) => {
  // The second the time pill shows (it rounds down too).
  const second = Math.max(0, Math.min(Math.floor(time), Math.floor(Math.max(0, duration - 0.5))));
  const [, redraw] = useState(0);
  /** What the card showed last, held while the next frame loads instead of flashing empty. */
  const shown = useRef<string | null>(null);

  useEffect(() => {
    const l = () => redraw(n => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const f = path ? framesOf(path) : null;
  const framed = !!f && !f.frameless;
  useEffect(() => { if (framed) request(path!, second); }, [framed, path, second]);

  // Best first: this second; an exact frame a second or two away (closer to
  // the truth than a keyframe that may be far back); the keyframe.
  const fresh = framed ? f!.exact.get(second) ?? closeBy(f!.exact, second) ?? f!.near.get(second) ?? null : null;
  if (fresh) shown.current = fresh;
  const img = framed ? fresh ?? shown.current : null;
  const waiting = framed && !f!.exact.has(second);
  const height = Math.round(PREVIEW_WIDTH / (aspect > 0.3 ? aspect : 16 / 9));

  return (
    // The fade-in animates transform, so the centring translate lives on the wrapper.
    <div className="pointer-events-none absolute bottom-full mb-3 -translate-x-1/2 z-30" style={{ left }}>
      <div className="flex flex-col items-center gap-1.5 animate-[fadeIn_0.14s_ease-out]">
        {framed && (
          <div
            className="rounded-xl overflow-hidden border border-white/20 bg-neutral-900/90 shadow-[0_14px_36px_rgba(0,0,0,0.6)]"
            style={{ width: PREVIEW_WIDTH, height }}
          >
            {img
              ? <img src={img} alt="" className={`w-full h-full object-cover transition-opacity duration-150 ${waiting && !fresh ? 'opacity-70' : 'opacity-100'}`} draggable={false} />
              : <div className="w-full h-full animate-pulse bg-gradient-to-br from-neutral-800 to-neutral-900" />}
          </div>
        )}
        <div className="flex items-center gap-1.5 max-w-[240px] rounded-full bg-black/80 border border-white/10 px-2.5 py-1 shadow-lg">
          <span className="text-[11px] font-semibold text-white tabular-nums">{fmt(time)}</span>
          {chapter && (
            <>
              <span className="w-1 h-1 rounded-full bg-red-500 shrink-0" />
              <span className="text-[11px] text-white/80 truncate">{chapter}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default SeekPreview;
