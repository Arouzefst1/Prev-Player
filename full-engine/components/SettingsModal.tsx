import React from 'react';
import { X, Settings as SettingsIcon, FolderOpen, RotateCcw } from 'lucide-react';
import { AppSettings } from '../settings';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
}

// A small iOS-style on/off switch.
const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void }> = ({ checked, onChange }) => (
  <button
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className={`relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 ${checked ? 'bg-red-600' : 'bg-neutral-700'}`}
  >
    <span
      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : ''}`}
    />
  </button>
);

// One labelled row (title + description on the left, control on the right).
const Row: React.FC<{ title: string; desc: string; children: React.ReactNode }> = ({ title, desc, children }) => (
  <div className="flex items-center justify-between gap-4 py-3">
    <div className="min-w-0">
      <div className="text-sm font-medium text-white">{title}</div>
      <div className="text-xs text-neutral-500 mt-0.5 leading-snug">{desc}</div>
    </div>
    <div className="flex-shrink-0">{children}</div>
  </div>
);

const SettingsModal: React.FC<SettingsModalProps> = ({ open, onClose, settings, onChange }) => {
  if (!open) return null;

  // Pick a folder for downloaded/received videos.
  const chooseDownloadFolder = async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const dir = await openDialog({ directory: true, multiple: false, title: 'Choose download folder' });
      if (dir && typeof dir === 'string') onChange({ downloadPath: dir });
    } catch {}
  };

  const downloadLabel = settings.downloadPath || 'Downloads / PREV Player (default)';

  return (
    <div
      className="fixed inset-0 z-[320] bg-black/70 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-neutral-700/60 shadow-2xl shadow-black/60 overflow-hidden flex flex-col max-h-[88vh]"
        style={{ background: 'rgb(20,20,23)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-purple-600 flex items-center justify-center">
              <SettingsIcon size={16} className="text-white" />
            </div>
            <h3 className="font-bold text-white">Settings</h3>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors">
            <X size={18} className="text-neutral-400" />
          </button>
        </div>

        {/* body */}
        <div className="p-5 overflow-auto custom-scrollbar divide-y divide-neutral-800/70">
          {/* Library */}
          <div className="pb-1">
            <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-[0.15em] mb-1">Library</p>
            <Row title="Play videos when added" desc="Start playing right away when you add videos to the library.">
              <Toggle checked={settings.playOnAdd} onChange={(v) => onChange({ playOnAdd: v })} />
            </Row>
            <Row title="Default library view" desc="Show the library as a list or a grid.">
              <div className="flex gap-1 bg-neutral-800 p-1 rounded-lg">
                {(['list', 'grid'] as const).map(v => (
                  <button
                    key={v}
                    onClick={() => onChange({ defaultView: v })}
                    className={`px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${settings.defaultView === v ? 'bg-red-600 text-white' : 'text-neutral-400 hover:text-white'}`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </Row>
            <Row title="Remember last video" desc="Show a “Resume Watching” card on the home screen.">
              <Toggle checked={settings.rememberLastVideo} onChange={(v) => onChange({ rememberLastVideo: v })} />
            </Row>
          </div>

          {/* Playback */}
          <div className="py-1">
            <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-[0.15em] mb-1 mt-3">Playback</p>
            <Row title="Autoplay next" desc="Automatically play the next video in a playlist or queue.">
              <Toggle checked={settings.autoplayNext} onChange={(v) => onChange({ autoplayNext: v })} />
            </Row>
            <Row title="Resume where you left off" desc="Continue videos from your last position.">
              <Toggle checked={settings.resumePlayback} onChange={(v) => onChange({ resumePlayback: v })} />
            </Row>
            <Row title={`Default volume — ${Math.round(settings.defaultVolume * 100)}%`} desc="Volume a video starts at.">
              <input
                type="range" min={0} max={1} step={0.05} value={settings.defaultVolume}
                onChange={(e) => onChange({ defaultVolume: parseFloat(e.target.value) })}
                className="w-28 accent-red-600 cursor-pointer"
              />
            </Row>
            <Row title={`Default speed — ${settings.defaultSpeed === 1 ? 'Normal' : settings.defaultSpeed + '×'}`} desc="Playback speed a video starts at.">
              <select
                value={settings.defaultSpeed}
                onChange={(e) => onChange({ defaultSpeed: parseFloat(e.target.value) })}
                className="bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(s => (
                  <option key={s} value={s}>{s === 1 ? 'Normal' : s + '×'}</option>
                ))}
              </select>
            </Row>
          </div>

          {/* Downloads & updates */}
          <div className="py-1">
            <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-[0.15em] mb-1 mt-3">Downloads &amp; updates</p>
            <div className="py-3">
              <div className="text-sm font-medium text-white">Download folder</div>
              <div className="text-xs text-neutral-500 mt-0.5 leading-snug">Where received &amp; downloaded videos are saved.</div>
              <div className="flex items-center gap-2 mt-2">
                <div className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-300 truncate" title={downloadLabel}>
                  {downloadLabel}
                </div>
                <button
                  onClick={chooseDownloadFolder}
                  className="p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
                  title="Choose folder"
                >
                  <FolderOpen size={16} />
                </button>
                {settings.downloadPath && (
                  <button
                    onClick={() => onChange({ downloadPath: null })}
                    className="p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors"
                    title="Reset to default"
                  >
                    <RotateCcw size={16} />
                  </button>
                )}
              </div>
            </div>
            <Row title="Check for updates on launch" desc="Look for a newer version automatically at startup.">
              <Toggle checked={settings.autoCheckUpdates} onChange={(v) => onChange({ autoCheckUpdates: v })} />
            </Row>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
