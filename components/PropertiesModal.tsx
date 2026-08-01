import React, { useEffect, useState } from 'react';
import { X, Info, FolderOpen, Copy, Check } from 'lucide-react';
import { formatTime } from '../utils';
import { getMpvState, subscribeMpv, type MpvState } from '../mpv';

export interface PropertiesTarget {
  name: string;
  /** Native path for a local file, or the source URL while streaming. */
  path: string;
  /** Size in bytes when the app already knows it (library entry, share listing). */
  size?: number;
  /** True when `path` is a stream rather than something on disk. */
  streaming?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  target: PropertiesTarget | null;
}

const fmtSize = (b?: number) => {
  if (!b || b < 0) return null;
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 2 : 0)} ${u[i]}`;
};

/** One label + value. Blank values show a dash rather than collapsing the row. */
const Field: React.FC<{ label: string; value?: string | null }> = ({ label, value }) => (
  <div className="min-w-0">
    <div className="text-[11px] text-neutral-500">{label}</div>
    <div className="text-sm text-neutral-100 break-words">{value || '—'}</div>
  </div>
);

const PropertiesModal: React.FC<Props> = ({ open, onClose, target }) => {
  // mpv is the only thing that knows the codec, resolution and frame rate, and
  // it only knows them once the file is actually open — so this follows the live
  // state rather than snapshotting it when the dialog opens.
  const [mpv, setMpv] = useState<MpvState>(() => getMpvState());
  useEffect(() => { if (open) return subscribeMpv(setMpv); }, [open]);

  const [copied, setCopied] = useState(false);
  const [revealError, setRevealError] = useState('');

  if (!open || !target) return null;

  const audio = mpv.tracks?.find(t => t.type === 'audio' && t.id === mpv.audioId)
    ?? mpv.tracks?.find(t => t.type === 'audio');
  const channels = (audio as any)?.channels ?? (audio as any)?.demuxChannelCount;
  const ext = target.name.includes('.') ? target.name.split('.').pop()!.toLowerCase() : '';

  const copyPath = async () => {
    try { await navigator.clipboard.writeText(target.path); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {}
  };

  /** Open the containing folder with the file selected — not just the folder. */
  const revealFile = async () => {
    setRevealError('');
    if (target.streaming) { setRevealError('This is playing from a stream — there is no file on disk yet.'); return; }
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(target.path);
    } catch (e: any) {
      setRevealError(e?.message || 'Could not open that location.');
    }
  };

  return (
    <div className="fixed inset-0 z-[330] bg-black/70 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-neutral-700/60 shadow-2xl shadow-black/60 overflow-hidden flex flex-col max-h-[88vh]"
        style={{ background: 'rgb(20,20,23)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
          <div className="flex items-center gap-2.5">
            <Info size={18} className="text-neutral-400" />
            <h3 className="font-bold text-white">Properties</h3>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors">
            <X size={18} className="text-neutral-400" />
          </button>
        </div>

        <div className="p-5 overflow-auto custom-scrollbar">
          <div className="mb-4">
            <div className="text-[11px] text-neutral-500">Title</div>
            <div className="text-sm text-white font-medium break-words">{target.name}</div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
            <Field label="Length" value={mpv.duration ? formatTime(mpv.duration) : null} />
            <Field label="Item type" value={ext ? `.${ext}` : (mpv.fileFormat ?? null)} />
            <Field label="Resolution" value={mpv.width && mpv.height ? `${mpv.width} × ${mpv.height}` : null} />
            <Field label="Frame rate" value={mpv.fps ? `${mpv.fps.toFixed(3)} fps` : null} />
            <Field label="Video codec" value={mpv.videoCodec ?? null} />
            <Field label="Audio channels" value={channels ? String(channels) : (audio?.lang ?? null)} />
            <Field label="Size" value={fmtSize(target.size ?? mpv.fileSize)} />
            <Field
              label="Decoding"
              value={mpv.hwdec && mpv.hwdec !== 'no' ? `Hardware (${mpv.hwdec})` : mpv.hwdec === 'no' ? 'Software' : null}
            />
          </div>

          <div className="mt-4">
            <div className="text-[11px] text-neutral-500">{target.streaming ? 'Source' : 'File location'}</div>
            <div className="flex items-start gap-2 mt-1">
              <div className="flex-1 min-w-0 bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-neutral-300 break-all">
                {target.path}
              </div>
              <button
                onClick={copyPath}
                title="Copy path"
                className="p-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-200 shrink-0 transition-colors"
              >
                {copied ? <Check size={15} className="text-green-400" /> : <Copy size={15} />}
              </button>
            </div>
          </div>

          {revealError && <p className="mt-3 text-xs text-red-400">{revealError}</p>}

          {!target.streaming && (
            <button
              onClick={revealFile}
              className="mt-4 w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm font-medium text-neutral-100 transition-colors active:scale-[0.99]"
            >
              <FolderOpen size={16} className="text-red-400" />
              Open file location
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PropertiesModal;
