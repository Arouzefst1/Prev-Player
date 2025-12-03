import React, { useEffect, useState } from 'react';
import { Play, Pause, Volume2, FastForward, Rewind, ChevronsRight, ChevronsLeft } from 'lucide-react';
import { OverlayState } from '../utils';

interface ActionOverlayProps {
  overlayState: OverlayState;
}

const ActionOverlay: React.FC<ActionOverlayProps> = ({ overlayState }) => {
  const [visible, setVisible] = useState(false);
  const { action, id, value } = overlayState;

  useEffect(() => {
    if (!action) return;
    
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
    }, 600); // Animation duration

    return () => clearTimeout(timer);
  }, [id, action]);

  if (!visible || !action) return null;

  // Render logic based on action type
  
  // 1. Volume Overlay (Top Center)
  if (action === 'volume-up' || action === 'volume-down') {
    return (
      <div className="absolute top-8 left-1/2 -translate-x-1/2 z-40 animate-fade-in-out pointer-events-none">
        <div className="bg-black/70 backdrop-blur-md px-4 py-2 rounded-full flex items-center gap-2 text-white">
           <Volume2 size={20} />
           <span className="font-bold text-sm">{value}</span>
        </div>
      </div>
    );
  }

  // 2. Skip Animations (Left / Right zones)
  if (action === 'forward-5' || action === 'forward-10') {
    return (
        <div className="absolute right-20 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center pointer-events-none z-30">
            <div className="bg-black/40 backdrop-blur-sm p-6 rounded-full animate-ping-once flex flex-col items-center justify-center text-white">
                <FastForward size={40} fill="currentColor" />
                <span className="text-xs font-bold mt-1">{action === 'forward-5' ? '+5s' : '+10s'}</span>
            </div>
        </div>
    );
  }

  if (action === 'rewind-5' || action === 'rewind-10') {
    return (
        <div className="absolute left-20 top-1/2 -translate-y-1/2 flex flex-col items-center justify-center pointer-events-none z-30">
            <div className="bg-black/40 backdrop-blur-sm p-6 rounded-full animate-ping-once flex flex-col items-center justify-center text-white">
                <Rewind size={40} fill="currentColor" />
                <span className="text-xs font-bold mt-1">{action === 'rewind-5' ? '-5s' : '-10s'}</span>
            </div>
        </div>
    );
  }

  // 4. Center Play/Pause Overlay
  let Icon = Play;
  if (action === 'pause') Icon = Pause;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-30">
      <div className="bg-black/50 backdrop-blur-sm p-6 rounded-full animate-ping-once flex flex-col items-center justify-center text-white transform transition-all duration-500 scale-110 opacity-100">
        <Icon size={48} fill="currentColor" className="text-white drop-shadow-lg" />
      </div>
    </div>
  );
};

export default ActionOverlay;