import React, { useState, useCallback, useEffect } from 'react';
import { Upload, FileVideo, AlertCircle, List, X, Trash2, Save, FolderOpen, History } from 'lucide-react';
import VideoPlayer from './components/VideoPlayer';
import { srtToVtt } from './utils';

interface PlaylistItem {
  id: string;
  src: string;
  name: string;
  subtitleSrc?: string;
  file?: File; // Keep reference if available (for name mainly)
}

interface HistoryItem {
  id: string;
  src: string;
  name: string;
  subtitleSrc?: string;
  addedAt: number;
}

function App() {
  const [playlist, setPlaylist] = useState<PlaylistItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [recentVideos, setRecentVideos] = useState<HistoryItem[]>([]);

  // Add video to history (max 5)
  const addToHistory = useCallback((video: PlaylistItem) => {
    setRecentVideos(prev => {
      // Don't add if it's already the most recent
      if (prev.length > 0 && prev[0].src === video.src) return prev;
      
      const historyItem: HistoryItem = {
        id: video.id,
        src: video.src,
        name: video.name,
        subtitleSrc: video.subtitleSrc,
        addedAt: Date.now()
      };
      
      // Remove if already exists, then add to front, keep max 5
      const filtered = prev.filter(v => v.src !== video.src);
      return [historyItem, ...filtered].slice(0, 5);
    });
  }, []);

  // Play a video immediately (used by Change Video button)
  const playVideoImmediately = useCallback((files: FileList | File[]) => {
    const videoFiles = Array.from(files).filter(f => f.type.startsWith('video/'));
    
    if (videoFiles.length === 0) {
      setError("Please select a video file.");
      return;
    }

    // Save current video to history before switching
    if (playlist.length > 0 && playlist[currentIndex]) {
      addToHistory(playlist[currentIndex]);
    }

    const file = videoFiles[0];
    const newVideo: PlaylistItem = {
      id: Math.random().toString(36).substr(2, 9),
      src: URL.createObjectURL(file),
      name: file.name,
      file: file
    };

    // Replace current video in playlist or add as first
    if (playlist.length === 0) {
      setPlaylist([newVideo]);
      setCurrentIndex(0);
    } else {
      // Replace current video
      const newPlaylist = [...playlist];
      newPlaylist[currentIndex] = newVideo;
      setPlaylist(newPlaylist);
    }
    
    setError(null);
  }, [playlist, currentIndex, addToHistory]);

  // Play video from history
  const playFromHistory = useCallback((historyItem: HistoryItem) => {
    // Save current video to history before switching
    if (playlist.length > 0 && playlist[currentIndex]) {
      addToHistory(playlist[currentIndex]);
    }

    const newVideo: PlaylistItem = {
      id: historyItem.id,
      src: historyItem.src,
      name: historyItem.name,
      subtitleSrc: historyItem.subtitleSrc
    };

    if (playlist.length === 0) {
      setPlaylist([newVideo]);
      setCurrentIndex(0);
    } else {
      const newPlaylist = [...playlist];
      newPlaylist[currentIndex] = newVideo;
      setPlaylist(newPlaylist);
    }

    // Remove from history since it's now playing
    setRecentVideos(prev => prev.filter(v => v.id !== historyItem.id));
  }, [playlist, currentIndex, addToHistory]);

  const addToPlaylist = (files: FileList | File[]) => {
    const newItems: PlaylistItem[] = [];
    let subtitleFile: File | null = null;
    let videoFiles: File[] = [];

    // Separate subtitles and videos
    Array.from(files).forEach(file => {
      if (file.name.endsWith('.vtt') || file.name.endsWith('.srt')) {
        subtitleFile = file;
      } else if (file.type.startsWith('video/')) {
        videoFiles.push(file);
      }
    });

    if (videoFiles.length === 0 && !subtitleFile) {
        setError("Please drop a video file.");
        return;
    }

    // Process Subtitle
    let subUrl: string | undefined = undefined;
    if (subtitleFile) {
        // If dropping JUST a subtitle, try to apply to current video
        if (videoFiles.length === 0 && playlist.length > 0) {
            const updatedPlaylist = [...playlist];
            const reader = new FileReader();
            reader.onload = (e) => {
                 const text = e.target?.result as string;
                 const vttText = (subtitleFile as File).name.endsWith('.srt') ? srtToVtt(text) : text;
                 const blob = new Blob([vttText], { type: 'text/vtt' });
                 const subBlobUrl = URL.createObjectURL(blob);
                 
                 updatedPlaylist[currentIndex].subtitleSrc = subBlobUrl;
                 setPlaylist(updatedPlaylist);
            };
            reader.readAsText(subtitleFile);
            return; // Done
        } else {
             // Will attach to the first video being added
             // Note: Async nature makes this tricky in a loop, simpler to just allow single sub drop or attach to all dropped? 
             // Let's attach to the first video for now.
             const reader = new FileReader();
             reader.onload = (e) => {
                  const text = e.target?.result as string;
                  const vttText = (subtitleFile as File).name.endsWith('.srt') ? srtToVtt(text) : text;
                  const blob = new Blob([vttText], { type: 'text/vtt' });
                  subUrl = URL.createObjectURL(blob);
                  
                  // Update the item after it was added (react state update)
                  // Simplified: user drops video + sub together
             };
             reader.readAsText(subtitleFile);
        }
    }

    // Process Videos
    videoFiles.forEach((file) => {
        newItems.push({
            id: Math.random().toString(36).substr(2, 9),
            src: URL.createObjectURL(file),
            name: file.name,
            file: file
        });
    });

    if (newItems.length > 0) {
        // If we had a sub waiting (race condition handled poorly above, so let's do a simple fix: 
        // If user drops multiple files, we assume 1 video 1 sub or multiple videos. 
        // Realistically, sub loading is better done individually.
        // We will just add videos. Subtitles handled by dropping ON the player.
        setPlaylist(prev => [...prev, ...newItems]);
        setError(null);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addToPlaylist(e.dataTransfer.files);
    }
  }, [playlist, currentIndex]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      addToPlaylist(e.target.files);
    }
  };

  const playNext = () => {
      if (currentIndex < playlist.length - 1) {
          setCurrentIndex(prev => prev + 1);
      }
  };

  const removeVideo = (e: React.MouseEvent, index: number) => {
      e.stopPropagation();
      const newPlaylist = playlist.filter((_, i) => i !== index);
      setPlaylist(newPlaylist);
      if (index < currentIndex) {
          setCurrentIndex(prev => prev - 1);
      } else if (index === currentIndex && newPlaylist.length > 0) {
          setCurrentIndex(0); // Reset to start if current deleted
      } else if (newPlaylist.length === 0) {
          setCurrentIndex(0);
      }
  };

  const savePlaylist = () => {
      // Save metadata only (filenames), as we can't save blobs
      const data = JSON.stringify(playlist.map(p => ({ name: p.name })));
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'playlist.json';
      a.click();
      URL.revokeObjectURL(url);
  };

  return (
    <div className="w-screen h-screen bg-neutral-900 text-white overflow-hidden flex flex-col font-sans">
      {playlist.length > 0 ? (
        <div className="relative w-full h-full flex">
            
          {/* Main Player Area */}
          <div className={`relative flex-1 h-full bg-black transition-all duration-300 ${showPlaylist ? 'mr-0' : 'mr-0'}`}>
              <VideoPlayer 
                key={playlist[currentIndex].id} // Force remount on change
                src={playlist[currentIndex].src}
                subtitlesSrc={playlist[currentIndex].subtitleSrc}
                autoPlay={true}
                onEnded={playNext}
                onChangeVideo={playVideoImmediately}
              />
              
              {/* Toggle Playlist Button (Visible when sidebar is closed or if it doesn't overlap) */}
              <button 
                onClick={() => setShowPlaylist(!showPlaylist)}
                className={`absolute top-4 right-4 z-40 bg-black/50 hover:bg-black/70 text-white p-2 rounded-full backdrop-blur-md transition-colors ${showPlaylist ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
                title="Toggle Playlist"
              >
                <List size={20} />
              </button>
          </div>

          {/* Playlist Sidebar */}
          <div 
             className={`fixed right-0 top-0 bottom-0 w-80 bg-neutral-900 border-l border-neutral-800 shadow-2xl transform transition-transform duration-300 z-50 flex flex-col ${showPlaylist ? 'translate-x-0' : 'translate-x-full'}`}
          >
             <div className="p-4 border-b border-neutral-800 flex items-center justify-between bg-neutral-900/95 backdrop-blur">
                 <h2 className="font-bold text-lg">Playlist</h2>
                 <div className="flex gap-2 items-center">
                     <button onClick={savePlaylist} className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white" title="Save Playlist JSON"><Save size={18} /></button>
                     <label className="p-1 hover:bg-neutral-800 rounded cursor-pointer text-neutral-400 hover:text-white" title="Add Videos">
                        <FolderOpen size={18} />
                        <input type="file" multiple accept="video/*" className="hidden" onChange={handleFileSelect} />
                     </label>
                     <div className="w-px h-4 bg-neutral-700 mx-1"></div>
                     <button onClick={() => setShowPlaylist(false)} className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white" title="Close"><X size={20} /></button>
                 </div>
             </div>
             
             <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-2">
                 {playlist.map((video, index) => (
                     <div 
                        key={video.id}
                        onClick={() => setCurrentIndex(index)}
                        className={`group p-3 rounded-lg flex items-center justify-between cursor-pointer transition-all ${index === currentIndex ? 'bg-red-600/20 border border-red-600/50' : 'bg-neutral-800 hover:bg-neutral-700'}`}
                     >
                         <div className="flex items-center gap-3 overflow-hidden">
                             <div className="text-xs text-neutral-500 font-mono w-4">{index + 1}</div>
                             <div className="truncate text-sm font-medium text-gray-200">{video.name}</div>
                         </div>
                         <button 
                            onClick={(e) => removeVideo(e, index)}
                            className="text-neutral-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity p-1"
                         >
                            <Trash2 size={16} />
                         </button>
                     </div>
                 ))}
             </div>

             {/* Recently Played Section */}
             {recentVideos.length > 0 && (
               <div className="border-t border-neutral-700">
                 <div className="p-3 flex items-center gap-2 text-neutral-400 text-sm font-medium bg-neutral-800/50">
                   <History size={14} />
                   <span>Recently Played</span>
                 </div>
                 <div className="p-2 space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
                   {recentVideos.map((video, index) => (
                     <button
                       key={video.id}
                       onClick={() => playFromHistory(video)}
                       className="w-full text-left p-2 rounded-lg bg-neutral-800/50 hover:bg-neutral-700 transition-all group flex items-center gap-3"
                     >
                       <span className="text-xs text-neutral-500 font-mono w-4">{index + 1}</span>
                       <span className="text-sm text-neutral-300 truncate flex-1 group-hover:text-white">
                         {video.name}
                       </span>
                     </button>
                   ))}
                 </div>
               </div>
             )}

             <div className="p-4 bg-neutral-800 text-xs text-neutral-400 border-t border-neutral-700">
                 Drag & drop .srt/.vtt files directly onto the player to add subtitles.
             </div>
          </div>
        </div>
      ) : (
        /* Empty State */
        <div 
          className={`flex-1 flex flex-col items-center justify-center p-8 transition-colors duration-300 ${isDragging ? 'bg-neutral-800' : 'bg-neutral-900'}`}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        >
          <div className={`max-w-xl w-full border-2 border-dashed rounded-3xl p-12 flex flex-col items-center justify-center text-center transition-all duration-300 ${isDragging ? 'border-red-500 scale-105' : 'border-neutral-700'}`}>
            <div className="bg-neutral-800 p-6 rounded-full mb-6 shadow-2xl animate-bounce-slow">
              <FileVideo size={64} className="text-red-500" />
            </div>
            
            <h1 className="text-4xl font-bold mb-4 bg-gradient-to-r from-red-500 to-purple-600 bg-clip-text text-transparent">
              Zenith Player
            </h1>
            <p className="text-neutral-400 mb-8 text-lg">
              Drag and drop video files here, or browse to start your playlist.
            </p>

            <label className="group relative inline-flex items-center justify-center px-8 py-3 font-semibold text-white transition-all duration-200 bg-red-600 rounded-full hover:bg-red-700 hover:shadow-lg hover:shadow-red-500/30 cursor-pointer overflow-hidden">
              <span className="mr-2"><Upload size={20} /></span>
              <span>Select Videos</span>
              <input 
                type="file" 
                multiple
                accept="video/*" 
                onChange={handleFileSelect} 
                className="hidden" 
              />
            </label>

            {error && (
              <div className="mt-6 flex items-center text-red-400 bg-red-400/10 px-4 py-2 rounded-lg animate-pulse">
                <AlertCircle size={20} className="mr-2" />
                <span>{error}</span>
              </div>
            )}
            
            <div className="mt-12 grid grid-cols-2 gap-4 text-sm text-neutral-500 text-left">
               <div className="flex items-center gap-2"><span className="kbd bg-neutral-800 px-2 py-1 rounded border border-neutral-700 min-w-[24px] text-center">K</span> Play/Pause</div>
               <div className="flex items-center gap-2"><span className="kbd bg-neutral-800 px-2 py-1 rounded border border-neutral-700 min-w-[24px] text-center">J</span> -10s Seek</div>
               <div className="flex items-center gap-2"><span className="kbd bg-neutral-800 px-2 py-1 rounded border border-neutral-700 min-w-[24px] text-center">L</span> +10s Seek</div>
               <div className="flex items-center gap-2"><span className="kbd bg-neutral-800 px-2 py-1 rounded border border-neutral-700 min-w-[24px] text-center">F</span> Fullscreen</div>
               <div className="flex items-center gap-2"><span className="kbd bg-neutral-800 px-2 py-1 rounded border border-neutral-700 min-w-[24px] text-center">M</span> Mute</div>
               <div className="flex items-center gap-2"><span className="kbd bg-neutral-800 px-2 py-1 rounded border border-neutral-700 min-w-[24px] text-center">0-9</span> Skip to %</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;