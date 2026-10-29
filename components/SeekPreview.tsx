import React, { useEffect, useRef, useState } from 'react';
import { grabFrame } from '../frames';

// ---------------------------------------------------------------------------
// The frame under the pointer on the seek bar (YouTube-style), with the time
// and the chapter it falls in.
//
// Frames come from the frame engine's preview lane, which keeps the file open,
// so each new one is a single keyframe seek (~30 ms). Requests are quantised
// to a few seconds and cached, and only one is ever in flight: while it runs,
// the pointer may move on, and when it lands the latest position is asked for
// next — sweeping the bar never builds up a queue.
// ---------------------------------------------------------------------------

const CACHE_LIMIT = 300;
const cache = new Map<string, Map<number, string>>();
const pump = { busy: false, path: '', next: null as number | null, listeners: new Set<() => void>() };
/** Files that gave no frame at all (audio, unreadable): the time pill alone. */
const frameless = new Set<string>();

function framesOf(path: string): Map<number, string> {
  let m = cache.get(path);
  if (!m) {
    cache.clear(); // one video at a time — drop the last one's frames
    m = new Map();
    cache.set(path, m);
  }
  return m;
}

async function request(path: string, bucket: number) {
  pump.path = path;
  pump.next = bucket;
  if (pump.busy) return;
  pump.busy = true;
  try {
    while (pump.next !== null) {
      const [p, b] = [pump.path, pump.next];
      pump.next = null;
      if (framesOf(p).has(b)) continue;
      const url = await grabFrame(p, b, 'preview').catch(() => null);
      const frames = framesOf(p);
      if (!url) {
        if (frames.size === 0) { frameless.add(p); pump.listeners.forEach(l => l()); }
        continue;
      }
      if (frames.size >= CACHE_LIMIT) frames.delete(frames.keys().next().value!);
      frames.set(b, url);
      pump.listeners.forEach(l => l());
    }
  } finally {
    pump.busy = false;
  }
}

/** The cached frame closest to `bucket`, so something sensible shows while the exact one loads. */
function nearest(path: string, bucket: number): string | null {
  const frames = cache.get(path);
  if (!frames || frames.size === 0) return null;
  const exact = frames.get(bucket);
  if (exact) return exact;
  let best: [number, string] | null = null;
  for (const [t, url] of frames) {
    if (!best || Math.abs(t - bucket) < Math.abs(best[0] - bucket)) best = [t, url];
  }
  return best && Math.abs(best[0] - bucket) <= 30 ? best[1] : null;
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
  const step = duration > 3600 ? 5 : 2;
  const bucket = Math.max(0, Math.min(Math.round(time / step) * step, Math.max(0, duration - 0.5)));
  const [, redraw] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const l = () => { if (mounted.current) redraw(n => n + 1); };
    pump.listeners.add(l);
    return () => { mounted.current = false; pump.listeners.delete(l); };
  }, []);

  const framed = !!path && !frameless.has(path);
  useEffect(() => { if (framed) request(path!, bucket); }, [framed, path, bucket]);

  const img = framed ? nearest(path!, bucket) : null;
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
              ? <img src={img} alt="" className="w-full h-full object-cover" draggable={false} />
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
