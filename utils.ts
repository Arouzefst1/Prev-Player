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
  // Simple SRT to VTT converter
  // 1. Add WEBVTT header
  // 2. Replace comma in timestamp with dot
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
  value?: string | number; // For volume percentage or speed value
  id: number; // Unique ID to trigger re-render of animation
}

/**
 * Extract thumbnail from video at specific time (with timeout for Edge/Firefox)
 */
export const extractVideoThumbnail = (videoUrl: string, atTime: number = 1): Promise<string> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load(); // force release
    };

    // Timeout: reject after 8s to avoid hanging in Edge
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
 * Get video duration from Blob (with timeout for Edge/Firefox)
 */
export const getVideoDuration = (videoUrl: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
    };

    // Timeout: reject after 8s
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
 * Get video codec support
 */
export const detectCodecSupport = (): Record<string, boolean> => {
  const video = document.createElement('video');
  const support: Record<string, boolean> = {};

  // Comprehensive list of all possible codecs and their MIME type strings
  const codecTests = [
    // H.264 / AVC1
    { name: 'h264', mimes: [
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="avc1.4D401E"',
      'video/mp4; codecs="avc1.640028"',
    ]},
    
    // H.265 / HEVC
    { name: 'hevc', mimes: [
      'video/mp4; codecs="hev1.1.6.L93.B0"',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hev1.2.4.L153.B0"',
    ]},
    
    // VP8
    { name: 'vp8', mimes: [
      'video/webm; codecs="vp8"',
    ]},
    
    // VP9
    { name: 'vp9', mimes: [
      'video/webm; codecs="vp9"',
      'video/mp4; codecs="vp09.00.10.08"',
      'video/webm; codecs="vp09.00.10.08"',
    ]},
    
    // AV1
    { name: 'av1', mimes: [
      'video/mp4; codecs="av01.0.05M.08"',
      'video/webm; codecs="av01.0.05M.08"',
      'video/mp4; codecs="av01.0.08M.08"',
    ]},
    
    // Theora
    { name: 'theora', mimes: [
      'video/ogg; codecs="theora"',
    ]},
    
    // MPEG-4 Part 2
    { name: 'mpeg4', mimes: [
      'video/mp4; codecs="mp4v.20.9"',
    ]},
    
    // Container formats
    { name: 'mp4', mimes: ['video/mp4'] },
    { name: 'webm', mimes: ['video/webm'] },
    { name: 'ogg', mimes: ['video/ogg'] },
    { name: 'quicktime', mimes: ['video/quicktime'] },
    { name: 'avi', mimes: ['video/avi', 'video/x-avi'] },
    { name: 'matroska', mimes: ['video/x-matroska', 'video/mkv'] },
    { name: 'flv', mimes: ['video/x-flv'] },
    { name: '3gp', mimes: ['video/3gpp'] },
    { name: 'ts', mimes: ['video/mp2t', 'video/typescript'] },
    { name: 'mov', mimes: ['video/quicktime'] },
    { name: 'wmv', mimes: ['video/x-ms-wmv'] },
  ];

  // Test each codec
  for (const codec of codecTests) {
    let isSupported = false;
    for (const mime of codec.mimes) {
      try {
        const canPlay = video.canPlayType(mime);
        if (canPlay === 'probably' || canPlay === 'maybe') {
          isSupported = true;
          break;
        }
      } catch (e) {
        // Ignore errors
      }
    }
    support[codec.name] = isSupported;
  }

  // Additional checks
  support['hardware_acceleration'] = 
    (navigator as any).gpu !== undefined ||
    (navigator as any).mediaDevices !== undefined;
  
  return support;
};

// ==========================================
// IndexedDB Video Storage
// ==========================================

const DB_NAME = 'prevplayer_db';
const DB_VERSION = 1;
const STORE_NAME = 'videos';

export interface StoredVideo {
  id: string;
  name: string;
  blob: Blob;          // Actual video binary data
  thumbnail?: string;  // base64 thumbnail (small, ok for storage)
  size: number;
  addedAt: number;
  duration?: number;
  type: string;        // MIME type
}

// Metadata-only version (without the blob) for listing
export interface VideoMeta {
  id: string;
  name: string;
  thumbnail?: string;
  size: number;
  addedAt: number;
  duration?: number;
  type: string;
}

// Cache a single connection. Reopening the DB on every operation is slow,
// especially in Edge/Firefox under the rapid sequential writes of a batch import.
let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Drop the cached handle if the connection is closed or superseded so the next call reopens.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  return dbPromise;
}

