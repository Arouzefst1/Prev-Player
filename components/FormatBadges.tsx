import React, { useEffect, useMemo, useState } from 'react';
import { getMpvState, subscribeMpv } from '../mpv';
import { describeMedia, cardBadgesFor, type DisplayHdr, type MediaInfo, type RawMedia, type BadgeTone } from '../media';
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

export const TONE: Record<BadgeTone, string> = {
  dolby: 'text-white border-white/40 bg-gradient-to-b from-white/[0.18] to-white/[0.04]',
  hdr: 'text-amber-200 border-amber-300/40 bg-gradient-to-b from-amber-300/[0.22] to-amber-500/[0.06]',
  plain: 'text-white/85 border-white/15 bg-black/55',
};

/** The small badges on a library card, from what the probe stored with it. */
export const CardBadges: React.FC<{ media?: RawMedia; disc?: 'bluray' | 'dvd'; className?: string }> = ({ media, disc, className }) => {
  const badges = useMemo(() => [
    ...(disc ? [{ label: disc === 'bluray' ? 'Blu-ray' : 'DVD', tone: 'dolby' as BadgeTone }] : []),
    ...(media ? cardBadgesFor(describeMedia(media)) : []),
  ], [media, disc]);
  if (badges.length === 0) return null;
  return (
    <div className={`flex items-center gap-1 ${className ?? ''}`}>
      {badges.map(b => (
        <span
          key={b.label}
          className={`inline-flex items-center h-[18px] px-1.5 rounded border text-[9.5px] font-bold uppercase tracking-[0.06em] leading-none ${TONE[b.tone]}`}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
};
