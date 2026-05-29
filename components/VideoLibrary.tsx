import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Trash2, Search, Grid, List, X, ChevronLeft } from 'lucide-react';
import { VideoMeta, Folder, folderStore, videoOrderStore } from '../utils';

// ============================================================
// Props
// ============================================================

interface VideoLibraryProps {
  videos: VideoMeta[];
  onPlayVideo: (video: VideoMeta) => void;
  onDeleteVideo: (id: string) => void;
  onClose: () => void;
  onAddVideos?: (files: FileList | File[]) => void;
  onReorderVideos?: (orderedIds: string[]) => void;
  onPlayFolder?: (videoIds: string[], shuffle: boolean, loop: boolean) => void;
  onAddToFolder?: (files: FileList | File[], folderId: string) => void;
  onAddFolderFromPC?: (files: FileList | File[]) => void;
}

// ============================================================
// Helper functions
// ============================================================

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

const genId = () => Math.random().toString(36).substr(2, 9);

// ============================================================
// SVG Icons with click animations
// ============================================================

const ShuffleIcon: React.FC<{ active?: boolean; className?: string; onClick?: () => void }> = ({ active, className, onClick }) => {
  const [animating, setAnimating] = useState(false);
  const handleClick = () => {
    setAnimating(true);
    setTimeout(() => setAnimating(false), 400);
    onClick?.();
  };
  return (
    <button onClick={handleClick} className={`p-2 rounded-lg transition-all duration-200 active:scale-90 ${active ? 'text-red-500 bg-red-500/15' : 'text-neutral-400 hover:text-white hover:bg-white/5'} ${className || ''}`} title="Shuffle">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className={`transition-transform ${animating ? 'animate-[shake_0.4s_ease-in-out]' : ''}`}
      >
        <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
        <polyline points="21 16 21 21 16 21" /><line x1="15" y1="15" x2="21" y2="21" />
        <line x1="4" y1="4" x2="9" y2="9" />
      </svg>
    </button>
  );
};

const LoopIcon: React.FC<{ active?: boolean; className?: string; onClick?: () => void }> = ({ active, className, onClick }) => {
  const [animating, setAnimating] = useState(false);
  const handleClick = () => {
    setAnimating(true);
    setTimeout(() => setAnimating(false), 600);
    onClick?.();
  };
  return (
    <button onClick={handleClick} className={`p-2 rounded-lg transition-all duration-200 active:scale-90 ${active ? 'text-red-500 bg-red-500/15' : 'text-neutral-400 hover:text-white hover:bg-white/5'} ${className || ''}`} title="Loop">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        className={`transition-transform ${animating ? 'animate-[spin_0.6s_ease-in-out]' : ''}`}
      >
        <polyline points="17 1 21 5 17 9" />
        <path d="M3 11V9a4 4 0 014-4h14" />
        <polyline points="7 23 3 19 7 15" />
        <path d="M21 13v2a4 4 0 01-4 4H3" />
      </svg>
    </button>
  );
};

const PlayAllIcon: React.FC<{ className?: string; onClick?: () => void }> = ({ className, onClick }) => {
  const [animating, setAnimating] = useState(false);
  const handleClick = () => {
    setAnimating(true);
    setTimeout(() => setAnimating(false), 400);
    onClick?.();
  };
  return (
    <button onClick={handleClick} className={`flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-all duration-200 active:scale-95 ${className || ''}`} title="Play All">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"
        className={`transition-transform ${animating ? 'animate-[pulse_0.4s_ease-in-out]' : ''}`}
      >
        <polygon points="5,3 19,12 5,21" />
      </svg>
      Play All
    </button>
  );
};

// Drag handle icon (3 horizontal lines)
const DragHandle: React.FC<{ className?: string }> = ({ className }) => (
  <div className={`cursor-grab active:cursor-grabbing flex flex-col gap-[3px] p-1 ${className || ''}`} title="Drag to reorder">
    <span className="block w-4 h-[2px] bg-neutral-500 rounded" />
    <span className="block w-4 h-[2px] bg-neutral-500 rounded" />
    <span className="block w-4 h-[2px] bg-neutral-500 rounded" />
  </div>
);

// ============================================================
// Drag-to-Reorder Hook (with auto-scroll support — Fix #4)
// ============================================================

