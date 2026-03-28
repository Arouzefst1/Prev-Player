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
 * Extract thumbnail from video at specific time
 */
export const extractVideoThumbnail = (videoUrl: string, atTime: number = 1): Promise<string> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');

    video.addEventListener('loadedmetadata', () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      video.currentTime = Math.min(atTime, video.duration * 0.1); // At 1 second or 10% in
    });

    video.addEventListener('seeked', () => {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      } else {
        reject('Failed to get canvas context');
      }
    });

    video.addEventListener('error', () => {
      reject('Failed to load video for thumbnail');
    });

    video.crossOrigin = 'anonymous';
    video.src = videoUrl;
  });
};

/**
 * Get video duration from Blob
 */
export const getVideoDuration = (videoUrl: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');

    video.addEventListener('loadedmetadata', () => {
      resolve(video.duration);
    });

    video.addEventListener('error', () => {
      reject('Failed to load video');
    });

    video.crossOrigin = 'anonymous';
    video.src = videoUrl;
  });
};

export const getCodecSupport = (): Record<string, boolean> => {
const video = document.createElement('video');
const support: Record<string, boolean> = {};

// Comprehensive list of all possible codecs and their MIME type strings
const codecTests = [
  // H.264 / AVC1
  {
    name: 'h264', mimes: [
      'video/mp4; codecs="avc1.42E01E"',
      'video/mp4; codecs="avc1.4D401E"',
      'video/mp4; codecs="avc1.640028"',
    ]
  },

  // H.265 / HEVC
  {
    name: 'hevc', mimes: [
      'video/mp4; codecs="hev1.1.6.L93.B0"',
      'video/mp4; codecs="hvc1.1.6.L93.B0"',
      'video/mp4; codecs="hev1.2.4.L153.B0"',
    ]
  },

  // VP8
  {
    name: 'vp8', mimes: [
      'video/webm; codecs="vp8"',
    ]
  },

  // VP9
  {
    name: 'vp9', mimes: [
      'video/webm; codecs="vp9"',
      'video/mp4; codecs="vp09.00.10.08"',
      'video/webm; codecs="vp09.00.10.08"',
    ]
  },

  // AV1
  {
    name: 'av1', mimes: [
      'video/mp4; codecs="av01.0.05M.08"',
      'video/webm; codecs="av01.0.05M.08"',
      'video/mp4; codecs="av01.0.08M.08"',
    ]
  },

  // Theora
  {
    name: 'theora', mimes: [
      'video/ogg; codecs="theora"',
    ]
  },

  // MPEG-4 Part 2
  {
    name: 'mpeg4', mimes: [
      'video/mp4; codecs="mp4v.20.9"',
    ]
  },

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