export const videoStore = {
  /** Save a video file to IndexedDB */
  async save(video: StoredVideo): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(video);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Get all video metadata (without blobs, for listing) */
  async getAllMeta(): Promise<VideoMeta[]> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      
      request.onsuccess = () => {
        const results: VideoMeta[] = (request.result as StoredVideo[]).map(v => ({
          id: v.id,
          name: v.name,
          thumbnail: v.thumbnail,
          size: v.size,
          addedAt: v.addedAt,
          duration: v.duration,
          type: v.type,
        }));
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  },

  /** Get a single video's blob by ID, returns a blob URL */
  async getBlobUrl(id: string): Promise<string | null> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).get(id);
      
      request.onsuccess = () => {
        const video = request.result as StoredVideo | undefined;
        if (video?.blob) {
          const url = URL.createObjectURL(video.blob);
          resolve(url);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
    });
  },

  /** Delete a video by ID */
  async delete(id: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  /** Patch thumbnail/duration on an existing record (used by background metadata extraction) */
  async updateMeta(id: string, patch: { thumbnail?: string; duration?: number }): Promise<void> {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const record = getReq.result as StoredVideo | undefined;
        if (record) {
          if (patch.thumbnail) record.thumbnail = patch.thumbnail;
          if (patch.duration !== undefined) record.duration = patch.duration;
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
// Stored in localStorage as a map: { [videoId]: { time, duration, updatedAt } }
// - Saved every 5s during playback, on pause, on tab hide, and on unmount.
// - Auto-cleared once a video is watched past 95% (so it doesn't resume at the end).
// - Below 5s into the video, we don't save (avoids polluting the map with near-zero entries).

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
  } catch {
    // Storage full or unavailable — ignore
  }
}

export function saveVideoProgress(videoId: string, time: number, duration: number) {
  if (!videoId || !isFinite(duration) || duration <= 0 || !isFinite(time)) return;
  const map = readProgressMap();
  if (time / duration > 0.95) {
    // Watched to (near) the end — clear so it starts from the beginning next time
    if (map[videoId]) {
      delete map[videoId];
      writeProgressMap(map);
    }
    return;
  }
  if (time < 5) {
    // Don't overwrite/save tiny offsets; leave any existing entry alone
    return;
  }
  map[videoId] = { time, duration, updatedAt: Date.now() };
  writeProgressMap(map);
}

export function loadVideoProgress(videoId: string): number | null {
  if (!videoId) return null;
  const map = readProgressMap();
  const entry = map[videoId];
  return entry ? entry.time : null;
}

// ==========================================
// Folder / Playlist Storage (localStorage)
// ==========================================

export interface Folder {
  id: string;
  name: string;
  videoIds: string[];   // ordered list of video IDs
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
  } catch {
    // Storage full — ignore
  }
}

export const folderStore = {
  getAll(): Folder[] {
    return readFolders();
  },

  save(folder: Folder): void {
    const folders = readFolders();
    const idx = folders.findIndex(f => f.id === folder.id);
    if (idx >= 0) {
      folders[idx] = folder;
    } else {
      folders.push(folder);
    }
    writeFolders(folders);
  },

  delete(id: string): void {
    const folders = readFolders().filter(f => f.id !== id);
    writeFolders(folders);
  },

  rename(id: string, name: string): void {
    const folders = readFolders();
    const folder = folders.find(f => f.id === id);
    if (folder) {
      folder.name = name;
      writeFolders(folders);
    }
  },

  addVideo(folderId: string, videoId: string): void {
    const folders = readFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder && !folder.videoIds.includes(videoId)) {
      folder.videoIds.push(videoId);
      writeFolders(folders);
    }
  },

  removeVideo(folderId: string, videoId: string): void {
    const folders = readFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      folder.videoIds = folder.videoIds.filter(id => id !== videoId);
      writeFolders(folders);
    }
  },

  reorderVideos(folderId: string, videoIds: string[]): void {
    const folders = readFolders();
    const folder = folders.find(f => f.id === folderId);
    if (folder) {
      folder.videoIds = videoIds;
      writeFolders(folders);
    }
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
    } catch {
      return [];
    }
  },

  setOrder(ids: string[]): void {
    try {
      localStorage.setItem(STORAGE_VIDEO_ORDER, JSON.stringify(ids));
    } catch {
      // Storage full — ignore
    }
  },
};