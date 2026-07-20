// ==========================================================================
// App Settings — a tiny localStorage-backed store + React hook.
//
// One place that decides how the app behaves: whether newly-added videos start
// playing, whether playback resumes where you left off, the default volume/speed,
// where downloads land, etc. Persisted to localStorage and broadcast to every
// subscriber so all open views stay in sync the instant a toggle flips.
// ==========================================================================

import { useState, useEffect, useCallback } from 'react';

export interface AppSettings {
  /** Start playing videos immediately when they're added to the library. */
  playOnAdd: boolean;
  /** Auto-advance to the next video in a playlist/queue when one ends. */
  autoplayNext: boolean;
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
  /** Check for app updates automatically on launch. */
  autoCheckUpdates: boolean;
  /** Folder received/downloaded videos are saved to (null → Downloads/PREV Player). */
  downloadPath: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  playOnAdd: false,
  autoplayNext: true,
  resumePlayback: true,
  rememberLastVideo: true,
  defaultView: 'list',
  defaultVolume: 1,
  defaultSpeed: 1,
  autoCheckUpdates: true,
  downloadPath: null,
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
