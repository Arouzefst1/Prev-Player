// ==========================================================================
// App Settings — a tiny localStorage-backed store + React hook.
//
// One place that decides how the app behaves: whether newly-added videos start
// playing, whether playback resumes where you left off, the default volume/speed,
// where downloads land, etc. Persisted to localStorage and broadcast to every
// subscriber so all open views stay in sync the instant a toggle flips.
// ==========================================================================

import { useState, useEffect, useCallback } from 'react';
import type { ShortcutAction } from './shortcuts';

export interface AppSettings {
  /** Start playing videos immediately when they're added to the library. */
  playOnAdd: boolean;
  /** Auto-advance to the next video in a playlist/queue when one ends. */
  autoplayNext: boolean;
  /** Keep advancing through the queue while the mini-player (PiP) is open. */
  pipAutoplayQueue: boolean;
  /**
   * Whether the scroll wheel changes volume while the mini-player (PiP) is open.
   * Off by default: the mini-player floats over other windows, so a stray scroll
   * on the way past it shouldn't silently move the volume. (At full size the
   * wheel always works — the pointer is over the video because you're watching it.)
   */
  pipScrollVolume: boolean;
  /** Resume videos from where you left off. */
  resumePlayback: boolean;
  /** Show the "Resume Watching" card on the home screen. */
  rememberLastVideo: boolean;
  /** Default library layout. */
  defaultView: 'list' | 'grid';
  /** Starting volume for a video (0–1). */
  defaultVolume: number;
  /** Starting playback speed (0.25–2). */
  defaultSpeed: number;
  /** How much the ">"/"<" keys and the speed panel's +/− buttons nudge speed. */
  speedStep: number;
  /** Check for app updates automatically on launch. */
  autoCheckUpdates: boolean;
  /** Folder received/downloaded videos are saved to (null → Downloads/PREV Player). */
  downloadPath: string | null;
  /**
   * Send Dolby and DTS audio to an AV receiver / soundbar undecoded, so it can
   * render Atmos and DTS:X. Off by default: speakers or headphones plugged into
   * the PC would get silence.
   */
  audioPassthrough: boolean;
  /**
   * Turn Windows HDR on while an HDR video plays (and back off after), so it
   * isn't tone-mapped down on a screen that could show it.
   */
  autoHdr: boolean;
  /** Switch the screen's refresh rate to match the video (24p on a 24 Hz mode). */
  matchRefreshRate: boolean;
  /** How see-through the Stats for nerds panel is: 0.15 (glass) … 1 (solid). */
  statsOpacity: number;
  /** Keys the user changed; anything missing uses the default (shortcuts.ts). */
  shortcuts: Partial<Record<ShortcutAction, string>>;
  /**
   * Pick the audio track in the preferred language, best quality first
   * (lossless and Atmos over lossy, surround over stereo), skipping commentary.
   */
  smartAudio: boolean;
  /** Language for smart audio and subtitles ("" = the app's language). */
  preferredLanguage: string;
  /** Remember the audio and subtitle tracks picked for a video, and use them for the rest of its folder. */
  rememberTracks: boolean;
  /** Show forced subtitles (signs, foreign dialogue) even with subtitles off. */
  forcedSubtitles: boolean;
  /** A second subtitle line, in this language, above the first ("" = off). */
  secondSubtitleLanguage: string;
  /** Skipping back with subtitles off shows them for the part you replay. */
  subtitlesOnSkipBack: boolean;
  /** Open Blu-ray and DVD ISOs and BDMV / VIDEO_TS folders as discs. */
  discPlayback: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  playOnAdd: false,
  autoplayNext: true,
  pipAutoplayQueue: true,
  pipScrollVolume: false,
  resumePlayback: true,
  rememberLastVideo: true,
  defaultView: 'list',
  defaultVolume: 1,
  defaultSpeed: 1,
  speedStep: 0.5,
  autoCheckUpdates: true,
  downloadPath: null,
  audioPassthrough: false,
  autoHdr: false,
  matchRefreshRate: false,
  statsOpacity: 0.6,
  shortcuts: {},
  smartAudio: false,
  preferredLanguage: '',
  rememberTracks: false,
  forcedSubtitles: false,
  secondSubtitleLanguage: '',
  subtitlesOnSkipBack: false,
  discPlayback: false,
};

const STORAGE_SETTINGS = 'prevplayer_settings';

type Listener = (s: AppSettings) => void;
const listeners = new Set<Listener>();

function readSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    // Spread over defaults so new settings added in later versions get sane values.
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export const settingsStore = {
  /** Current settings (always reads the latest from storage). */
  get(): AppSettings {
    return readSettings();
  },

  /** Merge a partial update, persist it, and notify all subscribers. */
  set(patch: Partial<AppSettings>): AppSettings {
    const next = { ...readSettings(), ...patch };
    try { localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(next)); } catch {}
    listeners.forEach(fn => fn(next));
    return next;
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};

/** React hook: current settings + an updater. Re-renders on any change anywhere. */
export function useSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  const [settings, setSettings] = useState<AppSettings>(() => settingsStore.get());
  useEffect(() => settingsStore.subscribe(setSettings), []);
  const update = useCallback((patch: Partial<AppSettings>) => { settingsStore.set(patch); }, []);
  return [settings, update];
}
