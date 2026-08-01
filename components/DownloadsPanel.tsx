import React, { useState } from 'react';
import { Download, Pause, Play, X, Check, ChevronDown, ChevronUp, Loader2, Info } from 'lucide-react';

export interface DlItem {
  id: string;
  libId: string;
  name: string;
  link: string;
  index: number;
  dest: string;
  bytes: number;
  total: number;
  speed: number;
  eta: number | null;
  /** Set while this is a save tap on a stream you're watching, not a download. */
  streamId?: string;
  status: 'downloading' | 'saving' | 'paused' | 'done' | 'error';
  /** True only when a published checksum matched — size alone doesn't count. */
  verified?: boolean;
  group?: string;
}

interface Props {
  downloads: DlItem[];
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  /** Open this download in the player (finished file, or its stream while it runs). */
  onPlay?: (d: DlItem) => void;
  /** Show its Properties — including where on disk it landed. */
  onShowInfo?: (d: DlItem) => void;
  /** What the player currently has open — that row hides its play button. */
  currentPath?: string | null;
  currentName?: string | null;
}

const fmtSize = (b: number) => {
  if (!b || b < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const fmtEta = (s: number) => {
  if (!isFinite(s) || s < 0) return '';
  const m = Math.floor(s / 60); const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s left` : `${sec}s left`;
};

const DownloadsPanel: React.FC<Props> = ({
  downloads, onPause, onResume, onCancel, onDismiss, onPlay, onShowInfo, currentPath, currentName,
}) => {
  const [open, setOpen] = useState(true);
  if (downloads.length === 0) return null;

  const active = downloads.filter(d => d.status !== 'done' && d.status !== 'error').length;

  return (
    <div className="fixed bottom-4 right-4 z-[290] w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-neutral-700/70 shadow-2xl shadow-black/50 overflow-hidden" style={{ background: 'rgb(20,20,23)' }}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-white/5 transition-colors">
        <div className="flex items-center gap-2">
          <Download size={16} className="text-red-400" />
          <span className="text-sm font-semibold text-white">Downloads</span>
          {active > 0 && <span className="text-[11px] text-neutral-400">{active} active</span>}
        </div>
        {open ? <ChevronDown size={16} className="text-neutral-500" /> : <ChevronUp size={16} className="text-neutral-500" />}
      </button>

      {open && (
        <div className="max-h-72 overflow-auto custom-scrollbar border-t border-neutral-800">
          {downloads.map(d => {
            const pct = d.total ? Math.min(100, Math.round((d.bytes / d.total) * 100)) : 0;
            // The engine measures the ETA against its own throughput; fall back to
            // the arithmetic only before the first progress tick lands.
            const eta = d.status === 'downloading' && d.eta != null ? fmtEta(d.eta)
              : (d.status === 'downloading' || d.status === 'saving') && d.speed > 0 && d.total
                ? fmtEta((d.total - d.bytes) / d.speed)
                : '';
            // Hidden while this very video is what the player has open — there's
            // nothing to go back to. Shown the moment you leave it (home, library,
            // another video), so a download you walked away from is one click away.
            const isOpenInPlayer =
              (!!currentPath && currentPath === d.dest) || (!!currentName && currentName === d.name);
            const canPlay = !!onPlay && !isOpenInPlayer && d.status !== 'error';
            return (
              <div key={d.id} className="px-3.5 py-2.5 border-b border-neutral-800/60 last:border-0">
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-white truncate">{d.name}</div>
                  </div>
                  {onShowInfo && (
                    <button
                      onClick={() => onShowInfo(d)}
                      title="Properties"
                      className="p-1 text-neutral-500 hover:text-white shrink-0"
                    >
                      <Info size={14} />
                    </button>
                  )}
                  {canPlay && (
                    <button
                      onClick={() => onPlay!(d)}
                      title={d.status === 'done' ? 'Play' : 'Play while it downloads'}
                      className="flex items-center gap-1 shrink-0 rounded-md bg-white/10 hover:bg-white/20 text-white text-[10px] font-medium px-1.5 py-1 transition-colors active:scale-95"
                    >
                      <Play size={12} fill="currentColor" strokeWidth={0} />
                      Play
                    </button>
                  )}
                  {d.status === 'done' ? (
                    <>
                      <Check
                        size={15}
                        className={`shrink-0 ${d.verified ? 'text-green-400' : 'text-neutral-400'}`}
                        // Only a matched checksum earns the confident tick; a LAN
                        // sender that published no digest gets the quiet one.
                        aria-label={d.verified ? 'Verified against the sender’s checksum' : 'Complete'}
                      />
                      <button onClick={() => onDismiss(d.id)} title="Dismiss" className="p-1 text-neutral-500 hover:text-white shrink-0"><X size={14} /></button>
                    </>
                  ) : d.status === 'error' ? (
                    <>
                      <span className="text-[10px] text-red-400">failed</span>
                      <button onClick={() => onDismiss(d.id)} className="p-1 text-neutral-500 hover:text-white shrink-0"><X size={14} /></button>
                    </>
                  ) : (
                    <>
                      {d.status === 'paused'
                        ? <button onClick={() => onResume(d.id)} title="Resume" className="p-1 text-neutral-300 hover:text-white shrink-0"><Play size={14} /></button>
                        : <button
                            onClick={() => onPause(d.id)}
                            // Pausing a save stops it following playback; what it
                            // already wrote is kept and Resume finishes the rest.
                            title={d.status === 'saving' ? 'Stop keeping it (finish later)' : 'Pause'}
                            className="p-1 text-neutral-300 hover:text-white shrink-0"
                          >
                            <Pause size={14} />
                          </button>}
                      <button
                        onClick={() => onCancel(d.id)}
                        title={d.status === 'saving' ? 'Stop keeping this' : 'Cancel'}
                        className="p-1 text-neutral-500 hover:text-red-400 shrink-0"
                      >
                        <X size={14} />
                      </button>
                    </>
                  )}
                </div>
                {d.status !== 'done' && d.status !== 'error' && (
                  <>
                    <div className="mt-1.5 h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-red-500 to-purple-500 transition-all" style={{ width: `${d.total ? pct : 5}%` }} />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[10px] text-neutral-500">
                      <span>{fmtSize(d.bytes)}{d.total ? ` / ${fmtSize(d.total)}` : ''}</span>
                      <span className="flex items-center gap-1">
                        {d.status === 'paused' ? 'Paused'
                          : d.speed > 0 ? `${fmtSize(d.speed)}/s${eta ? ' · ' + eta : ''}`
                          : d.status === 'saving' ? 'Keeping as you watch'
                          : <><Loader2 size={10} className="animate-spin" /> starting…</>}
                      </span>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DownloadsPanel;