function useDragReorder<T extends { id: string }>(
  items: T[],
  onReorder: (items: T[]) => void,
  scrollContainerRef?: React.RefObject<HTMLElement | null>
) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLElement | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    dragNodeRef.current = e.currentTarget as HTMLElement;
    e.dataTransfer.effectAllowed = 'move';
    // Make the dragged element semi-transparent after a frame
    requestAnimationFrame(() => {
      if (dragNodeRef.current) {
        dragNodeRef.current.style.opacity = '0.4';
      }
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverIndex(index);

    // Auto-scroll when near edges (Fix #4)
    const container = scrollContainerRef?.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      const edgeZone = 60;
      if (e.clientY - rect.top < edgeZone) {
        container.scrollBy({ top: -12, behavior: 'auto' });
      } else if (rect.bottom - e.clientY < edgeZone) {
        container.scrollBy({ top: 12, behavior: 'auto' });
      }
    }
  }, [scrollContainerRef]);

  const handleDragEnd = useCallback(() => {
    if (dragNodeRef.current) {
      dragNodeRef.current.style.opacity = '1';
    }
    if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
      const newItems = [...items];
      const [moved] = newItems.splice(dragIndex, 1);
      newItems.splice(overIndex, 0, moved);
      onReorder(newItems);
    }
    setDragIndex(null);
    setOverIndex(null);
    dragNodeRef.current = null;
  }, [dragIndex, overIndex, items, onReorder]);

  const getItemStyle = useCallback((index: number): React.CSSProperties => {
    if (dragIndex === null || overIndex === null) return {};
    if (index === dragIndex) return { opacity: 0.4, transform: 'scale(1.02)' };
    // Shift items to make room
    if (dragIndex < overIndex) {
      if (index > dragIndex && index <= overIndex) {
        return { transform: 'translateY(-100%)', transition: 'transform 0.2s ease' };
      }
    } else {
      if (index < dragIndex && index >= overIndex) {
        return { transform: 'translateY(100%)', transition: 'transform 0.2s ease' };
      }
    }
    return { transition: 'transform 0.2s ease' };
  }, [dragIndex, overIndex]);

  return { dragIndex, overIndex, handleDragStart, handleDragOver, handleDragEnd, getItemStyle };
}

// ============================================================
// Main Component
// ============================================================

