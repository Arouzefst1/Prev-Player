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