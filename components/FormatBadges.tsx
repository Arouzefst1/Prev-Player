import React, { useEffect, useMemo, useState } from 'react';
import { getMpvState, subscribeMpv } from '../mpv';
import { describeMedia, badgesFor, type DisplayHdr, type MediaInfo, type RawMedia, type BadgeTone } from '../media';
import { currentDisplayHdr } from '../display';

/**
 * What is playing, described (media.ts), kept live. The screen's HDR state is
 * asked of Windows when an HDR picture starts and whenever the window gets
 * focus back — the moment someone returns from switching HDR on in Settings.
 */
export function useMediaInfo(enabled = true): { info: MediaInfo; display: DisplayHdr | null } {
  const [raw, setRaw] = useState<RawMedia>(() => getMpvState().media);
  const [display, setDisplay] = useState<DisplayHdr | null>(null);

  // mpv pushes state on every tick; the media object only changes identity when
  // something in it did, so this re-renders per file, not per frame.
  useEffect(() => {
    if (!enabled) return;
    return subscribeMpv(s => setRaw(prev => (prev === s.media ? prev : s.media)));
  }, [enabled]);

  const gamma = raw.video?.gamma;
  const hdrPicture = gamma === 'pq' || gamma === 'hlg';
  useEffect(() => {
    if (!enabled || !hdrPicture) return;
    let live = true;
    const ask = () => currentDisplayHdr().then(d => { if (live) setDisplay(d); });
    ask();
    window.addEventListener('focus', ask);
    return () => { live = false; window.removeEventListener('focus', ask); };
  }, [enabled, hdrPicture]);

  const info = useMemo(() => describeMedia(raw, display), [raw, display]);
  return { info, display };
}

const TONE: Record<BadgeTone, string> = {
  dolby: 'text-white border-white/40 bg-gradient-to-b from-white/[0.18] to-white/[0.04]',
  hdr: 'text-amber-200 border-amber-300/40 bg-gradient-to-b from-amber-300/[0.22] to-amber-500/[0.06]',
  plain: 'text-white/85 border-white/15 bg-black/55',
};

/**
 * "4K · DOLBY VISION · 10-BIT · DOLBY ATMOS · 7.1" over the picture, shown with
 * the rest of the controls. No backdrop blur: it sits over playing video, where
 * blur cost frames before (see ActionOverlay).
 */
const FormatBadges: React.FC<{ visible: boolean; className?: string }> = ({ visible, className }) => {
  const { info } = useMediaInfo();
  const badges = badgesFor(info);
  if (badges.length === 0) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-1.5 pointer-events-auto transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'} ${className ?? ''}`}
    >
      {badges.map((b, i) => (
        <span
          key={b.label}
          title={b.title}
          style={{ animationDelay: `${i * 45}ms` }}
          className={`inline-flex items-center h-6 px-2 rounded-md border text-[10.5px] font-bold uppercase tracking-[0.08em] shadow-[0_2px_10px_rgba(0,0,0,0.35)] animate-[fadeIn_0.3s_ease_both] cursor-default select-none ${TONE[b.tone]}`}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
};

export default FormatBadges;