const VideoLibrary: React.FC<VideoLibraryProps> = ({
  videos,
  onPlayVideo,
  onDeleteVideo,
  onClose,
  onAddVideos,
  onReorderVideos,
  onPlayFolder,
  onAddToFolder,
  onAddFolderFromPC,
}) => {
  // Tabs
  const [activeTab, setActiveTab] = useState<'videos' | 'folders'>('videos');
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');
  const addFileInputRef = useRef<HTMLInputElement>(null);
  const addFolderInputRef = useRef<HTMLInputElement>(null);
  const folderAddFileInputRef = useRef<HTMLInputElement>(null);

  // Videos tab — ordered list
  const [orderedVideos, setOrderedVideos] = useState<VideoMeta[]>([]);

  // Edit mode (multi-select delete) — Videos tab only
  const [editMode, setEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Folders tab
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openFolder, setOpenFolder] = useState<Folder | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderShuffle, setFolderShuffle] = useState(false);
  const [folderLoop, setFolderLoop] = useState(false);
  const [addingToFolder, setAddingToFolder] = useState(false);

  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const videoScrollRef = useRef<HTMLDivElement>(null);
  const folderVideoScrollRef = useRef<HTMLDivElement>(null);

  // Folder rename state (Fix #2)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');

  // Load persisted order & folders on mount
  useEffect(() => {
    const savedOrder = videoOrderStore.getOrder();
    if (savedOrder.length > 0) {
      // Reorder videos according to saved order; new videos go at the end
      const orderMap = new Map(savedOrder.map((id, i) => [id, i]));
      const sorted = [...videos].sort((a, b) => {
        const ai = orderMap.get(a.id) ?? Infinity;
        const bi = orderMap.get(b.id) ?? Infinity;
        return ai - bi;
      });
      setOrderedVideos(sorted);
    } else {
      setOrderedVideos(videos);
    }
  }, [videos]);

  // Reload folders whenever videos list changes (covers PC imports)
  useEffect(() => {
    const latest = folderStore.getAll();
    setFolders(latest);
    // Keep openFolder in sync
    if (openFolder) {
      const updated = latest.find(f => f.id === openFolder.id);
      if (updated) setOpenFolder(updated);
    }
  }, [videos]);

  // Focus new folder input
  useEffect(() => {
    if (creatingFolder && newFolderInputRef.current) {
      newFolderInputRef.current.focus();
    }
  }, [creatingFolder]);

  // Filtered videos (search)
  const filteredVideos = searchQuery
    ? orderedVideos.filter(v => v.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : orderedVideos;

  // Reorder handler for videos tab
  const handleVideoReorder = useCallback((newOrder: VideoMeta[]) => {
    setOrderedVideos(newOrder);
    const ids = newOrder.map(v => v.id);
    videoOrderStore.setOrder(ids);
    onReorderVideos?.(ids);
  }, [onReorderVideos]);

  // Drag reorder for videos tab (with scroll container ref — Fix #4)
  const videoDrag = useDragReorder(filteredVideos, (reordered) => {
    // If searching, merge back into full list
    if (searchQuery) {
      const reorderedIds = new Set(reordered.map(v => v.id));
      const rest = orderedVideos.filter(v => !reorderedIds.has(v.id));
      handleVideoReorder([...reordered, ...rest]);
    } else {
      handleVideoReorder(reordered);
    }
  }, videoScrollRef);

  // Folder detail — reorder videos inside folder
  const handleFolderVideoReorder = useCallback((reordered: VideoMeta[]) => {
    if (!openFolder) return;
    const newIds = reordered.map(v => v.id);
    folderStore.reorderVideos(openFolder.id, newIds);
    setOpenFolder({ ...openFolder, videoIds: newIds });
    setFolders(folderStore.getAll());
  }, [openFolder]);

  const folderVideos: VideoMeta[] = openFolder
    ? openFolder.videoIds.map(id => videos.find(v => v.id === id)).filter(Boolean) as VideoMeta[]
    : [];

  const folderDrag = useDragReorder(folderVideos, handleFolderVideoReorder, folderVideoScrollRef);

  // Folder CRUD
  const createFolder = () => {
    const name = newFolderName.trim();
    if (!name) return;
    const folder: Folder = { id: genId(), name, videoIds: [], createdAt: Date.now() };
    folderStore.save(folder);
    setFolders(folderStore.getAll());
    setCreatingFolder(false);
    setNewFolderName('');
  };

  const deleteFolder = (id: string) => {
    folderStore.delete(id);
    setFolders(folderStore.getAll());
    if (openFolder?.id === id) setOpenFolder(null);
  };

  const removeVideoFromFolder = (videoId: string) => {
    if (!openFolder) return;
    folderStore.removeVideo(openFolder.id, videoId);
    const updated = folderStore.getAll().find(f => f.id === openFolder.id);
    if (updated) setOpenFolder(updated);
    setFolders(folderStore.getAll());
  };

  const addVideosToFolder = (videoIds: string[]) => {
    if (!openFolder) return;
    videoIds.forEach(vid => folderStore.addVideo(openFolder.id, vid));
    const updated = folderStore.getAll().find(f => f.id === openFolder.id);
    if (updated) setOpenFolder(updated);
    setFolders(folderStore.getAll());
    setAddingToFolder(false);
  };

  // Play folder
  const handlePlayFolder = () => {
    if (!openFolder || openFolder.videoIds.length === 0) return;
    onPlayFolder?.(openFolder.videoIds, folderShuffle, folderLoop);
  };

  // Folder rename (Fix #2)
  const startRenameFolder = (id: string, currentName: string) => {
    setRenamingFolderId(id);
    setRenameFolderValue(currentName);
  };

  const commitRenameFolder = () => {
    if (renamingFolderId && renameFolderValue.trim()) {
      folderStore.rename(renamingFolderId, renameFolderValue.trim());
      setFolders(folderStore.getAll());
      // Also update openFolder if it's the one being renamed
      if (openFolder?.id === renamingFolderId) {
        setOpenFolder({ ...openFolder, name: renameFolderValue.trim() });
      }
    }
    setRenamingFolderId(null);
    setRenameFolderValue('');
  };

  const cancelRenameFolder = () => {
    setRenamingFolderId(null);
    setRenameFolderValue('');
  };

  // F2 keyboard shortcut for folder rename (Fix #2)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F2' && openFolder && !renamingFolderId) {
        e.preventDefault();
        startRenameFolder(openFolder.id, openFolder.name);
      }
      if (e.key === 'Escape' && renamingFolderId) {
        cancelRenameFolder();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openFolder, renamingFolderId]);

  // Edit mode helpers (Videos tab only)
  const toggleEditMode = () => {
    if (editMode) {
      setSelectedIds(new Set());
    }
    setEditMode(!editMode);
  };

  const toggleSelectVideo = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === filteredVideos.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredVideos.map(v => v.id)));
    }
  };

  const deleteSelected = () => {
    selectedIds.forEach(id => onDeleteVideo(id));
    setSelectedIds(new Set());
    setEditMode(false);
  };

  // ============================================================
  // Render helpers
  // ============================================================

  const renderVideoItem = (
    video: VideoMeta,
    index: number,
    drag: ReturnType<typeof useDragReorder>,
    options?: { numbered?: boolean; onRemove?: (id: string) => void; showDelete?: boolean }
  ) => (
    <div
      key={video.id}
      draggable
      onDragStart={(e) => drag.handleDragStart(e, index)}
      onDragOver={(e) => drag.handleDragOver(e, index)}
      onDragEnd={drag.handleDragEnd}
      onClick={() => onPlayVideo(video)}
      className={`flex items-center gap-3 sm:gap-4 p-3 sm:p-4 hover:bg-neutral-800/80 transition-all duration-200 group cursor-pointer border-b border-neutral-800/50 ${
        drag.dragIndex === index ? 'bg-neutral-700/50 shadow-lg shadow-black/30 scale-[1.02] z-10 relative rounded-lg' : ''
      } ${drag.overIndex === index && drag.dragIndex !== index ? 'border-t-2 border-t-red-500' : ''}`}
    >
      {/* Drag Handle */}
      <DragHandle className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />

      {/* Number */}
      {options?.numbered && (
        <span className="text-neutral-500 text-sm font-mono w-6 text-right flex-shrink-0">{index + 1}</span>
      )}

      {/* Thumbnail */}
      <div className="relative w-16 h-12 sm:w-20 sm:h-14 flex-shrink-0 rounded overflow-hidden bg-neutral-700">
        {video.thumbnail ? (
          <img src={video.thumbnail} alt={video.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-neutral-800">
            <Play size={16} className="text-neutral-600" fill="currentColor" />
          </div>
        )}
        {video.duration && (
          <div className="absolute bottom-0.5 right-0.5 bg-black/80 px-1 py-0.5 rounded text-[10px] text-white font-semibold">
            {formatTime(video.duration)}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <h3 className="text-sm font-semibold text-white truncate group-hover:text-red-400 transition-colors">
          {video.name}
        </h3>
        <p className="text-xs text-neutral-500 mt-0.5">{formatFileSize(video.size)}</p>
      </div>

      {/* Play */}
      <button
        onClick={(e) => { e.stopPropagation(); onPlayVideo(video); }}
        className="p-2 rounded-full opacity-0 group-hover:opacity-100 bg-red-600/0 group-hover:bg-red-600 transition-all duration-200"
      >
        <Play size={16} className="text-white fill-white" />
      </button>

      {/* Remove / Delete */}
      {options?.onRemove ? (
        <button
          onClick={(e) => { e.stopPropagation(); options.onRemove!(video.id); }}
          className="p-2 rounded-full opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 hover:bg-red-600/20 transition-all duration-200"
        >
          <X size={16} />
        </button>
      ) : options?.showDelete !== false && (
        <button
          onClick={(e) => { e.stopPropagation(); onDeleteVideo(video.id); }}
          className="p-2 rounded-full opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 hover:bg-red-600/20 transition-all duration-200"
        >
          <Trash2 size={16} />
        </button>
      )}
    </div>
  );

  // Grid card (no drag in grid)
  const renderVideoCard = (video: VideoMeta) => (
    <div
      key={video.id}
      className="group relative rounded-lg overflow-hidden bg-neutral-800 hover:bg-neutral-700 transition-all duration-300 cursor-pointer hover:scale-105 hover:shadow-lg hover:shadow-red-600/20"
    >
      <div className="relative w-full pt-[56.25%] bg-gradient-to-br from-neutral-700 to-neutral-900 overflow-hidden">
        {video.thumbnail ? (
          <img src={video.thumbnail} alt={video.name} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-800">
            <Play size={32} className="text-neutral-600" fill="currentColor" />
          </div>
        )}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all duration-300 flex items-center justify-center">
          <button
            onClick={() => onPlayVideo(video)}
            className="bg-red-600 p-3 rounded-full transform scale-0 group-hover:scale-100 transition-transform duration-300 hover:bg-red-700"
          >
            <Play size={20} className="text-white fill-white" />
          </button>
        </div>
        {video.duration && (
          <div className="absolute bottom-1 right-1 bg-black/80 px-2 py-0.5 rounded text-xs text-white font-semibold">
            {formatTime(video.duration)}
          </div>
        )}
      </div>
      <div className="p-2 sm:p-3">
        <h3 className="text-xs sm:text-sm font-semibold text-white truncate group-hover:text-red-400 transition-colors">
          {video.name}
        </h3>
        <p className="text-xs text-neutral-500 mt-1">{formatFileSize(video.size)}</p>
        <button
          onClick={(e) => { e.stopPropagation(); onDeleteVideo(video.id); }}
          className="absolute top-1 right-1 bg-red-600/0 hover:bg-red-600 p-1 rounded opacity-0 group-hover:opacity-100 transition-all duration-300"
        >
          <Trash2 size={14} className="text-white" />
        </button>
      </div>
    </div>
  );

  // ============================================================
  // Folder Detail View
  // ============================================================

  if (openFolder) {
    const videosNotInFolder = videos.filter(v => !openFolder.videoIds.includes(v.id));

    return (
      <div className="fixed inset-0 bg-black/95 z-50 flex flex-col animate-[fadeIn_0.2s_ease]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 sm:p-6 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <button onClick={() => setOpenFolder(null)} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
              <ChevronLeft size={20} className="text-neutral-400" />
            </button>
            <div>
              {/* Folder name — double-click to rename (Fix #2) */}
              {renamingFolderId === openFolder.id ? (
                <input
                  autoFocus
                  type="text"
                  value={renameFolderValue}
                  onChange={(e) => setRenameFolderValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRenameFolder();
                    if (e.key === 'Escape') cancelRenameFolder();
                  }}
                  onBlur={commitRenameFolder}
                  className="text-xl sm:text-2xl font-bold text-white bg-neutral-800 px-2 py-0.5 rounded-lg outline-none focus:ring-2 focus:ring-red-500 min-w-[120px]"
                />
              ) : (
                <h1
                  className="text-xl sm:text-2xl font-bold text-white cursor-pointer hover:text-red-400 transition-colors"
                  onDoubleClick={() => startRenameFolder(openFolder.id, openFolder.name)}
                  title="Double-click to rename (or press F2)"
                >{openFolder.name}</h1>
              )}
              <p className="text-neutral-400 text-sm mt-0.5">{folderVideos.length} videos</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
            <X size={24} className="text-neutral-400 hover:text-white" />
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 p-4 sm:px-6 border-b border-neutral-800 flex-wrap">
          <PlayAllIcon onClick={handlePlayFolder} />
          <ShuffleIcon active={folderShuffle} onClick={() => setFolderShuffle(!folderShuffle)} />
          <LoopIcon active={folderLoop} onClick={() => setFolderLoop(!folderLoop)} />

          <div className="flex-1" />

          {/* Add videos from library */}
          <button
            onClick={() => setAddingToFolder(!addingToFolder)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-300 hover:text-white transition-all active:scale-95"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            From Library
          </button>

          {/* Import from PC */}
          {onAddToFolder && (
            <>
              <input
                ref={folderAddFileInputRef}
                type="file"
                multiple
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && openFolder) {
                    onAddToFolder(e.target.files, openFolder.id);
                  }
                  e.target.value = '';
                }}
              />
              <button
                onClick={() => folderAddFileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-300 hover:text-white transition-all active:scale-95"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                From PC
              </button>
            </>
          )}

          {/* Delete folder */}
          <button
            onClick={() => deleteFolder(openFolder.id)}
            className="p-2 rounded-lg text-neutral-500 hover:text-red-400 hover:bg-red-600/20 transition-all"
            title="Delete folder"
          >
            <Trash2 size={18} />
          </button>
        </div>

        {/* Add-to-folder selection overlay */}
        {addingToFolder && (
          <div className="border-b border-neutral-800 bg-neutral-900/80 p-4 sm:px-6 max-h-60 overflow-auto custom-scrollbar">
            <p className="text-xs text-neutral-400 mb-3 uppercase tracking-wider">Select videos to add:</p>
            {videosNotInFolder.length === 0 ? (
              <p className="text-neutral-500 text-sm">All videos are already in this folder.</p>
            ) : (
              <div className="space-y-1">
                {videosNotInFolder.map(v => (
                  <button
                    key={v.id}
                    onClick={() => addVideosToFolder([v.id])}
                    className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-neutral-800 transition-colors text-left group"
                  >
                    <div className="w-10 h-7 rounded overflow-hidden bg-neutral-700 flex-shrink-0">
                      {v.thumbnail ? (
                        <img src={v.thumbnail} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center"><Play size={10} className="text-neutral-600" /></div>
                      )}
                    </div>
                    <span className="text-sm text-neutral-300 truncate flex-1 group-hover:text-white">{v.name}</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-neutral-600 group-hover:text-red-400 flex-shrink-0">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Folder video list (ordered, draggable) */}
        <div className="flex-1 overflow-auto custom-scrollbar" ref={folderVideoScrollRef}>
          {folderVideos.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-neutral-500 text-lg mb-2">No videos in this folder</p>
                <button
                  onClick={() => setAddingToFolder(true)}
                  className="text-red-400 hover:text-red-300 text-sm transition-colors"
                >
                  + Add some videos
                </button>
              </div>
            </div>
          ) : (
            <div>
              {folderVideos.map((video, i) =>
                renderVideoItem(video, i, folderDrag, { numbered: true, onRemove: removeVideoFromFolder })
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ============================================================
  // Main Library View (Tabs)
  // ============================================================

  return (
    <div className="fixed inset-0 bg-black/95 z-50 flex flex-col animate-[fadeIn_0.2s_ease]">
      {/* Header */}
      <div className="flex items-center justify-between p-4 sm:p-6 border-b border-neutral-800">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">Video Library</h1>
            <p className="text-neutral-400 text-sm mt-1">{videos.length} videos · {folders.length} folders</p>
          </div>
          {/* Add Videos Buttons */}
          {onAddVideos && (
            <>
              {/* Hidden file input */}
              <input
                ref={addFileInputRef}
                type="file"
                multiple
                accept="video/*,.mkv,.avi,.mov,.wmv,.flv,.ogv,.m4v,.3gp,.ts,.mts,.m2ts,.vob,.mpg,.mpeg"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) onAddVideos(e.target.files);
                  e.target.value = '';
                }}
              />
              {/* Hidden folder input */}
              <input
                ref={addFolderInputRef}
                type="file"
                // @ts-ignore webkitdirectory is non-standard
                webkitdirectory=""
                directory=""
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && onAddFolderFromPC) {
                    onAddFolderFromPC(e.target.files);
                  }
                  e.target.value = '';
                }}
              />
              {/* Add Files button */}
              <button
                onClick={() => addFileInputRef.current?.click()}
                className="group relative p-2 rounded-lg bg-red-600 hover:bg-red-700 transition-all duration-300 hover:scale-105 active:scale-95 hover:shadow-lg hover:shadow-red-600/30"
                title="Add Video Files"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  className="text-white sm:w-6 sm:h-6 transition-transform duration-300 group-hover:rotate-90"
                >
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              {/* Add Folder button */}
              <button
                onClick={() => addFolderInputRef.current?.click()}
                className="group relative p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 transition-all duration-300 hover:scale-105 active:scale-95"
                title="Add Folder (scans for videos)"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="text-neutral-300 sm:w-6 sm:h-6 group-hover:text-white transition-colors"
                >
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                  <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
                </svg>
              </button>
            </>
          )}
        </div>
        <button onClick={onClose} className="p-2 hover:bg-neutral-800 rounded-lg transition-colors">
          <X size={24} className="text-neutral-400 hover:text-white" />
        </button>
      </div>

      {/* Tabs */}
      <div className="relative flex border-b border-neutral-800">
        {(['videos', 'folders'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => { setActiveTab(tab); setEditMode(false); setSelectedIds(new Set()); }}
            className={`relative flex-1 sm:flex-none px-6 py-3 text-sm font-semibold transition-colors duration-200 ${
              activeTab === tab ? 'text-white' : 'text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {tab === 'videos' ? `Videos (${videos.length})` : `Folders (${folders.length})`}
            {/* Animated underline */}
            {activeTab === tab && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-red-500 animate-[scaleX_0.25s_ease]" style={{ transformOrigin: 'center' }} />
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'videos' ? (
        <>
          {/* Controls */}
          <div className="flex items-center gap-2 sm:gap-4 p-4 sm:px-6 border-b border-neutral-800 flex-wrap">
            <div className="flex-1 min-w-48 relative">
              <Search size={18} className="absolute left-3 top-3 text-neutral-500" />
              <input
                type="text"
                placeholder="Search videos..."
                className="w-full bg-neutral-800 pl-10 pr-4 py-2 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-red-500 text-sm"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
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
            {/* Edit mode toggle (pencil SVG) */}
            <button
              onClick={toggleEditMode}
              className={`p-2 rounded-lg transition-all duration-200 active:scale-90 ${editMode ? 'bg-red-600 text-white' : 'bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700'}`}
              title={editMode ? 'Exit Edit Mode' : 'Edit Mode'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          </div>

          {/* Edit mode action bar */}
          {editMode && (
            <div className="flex items-center gap-3 px-4 sm:px-6 py-2.5 border-b border-neutral-800 bg-neutral-900/80 animate-[fadeIn_0.2s_ease]">
              {/* Select All checkbox */}
              <button
                onClick={selectAll}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-all active:scale-90"
                title={selectedIds.size === filteredVideos.length ? 'Deselect All' : 'Select All'}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {selectedIds.size === filteredVideos.length && filteredVideos.length > 0 ? (
                    <>
                      <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" className="text-red-500" stroke="none" />
                      <path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2.5" />
                    </>
                  ) : (
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                  )}
                </svg>
              </button>
              <span className="text-sm text-neutral-400">
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select videos to delete'}
              </span>
              <div className="flex-1" />
              {/* Delete selected */}
              {selectedIds.size > 0 && (
                <button
                  onClick={deleteSelected}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600 hover:text-white transition-all duration-200 active:scale-95"
                  title={`Delete ${selectedIds.size} video${selectedIds.size > 1 ? 's' : ''}`}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                  <span className="text-sm font-semibold">{selectedIds.size}</span>
                </button>
              )}
              {/* Cancel edit */}
              <button
                onClick={toggleEditMode}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-all active:scale-90"
                title="Cancel"
              >
                <X size={18} />
              </button>
            </div>
          )}

          {/* Videos content */}
          <div className="flex-1 overflow-auto custom-scrollbar" ref={videoScrollRef}>
            {filteredVideos.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-neutral-500 text-lg">No videos found</p>
              </div>
            ) : viewMode === 'grid' ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4 p-4 sm:p-6">
                {filteredVideos.map(video => (
                  <div key={video.id} className="relative">
                    {editMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleSelectVideo(video.id); }}
                        className="absolute top-2 left-2 z-10 p-0.5 rounded"
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {selectedIds.has(video.id) ? (
                            <>
                              <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" className="text-red-500" stroke="none" />
                              <path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2.5" />
                            </>
                          ) : (
                            <rect x="3" y="3" width="18" height="18" rx="2" className="text-white/70" />
                          )}
                        </svg>
                      </button>
                    )}
                    {renderVideoCard(video)}
                  </div>
                ))}
              </div>
            ) : (
              <div>
                {filteredVideos.map((video, i) => (
                  <div key={video.id} className="flex items-center">
                    {editMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleSelectVideo(video.id); }}
                        className="pl-4 pr-1 py-3 flex-shrink-0"
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {selectedIds.has(video.id) ? (
                            <>
                              <rect x="3" y="3" width="18" height="18" rx="2" fill="currentColor" className="text-red-500" stroke="none" />
                              <path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2.5" />
                            </>
                          ) : (
                            <rect x="3" y="3" width="18" height="18" rx="2" className="text-neutral-500" />
                          )}
                        </svg>
                      </button>
                    )}
                    <div className="flex-1 min-w-0">
                      {renderVideoItem(video, i, videoDrag, { showDelete: !editMode })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        /* Folders Tab */
        <div className="flex-1 overflow-auto custom-scrollbar p-4 sm:p-6">
          {/* Create folder */}
          <div className="mb-6">
            {creatingFolder ? (
              <div className="flex gap-2 animate-[fadeIn_0.2s_ease]">
                <input
                  ref={newFolderInputRef}
                  type="text"
                  placeholder="Folder name..."
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') { setCreatingFolder(false); setNewFolderName(''); } }}
                  className="flex-1 bg-neutral-800 px-4 py-2 rounded-lg text-white placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-red-500 text-sm"
                />
                <button onClick={createFolder} className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-semibold text-white transition-colors active:scale-95">
                  Create
                </button>
                <button onClick={() => { setCreatingFolder(false); setNewFolderName(''); }} className="px-3 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-sm text-neutral-400 transition-colors">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreatingFolder(true)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-neutral-700 hover:border-red-500/50 rounded-lg text-neutral-400 hover:text-red-400 transition-all duration-300 group"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="transition-transform duration-300 group-hover:rotate-90"
                >
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span className="text-sm font-semibold">Create New Folder</span>
              </button>
            )}
          </div>

          {/* Folder cards */}
          {folders.length === 0 && !creatingFolder ? (
            <div className="flex items-center justify-center py-20">
              <div className="text-center">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-neutral-700 mx-auto mb-3">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                </svg>
                <p className="text-neutral-500 text-lg">No folders yet</p>
                <p className="text-neutral-600 text-sm mt-1">Create a folder to organize your playlists</p>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {folders.map(folder => {
                const fvids = folder.videoIds.map(id => videos.find(v => v.id === id)).filter(Boolean) as VideoMeta[];
                const thumbs = fvids.slice(0, 4);

                return (
                  <button
                    key={folder.id}
                    onClick={() => setOpenFolder(folder)}
                    className="group relative bg-neutral-800/60 hover:bg-neutral-800 rounded-xl p-4 transition-all duration-300 hover:shadow-lg hover:shadow-red-600/10 text-left active:scale-[0.98]"
                  >
                    {/* Thumbnail mosaic */}
                    <div className="grid grid-cols-2 gap-1 rounded-lg overflow-hidden mb-3 aspect-video bg-neutral-900">
                      {thumbs.length > 0 ? thumbs.map((v, i) => (
                        <div key={i} className={`bg-neutral-700 overflow-hidden ${thumbs.length === 1 ? 'col-span-2 row-span-2' : thumbs.length === 2 ? 'row-span-2' : ''}`}>
                          {v.thumbnail ? (
                            <img src={v.thumbnail} alt="" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Play size={16} className="text-neutral-600" />
                            </div>
                          )}
                        </div>
                      )) : (
                        <div className="col-span-2 row-span-2 flex items-center justify-center bg-neutral-800">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-neutral-700">
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                          </svg>
                        </div>
                      )}
                    </div>

                    {/* Folder name — double-click to rename (Fix #2) */}
                    {renamingFolderId === folder.id ? (
                      <input
                        autoFocus
                        type="text"
                        value={renameFolderValue}
                        onChange={(e) => setRenameFolderValue(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === 'Enter') commitRenameFolder();
                          if (e.key === 'Escape') cancelRenameFolder();
                        }}
                        onBlur={commitRenameFolder}
                        onClick={(e) => e.stopPropagation()}
                        className="font-semibold text-white bg-neutral-700 px-2 py-0.5 rounded-lg outline-none focus:ring-2 focus:ring-red-500 w-full truncate"
                      />
                    ) : (
                      <h3
                        className="font-semibold text-white truncate group-hover:text-red-400 transition-colors cursor-pointer"
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          startRenameFolder(folder.id, folder.name);
                        }}
                        title="Double-click to rename"
                      >{folder.name}</h3>
                    )}
                    <p className="text-xs text-neutral-500 mt-1">{fvids.length} video{fvids.length !== 1 ? 's' : ''}</p>

                    {/* Delete */}
                    <button
                      onClick={(e) => { e.stopPropagation(); deleteFolder(folder.id); }}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/50 opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-400 hover:bg-red-600/20 transition-all"
                    >
                      <Trash2 size={14} />
                    </button>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default VideoLibrary;
