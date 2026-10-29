// ===========================================================================
// mpv bridge — the "engine" of the native build.
//
// This wraps `tauri-plugin-mpv` (a real mpv process embedded in the window via
// --wid) behind a small, video-element-like API so the React UI can drive it
// without knowing about mpv internals. mpv decodes EVERYTHING (MKV/AVI/HEVC/
// Dolby/HDR10) on the GPU — that's the whole point of this build.
//
// Volume is exposed to the app as 0..1 (mpv's native scale is 0..100).
// Paths passed to mpvLoad() must be NATIVE file-system paths (not asset URLs).
// ===========================================================================

import {
  init, destroy, command, setProperty, getProperty, observeProperties,
  type MpvConfig,
} from 'tauri-plugin-mpv-api';
import { dynamicMetadataOf, type RawMedia } from './media';

export interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title?: string;
  lang?: string;
  selected: boolean;
  codec?: string;
  /** Audio only — how many channels the stream carries (2 = stereo, 6 = 5.1). */
  channels?: number;
  /** Marked forced: only signs and foreign-language lines (subtitles). */
  forced?: boolean;
  /** The file's own pick for this track type. */
  default?: boolean;
  /** Loaded from a separate file rather than the container. */
  external?: boolean;
  /** "DTS-HD MA", "Dolby TrueHD + Dolby Atmos"… where this mpv reports it. */
  profile?: string;
  hearingImpaired?: boolean;
}

export interface MpvState {
  paused: boolean;
  currentTime: number; // seconds
  duration: number;    // seconds
  volume: number;      // 0..1
  muted: boolean;
  speed: number;
  ended: boolean;      // eof-reached (keep-open pauses on the last frame)
  filename?: string;
  tracks: MpvTrack[];  // all embedded audio/subtitle/video tracks
  audioId: number | null; // current audio track id (aid)
  subId: number | null;   // current subtitle track id (sid), null = off
  /** Second subtitle shown above the first (secondary-sid), null = none. */
  secondarySubId?: number | null;
  videoAspect: number | null; // display aspect ratio (dwidth/dheight)
  /** The hardware decoder actually in use, or "no" when decoding in software. */
  hwdec?: string;
  videoCodec?: string;
  /** Seconds of demuxed data ahead of the playhead — 0 while starved. */
  cacheAhead?: number;
  /** Frames the decoder couldn't keep up with. Climbing = too slow to play. */
  droppedFrames?: number;
  /** Audio output driver mpv has open ("wasapi"), or null while it has none. */
  audioOutput?: string | null;
  // --- for the Properties panel ---
  width?: number;
  height?: number;
  fps?: number;
  fileFormat?: string;
  fileSize?: number;
  /** What mpv reports about the picture and sound — read through media.ts. */
  media: RawMedia;
  /** Chapters, in order (seek-bar preview titles and dividers). */
  chapters: { title?: string; time: number }[];
}

// Properties we ask mpv to push to us on change. The diagnostic four (hwdec…
// frame-drop-count) tell "starved of data" apart from "decoding too slowly".
// `current-ao` and `audio-device-list` drive the audio-output recovery below;
// observing `audio-device-list` is also what makes mpv listen for device
// hotplug at all.
const OBSERVED = [
  'pause', 'time-pos', 'duration', 'volume', 'mute', 'speed', 'eof-reached', 'filename',
  'track-list', 'aid', 'sid', 'secondary-sid', 'dwidth', 'dheight',
  'hwdec-current', 'video-codec', 'demuxer-cache-duration', 'frame-drop-count',
  'container-fps', 'file-format', 'file-size',
  'current-ao', 'audio-device-list',
  // Picture and sound, for media.ts. Individual fields rather than the whole
  // `video-params` object: that also carries HDR10+ / Dolby Vision dynamic
  // metadata, which changes every scene or frame and would flood this channel.
  // (Fields an older mpv lacks are accepted and simply stay empty.)
  'video-params/gamma', 'video-params/primaries', 'video-params/pixelformat',
  'video-params/w', 'video-params/h',
  'video-params/max-cll', 'video-params/max-fall', 'video-params/max-luma',
  'video-target-params/gamma', 'audio-out-params/format',
  'chapter-list',
] as const;

