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
  init, destroy, command, setProperty, observeProperties,
  type MpvConfig,
} from 'tauri-plugin-mpv-api';

export interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  title?: string;
  lang?: string;
  selected: boolean;
  codec?: string;
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
  videoAspect: number | null; // display aspect ratio (dwidth/dheight)
}

// Properties we ask mpv to push to us on change.
const OBSERVED = [
  'pause', 'time-pos', 'duration', 'volume', 'mute', 'speed', 'eof-reached', 'filename',
  'track-list', 'aid', 'sid', 'dwidth', 'dheight',
] as const;

let _dw = 0; let _dh = 0;

let initialized = false;
let initPromise: Promise<boolean> | null = null;
let unlisten: (() => void) | null = null;

const state: MpvState = {
  paused: true, currentTime: 0, duration: 0, volume: 1, muted: false, speed: 1, ended: false,
  tracks: [], audioId: null, subId: null, videoAspect: null,
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
        '--target-colorspace-hint=yes',// HDR10/Dolby passthrough hint
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
      initPromise = null;
      return false;
    }
    initialized = true;

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
        case 'dwidth':       _dw = typeof data === 'number' ? data : 0; state.videoAspect = _dw && _dh ? _dw / _dh : null; break;
        case 'dheight':      _dh = typeof data === 'number' ? data : 0; state.videoAspect = _dw && _dh ? _dw / _dh : null; break;
        case 'track-list':
          if (Array.isArray(data)) {
            state.tracks = data.map((t: any) => ({
              id: t.id, type: t.type, title: t.title, lang: t.lang,
              selected: !!t.selected, codec: t.codec,
            }));
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

export async function mpvLoad(path: string, startSeconds = 0): Promise<void> {
  state.ended = false;
  state.tracks = []; state.audioId = null; state.subId = null;
  state.videoAspect = null; _dw = 0; _dh = 0;
  if (!(await ready())) throw new Error('mpv engine is not running');
  // Resume: start the file AT the saved position via a file-local option, so mpv
  // applies it as it opens the file. Unlike a seek fired after load, this can never
  // be dropped. mpv >= 0.38 loadfile syntax: loadfile <url> <flags> <index> <options>.
  const loadArgs: (string | number)[] = startSeconds > 0
    ? [path, 'replace', 0, `start=${Math.floor(startSeconds)}`]
    : [path];
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

/** Select an embedded/added subtitle track by id, or null to turn subtitles off. */
export async function mpvSetSubtitleTrack(id: number | null): Promise<void> {
  if (!(await ready())) return;
  await setProperty('sid', (id === null ? 'no' : id) as any);
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
  if (!initialized) return; // never start mpv just to stop it
  await command('stop');
}

/** Tear down the engine (on app exit / leaving the player for good). */
export async function shutdownMpv(): Promise<void> {
  if (unlisten) { unlisten(); unlisten = null; }
  if (initialized) { await destroy().catch(() => {}); initialized = false; initPromise = null; }
}
