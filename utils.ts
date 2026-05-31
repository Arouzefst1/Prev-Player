export const formatTime = (seconds: number): string => {
  if (isNaN(seconds)) return "00:00";

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
};

export const srtToVtt = (srt: string): string => {
  let vtt = "WEBVTT\n\n";
  vtt += srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return vtt;
};

export type ActionType =
  | 'play'
  | 'pause'
  | 'volume-up'
  | 'volume-down'
  | 'forward-5'
  | 'rewind-5'
  | 'forward-10'
  | 'rewind-10'
  | 'speed-up'
  | 'speed-down'
  | null;

export interface OverlayState {
  action: ActionType;
  value?: string | number;
  id: number;
}

/**
 * Extract thumbnail from a video URL at a specific time (with 8s timeout for Edge/Firefox).
 * Pass a Tauri asset URL (convertFileSrc result) as videoUrl.
 */
export const extractVideoThumbnail = (videoUrl: string, atTime: number = 1): Promise<string> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    const timer = setTimeout(() => {
      if (!settled) { settled = true; cleanup(); reject('Thumbnail extraction timed out'); }
    }, 8000);

    video.addEventListener('loadedmetadata', () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      video.currentTime = Math.min(atTime, video.duration * 0.1);
    });

    video.addEventListener('seeked', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } else {
        reject('Failed to get canvas context');
      }
      cleanup();
    });

    video.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject('Failed to load video for thumbnail');
    });

    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.src = videoUrl;
  });
};

/**
 * Get video duration from a URL (with 8s timeout for Edge/Firefox).
 */
export const getVideoDuration = (videoUrl: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    const timer = setTimeout(() => {
      if (!settled) { settled = true; cleanup(); reject('Duration extraction timed out'); }
    }, 8000);

    video.addEventListener('loadedmetadata', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(video.duration);
      cleanup();
    });

    video.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject('Failed to load video');
    });

    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.src = videoUrl;
  });
};

/**
 * Detect which video codecs/containers the current WebView supports.
 */
