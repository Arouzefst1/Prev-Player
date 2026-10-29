import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { mpvGetProperties, getMpvState } from '../mpv';
import { useMediaInfo } from './FormatBadges';
import { useSettings } from '../settings';

// ---------------------------------------------------------------------------
// Stats for nerds — what mpv is doing with this file, live: the stream as
// decoded, how it reaches the screen and the speakers, and whether playback is
// keeping up. Read straight from mpv twice a second while open (and not at all
// while closed); names stay mpv's where that is what someone would search for.
// ---------------------------------------------------------------------------

const PROPS = [
  'video-codec', 'video-format', 'width', 'height', 'container-fps', 'estimated-vf-fps', 'display-fps',
  'hwdec-current', 'current-vo', 'frame-drop-count', 'decoder-frame-drop-count', 'vo-delayed-frame-count',
  'mistimed-frame-count', 'video-bitrate', 'audio-bitrate', 'audio-codec-name', 'audio-params/samplerate',
  'audio-params/channel-count', 'audio-out-params/format', 'audio-out-params/samplerate',
  'audio-out-params/channel-count', 'current-ao', 'avsync', 'demuxer-cache-duration', 'cache-speed',
  'file-format', 'file-size', 'path', 'video-params/pixelformat', 'video-params/hw-pixelformat', 'video-params/gamma',
  'video-params/primaries', 'video-params/colormatrix', 'video-params/levels', 'video-params/max-cll',
  'video-params/max-fall', 'video-params/max-luma', 'video-target-params/gamma', 'video-target-params/max-luma',
] as const;

const HISTORY = 60; // samples → 30 s of graph

