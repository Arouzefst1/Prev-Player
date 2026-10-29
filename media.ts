// ===========================================================================
// What is actually playing — picture and sound, in words a person knows.
//
// mpv (FFmpeg + libplacebo) does the decoding and the HDR rendering; this file
// reads what it reports and turns it into "4K · Dolby Vision · Atmos". Pure
// functions, no I/O: mpv.ts collects the raw values, the UI shows the result.
//
// Field names were checked against a real mpv (0.37) playing generated HDR10,
// HLG, AV1-PQ, TrueHD, E-AC-3, DTS and 24-bit FLAC files. Some signals only
// exist in newer builds — the Dolby Vision profile, the codec profile that
// tells DTS-HD MA / DTS:X / Atmos apart, the HDR10+ and Dolby Vision dynamic
// metadata, and the output colour space — so every one of them is optional and
// the description falls back to what the build does report.
// ===========================================================================

/** Raw values as mpv reports them. Every field is optional. */
export interface RawMedia {
  /** `video-params` (only the keys we use). */
  video?: Record<string, any>;
  /** `video-target-params` — the colour space actually sent to the screen (newer mpv). */
  target?: Record<string, any>;
  /** `audio-out-params` — what goes to the audio device. */
  audioOut?: Record<string, any>;
  /** The selected video / audio entries of `track-list`. */
  videoTrack?: Record<string, any>;
  audioTrack?: Record<string, any>;
  /** `hwdec-current`: the hardware decoder in use, or "no". */
  hwdec?: string;
  /** Whether a dynamic-metadata key was seen in a full `video-params` snapshot. */
  dynamic?: { hdr10plus: boolean; dolbyVision: boolean };
}

/** Whether the screen the player is on is in HDR mode (null: unknown). */
export interface DisplayHdr { supported: boolean; enabled: boolean }

export type RangeKind = 'dolby-vision' | 'hdr10+' | 'hdr10' | 'pq' | 'hlg' | 'sdr';

export interface MediaInfo {
  resolution?: string;            // "4K", "1080p" …
  width?: number;
  height?: number;
  range?: { kind: RangeKind; label: string; detail?: string };
  bitDepth?: number;
  videoCodec?: string;
  hardwareDecoding?: boolean;
  /** How the picture reaches the screen. */
  output?: 'hdr' | 'tone-mapped' | 'sdr';
  mastering?: { maxCll?: number; maxFall?: number; peakNits?: number };
  audio?: {
    format: string;               // "Dolby TrueHD", "DTS-HD MA" …
    immersive?: 'Dolby Atmos' | 'DTS:X';
    channels?: string;            // "7.1", "5.1", "Stereo"
    sampleRate?: number;
    lossless: boolean;
    /** Sent to the receiver as a bitstream instead of being decoded here. */
    passthrough: boolean;
  };
}

// ---------------------------------------------------------------------------

const VIDEO_CODECS: Record<string, string> = {
  hevc: 'HEVC', h264: 'H.264', av1: 'AV1', vvc: 'VVC', vp9: 'VP9', vp8: 'VP8',
  mpeg2video: 'MPEG-2', mpeg4: 'MPEG-4', vc1: 'VC-1', wmv3: 'WMV', prores: 'ProRes',
  dnxhd: 'DNxHD', cfhd: 'CineForm', ffv1: 'FFV1', theora: 'Theora', mjpeg: 'MJPEG',
  h263: 'H.263', rawvideo: 'Uncompressed',
};

const AUDIO_CODECS: Record<string, string> = {
  truehd: 'Dolby TrueHD', eac3: 'Dolby Digital Plus', ac3: 'Dolby Digital', ac4: 'Dolby AC-4',
  dts: 'DTS', mlp: 'MLP', flac: 'FLAC', alac: 'ALAC', ape: "Monkey's Audio", wavpack: 'WavPack',
  tak: 'TAK', tta: 'TTA', aac: 'AAC', opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', mp2: 'MP2',
  wmapro: 'WMA Pro', wmav2: 'WMA', wmalossless: 'WMA Lossless',
};

const LOSSLESS = new Set(['truehd', 'mlp', 'flac', 'alac', 'ape', 'wavpack', 'tak', 'tta', 'wmalossless']);

/** Common speaker layouts by channel count. */
const LAYOUTS: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 3: '2.1', 6: '5.1', 7: '6.1', 8: '7.1', 10: '7.1.2', 12: '7.1.4' };

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);

function resolutionOf(w?: number, h?: number): string | undefined {
  if (!w || !h) return undefined;
  // By the larger dimension's class, so a 3840×1600 scope film is still 4K.
  if (w >= 7000 || h >= 4000) return '8K';
  if (w >= 3200 || h >= 2000) return '4K';
  if (w >= 2400 || h >= 1400) return '1440p';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  return 'SD';
}

/** "yuv420p10" → 10; plain "yuv420p" → 8. */
function bitDepthOf(pixfmt?: string): number | undefined {
  if (!pixfmt) return undefined;
  const m = pixfmt.match(/p(\d{2})(le|be)?$/) ?? pixfmt.match(/(\d{2})(le|be)?$/);
  if (m) return parseInt(m[1], 10);
  return /^(yuv|nv12|rgb|bgr|gray)/.test(pixfmt) ? 8 : undefined;
}