/** Formats mpv may hand to the receiver undecoded when passthrough is on. */
const SPDIF_CODECS = 'ac3,eac3,dts,dts-hd,truehd';
let passthrough = false;

let _dw = 0; let _dh = 0;

let initialized = false;
let initPromise: Promise<boolean> | null = null;
let unlisten: (() => void) | null = null;

const state: MpvState = {
  paused: true, currentTime: 0, duration: 0, volume: 1, muted: false, speed: 1, ended: false,
  tracks: [], audioId: null, subId: null, videoAspect: null, media: {}, chapters: [],
};
const subscribers = new Set<(s: MpvState) => void>();

/** True only when running inside the Tauri shell (mpv unavailable in a plain browser). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Retry a transient mpv IPC call (mpv can be slow to accept its first connection). */
async function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw last;
}

function emit() {
  const snap = { ...state };
  subscribers.forEach((cb) => cb(snap));
}

/** Subscribe to engine state. Fires immediately with the current snapshot. */
export function subscribeMpv(cb: (s: MpvState) => void): () => void {
  subscribers.add(cb);
  cb({ ...state });
  return () => { subscribers.delete(cb); };
}

export function getMpvState(): MpvState {
  return { ...state };
}

// ---------------------------------------------------------------------------
// Audio-output recovery.
//
// When the audio device changes (headphones in/out, a Bluetooth headset
// reconnecting) mpv closes its WASAPI output and re-opens it on the new default
// device. If that re-open fails — and right after a reconnect it often does,
// because Windows is still bringing the endpoint up — mpv logs "Could not
// open/initialize audio device -> no sound", DESELECTS the audio track and never
// tries again. The video keeps playing in silence until a new file is loaded.
//
// mpv does not reflect that in `aid` (it keeps reporting the old id); the only
// signal is `track-list`, where the audio track is now selected=false. So we
// watch for "has an audio track, none selected" and re-select the track, which
// rebuilds the audio chain and re-opens the device. Attempts back off, because
// the device can take a few seconds to settle, and stop after a handful so a
// file whose audio genuinely cannot play is not retried forever. Any change to
// `audio-device-list` — the device coming back — starts a fresh round.
// Verified against the bundled mpv by forcing the re-open to fail over IPC.
// ---------------------------------------------------------------------------

const AUDIO_RECOVERY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];
let audioRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
let audioRecoveryAttempt = 0;

/** The open file has audio, and mpv is not playing any of it. */
function audioDropped(): boolean {
  const audio = state.tracks.filter(t => t.type === 'audio');
  return audio.length > 0 && !audio.some(t => t.selected);
}

function cancelAudioRecovery(): void {
  if (audioRecoveryTimer) { clearTimeout(audioRecoveryTimer); audioRecoveryTimer = null; }
  audioRecoveryAttempt = 0;
}

function scheduleAudioRecovery(): void {
  if (audioRecoveryTimer) return;                                       // one attempt in flight
  if (audioRecoveryAttempt >= AUDIO_RECOVERY_DELAYS_MS.length) return;  // gave up until a device change
  const delay = AUDIO_RECOVERY_DELAYS_MS[audioRecoveryAttempt++];
  audioRecoveryTimer = setTimeout(async () => {
    audioRecoveryTimer = null;
    if (!audioDropped()) { audioRecoveryAttempt = 0; return; }          // came back, or file changed
    // Prefer the track that was playing (aid still names it), else the first one.
    const audio = state.tracks.filter(t => t.type === 'audio');
    const id = audio.some(t => t.id === state.audioId) ? state.audioId! : audio[0].id;
    console.warn(`[mpv] audio output lost — re-selecting audio track ${id} `
      + `(attempt ${audioRecoveryAttempt}/${AUDIO_RECOVERY_DELAYS_MS.length})`);
    try { await setProperty('aid', id as any); }
    catch (e) { console.error('[mpv] audio recovery: could not re-select the track', e); }
    // If the device still is not ready mpv drops the track again; that arrives
    // as another track-list update and queues the next, slower attempt.
  }, delay);
}

