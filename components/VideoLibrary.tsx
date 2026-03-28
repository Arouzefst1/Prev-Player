import React, { useState, useEffect } from 'react';
import { Play, Trash2, Search, Grid, List, X } from 'lucide-react';

interface StoredVideo {
  id: string;
  name: string;
  src: string;
  thumbnail?: string;
  size: number;
  addedAt: number;
  duration?: number;
}

interface VideoLibraryProps {
  videos: StoredVideo[];
  onPlayVideo: (video: StoredVideo) => void;
  onDeleteVideo: (id: string) => void;
  onClose: () => void;
}

const VideoLibrary: React.FC<VideoLibraryProps> = ({ videos, onPlayVideo, onDeleteVideo, onClose }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [filteredVideos, setFilteredVideos] = useState(videos);

  useEffect(() => {
    const filtered = videos.filter(v => 
      v.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredVideos(filtered);
  }, [searchQuery, videos]);

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const formatTime = (seconds?: number) => {
    if (!seconds) return 'Unknown';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 bg-black/95 z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 sm:p-6 border-b border-neutral-800">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Video Library</h1>
          <p className="text-neutral-400 text-sm mt-1">{filteredVideos.length} videos</p>
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-neutral-800 rounded-lg transition-colors"
        >
          <X size={24} className="text-neutral-400 hover:text-white" />
        </button>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-2 sm:gap-4 p-4 sm:p-6 border-b border-neutral-800 flex-wrap">
        {/* Search */}
        <div className="flex-1 min-w-48 relative">
          <Search size={18} className="absolute left-3 top-3 text-neutral-500" />
          <input
            type="text"
            placeholder="Search videos..."
            className="w-full bg-neutral-800 pl-10 pr-4 py-2 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-red-500"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* View Toggle */}
        <div className="flex gap-1 bg-neutral-800 p-1 rounded-lg">
          <button
            onClick={() => setViewMode('grid')}
            className={`p-2 rounded transition-colors ${viewMode === 'grid' ? 'bg-red-600 text-white' : 'text-neutral-400 hover:text-white'}`}
          >
            <Grid size={18} />
          </button>
          <button
            onClick={() => setViewMode('list')}
            className={`p-2 rounded transition-colors ${viewMode === 'list' ? 'bg-red-600 text-white' : 'text-neutral-400 hover:text-white'}`}
          >
            <List size={18} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto custom-scrollbar">
        {filteredVideos.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-neutral-500 text-lg">No videos found</p>
          </div>
        ) : viewMode === 'grid' ? (
          // Grid View
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4 p-4 sm:p-6">
            {filteredVideos.map((video) => (
              <div
                key={video.id}
                className="group relative rounded-lg overflow-hidden bg-neutral-800 hover:bg-neutral-700 transition-all duration-300 cursor-pointer hover:scale-105 hover:shadow-lg hover:shadow-red-600/20"
              >
                {/* Thumbnail */}
                <div className="relative w-full pt-[56.25%] bg-gradient-to-br from-neutral-700 to-neutral-900 overflow-hidden">
                  {video.thumbnail ? (
                    <img
                      src={video.thumbnail}
                      alt={video.name}
                      className="absolute inset-0 w-full h-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center bg-neutral-800">
                      <Play size={32} className="text-neutral-600" fill="currentColor" />
                    </div>
                  )}

                  {/* Overlay */}
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center">
                    <button
                      onClick={() => onPlayVideo(video)}
                      className="bg-red-600 p-3 rounded-full transform scale-0 group-hover:scale-100 transition-transform duration-300 hover:bg-red-700"
                    >
                      <Play size={20} className="text-white fill-white" />
                    </button>
                  </div>

                  {/* Duration Badge */}
                  {video.duration && (
                    <div className="absolute bottom-1 right-1 bg-black/80 px-2 py-0.5 rounded text-xs text-white font-semibold">
                      {formatTime(video.duration)}
                    </div>
                  )}
                </div>

                {/* Title & Info */}
                <div className="p-2 sm:p-3">
                  <h3 className="text-xs sm:text-sm font-semibold text-white truncate group-hover:text-red-400 transition-colors">
                    {video.name}
                  </h3>
                  <p className="text-xs text-neutral-500 mt-1">{formatFileSize(video.size)}</p>

                  {/* Delete Button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteVideo(video.id);
                    }}
                    className="absolute top-1 right-1 bg-red-600/0 hover:bg-red-600 p-1 rounded opacity-0 group-hover:opacity-100 transition-all duration-300"
                  >
                    <Trash2 size={14} className="text-white" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          // List View
          <div className="divide-y divide-neutral-800">
            {filteredVideos.map((video) => (
              <div
                key={video.id}
                onClick={() => onPlayVideo(video)}
                className="flex items-center gap-3 sm:gap-4 p-3 sm:p-4 hover:bg-neutral-800 transition-colors group cursor-pointer"
              >
                {/* Thumbnail */}
                <div className="relative w-20 h-20 sm:w-24 sm:h-24 flex-shrink-0 rounded overflow-hidden bg-neutral-700">
                  {video.thumbnail ? (
                    <img
                      src={video.thumbnail}
                      alt={video.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center bg-neutral-800">
                      <Play size={20} className="text-neutral-600" fill="currentColor" />
                    </div>
                  )}
                  {video.duration && (
                    <div className="absolute bottom-1 right-1 bg-black/80 px-1.5 py-0.5 rounded text-xs text-white font-semibold">
                      {formatTime(video.duration)}
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm sm:text-base font-semibold text-white truncate group-hover:text-red-400 transition-colors">
                    {video.name}
                  </h3>
                  <p className="text-xs sm:text-sm text-neutral-500 mt-1">
                    {formatFileSize(video.size)}
                  </p>
                  <p className="text-xs text-neutral-600 mt-1">
                    Added {new Date(video.addedAt).toLocaleDateString()}
                  </p>
                </div>

                {/* Play Button */}
                <button
                  onClick={() => onPlayVideo(video)}
                  className="p-2 sm:p-3 rounded-full bg-red-600/0 group-hover:bg-red-600 transition-all duration-300"
                >
                  <Play size={18} className="text-neutral-400 group-hover:text-white fill-white" />
                </button>

                {/* Delete Button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteVideo(video.id);
                  }}
                  className="p-2 sm:p-3 rounded-full text-neutral-500 hover:text-red-400 hover:bg-red-600/20 transition-all duration-300"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default VideoLibrary;
