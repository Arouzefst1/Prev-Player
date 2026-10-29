// Blu-ray and DVD discs: ISO images and BDMV / VIDEO_TS folders (opt-in,
// Settings › Playback). What's a disc is decided by the backend
// (src-tauri/src/disc.rs); mpv plays it (mpv.ts › DiscSource).

import { invoke } from '@tauri-apps/api/core';
import { isMediaPath } from './formats';

export interface DiscTitle {
  /** Blu-ray playlist number (00800.mpls → 800). */
  playlist: number;
  seconds: number;
  chapters: number;
}

export interface DiscInfo {
  kind: 'bluray' | 'dvd';
  /** The ISO, or the folder that holds BDMV / VIDEO_TS. */
  root: string;
  label: string;
  /** Blu-ray folders: the titles worth offering, longest first. */
  titles: DiscTitle[];
}

const isUrl = (p: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(p);

export const isIsoPath = (p: string) => /\.iso$/i.test(p);

/** The disc at `path`, or null — for a normal media file without asking the backend. */
export async function probeDisc(path: string | undefined): Promise<DiscInfo | null> {
  if (!path || isUrl(path) || isMediaPath(path)) return null;
  return invoke<DiscInfo | null>('disc_probe', { path }).catch(() => null);
}

export const discName = (kind: DiscInfo['kind']) => (kind === 'bluray' ? 'Blu-ray' : 'DVD');