/** An audio device appeared or disappeared: whatever came before, start over. */
function onAudioDevicesChanged(): void {
  cancelAudioRecovery();
  if (audioDropped()) scheduleAudioRecovery();
}

// ---------------------------------------------------------------------------
// Dynamic HDR metadata.
//
// HDR10+ and Dolby Vision carry per-scene/per-frame metadata, which is why
// `video-params` isn't observed as a whole. Whether a file HAS it is a one-off
// question, so it's asked once, shortly after the picture's format is known.
// ---------------------------------------------------------------------------

let dynamicProbe: ReturnType<typeof setTimeout> | null = null;

function scheduleDynamicProbe(): void {
  if (dynamicProbe) clearTimeout(dynamicProbe);
  dynamicProbe = setTimeout(async () => {
    dynamicProbe = null;
    try {
      const params = await getProperty<Record<string, any>>('video-params');
      state.media = { ...state.media, dynamic: dynamicMetadataOf(params) };
      emit();
    } catch { /* no video, or the file changed — nothing to learn */ }
  }, 1200);
}

function setMediaVideo(key: string, value: unknown): void {
  const video = { ...state.media.video };
  if (value === null || value === undefined) delete video[key]; else video[key] = value;
  state.media = { ...state.media, video };
}

/**
 * Initialize the mpv engine. `mpvPath` points at a bundled mpv binary; omit it
 * in dev to use mpv from PATH. Safe to call multiple times (returns the same
 * promise). Returns false in a non-Tauri (browser) context.
 */
