import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize, Minimize, Settings, Captions, MoreVertical } from 'lucide-react';
import { formatTime } from '../utils';

interface PlayerControlsProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  isMuted: boolean;
  visible: boolean;
  playbackSpeed: number;
  hasSubtitles: boolean;
  subtitlesEnabled: boolean;
  isLooping: boolean;
  onPlayPause: () => void;
  onSeek: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSeekStart: () => void;
  onSeekEnd: (e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => void;
  onVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onToggleMute: () => void;
  onToggleFullscreen: () => void;
  onSpeedChange: (speed: number) => void;
  onToggleSubtitles: () => void;
  onToggleLoop: () => void;
  onTogglePip: () => void;
  isPip: boolean;
  isFullscreen: boolean;
  isRemainingTimeMode: boolean;
  onToggleTimeDisplay: () => void;
  // Playlist navigation
  onNext?: () => void;
  onPrev?: () => void;
  hasNext?: boolean;
  hasPrev?: boolean;
  // Queue
  onToggleQueue?: () => void;
  showQueue?: boolean;
}

const PlayerControls: React.FC<PlayerControlsProps> = ({
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  visible,
  playbackSpeed,
  hasSubtitles,
  subtitlesEnabled,
  isLooping,
  onPlayPause,
  onSeek,
  onSeekStart,
  onSeekEnd,
  onVolumeChange,
  onToggleMute,
  onToggleFullscreen,
  onSpeedChange,
  onToggleSubtitles,
  onToggleLoop,
  onTogglePip,
  isPip,
  isFullscreen,
  isRemainingTimeMode,
  onToggleTimeDisplay,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  onToggleQueue,
  showQueue,
}) => {
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  const progressPercent = duration ? (currentTime / duration) * 100 : 0;

  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  const formatTime = (seconds: number): string => {
    if (!seconds || !isFinite(seconds)) return '0:00';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const getRemainingTime = (): number => {
    return Math.max(0, duration - currentTime);
  };

  // Close settings when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };

    if (showSettings) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSettings]);

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 sm:px-4 pb-2 sm:pb-4 pt-8 sm:pt-14 transition-all duration-200 ease-out z-20 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
      }`}
    >
      {/* Progress Bar Container */}
      <div className="relative group w-full h-2 sm:h-4 mb-1.5 sm:mb-2 cursor-pointer flex items-center">
        {/* Track Background */}
        <div className="absolute w-full h-1 bg-white/30 rounded-full overflow-hidden">
             {/* Buffered/Progress Bar */}
            <div 
                className="h-full bg-red-600 relative"
                style={{ width: `${progressPercent}%` }}
            >
                {/* Glow effect at the tip */}
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 sm:w-2 h-1.5 sm:h-2 bg-red-600 rounded-full shadow-[0_0_10px_rgba(220,38,38,0.8)] opacity-0 group-hover:opacity-100 transition-opacity"></div>
            </div>
        </div>
        
        {/* Invisible Range Input for Interaction */}
        <input
          type="range"
          min="0"
          max={duration || 100}
          value={currentTime}
          onChange={onSeek}
          onMouseDown={onSeekStart}
          onTouchStart={onSeekStart}
          onMouseUp={onSeekEnd}
          onTouchEnd={onSeekEnd}
          className="absolute w-full h-full opacity-0 cursor-pointer z-10"
        />
        
        {/* Thumb (Only visible on hover or drag) */}
        <div 
            className="pointer-events-none absolute h-2 sm:h-3 w-2 sm:w-3 bg-red-600 rounded-full shadow-md top-1/2 -translate-y-1/2 -ml-1 sm:-ml-1.5 transition-all duration-100 scale-0 group-hover:scale-100"
            style={{ left: `${progressPercent}%` }}
        />
      </div>

      {/* Buttons Row - Responsive Layout */}
      <div className="flex items-center justify-between flex-wrap gap-1.5 sm:gap-4">
        {/* Left Controls */}
        <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
          {/* Previous Track */}
          {hasPrev && (
            <button
              onClick={onPrev}
              className="text-white/70 hover:text-white transition-colors p-1 active:scale-90"
              title="Previous"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="sm:w-6 sm:h-6">
                <rect x="3" y="5" width="3" height="14" rx="1" />
                <polygon points="21,5 9,12 21,19" />
              </svg>
            </button>
          )}

          <button
            onClick={onPlayPause}
            className="text-white hover:text-gray-200 transition-colors p-1 sm:p-1.5 active:scale-95"
            title={isPlaying ? "Pause (k)" : "Play (k)"}
          >
            {isPlaying ? <Pause size={24} className="sm:w-7 sm:h-7" fill="currentColor" /> : <Play size={24} className="sm:w-7 sm:h-7" fill="currentColor" />}
          </button>

          {/* Next Track */}
          {hasNext && (
            <button
              onClick={onNext}
              className="text-white/70 hover:text-white transition-colors p-1 active:scale-90"
              title="Next"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="sm:w-6 sm:h-6">
                <polygon points="3,5 15,12 3,19" />
                <rect x="18" y="5" width="3" height="14" rx="1" />
              </svg>
            </button>
          )}

          {/* Volume Controls - Animated SVG */}
          <div className="flex items-center gap-1 sm:gap-2 group/vol relative">
            <button onClick={onToggleMute} className="text-white hover:text-gray-200 transition-colors p-1 active:scale-95">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" className="sm:w-6 sm:h-6 transition-transform duration-150">
                {/* Speaker body */}
                <path d="M11 5L6 9H2v6h4l5 4V5z" fill="white" />
                {isMuted || volume === 0 ? (
                  /* X mark for muted */
                  <>
                    <line x1="16" y1="9" x2="22" y2="15" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
                    <line x1="22" y1="9" x2="16" y2="15" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" />
                  </>
                ) : (
                  /* Animated wave arcs based on volume level */
                  <>
                    <path
                      d="M15.5 8.5a3.5 3.5 0 010 7"
                      stroke="white"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="transition-all duration-300"
                      style={{
                        opacity: volume > 0 ? 1 : 0,
                        transform: volume > 0 ? 'scaleY(1)' : 'scaleY(0)',
                        transformOrigin: 'center',
                      }}
                    />
                    <path
                      d="M17.5 6.5a6.5 6.5 0 010 11"
                      stroke="white"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="transition-all duration-300"
                      style={{
                        opacity: volume > 0.33 ? 1 : 0,
                        transform: volume > 0.33 ? 'scaleY(1)' : 'scaleY(0)',
                        transformOrigin: 'center',
                      }}
                    />
                    <path
                      d="M19.5 4.5a9.5 9.5 0 010 15"
                      stroke="white"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      className="transition-all duration-300"
                      style={{
                        opacity: volume > 0.66 ? 1 : 0,
                        transform: volume > 0.66 ? 'scaleY(1)' : 'scaleY(0)',
                        transformOrigin: 'center',
                      }}
                    />
                  </>
                )}
              </svg>
            </button>
            <div className="hidden sm:flex w-0 overflow-hidden group-hover/vol:w-24 transition-all duration-300 ease-out items-center">
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={isMuted ? 0 : volume}
                onChange={onVolumeChange}
                className="w-20 h-1 bg-white/30 rounded-lg appearance-none cursor-pointer accent-white mx-2"
              />
            </div>
          </div>

          {/* Loop Button - Next to Volume */}
          <button
            onClick={onToggleLoop}
            className={`p-1 transition-all duration-300 active:scale-95 relative ${
              isLooping 
                ? 'text-red-500' 
                : 'text-white/50 hover:text-white'
            }`}
            title={isLooping ? 'Loop: On' : 'Loop: Off'}
          >
            <svg 
              width="20" 
              height="20" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2" 
              strokeLinecap="round" 
              strokeLinejoin="round"
              className={`sm:w-6 sm:h-6 transition-transform duration-500 ${isLooping ? 'rotate-0' : 'rotate-180'}`}
            >
              <path d="M17 2l4 4-4 4" />
              <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
              <path d="M7 22l-4-4 4-4" />
              <path d="M21 13v1a4 4 0 0 1-4 4H3" />
            </svg>
            {/* Active indicator dot */}
            {isLooping && (
              <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse" />
            )}
          </button>

          {/* Time Display - Next to Volume */}
          <button 
            onClick={onToggleTimeDisplay}
            className="text-white hover:text-gray-200 transition-colors p-1 sm:p-1.5 active:scale-95 text-xs sm:text-sm font-medium whitespace-nowrap"
            title="Click to toggle remaining time"
          >
            {isRemainingTimeMode ? (
              <span className="flex items-center gap-1">
                <span className="text-red-400">-</span>
                {formatTime(getRemainingTime())}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                {formatTime(currentTime)} <span className="text-neutral-400">/</span> {formatTime(duration)}
              </span>
            )}
          </button>
        </div>

        {/* Right Controls - Collapsible on Mobile */}
        <div className="flex items-center gap-1.5 sm:gap-4 relative">
          
          {/* Caption Toggle - Always visible if subtitles exist */}
          {hasSubtitles && (
            <button 
                onClick={onToggleSubtitles}
                className={`transition-colors p-1 active:scale-95 ${subtitlesEnabled ? 'text-white border-b-2 border-red-600' : 'text-white/70 hover:text-white'}`}
                title="Subtitles/CC (c)"
            >
                <Captions size={18} className="sm:w-6 sm:h-6" />
            </button>
          )}

          {/* Settings Menu */}
          <div className="relative" ref={settingsRef}>
            <button
                onClick={() => setShowSettings(!showSettings)}
                className={`transition-colors p-1 active:scale-95 ${showSettings ? 'text-white rotate-45' : 'text-white/70 hover:text-white'}`}
                title="Settings"
            >
                <Settings size={18} className="sm:w-6 sm:h-6 transition-transform duration-300" />
            </button>
            
            {showSettings && (
                <div className="absolute bottom-12 right-0 bg-black/90 backdrop-blur-md rounded-xl p-1.5 sm:p-2 w-40 sm:w-48 shadow-xl border border-white/10 overflow-hidden animate-fade-in text-xs sm:text-sm z-50">
                    <div className="p-1.5 sm:p-2 border-b border-white/10 mb-1.5 sm:mb-2 font-bold text-gray-400 text-xs">Settings</div>
                    <div className="mb-1.5 sm:mb-2">
                        <div className="px-2 py-0.5 text-xs text-gray-400 font-semibold uppercase tracking-wider">Speed</div>
                        <div className="max-h-32 overflow-y-auto custom-scrollbar">
                            {speeds.map(s => (
                                <button
                                    key={s}
                                    onClick={() => {
                                        onSpeedChange(s);
                                        setShowSettings(false);
                                    }}
                                    className={`w-full text-left px-2 sm:px-3 py-1.5 sm:py-2 hover:bg-white/10 rounded flex justify-between text-xs sm:text-sm active:scale-95 ${playbackSpeed === s ? 'text-red-500 font-bold' : 'text-white'}`}
                                >
                                    <span>{s === 1 ? 'Normal' : s + 'x'}</span>
                                    {playbackSpeed === s && <span>✓</span>}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}
          </div>

          {/* Queue Toggle */}
          {onToggleQueue && (
            <button
              onClick={onToggleQueue}
              className={`transition-colors p-1 active:scale-95 ${showQueue ? 'text-red-500' : 'text-white/70 hover:text-white'}`}
              title="Queue (q)"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-6 sm:h-6">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" strokeWidth="3" strokeLinecap="round" />
                <line x1="3" y1="12" x2="3.01" y2="12" strokeWidth="3" strokeLinecap="round" />
                <line x1="3" y1="18" x2="3.01" y2="18" strokeWidth="3" strokeLinecap="round" />
              </svg>
            </button>
          )}

          {/* Picture-in-Picture Button */}
          <button
            onClick={onTogglePip}
            className={`transition-colors p-1 active:scale-95 ${isPip ? 'text-red-500' : 'text-white/70 hover:text-white'}`}
            title="Picture-in-Picture (p)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="sm:w-6 sm:h-6">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
              <rect x="12" y="9" width="8" height="6" rx="1" ry="1" fill={isPip ? 'currentColor' : 'none'} strokeWidth="1.5" />
            </svg>
          </button>

          <button
            onClick={onToggleFullscreen}
            className="text-white/70 hover:text-white transition-colors p-1 active:scale-95"
            title="Fullscreen (f)"
          >
            {isFullscreen ? <Minimize size={18} className="sm:w-6 sm:h-6" /> : <Maximize size={18} className="sm:w-6 sm:h-6" />}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PlayerControls;