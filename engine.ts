// ===========================================================================
// The transfer engine, from the frontend's side.
//
// One module wraps every `engine_*` command and the single `prev-engine` event
// channel. Nothing above this file knows how bytes move: a share, a stream and
// a download are all "a link, and maybe an index into it".
//
// The link is opaque on purpose. It is minted by the backend (LAN share, or
// `httpLink` for GitHub assets) and handed back unread — the wire format lives
// in Rust so the two sides can never drift.
// ===========================================================================

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ---- what a share turns out to be -----------------------------------------

export interface ResolvedFile {
  /** Position in the share — the handle for `watch` / `download`. */
  index: number;
  name: string;
  size: number;
}

export interface Resolved {
  /** Pass this back for every later call on the same share. */
  link: string;
  name: string;
  kind: 'file' | 'folder';
  totalSize: number;
  transport: string;
  /**
   * False means the source refuses range requests. The engine needs them for
   * both streaming and parallel download, so this is the one hard "no".
   */
  seekable: boolean;
  files: ResolvedFile[];
}

export interface Published {
  /** Revocation handle for `stopShare`. */
  id: string;
  link: string;
  name: string;
  size: number;
  fileCount: number;
}

export interface WatchHandle {
  id: string;
  /** An ordinary seekable HTTP URL — hand it straight to mpv. */
  url: string;
  name: string;
  size: number;
}

export interface Started {
  /** Transfer id: the key for progress events, pause, resume and cancel. */
  id: string;
  name: string;
  size: number;
  dest: string;
}

export type TransferState =
  | 'queued' | 'running' | 'paused' | 'verifying' | 'completed' | 'failed' | 'cancelled';

/** What a "done" download's integrity claim actually rests on. */
export type Verification = 'verified' | 'sizeOnly' | 'skipped';

export interface TransferRecord {
  id: string;
  name: string;
  url: string;
  transport: string;
  dest: string;
  partial: string;
  total: number;
  chunkSize: number;
  chunksTotal: number;
  chunksDone: number;
  state: TransferState;
  error?: string | null;
  createdAt: number;
  updatedAt: number;
}

// Note the snake_case fields: the Rust enum renames its *variants* to camelCase,
// which leaves the fields inside them alone.
export type SaveOutcome =
  | { outcome: 'completed'; id: string; path: string }
  | { outcome: 'resumable'; id: string; chunks_done: number; chunks_total: number }
  | { outcome: 'notSaving' };

// ---- the one event channel -------------------------------------------------

export type EngineEvent =
  | {
      kind: 'downloadProgress';
      id: string; name: string;
      transferred: number; total: number;
      speedBps: number; etaSecs: number | null;
      chunksDone: number; chunksTotal: number; workers: number;
    }
  | {
      kind: 'downloadState';
      id: string; name: string; state: TransferState;
      error?: string; path?: string; verification?: Verification;
    }
  | {
      kind: 'streamStats';
      id: string; playhead: number;
      bufferedAhead: number; bufferedBehind: number;
      cachedBytes: number; cacheLimit: number; chunksResident: number;
      fetches: number; savedBytes: number; saving: boolean;
    }
  | { kind: 'streamState'; id: string; state: TransferState; error?: string }
  | { kind: 'chunkRepaired'; id: string; index: number };

/** Subscribe to progress, state changes and buffer stats for everything at once. */
export function onEngineEvent(fn: (e: EngineEvent) => void): Promise<UnlistenFn> {
  return listen<EngineEvent>('prev-engine', ({ payload }) => fn(payload));
}

// ---- sending ---------------------------------------------------------------

export function shareFile(path: string): Promise<Published> {
  return invoke('engine_share_file', { path });
}

export function shareFolder(paths: string[], folderName: string): Promise<Published> {
  return invoke('engine_share_folder', { paths, folderName });
}

export function stopShare(id: string): Promise<boolean> {
  return invoke('engine_stop_share', { id });
}

export function stopAllShares(): Promise<void> {
  return invoke('engine_stop_all_shares');
}

// ---- receiving -------------------------------------------------------------

/** Mint an engine link for sources the frontend resolved itself (GitHub assets). */
export function httpLink(
  name: string,
  files: { name: string; size: number; url: string; sha256?: string | null }[],
): Promise<string> {
  return invoke('engine_http_link', { name, files });
}

export function resolve(link: string): Promise<Resolved> {
  return invoke('engine_resolve', { link });
}

/** Open a stream. Nothing is written to disk unless `saveStream` is called. */
export function watch(link: string, index = 0): Promise<WatchHandle> {
  return invoke('engine_watch', { link, index });
}

/** Free the buffer. Always call this when playback of a stream ends. */
export function stopWatch(id: string): Promise<void> {
  return invoke('engine_stop_watch', { id });
}

/** Queue a download. Omit `indices` to take every file in the share. */
export function download(
  link: string,
  indices: number[] | null,
  destDir: string | null,
): Promise<Started[]> {
  return invoke('engine_download', { link, indices, destDir });
}

export function pause(id: string): Promise<void> { return invoke('engine_pause', { id }); }
export function resume(id: string): Promise<void> { return invoke('engine_resume', { id }); }
export function cancel(id: string): Promise<void> { return invoke('engine_cancel', { id }); }

/** Every transfer the engine remembers — including ones a quit interrupted. */
export function transfers(): Promise<TransferRecord[]> {
  return invoke('engine_transfers');
}

// ---- keeping a copy of what you're watching --------------------------------

/**
 * Start writing the stream to disk without interrupting playback. What is
 * already buffered is written straight away, so saving a film you're an hour
 * into doesn't re-fetch that hour. Returns the transfer id it's tracked under.
 */
export function saveStream(id: string, destDir: string | null): Promise<string> {
  return invoke('engine_save_stream', { id, destDir });
}

export function stopSaving(id: string): Promise<SaveOutcome> {
  return invoke('engine_stop_saving', { id });
}

/** Fetch only the parts of a saved stream that playback never reached. */
export function finishSave(transferId: string): Promise<void> {
  return invoke('engine_finish_save', { transferId });
}

// ---- misc ------------------------------------------------------------------

/** …/Downloads/PREV Player, created if needed. */
export function downloadDir(): Promise<string> {
  return invoke('engine_download_dir');
}

export interface Tuning {
  /** RAM ceiling for one streaming session, in MB. */
  streamCacheMb: number;
  /** Parallel workers per download; 0 = decide from the CPU count. */
  downloadWorkers: number;
}

export function getTuning(): Promise<Tuning> { return invoke('engine_tuning'); }

/** Applies on the next launch — a live session's buffer geometry is already set. */
export function setTuning(tuning: Tuning): Promise<void> {
  return invoke('engine_set_tuning', { tuning });
}