function rangeOf(raw: RawMedia): MediaInfo['range'] {
  const v = raw.video ?? {};
  const t = raw.videoTrack ?? {};
  const dvProfile = num(t['dolby-vision-profile']);
  if (dvProfile !== undefined || raw.dynamic?.dolbyVision) {
    const level = num(t['dolby-vision-level']);
    const detail = dvProfile !== undefined
      ? `Profile ${dvProfile}${level !== undefined ? ` · Level ${level}` : ''}`
      : undefined;
    return { kind: 'dolby-vision', label: 'Dolby Vision', detail };
  }
  if (v.gamma === 'hlg') return { kind: 'hlg', label: 'HLG' };
  if (v.gamma === 'pq') {
    if (raw.dynamic?.hdr10plus) return { kind: 'hdr10+', label: 'HDR10+' };
    // HDR10 proper is PQ on BT.2020; PQ on anything else is still HDR, just not
    // the HDR10 format.
    return v.primaries === 'bt.2020'
      ? { kind: 'hdr10', label: 'HDR10' }
      : { kind: 'pq', label: 'HDR' };
  }
  if (v.gamma) return { kind: 'sdr', label: 'SDR' };
  return undefined;
}

function audioOf(raw: RawMedia): MediaInfo['audio'] {
  const t = raw.audioTrack;
  if (!t?.codec) return undefined;
  const codec = String(t.codec);
  // FFmpeg 6.1+ names the variant in the profile ("Dolby TrueHD + Dolby Atmos",
  // "DTS-HD MA + DTS:X"); newer mpv passes it on. Release groups usually put the
  // same thing in the track title, which older builds do show.
  const profile = String(t['codec-profile'] ?? t.profile ?? '');
  const title = String(t.title ?? '');
  const hint = `${profile} ${title}`;

  let format = AUDIO_CODECS[codec] ?? (codec.startsWith('pcm_') ? 'PCM' : codec.startsWith('dsd_') ? 'DSD' : codec.toUpperCase());
  let lossless = LOSSLESS.has(codec) || codec.startsWith('pcm_') || codec.startsWith('dsd_');
  if (codec === 'dts') {
    if (/DTS-HD MA|Master Audio/i.test(hint)) { format = 'DTS-HD MA'; lossless = true; }
    else if (/DTS-HD HRA|High Resolution/i.test(hint)) format = 'DTS-HD HRA';
    else if (/Express/i.test(hint)) format = 'DTS Express';
    else if (/96\/24/.test(hint)) format = 'DTS 96/24';
    else if (/DTS-ES/i.test(hint)) format = 'DTS-ES';
  }

  let immersive: 'Dolby Atmos' | 'DTS:X' | undefined;
  if ((codec === 'truehd' || codec === 'eac3' || codec === 'ac4') && /atmos/i.test(hint)) immersive = 'Dolby Atmos';
  if (codec === 'dts' && /DTS[:\s-]?X/i.test(hint)) immersive = 'DTS:X';

  const count = num(t['demux-channel-count']) ?? num(t['audio-channels']);
  const out = raw.audioOut ?? {};
  const passthrough = typeof out.format === 'string' && out.format.startsWith('spdif');
  return {
    format,
    immersive,
    channels: count ? (LAYOUTS[count] ?? `${count} ch`) : undefined,
    sampleRate: num(t['demux-samplerate']),
    lossless,
    passthrough,
  };
}

/**
 * Describe what is playing. `display` is the Windows HDR state of the screen
 * the player is on; mpv's own `video-target-params` wins when the build has it,
 * since that is what was actually sent to the screen.
 */
export function describeMedia(raw: RawMedia, display?: DisplayHdr | null): MediaInfo {
  const v = raw.video ?? {};
  const t = raw.videoTrack ?? {};
  const width = num(v.w) ?? num(t['demux-w']);
  const height = num(v.h) ?? num(t['demux-h']);
  const range = rangeOf(raw);
  const hdr = !!range && range.kind !== 'sdr';

  let output: MediaInfo['output'];
  if (range) {
    const sent = raw.target?.gamma;
    if (!hdr) output = 'sdr';
    else if (sent) output = sent === 'pq' || sent === 'hlg' ? 'hdr' : 'tone-mapped';
    else if (display) output = display.enabled ? 'hdr' : 'tone-mapped';
  }

  // Only real mastering metadata. Without it mpv still reports a peak — PQ's
  // 10,000-nit ceiling, or HLG's assumed 1,000 — which describes the format,
  // not the film.
  const maxCll = num(v['max-cll']);
  const maxFall = num(v['max-fall']);
  const peak = maxCll || maxFall ? num(v['max-luma']) : undefined;
  const codecId = raw.videoTrack?.codec ? String(raw.videoTrack.codec) : undefined;

  return {
    resolution: resolutionOf(width, height),
    width, height,
    range,
    bitDepth: bitDepthOf(v.pixelformat),
    videoCodec: codecId ? (VIDEO_CODECS[codecId] ?? codecId.toUpperCase()) : undefined,
    hardwareDecoding: raw.hwdec ? raw.hwdec !== 'no' : undefined,
    output,
    mastering: hdr && (maxCll || maxFall || peak)
      ? { maxCll: maxCll || undefined, maxFall: maxFall || undefined, peakNits: peak || undefined }
      : undefined,
    audio: audioOf(raw),
  };
}