export function initMpv(mpvPath?: string): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const mkConfig = (path?: string): MpvConfig => ({
      path,
      args: [
        '--vo=gpu-next',               // modern GPU renderer (needed for HDR)
        '--hwdec=auto-safe',           // hardware decode when safe
        '--keep-open=yes',             // pause on last frame instead of closing
        '--force-window=yes',          // always show the video surface
        '--idle=yes',                  // stay alive with no file loaded
        // HDR: libplacebo renders HDR10, HDR10+ (dynamic metadata), HLG and Dolby
        // Vision (profiles 5, 7 and 8, by applying the RPU), and this hint has it
        // switch the screen into HDR when Windows HDR is on. On an SDR screen the
        // same pipeline tone-maps instead, peak-detected per scene.
        '--target-colorspace-hint=yes',
        // Bitstream Dolby / DTS to an AV receiver when the user has turned it on.
        // Changed live by mpvSetPassthrough(); this is just the starting value.
        `--audio-spdif=${passthrough ? SPDIF_CODECS : ''}`,
        // Streaming: the engine answers an open-ended range with a bounded slice
        // so no single request can pin a serving thread to writing tens of GB.
        // ffmpeg treats a short body as a dead connection unless told to ask
        // again — without this a big MKV never gets past reading its header,
        // because its cues live at EOF and every seek fails.
        '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5',
        '--osc=no',                    // no mpv OSC — our React UI draws controls
        '--input-default-bindings=no', // our UI owns keyboard/mouse input
        '--cursor-autohide=no',
      ],
      observedProperties: OBSERVED,
      // mpv.exe is ~115 MB; a cold start can take several seconds. A short timeout
      // here makes init() "fail" while mpv is still coming up.
      ipcTimeoutMs: 20000,
    });

    // Resolve the bundled mpv ONCE, verified to exist by the backend. If it isn't
    // there (plain dev checkout) we pass undefined and the plugin uses PATH.
    // NOTE: we must call init() exactly once — a second init() while mpv is still
    // starting spawns a rival mpv process that fights for the video window.
    let chosen: string | undefined = mpvPath;
    if (!chosen) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        chosen = (await invoke<string | null>('bundled_mpv_path')) ?? undefined;
      } catch { /* older backend — fall through to PATH */ }
    }

    try {
      await init(mkConfig(chosen));
    } catch (e) {
      console.error(`[mpv] init failed (using ${chosen ?? 'mpv on PATH'})`, e);
      initPromise = null; // allow a clean retry later
      return false;
    }

    // The plugin's init() only waits for mpv's IPC *pipe to exist* — mpv may not be
    // accepting connections yet, so the very first command can fail (that's why
    // "Try Again" used to work). Poll a harmless command until it lands, and only
    // then report ready. Every command wrapper below waits on this.
    try {
      await retry(() => setProperty('pause', true), 25, 120);
    } catch (e) {
      console.error('[mpv] started but never accepted IPC commands', e);
      // Tear the half-started instance down BEFORE allowing a retry: the next
      // init() would otherwise spawn a rival mpv that fights this one for the
      // window (see the NOTE above).
      await destroy().catch(() => {});
      initPromise = null;
      return false;
    }
    initialized = true;
    recordCapabilities();

    unlisten = await observeProperties(OBSERVED, ({ name, data }) => {
      switch (name) {
        case 'pause':        state.paused = !!data; break;
        case 'time-pos':     if (typeof data === 'number') state.currentTime = data; break;
        case 'duration':     if (typeof data === 'number') state.duration = data; break;
        case 'volume':       if (typeof data === 'number') state.volume = Math.max(0, Math.min(1, data / 100)); break;
        case 'mute':         state.muted = !!data; break;
        case 'speed':        if (typeof data === 'number') state.speed = data; break;
        case 'eof-reached':  state.ended = !!data; break;
        case 'filename':     state.filename = (data as string) ?? undefined; break;
        case 'aid':          state.audioId = typeof data === 'number' ? data : null; break;
        case 'sid':          state.subId = typeof data === 'number' ? data : null; break;
        case 'secondary-sid': state.secondarySubId = typeof data === 'number' ? data : null; break;
        case 'dwidth':       _dw = typeof data === 'number' ? data : 0; state.width = _dw || undefined; state.videoAspect = _dw && _dh ? _dw / _dh : null; break;
        case 'dheight':      _dh = typeof data === 'number' ? data : 0; state.height = _dh || undefined; state.videoAspect = _dw && _dh ? _dw / _dh : null; break;
        case 'container-fps':          state.fps = typeof data === 'number' ? data : undefined; break;
        case 'file-format':            state.fileFormat = typeof data === 'string' ? data : undefined; break;
        case 'file-size':              state.fileSize = typeof data === 'number' ? data : undefined; break;
        case 'hwdec-current':
          state.hwdec = typeof data === 'string' ? data : undefined;
          state.media = { ...state.media, hwdec: state.hwdec };
          break;
        case 'video-codec':            state.videoCodec = typeof data === 'string' ? data : undefined; break;
        case 'demuxer-cache-duration': state.cacheAhead = typeof data === 'number' ? data : undefined; break;
        case 'frame-drop-count':       state.droppedFrames = typeof data === 'number' ? data : undefined; break;
        case 'current-ao':
          state.audioOutput = typeof data === 'string' && data ? data : null;
          // An output is open again: the recovery (if any) worked, reset its budget.
          if (state.audioOutput) cancelAudioRecovery();
          break;
        case 'audio-device-list': onAudioDevicesChanged(); break;
        case 'video-params/gamma':
          setMediaVideo('gamma', data);
          if (data) scheduleDynamicProbe();
          break;
        case 'video-params/primaries':  setMediaVideo('primaries', data); break;
        case 'video-params/pixelformat': setMediaVideo('pixelformat', data); break;
        case 'video-params/w':          setMediaVideo('w', data); break;
        case 'video-params/h':          setMediaVideo('h', data); break;
        case 'video-params/max-cll':    setMediaVideo('max-cll', data); break;
        case 'video-params/max-fall':   setMediaVideo('max-fall', data); break;
        case 'video-params/max-luma':   setMediaVideo('max-luma', data); break;
        case 'video-target-params/gamma':
          state.media = { ...state.media, target: data ? { gamma: data } : undefined };
          break;
        case 'audio-out-params/format':
          state.media = { ...state.media, audioOut: data ? { format: data } : undefined };
          break;
        case 'chapter-list':
          state.chapters = Array.isArray(data)
            // Discs and many files leave chapters unnamed — number them instead.
        ? data.filter((c: any) => typeof c?.time === 'number').map((c: any, i: number) => ({ title: c.title || `Chapter ${i + 1}`, time: c.time }))
            : [];
          break;
        case 'track-list':
          if (Array.isArray(data)) {
            state.tracks = data.map((t: any) => ({
              id: t.id, type: t.type, title: t.title, lang: t.lang,
              selected: !!t.selected, codec: t.codec,
              channels: t['demux-channel-count'] ?? t['audio-channels'] ?? undefined,
              forced: !!t.forced, default: !!t.default, external: !!t.external,
              profile: t['codec-profile'] ?? undefined,
              hearingImpaired: !!t['hearing-impaired'],
            }));
            // media.ts reads the playing tracks raw: codec profile, Dolby Vision
            // record, sample rate — whatever this mpv build reports.
            const playing = (type: string) => data.find((t: any) => t.type === type && t.selected);
            state.media = { ...state.media, videoTrack: playing('video'), audioTrack: playing('audio') };
            if (audioDropped()) scheduleAudioRecovery();
          }
          break;
      }
      emit();
    });

    initialized = true;
    return true;
  })();

  return initPromise;
}