const n = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);
const mbps = (bits?: number) => (bits === undefined ? '—' : bits >= 1e6 ? `${(bits / 1e6).toFixed(1)} Mbps` : `${Math.round(bits / 1e3)} kbps`);
const size = (b?: number) => (b === undefined ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const fps = (v?: number) => (v === undefined ? '' : `${+v.toFixed(3)} fps`);

/** A tiny line graph of recent values, scaled to its own peak. */
const Sparkline: React.FC<{ values: number[]; color: string }> = ({ values, color }) => {
  if (values.length < 2) return <span className="inline-block w-20 h-3" />;
  const peak = Math.max(...values, 1e-9);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 80},${12 - (v / peak) * 11}`).join(' ');
  return (
    <svg width="80" height="12" className="inline-block align-middle shrink-0" viewBox="0 0 80 12">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
};

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex gap-3 leading-[1.55]">
    <span className="w-[104px] shrink-0 text-right text-white/55">{label}</span>
    <span className="min-w-0 flex-1 text-white/95 break-words flex items-center gap-2 flex-wrap">{children}</span>
  </div>
);

interface Props {
  onClose: () => void;
  /** The key that opens and closes it, for the hint in the corner. */
  shortcut?: string;
}

const StatsForNerds: React.FC<Props> = ({ onClose, shortcut }) => {
  const [settings] = useSettings();
  const { info, display } = useMediaInfo(true);
  const [p, setP] = useState<Record<string, any>>({});
  const history = useRef<{ bitrate: number[]; buffer: number[] }>({ bitrate: [], buffer: [] });

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const values = await mpvGetProperties(PROPS).catch(() => ({} as Record<string, any>));
      if (!live) return;
      const h = history.current;
      h.bitrate = [...h.bitrate, n(values['video-bitrate']) ?? 0].slice(-HISTORY);
      h.buffer = [...h.buffer, n(values['demuxer-cache-duration']) ?? 0].slice(-HISTORY);
      setP(values);
    };
    tick();
    const id = setInterval(tick, 500);
    return () => { live = false; clearInterval(id); };
  }, []);

  const opacity = Math.min(1, Math.max(0.15, settings.statsOpacity ?? 0.6));
  const w = n(p.width), h = n(p.height);
  const hw = typeof p['hwdec-current'] === 'string' && p['hwdec-current'] !== 'no' ? p['hwdec-current'] : null;
  const outFormat: string | undefined = p['audio-out-params/format'];
  const passthrough = typeof outFormat === 'string' && outFormat.startsWith('spdif');
  const drops = [n(p['frame-drop-count']), n(p['decoder-frame-drop-count']), n(p['vo-delayed-frame-count']), n(p['mistimed-frame-count'])];
  const avsync = n(p.avsync);
  const cache = n(p['demuxer-cache-duration']);
  const cacheSpeed = n(p['cache-speed']);
  const gamma: string | undefined = p['video-params/gamma'];
  const targetGamma: string | undefined = p['video-target-params/gamma'];
  const screen = display ?? null;
  const mpvState = getMpvState();
  const dv = mpvState.media.videoTrack?.['dolby-vision-profile'];

  return (
    <div
      className="absolute top-16 left-4 z-30 w-[min(440px,calc(100%-32px))] rounded-xl border border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.45)] px-3.5 py-3 font-mono text-[11px] text-white select-text animate-fade-in"
      style={{ background: `rgba(8, 8, 10, ${opacity})` }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-2 font-sans">
        <span className="text-[12px] font-semibold tracking-wide text-white">Stats for nerds</span>
        <span className="flex items-center gap-2">
          {shortcut && <kbd className="text-[10px] text-white/50 border border-white/15 rounded px-1.5">{shortcut}</kbd>}
          <button onClick={onClose} className="p-0.5 rounded hover:bg-white/15 text-white/70 hover:text-white transition" title="Close">
            <X size={14} />
          </button>
        </span>
      </div>

      <Row label="Video">
        {[info.videoCodec ?? p['video-format'], w && h ? `${w}×${h}` : null, fps(n(p['container-fps']) ?? n(p['estimated-vf-fps']))].filter(Boolean).join(' · ') || '—'}
      </Row>
      <Row label="Picture">
        {[info.range?.label ?? (gamma ? gamma.toUpperCase() : null), gamma, p['video-params/primaries'], p['video-params/colormatrix'],
          info.bitDepth ? `${info.bitDepth}-bit` : null, p['video-params/hw-pixelformat'] ?? p['video-params/pixelformat'], p['video-params/levels']].filter(Boolean).join(' · ') || '—'}
      </Row>
      {dv !== undefined && (
        <Row label="Dolby Vision">
          Profile {String(dv)}{mpvState.media.videoTrack?.['dolby-vision-level'] !== undefined ? ` · Level ${mpvState.media.videoTrack['dolby-vision-level']}` : ''}
        </Row>
      )}
      {(n(p['video-params/max-cll']) || n(p['video-params/max-luma'])) && (
        <Row label="Mastering">
          {[n(p['video-params/max-luma']) ? `peak ${Math.round(p['video-params/max-luma'])} nits` : null,
            n(p['video-params/max-cll']) ? `MaxCLL ${Math.round(p['video-params/max-cll'])}` : null,
            n(p['video-params/max-fall']) ? `MaxFALL ${Math.round(p['video-params/max-fall'])}` : null].filter(Boolean).join(' · ')}
        </Row>
      )}
      <Row label="Output">
        {[targetGamma ? `${targetGamma === 'pq' || targetGamma === 'hlg' ? 'HDR' : 'SDR'} (${targetGamma})` : info.output?.toUpperCase(),
          screen ? `screen HDR ${screen.enabled ? 'on' : screen.supported ? 'off' : 'not supported'}` : null,
          n(p['display-fps']) ? `${+p['display-fps'].toFixed(3)} Hz` : null].filter(Boolean).join(' · ') || '—'}
      </Row>
      <Row label="Decoder">{hw ? `${hw} (hardware)` : 'software'}{p['current-vo'] ? ` · ${p['current-vo']}` : ''}</Row>
      <Row label="Frames">
        dropped {drops[0] ?? 0} · decoder {drops[1] ?? 0} · delayed {drops[2] ?? 0} · mistimed {drops[3] ?? 0}
      </Row>
      <Row label="Bitrate">
        <Sparkline values={history.current.bitrate} color="#ef4444" />
        <span>{mbps(n(p['video-bitrate']))}</span>
        <span className="text-white/50">audio {mbps(n(p['audio-bitrate']))}</span>
      </Row>
      <Row label="Buffer">
        <Sparkline values={history.current.buffer} color="#60a5fa" />
        <span>{cache !== undefined ? `${cache.toFixed(1)} s ahead` : '—'}</span>
        {cacheSpeed ? <span className="text-white/50">{mbps(cacheSpeed * 8)}</span> : null}
      </Row>
      <Row label="Audio">
        {[info.audio?.format ?? p['audio-codec-name'], info.audio?.immersive, info.audio?.channels ?? (n(p['audio-params/channel-count']) ? `${p['audio-params/channel-count']} ch` : null),
          n(p['audio-params/samplerate']) ? `${(p['audio-params/samplerate'] / 1000).toFixed(1)} kHz` : null].filter(Boolean).join(' · ') || '—'}
      </Row>
      <Row label="Sound out">
        {passthrough
          ? `bitstream to receiver (${outFormat!.replace('spdif-', '')})`
          : [p['current-ao'], outFormat, n(p['audio-out-params/channel-count']) ? `${p['audio-out-params/channel-count']} ch` : null,
             n(p['audio-out-params/samplerate']) ? `${(p['audio-out-params/samplerate'] / 1000).toFixed(1)} kHz` : null].filter(Boolean).join(' · ') || '—'}
      </Row>
      <Row label="A/V sync">{avsync !== undefined ? `${avsync >= 0 ? '+' : ''}${(avsync * 1000).toFixed(1)} ms` : '—'}</Row>
      <Row label="File">
        <span className="truncate max-w-full" title={p.path}>{[p['file-format'], size(n(p['file-size']))].filter(Boolean).join(' · ')}{p.path ? ` · ${String(p.path).split(/[\\/]/).pop()}` : ''}</span>
      </Row>
    </div>
  );
};

export default StatsForNerds;