/** Does a full `video-params` snapshot carry dynamic HDR metadata? */
export function dynamicMetadataOf(videoParams: Record<string, any> | null | undefined): RawMedia['dynamic'] {
  const v = videoParams ?? {};
  const positive = (k: string) => (num(v[k]) ?? 0) > 0;
  return {
    // HDR10+ (SMPTE ST 2094-40) scene statistics.
    hdr10plus: ['scene-max-r', 'scene-max-g', 'scene-max-b', 'scene-avg'].some(positive),
    // Dolby Vision L1 per-frame luminance.
    dolbyVision: ['max-pq-y', 'avg-pq-y'].some(positive),
  };
}

// ---------------------------------------------------------------------------
// Badges for the player overlay
// ---------------------------------------------------------------------------

export type BadgeTone = 'dolby' | 'hdr' | 'plain';
export interface Badge { label: string; tone: BadgeTone; title?: string }

export function badgesFor(info: MediaInfo): Badge[] {
  const out: Badge[] = [];
  if (info.resolution && info.resolution !== 'SD') out.push({ label: info.resolution, tone: 'plain' });
  const r = info.range;
  if (r && r.kind !== 'sdr') {
    const where = info.output === 'hdr' ? 'Shown in HDR'
      : info.output === 'tone-mapped' ? 'Your screen is in SDR, so this is converted to SDR — turn on HDR in Windows display settings to see it in HDR'
      : undefined;
    out.push({
      label: r.label,
      tone: r.kind === 'dolby-vision' ? 'dolby' : 'hdr',
      title: [r.detail, where].filter(Boolean).join(' · ') || undefined,
    });
  }
  if (info.bitDepth && info.bitDepth > 8) out.push({ label: `${info.bitDepth}-bit`, tone: 'plain' });
  const a = info.audio;
  if (a) {
    if (a.immersive) out.push({ label: a.immersive, tone: a.immersive === 'Dolby Atmos' ? 'dolby' : 'plain', title: a.format });
    else if (a.lossless || /Dolby|DTS/.test(a.format)) out.push({ label: a.format, tone: /Dolby/.test(a.format) ? 'dolby' : 'plain' });
    if (a.channels && a.channels !== 'Stereo' && a.channels !== 'Mono') out.push({ label: a.channels, tone: 'plain' });
    if (a.sampleRate && a.sampleRate >= 88200) out.push({ label: `${+(a.sampleRate / 1000).toFixed(1)} kHz`, tone: 'plain', title: 'High-resolution audio' });
    if (a.passthrough) out.push({ label: 'Passthrough', tone: 'plain', title: 'Sent to your receiver as a bitstream' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// What this mpv build can decode (Settings → Picture & sound)
// ---------------------------------------------------------------------------

export const CAPABILITY_CODECS: { group: 'Video' | 'Audio'; label: string; ids: string[] }[] = [
  { group: 'Video', label: 'HEVC / H.265', ids: ['hevc'] },
  { group: 'Video', label: 'AV1', ids: ['av1'] },
  { group: 'Video', label: 'VVC / H.266', ids: ['vvc'] },
  { group: 'Video', label: 'VP9', ids: ['vp9'] },
  { group: 'Video', label: 'H.264', ids: ['h264'] },
  { group: 'Video', label: 'ProRes', ids: ['prores'] },
  { group: 'Video', label: 'VC-1', ids: ['vc1'] },
  { group: 'Video', label: 'MPEG-2', ids: ['mpeg2video'] },
  { group: 'Audio', label: 'Dolby TrueHD', ids: ['truehd'] },
  { group: 'Audio', label: 'Dolby Digital Plus', ids: ['eac3'] },
  { group: 'Audio', label: 'Dolby Digital', ids: ['ac3'] },
  { group: 'Audio', label: 'DTS / DTS-HD', ids: ['dts'] },
  { group: 'Audio', label: 'FLAC', ids: ['flac'] },
  { group: 'Audio', label: 'ALAC', ids: ['alac'] },
  { group: 'Audio', label: 'DSD', ids: ['dsd_lsbf', 'dsd_msbf', 'dsd_lsbf_planar', 'dsd_msbf_planar'] },
  { group: 'Audio', label: 'Opus', ids: ['opus'] },
];

/** Which of the codecs above the running mpv has a decoder for. */
export function capabilitiesFrom(decoderList: { codec?: string }[]): { label: string; group: 'Video' | 'Audio'; ok: boolean }[] {
  const have = new Set(decoderList.map(d => d.codec).filter(Boolean));
  return CAPABILITY_CODECS.map(c => ({ label: c.label, group: c.group, ok: c.ids.some(id => have.has(id)) }));
}