// --- Playback control (mirrors the old <video> surface) -------------------
//
// CRITICAL: tauri-plugin-mpv panics (`instances.get(label).unwrap()` on None) if
// any command/property call arrives before init() registered the instance. That
// panic poisons the plugin's mutex — and with panic=abort it kills the whole app.
// So EVERY call below waits for init to finish first, and no-ops if mpv is absent.

async function ready(): Promise<boolean> {
  if (initialized) return true;
  return initMpv(); // starts init if needed; memoized, so only one mpv is spawned
}

/** A Blu-ray or DVD: an ISO, or the folder that holds BDMV / VIDEO_TS. */
export interface DiscSource {
  kind: 'bluray' | 'dvd';
  /** Blu-ray playlist number ("00800.mpls" → 800); absent = the main feature. */
  playlist?: number;
}

/**
 * The mpv URL that plays `path`. A disc is opened through libbluray / libdvdnav
 * with the ISO or folder as the device, so menus are skipped and the longest
 * title — the film — plays, with the disc's chapters and every audio and
 * subtitle stream.
 */
async function urlFor(path: string, disc?: DiscSource): Promise<string> {
  if (!disc) return path;
  await setProperty(disc.kind === 'bluray' ? 'bluray-device' : 'dvd-device', path);
  if (disc.kind === 'dvd') return 'dvd://';
  return disc.playlist !== undefined ? `bd://mpls/${disc.playlist}` : 'bd://';
}

export async function mpvLoad(path: string, startSeconds = 0, disc?: DiscSource): Promise<void> {
  cancelAudioRecovery();
  state.ended = false;
  state.tracks = []; state.audioId = null; state.subId = null; state.secondarySubId = null;
  state.videoAspect = null; _dw = 0; _dh = 0;
  state.media = {}; state.chapters = [];
  if (dynamicProbe) { clearTimeout(dynamicProbe); dynamicProbe = null; }
  if (!(await ready())) throw new Error('mpv engine is not running');
  // Resume: start the file AT the saved position via a file-local option, so mpv
  // applies it as it opens the file. Unlike a seek fired after load, this can never
  // be dropped. mpv >= 0.38 loadfile syntax: loadfile <url> <flags> <index> <options>.
  const url = await urlFor(path, disc);
  const loadArgs: (string | number)[] = startSeconds > 0
    // Keep sub-second precision — Math.floor() threw away up to a second on every
    // resume, so "continue where I left off" always landed slightly early.
    ? [url, 'replace', 0, `start=${startSeconds.toFixed(3)}`]
    : [url];
  // Retry: loading a network stream (or a cold engine) can transiently fail.
  await retry(() => command('loadfile', loadArgs) as Promise<unknown>, 3, 250);
  await setProperty('pause', false);
}

