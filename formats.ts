// ===========================================================================
// What the player opens. mpv (FFmpeg) probes the bytes, not the name, so this
// list only decides what the file pickers, drag-and-drop and folder imports
// offer — it is kept generous. The same extensions are registered with Windows
// in src-tauri/tauri.conf.json (fileAssociations); keep the two in step.
// ===========================================================================

export const VIDEO_EXT_LIST = [
  // Containers
  'mkv', 'mk3d', 'mp4', 'm4v', 'mov', 'webm', 'avi', 'divx', 'wmv', 'asf', 'flv', 'f4v',
  'ts', 'mts', 'm2ts', 'vob', 'evo', 'mpg', 'mpeg', 'm2v', 'mxf', 'ogv', 'ogg', 'ogm', 'rm', 'rmvb', '3gp', '3g2',
  // Raw elementary streams — HEVC, H.264, AV1, VVC
  'hevc', 'h265', '265', 'h264', '264', 'ivf', 'obu', 'vvc', '266',
];

export const AUDIO_EXT_LIST = [
  // Dolby and DTS as their own files
  'ac3', 'eac3', 'ec3', 'thd', 'mlp', 'dts', 'dtshd',
  // Lossless and hi-res, DSD included
  'flac', 'alac', 'wav', 'w64', 'aiff', 'aif', 'ape', 'wv', 'tak', 'tta', 'dsf', 'dff', 'caf',
  // Lossy
  // (.ogg is listed as video: it can carry Theora, and was treated as video before.)
  'mp3', 'mp2', 'm4a', 'm4b', 'aac', 'opus', 'oga', 'weba', 'wma', 'mpc', 'mka',
];

export const MEDIA_EXT_LIST = [...VIDEO_EXT_LIST, ...AUDIO_EXT_LIST];

const MEDIA_EXTENSIONS = new Set(MEDIA_EXT_LIST);
const AUDIO_EXTENSIONS = new Set(AUDIO_EXT_LIST);

const extOf = (p: string) => (p.includes('.') ? p.split('.').pop()!.toLowerCase() : '');

/** Video and audio both: the player shows audio over a still background. */
export const isMediaPath = (p: string): boolean => MEDIA_EXTENSIONS.has(extOf(p));
export const isAudioPath = (p: string): boolean => AUDIO_EXTENSIONS.has(extOf(p));