export const detectCodecSupport = (): Record<string, boolean> => {
  const video = document.createElement('video');
  const support: Record<string, boolean> = {};

  const codecTests = [
    { name: 'h264', mimes: ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.4D401E"', 'video/mp4; codecs="avc1.640028"'] },
    { name: 'hevc', mimes: ['video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="hvc1.1.6.L93.B0"'] },
    { name: 'vp8',  mimes: ['video/webm; codecs="vp8"'] },
    { name: 'vp9',  mimes: ['video/webm; codecs="vp9"', 'video/mp4; codecs="vp09.00.10.08"'] },
    { name: 'av1',  mimes: ['video/mp4; codecs="av01.0.05M.08"', 'video/webm; codecs="av01.0.05M.08"'] },
    { name: 'theora', mimes: ['video/ogg; codecs="theora"'] },
    { name: 'mpeg4',  mimes: ['video/mp4; codecs="mp4v.20.9"'] },
    { name: 'mp4',      mimes: ['video/mp4'] },
    { name: 'webm',     mimes: ['video/webm'] },
    { name: 'ogg',      mimes: ['video/ogg'] },
    { name: 'quicktime', mimes: ['video/quicktime'] },
    { name: 'avi',      mimes: ['video/avi', 'video/x-avi'] },
    { name: 'matroska', mimes: ['video/x-matroska', 'video/mkv'] },
    { name: 'flv',      mimes: ['video/x-flv'] },
    { name: '3gp',      mimes: ['video/3gpp'] },
    { name: 'ts',       mimes: ['video/mp2t'] },
    { name: 'wmv',      mimes: ['video/x-ms-wmv'] },
  ];

  for (const codec of codecTests) {
    let supported = false;
    for (const mime of codec.mimes) {
      try {
        const r = video.canPlayType(mime);
        if (r === 'probably' || r === 'maybe') { supported = true; break; }
      } catch {}
    }
    support[codec.name] = supported;
  }

  support['hardware_acceleration'] =
    (navigator as any).gpu !== undefined ||
    (navigator as any).mediaDevices !== undefined;

  return support;
};

// ==========================================
// IndexedDB Video Library Storage
// Path-based (v2): stores the file-system path, NOT the blob.
// No video data is copied — zero double-storage.
// ==========================================

const DB_NAME = 'prevplayer_db';
const DB_VERSION = 2;   // bumped from 1 (blob-based) to 2 (path-based)
const STORE_NAME = 'videos';

/** What is persisted in IndexedDB — just metadata + file path, never the video blob */
export interface StoredVideo {
  id: string;
  name: string;
  path: string;         // Native file-system path, e.g. C:\Videos\movie.mp4
  thumbnail?: string;   // base64 JPEG — tiny, fine to keep in IDB
  size: number;
  addedAt: number;
  duration?: number;
  type: string;
}

/** Metadata exposed to the UI */
export interface VideoMeta {
  id: string;
  name: string;
  path: string;
  thumbnail?: string;
  size: number;
  addedAt: number;
  duration?: number;
  type: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      // v1 stored blobs — drop that store and start fresh with path-based store
      if (oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

export const videoStore = {
  async save(video: StoredVideo): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(video);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getAllMeta(): Promise<VideoMeta[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as VideoMeta[]);
      request.onerror = () => reject(request.error);
    });
  },

  async delete(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async updateMeta(id: string, patch: { thumbnail?: string; duration?: number; size?: number }): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result as StoredVideo | undefined;
        if (record) {
          if (patch.thumbnail !== undefined) record.thumbnail = patch.thumbnail;
          if (patch.duration !== undefined) record.duration = patch.duration;
          if (patch.size !== undefined) record.size = patch.size;
          store.put(record);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ==========================================
// Playback Progress (resume-where-you-left-off)
// ==========================================

const STORAGE_PROGRESS = 'prevplayer_progress';

interface ProgressEntry {
  time: number;
  duration: number;
  updatedAt: number;
}

function readProgressMap(): Record<string, ProgressEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_PROGRESS);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeProgressMap(map: Record<string, ProgressEntry>) {
  try {
    localStorage.setItem(STORAGE_PROGRESS, JSON.stringify(map));
  } catch {}
}

export function saveVideoProgress(videoId: string, time: number, duration: number) {
  if (!videoId || !isFinite(duration) || duration <= 0 || !isFinite(time)) return;
  const map = readProgressMap();
  if (time / duration > 0.95) {
    if (map[videoId]) { delete map[videoId]; writeProgressMap(map); }
    return;
  }
  if (time < 5) return;
  map[videoId] = { time, duration, updatedAt: Date.now() };
  writeProgressMap(map);
}

export function loadVideoProgress(videoId: string): number | null {
  if (!videoId) return null;
  const entry = readProgressMap()[videoId];
  return entry ? entry.time : null;
}

// ==========================================
// Folder / Playlist Storage (localStorage)
// ==========================================

export interface Folder {
  id: string;
  name: string;
  videoIds: string[];
  createdAt: number;
}

const STORAGE_FOLDERS = 'prevplayer_folders';

function readFolders(): Folder[] {
  try {
    const raw = localStorage.getItem(STORAGE_FOLDERS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeFolders(folders: Folder[]) {
  try {
    localStorage.setItem(STORAGE_FOLDERS, JSON.stringify(folders));
  } catch {}
}

export const folderStore = {
  getAll(): Folder[] { return readFolders(); },

  save(folder: Folder): void {
    const folders = readFolders();
    const idx = folders.findIndex(f => f.id === folder.id);
    if (idx >= 0) folders[idx] = folder; else folders.push(folder);
    writeFolders(folders);
  },

  delete(id: string): void {
    writeFolders(readFolders().filter(f => f.id !== id));
  },

  rename(id: string, name: string): void {
    const folders = readFolders();
    const f = folders.find(f => f.id === id);
    if (f) { f.name = name; writeFolders(folders); }
  },

  addVideo(folderId: string, videoId: string): void {
    const folders = readFolders();
    const f = folders.find(f => f.id === folderId);
    if (f && !f.videoIds.includes(videoId)) { f.videoIds.push(videoId); writeFolders(folders); }
  },

  removeVideo(folderId: string, videoId: string): void {
    const folders = readFolders();
    const f = folders.find(f => f.id === folderId);
    if (f) { f.videoIds = f.videoIds.filter(id => id !== videoId); writeFolders(folders); }
  },

  reorderVideos(folderId: string, videoIds: string[]): void {
    const folders = readFolders();
    const f = folders.find(f => f.id === folderId);
    if (f) { f.videoIds = videoIds; writeFolders(folders); }
  },
};

// ==========================================
// Video Order Persistence (drag-reorder)
// ==========================================

const STORAGE_VIDEO_ORDER = 'prevplayer_video_order';

export const videoOrderStore = {
  getOrder(): string[] {
    try {
      const raw = localStorage.getItem(STORAGE_VIDEO_ORDER);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  },

  setOrder(ids: string[]): void {
    try { localStorage.setItem(STORAGE_VIDEO_ORDER, JSON.stringify(ids)); } catch {}
  },
};