/** Toggle subtitle visibility (for the "c" shortcut). */
export async function mpvCycleSubVisibility(): Promise<void> {
  if (!(await ready())) return;
  await command('cycle', ['sub-visibility']);
}

/** Select an embedded audio track by mpv track id. */
export async function mpvSetAudioTrack(id: number): Promise<void> {
  if (!(await ready())) return;
  await setProperty('aid', id as any);
}

/**
 * Send Dolby (Digital, Digital Plus, TrueHD — with Atmos) and DTS (incl. DTS-HD
 * MA and DTS:X) to the AV receiver as a bitstream instead of decoding them here.
 * Only a receiver or soundbar can render Atmos and DTS:X objects; decoded on the
 * PC they play as their 5.1/7.1 bed. Other formats keep decoding as usual.
 *
 * mpv picks "decode or pass through" when it builds the audio decoder, so a
 * change mid-file re-selects the track (verified against mpv: an output reload
 * alone keeps decoding). Before mpv starts, it only sets the starting value.
 */
export async function mpvSetPassthrough(on: boolean): Promise<void> {
  passthrough = on;
  if (!initialized) return;
  await setProperty('audio-spdif', on ? SPDIF_CODECS : '');
  const aid = state.audioId;
  if (aid === null) return;
  await setProperty('aid', 'no' as any);
  await setProperty('aid', aid as any);
}

// ---------------------------------------------------------------------------
// What this mpv build can decode. Read once mpv is up and kept, so Settings can
// show it without starting the engine just to ask.
// ---------------------------------------------------------------------------

const STORAGE_CAPS = 'prevplayer_mpv_caps';

export interface MpvCapabilities { mpv?: string; ffmpeg?: string; decoders: { codec?: string }[] }

async function recordCapabilities(): Promise<void> {
  try {
    const [decoders, mpv, ffmpeg] = await Promise.all([
      getProperty<{ codec?: string }[]>('decoder-list'),
      getProperty<string>('mpv-version').catch(() => undefined),
      getProperty<string>('ffmpeg-version').catch(() => undefined),
    ]);
    if (!Array.isArray(decoders)) return;
    const caps: MpvCapabilities = { mpv, ffmpeg, decoders: decoders.map(d => ({ codec: d.codec })) };
    localStorage.setItem(STORAGE_CAPS, JSON.stringify(caps));
  } catch { /* an older plugin or mpv — Settings just won't list them */ }
}

