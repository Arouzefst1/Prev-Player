// Thumbnails, lengths and format probes from the headless mpv in the backend
// (src-tauri/src/frames.rs → engine/crates/prev-frames). Opens anything the
// player can play, unlike the WebView's <video>.

import { invoke } from '@tauri-apps/api/core';
import type { RawMedia } from './media';

export interface Probe {
  duration?: number;
  videoParams?: Record<string, any>;
  trackList: Record<string, any>[];
  /** JPEG data URL; absent for audio without cover art. */
  thumbnail?: string;
}

export type FrameLane = 'library' | 'preview';

export const probe = (path: string): Promise<Probe> => invoke<Probe>('frames_probe', { path });

/**
 * The frame at `at` seconds: the keyframe before it (quick), or with `exact`
 * that very frame (decodes forward from the keyframe). Null for audio; rejects
 * when the file can't be read right now.
 */
export const grabFrame = (path: string, at: number, lane: FrameLane = 'preview', exact = false): Promise<string | null> =>
  invoke<string | null>('frames_grab', { path, at, laneName: lane, exact });

export interface Storyboard {
  /** Seconds between frames (1). */
  step: number;
  /** JPEG data URLs; frame i is at i × step seconds. */
  frames: string[];
}

/** A frame for every second of a video that's cheap to decode end to end, else null. */
export const storyboard = (path: string): Promise<Storyboard | null> =>
  invoke<Storyboard | null>('frames_storyboard', { path });

export const releaseFrames = (lane: FrameLane): Promise<void> =>
  invoke<void>('frames_release', { laneName: lane }).catch(() => {});

const VIDEO_KEYS = ['codec', 'dolby-vision-profile', 'dolby-vision-level', 'demux-w', 'demux-h'];
const AUDIO_KEYS = ['codec', 'codec-profile', 'title', 'demux-channel-count', 'demux-samplerate'];

const pick = (o: Record<string, any> | undefined, keys: string[]) =>
  o ? Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]])) : undefined;

/**
 * The part of a probe worth keeping with a library entry: what media.ts needs
 * to describe it, for the tracks mpv would play by default.
 */
export function mediaOfProbe(p: Probe): RawMedia {
  const playing = (type: string) => p.trackList.find(t => t.type === type && t.selected)
    ?? p.trackList.find(t => t.type === type && !t.albumart);
  return {
    video: p.videoParams,
    videoTrack: pick(playing('video'), VIDEO_KEYS),
    audioTrack: pick(playing('audio'), AUDIO_KEYS),
  };
}