/** The last capability report, or null if mpv hasn't run on this PC yet. */
export function mpvCapabilities(): MpvCapabilities | null {
  try {
    const raw = localStorage.getItem(STORAGE_CAPS);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

/**
 * After Windows switches HDR on or off under a playing video: re-send the
 * colour-space hint, so mpv re-reads what the screen can show now instead of
 * keeping the swap chain it opened with.
 */
export async function mpvRefreshColorspace(): Promise<void> {
  if (!initialized) return;
  await setProperty('target-colorspace-hint', false).catch(() => {});
  await setProperty('target-colorspace-hint', true).catch(() => {});
}

/** Show a second subtitle above the first, or null for none. */
export async function mpvSetSecondarySubtitle(id: number | null): Promise<void> {
  if (!(await ready())) return;
  await setProperty('secondary-sid', (id === null ? 'no' : id) as any);
}

/**
 * Read several properties at once, for Stats for nerds. One that this mpv
 * lacks, or that has no value right now, comes back undefined.
 */
export async function mpvGetProperties(names: readonly string[]): Promise<Record<string, any>> {
  if (!initialized) return {};
  const values = await Promise.all(names.map(n => getProperty<any>(n).catch(() => undefined)));
  return Object.fromEntries(names.map((n, i) => [n, values[i]]));
}

/** Select an embedded/added subtitle track by id, or null to turn subtitles off. */
export async function mpvSetSubtitleTrack(id: number | null): Promise<void> {
  if (!(await ready())) return;
  await setProperty('sid', (id === null ? 'no' : id) as any);
}

/**
 * Ask mpv for the picture's display aspect RIGHT NOW, instead of waiting to be told.
 *
 * `dwidth`/`dheight` are observed properties, so they only push on CHANGE. If mpv
 * settled on them before we subscribed — or a given file/codec path simply never
 * fires them — `state.videoAspect` sits at null forever, PiP falls back to its
 * 16:9 guess, and a portrait clip ends up pillarboxed inside a landscape window.
 * Querying directly closes that gap, with two fallbacks for good measure.
 */
export async function mpvFetchVideoAspect(): Promise<number | null> {
  if (!(await ready())) return null;
  const num = async (name: string): Promise<number> => {
    try {
      const v = await getProperty<number>(name);
      return typeof v === 'number' && isFinite(v) ? v : 0;
    } catch { return 0; }
  };
  const pairs: [string, string][] = [
    ['dwidth', 'dheight'],                 // display size — honours anamorphic
    ['video-params/dw', 'video-params/dh'],
    ['width', 'height'],                   // raw decoded size
  ];
  for (const [wName, hName] of pairs) {
    const [w, h] = [await num(wName), await num(hName)];
    if (w > 0 && h > 0) {
      _dw = w; _dh = h;
      state.videoAspect = w / h;
      emit();
      return state.videoAspect;
    }
  }
  return null;
}

/** The open file's real duration, straight from mpv (0 if unknown). */
export async function mpvGetDuration(): Promise<number> {
  if (!(await ready())) return 0;
  try {
    const v = await getProperty<number>('duration');
    return typeof v === 'number' && isFinite(v) && v > 0 ? v : 0;
  } catch { return 0; }
}

export async function mpvSetPaused(paused: boolean): Promise<void> {
  if (!(await ready())) return;
  await setProperty('pause', paused);
}

export async function mpvTogglePause(): Promise<void> {
  if (!(await ready())) return;
  await command('cycle', ['pause']);
}

/** Seek to an absolute time (seconds). */
export async function mpvSeekAbsolute(seconds: number): Promise<void> {
  if (!(await ready())) return;
  await command('seek', [seconds, 'absolute', 'exact']);
}

/** Seek by a delta (seconds, +/-). */
export async function mpvSeekRelative(delta: number): Promise<void> {
  if (!(await ready())) return;
  await command('seek', [delta, 'relative']);
}

/** Volume in 0..1 (converted to mpv's 0..100). */
export async function mpvSetVolume(v01: number): Promise<void> {
  if (!(await ready())) return;
  await setProperty('volume', Math.round(Math.max(0, Math.min(1, v01)) * 100));
}

export async function mpvSetMuted(muted: boolean): Promise<void> {
  if (!(await ready())) return;
  await setProperty('mute', muted);
}

export async function mpvSetSpeed(speed: number): Promise<void> {
  if (!(await ready())) return;
  await setProperty('speed', speed);
}

export async function mpvSetLoop(loop: boolean): Promise<void> {
  if (!(await ready())) return;
  await setProperty('loop-file', loop ? 'inf' : 'no');
}

/** Add and select an external subtitle file (native path). */
export async function mpvAddSubtitle(path: string): Promise<void> {
  if (!(await ready())) return;
  await command('sub-add', [path, 'select']);
}

export async function mpvSetSubtitleVisible(visible: boolean): Promise<void> {
  if (!(await ready())) return;
  await setProperty('sub-visibility', visible);
}

export async function mpvStop(): Promise<void> {
  cancelAudioRecovery();
  if (!initialized) return; // never start mpv just to stop it
  await command('stop');
}

/** Tear down the engine (on app exit / leaving the player for good). */
export async function shutdownMpv(): Promise<void> {
  cancelAudioRecovery();
  if (unlisten) { unlisten(); unlisten = null; }
  if (initialized) { await destroy().catch(() => {}); initialized = false; initPromise = null; }
}
