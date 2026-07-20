import React, { useState, useEffect, useRef, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  X, Share2, Link2, Download, Play, Pause, Copy, Check, Loader2, KeyRound, AlertCircle,
  Folder, ExternalLink, Wifi, Cloud, Square, Trash2, ListChecks,
} from 'lucide-react';
import {
  isShareConnected, getShareUser, connectGitHub, disconnectShare,
  shareFile, shareFolder, parseShareLink, resolveShare, downloadItem, controlDownload, shareDownloadDir,
  lanShareFile, lanShareFolder, lanStop,
  listMyShares, deleteShare, type MyShare,
  type ResolvedShare, type ResolvedItem,
} from '../share';
import { settingsStore } from '../settings';

type Mode = 'menu' | 'connect' | 'method' | 'receive' | 'sharing' | 'manage';
type ShareMethod = 'lan' | 'github';
type ShareJob =
  | { kind: 'file'; path: string; name: string }
  | { kind: 'folder'; files: { path: string; name: string }[]; name: string };

interface ShareModalProps {
  open: boolean;
  onClose: () => void;
  /** When opened from a video's Share action. */
  shareTarget?: { path: string; name: string } | null;
  /** When opened from a folder's Share action. */
  folderTarget?: { files: { path: string; name: string }[]; name: string } | null;
  /** When opened via a prevplayer:// deep-link — jump straight to receive + resolve. */
  initialLink?: string | null;
  /** Watch now (streams) + download all in parallel in the background (app manager). */
  onWatchAndDownload: (items: { url: string; name: string; size?: number }[], dir: string, group?: { id: string; name: string }) => void;
  /** Download all in parallel (app manager, persistent panel). */
  onDownload: (items: { url: string; name: string; size?: number }[], dir: string, group?: { id: string; name: string }) => void;
  /** True if a video with this file name is already in the library. */
  hasInLibrary: (name: string) => boolean;
  /** Open an already-owned library video by file name. */
  onOpenByName: (name: string) => void;
}

const fmtSize = (b: number) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const fmtEta = (s: number) => {
  if (!isFinite(s) || s < 0) return '—';
  const m = Math.floor(s / 60); const sec = Math.round(s % 60);
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};

const ShareModal: React.FC<ShareModalProps> = ({
  open, onClose, shareTarget, folderTarget, initialLink, onWatchAndDownload, onDownload, hasInLibrary, onOpenByName,
}) => {
  const [mode, setMode] = useState<Mode>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // connect
  const [token, setToken] = useState('');
  const [user, setUser] = useState<string | null>(getShareUser());

  // sharing
  const [shareLink, setShareLink] = useState('');
  const [shareStatus, setShareStatus] = useState('');
  const [shareMethod, setShareMethod] = useState<ShareMethod>('lan');
  const [lanId, setLanId] = useState<string | null>(null);
  const [job, setJob] = useState<ShareJob | null>(null);

  // manage (my shares)
  const [myShares, setMyShares] = useState<MyShare[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const openManage = useCallback(() => { setMyShares(listMyShares()); setError(''); setMode('manage'); }, []);
  const delShare = useCallback(async (tag: string) => {
    setDeleting(tag);
    try { await deleteShare(tag); setMyShares(listMyShares()); }
    catch (e: any) { setError(e?.message || String(e)); }
    finally { setDeleting(null); }
  }, []);

  // receive
  const [linkInput, setLinkInput] = useState('');
  const [resolved, setResolved] = useState<ResolvedShare | null>(null);

  // Decide the initial view whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setError(''); setCopied(false); setShareLink(''); setResolved(null);
    setLanId(null);
    if (initialLink) {
      setMode('receive'); setLinkInput(initialLink); doResolve(initialLink);
    } else if (shareTarget) {
      beginShare({ kind: 'file', path: shareTarget.path, name: shareTarget.name });
    } else if (folderTarget) {
      beginShare({ kind: 'folder', files: folderTarget.files, name: folderTarget.name });
    } else {
      setMode('menu');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shareTarget, folderTarget, initialLink]);

  const pendingRef = useRef<ShareJob | null>(null);

  // Choose the transport (LAN vs GitHub) for the pending job.
  const beginShare = useCallback((j: ShareJob) => {
    setJob(j); setError(''); setShareLink(''); setLanId(null); setMode('method');
  }, []);

  const runLanShare = useCallback(async (j: ShareJob) => {
    setMode('sharing'); setShareMethod('lan'); setBusy(true); setError(''); setShareLink('');
    try {
      setShareStatus('Starting local share…');
      const res = j.kind === 'file'
        ? await lanShareFile(j.path, j.name)
        : await lanShareFolder(j.files, j.name);
      setLanId(res.id); setShareLink(res.link); setShareStatus('');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  }, []);

  const runGithubShare = useCallback(async (j: ShareJob) => {
    setMode('sharing'); setShareMethod('github'); setBusy(true); setError(''); setShareLink('');
    try {
      let link = '';
      if (j.kind === 'file') {
        setShareStatus(`Uploading “${j.name}”…`);
        link = await shareFile(j.path, j.name);
      } else {
        link = await shareFolder(j.files, j.name, (i, total, name) => {
          setShareStatus(`Uploading ${i + 1}/${total}: ${name}`);
        });
      }
      setShareLink(link); setShareStatus('');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  }, []);

  const chooseGithub = useCallback((j: ShareJob | null) => {
    if (!j) return;
    if (!isShareConnected()) { pendingRef.current = j; setMode('connect'); return; }
    runGithubShare(j);
  }, [runGithubShare]);

  const stopLanShare = useCallback(async () => {
    if (lanId) { try { await lanStop(lanId); } catch {} setLanId(null); }
    onClose();
  }, [lanId, onClose]);

  const pickAndShareFile = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const sel = await open({ multiple: false, filters: [{ name: 'Media', extensions: ['mp4','mkv','avi','mov','webm','m4v','wmv','flv','ts','mpg','mpeg','mp3','flac','m4a','wav','aac','opus','ogg'] }] });
    if (!sel || typeof sel !== 'string') return;
    const name = sel.split(/[\\/]/).pop() || 'video';
    beginShare({ kind: 'file', path: sel, name });
  };

  const pickAndShareFolder = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true });
    if (!dir || typeof dir !== 'string') return;
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');
    const rx = /\.(mp4|mkv|avi|mov|webm|m4v|wmv|flv|ts|mpg|mpeg|mp3|flac|m4a|wav|aac|opus|ogg)$/i;
    const entries = await readDir(dir);
    const files: { path: string; name: string }[] = [];
    for (const e of entries) {
      if ((e as any).isFile && rx.test(e.name)) files.push({ path: await join(dir, e.name), name: e.name });
    }
    if (!files.length) { setError('No media files found in that folder.'); return; }
    const folderName = dir.split(/[\\/]/).pop() || 'folder';
    beginShare({ kind: 'folder', files, name: folderName });
  };

  const doConnect = async () => {
    setBusy(true); setError('');
    try {
      const u = await connectGitHub(token.trim());
      setUser(u); setToken('');
      const pending = pendingRef.current; pendingRef.current = null;
      if (pending) runGithubShare(pending);
      else setMode('menu');
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  };

  const doResolve = async (explicitLink?: string) => {
    setBusy(true); setError(''); setResolved(null);
    try {
      const p = parseShareLink(explicitLink ?? linkInput);
      if (!p) throw new Error('That doesn’t look like a PREV share link.');
      const r = await resolveShare(p);
      if (!r.items.length) throw new Error('This share has no playable files.');
      setResolved(r);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally { setBusy(false); }
  };

  const itemsOf = (r: ResolvedShare) => r.items.map(i => ({ url: i.url, name: i.name, size: i.size }));
  const groupOf = (r: ResolvedShare) => (r.kind === 'folder' ? { id: 'grp-' + Math.random().toString(36).slice(2), name: r.name } : undefined);

  // Watch now: stream immediately AND start ALL downloads in parallel (uses the
  // download folder from Settings if set, else the default Downloads/PREV Player).
  const doWatch = async () => {
    if (!resolved) return;
    const custom = settingsStore.get().downloadPath;
    const dir = custom && custom.trim() ? custom : await shareDownloadDir();
    onWatchAndDownload(itemsOf(resolved), dir, groupOf(resolved));
    onClose();
  };

  // Download: pick where, then hand ALL files to the app's parallel download manager
  // (progress lives in the persistent Downloads panel, not this dialog).
  const doDownload = async () => {
    if (!resolved) return;
    setError('');
    if (resolved.items.every(it => hasInLibrary(it.name))) { onOpenByName(resolved.items[0].name); onClose(); return; }
    const custom = settingsStore.get().downloadPath;
    let dir = '';
    if (custom && custom.trim()) {
      // A download folder is set in Settings → save straight there, no prompt.
      dir = custom;
    } else {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const def = await shareDownloadDir();
        const picked = await open({ directory: true, multiple: false, title: 'Save downloads to…', defaultPath: def });
        if (picked === null) return; // user cancelled the folder picker
        dir = typeof picked === 'string' ? picked : def;
      } catch { dir = await shareDownloadDir(); }
    }
    onDownload(itemsOf(resolved), dir, groupOf(resolved));
    onClose();
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(shareLink); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch {}
  };

  if (!open) return null;

  const allOwned = resolved?.items.every(i => hasInLibrary(i.name));

  return (
    <div className="fixed inset-0 z-[320] bg-black/70 flex items-center justify-center p-4 animate-[fadeIn_0.15s_ease]" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-neutral-700/60 shadow-2xl shadow-black/60 overflow-hidden"
        style={{ background: 'rgb(20,20,23)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-purple-600 flex items-center justify-center">
              <Share2 size={16} className="text-white" />
            </div>
            <h3 className="font-bold text-white">Share</h3>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-neutral-800 rounded-lg transition-colors">
            <X size={18} className="text-neutral-400" />
          </button>
        </div>

        <div className="p-5">
          {error && (
            <div className="mb-4 flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
              <AlertCircle size={16} className="mt-0.5 shrink-0" /><span>{error}</span>
            </div>
          )}

          {/* MENU */}
          {mode === 'menu' && (
            <div className="space-y-3">
              <button
                onClick={() => { setMode('receive'); setError(''); }}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-neutral-800/70 hover:bg-neutral-800 transition-colors text-left"
              >
                <Link2 size={20} className="text-red-400 shrink-0" />
                <div>
                  <div className="text-white font-medium text-sm">Open a shared link</div>
                  <div className="text-neutral-400 text-xs">Paste a link to watch or download</div>
                </div>
              </button>
              <button
                onClick={pickAndShareFile}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-neutral-800/70 hover:bg-neutral-800 transition-colors text-left"
              >
                <Play size={20} className="text-red-400 shrink-0" />
                <div>
                  <div className="text-white font-medium text-sm">Share a video</div>
                  <div className="text-neutral-400 text-xs">Pick a file → get a share link</div>
                </div>
              </button>
              <button
                onClick={pickAndShareFolder}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-neutral-800/70 hover:bg-neutral-800 transition-colors text-left"
              >
                <Folder size={20} className="text-red-400 shrink-0" />
                <div>
                  <div className="text-white font-medium text-sm">Share a folder</div>
                  <div className="text-neutral-400 text-xs">Share every video in a folder</div>
                </div>
              </button>
              {isShareConnected() && (
                <button
                  onClick={openManage}
                  className="w-full flex items-center gap-3 p-3.5 rounded-xl bg-neutral-800/70 hover:bg-neutral-800 transition-colors text-left"
                >
                  <ListChecks size={20} className="text-red-400 shrink-0" />
                  <div>
                    <div className="text-white font-medium text-sm">My shares</div>
                    <div className="text-neutral-400 text-xs">See or delete your GitHub shares</div>
                  </div>
                </button>
              )}
              <div className="flex items-center justify-between text-xs text-neutral-500 px-1">
                <span>{isShareConnected() ? `Sharing as ${user}` : 'Not connected to GitHub'}</span>
                {isShareConnected()
                  ? <button className="text-neutral-400 hover:text-white" onClick={() => { disconnectShare(); setUser(null); }}>Disconnect</button>
                  : <button className="text-red-400 hover:text-red-300" onClick={() => setMode('connect')}>Connect</button>}
              </div>
              <p className="text-[11px] text-neutral-500 leading-relaxed px-1">
                When you share, you pick <b>Local Wi‑Fi</b> (no account, nothing stored — works while
                you’re on the same network) or <b>GitHub</b> (any device, needs a free token).
              </p>
            </div>
          )}

          {/* METHOD PICKER */}
          {mode === 'method' && (
            <div className="space-y-3">
              <div className="text-sm text-neutral-300 mb-1">How do you want to share <b className="text-white">{job?.name}</b>?</div>
              <button
                onClick={() => runLanShare(job!)}
                className="w-full flex items-start gap-3 p-3.5 rounded-xl bg-neutral-800/70 hover:bg-neutral-800 transition-colors text-left"
              >
                <Wifi size={20} className="text-red-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-white font-medium text-sm">Local Wi‑Fi <span className="text-green-400 text-[10px] font-semibold ml-1">NO ACCOUNT</span></div>
                  <div className="text-neutral-400 text-xs">Instant, nothing stored. Receiver must be on the same network, app stays open.</div>
                </div>
              </button>
              <button
                onClick={() => chooseGithub(job)}
                className="w-full flex items-start gap-3 p-3.5 rounded-xl bg-neutral-800/70 hover:bg-neutral-800 transition-colors text-left"
              >
                <Cloud size={20} className="text-red-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-white font-medium text-sm">GitHub link</div>
                  <div className="text-neutral-400 text-xs">Works on any device, any time. Needs a free GitHub token (once).</div>
                </div>
              </button>
              <button onClick={() => setMode('menu')} className="w-full py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200">Back</button>
            </div>
          )}

          {/* CONNECT */}
          {mode === 'connect' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-neutral-300"><KeyRound size={16} className="text-red-400" /> Connect GitHub to share</div>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Paste a <b>classic Personal Access Token</b> with the <code>public_repo</code> scope
                (needed to create your free <code>prev-shares</code> repo). Stored only on this device —
                receivers need nothing.
              </p>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const { openUrl } = await import('@tauri-apps/plugin-opener');
                    await openUrl('https://github.com/settings/tokens/new?scopes=public_repo&description=PREV%20Player%20sharing');
                  } catch {
                    window.open('https://github.com/settings/tokens/new?scopes=public_repo&description=PREV%20Player%20sharing', '_blank');
                  }
                }}
                className="inline-flex items-center gap-1 text-xs text-red-400 hover:text-red-300"
              >
                Create the token (public_repo pre-selected) <ExternalLink size={12} />
              </button>
              <input
                type="password" value={token} onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_… or ghp_…"
                className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-red-500"
              />
              <div className="flex gap-2">
                <button onClick={() => setMode('menu')} className="flex-1 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200">Back</button>
                <button onClick={doConnect} disabled={busy || !token.trim()} className="flex-1 py-2 rounded-lg bg-gradient-to-r from-red-600 to-purple-600 hover:from-red-500 hover:to-purple-500 text-sm font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2">
                  {busy && <Loader2 size={15} className="animate-spin" />} Connect
                </button>
              </div>
            </div>
          )}

          {/* SHARING (upload + link) */}
          {mode === 'sharing' && (
            <div className="space-y-3">
              {busy && (
                <div className="flex items-center gap-2 text-sm text-neutral-300">
                  <Loader2 size={16} className="animate-spin text-red-400" /> {shareStatus || 'Uploading…'}
                </div>
              )}
              {shareLink && (
                <>
                  <div className="flex items-center gap-2 text-sm text-green-400">
                    {shareMethod === 'lan' ? <Wifi size={16} /> : <Cloud size={16} />} Ready to share
                  </div>
                  <div className="flex items-center gap-2 bg-neutral-900 border border-neutral-700 rounded-lg p-2">
                    <input readOnly value={shareLink} className="flex-1 bg-transparent text-xs text-neutral-300 outline-none" onFocus={(e) => e.target.select()} />
                    <button onClick={copyLink} className="p-1.5 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200">
                      {copied ? <Check size={15} className="text-green-400" /> : <Copy size={15} />}
                    </button>
                  </div>
                  {shareMethod === 'lan' ? (
                    <>
                      <p className="text-[11px] text-neutral-500 leading-relaxed">
                        Send this to someone on the <b>same Wi‑Fi</b>. Nothing is uploaded — it streams from your
                        device. Keep PREV Player open; the link dies when you stop or close it.
                      </p>
                      <button onClick={stopLanShare} className="w-full mt-1 py-2 rounded-lg bg-neutral-800 hover:bg-red-600/20 text-sm font-medium text-neutral-200 hover:text-red-300 flex items-center justify-center gap-2 transition-colors">
                        <Square size={14} /> Stop sharing
                      </button>
                    </>
                  ) : (
                    <p className="text-[11px] text-neutral-500">Works on any device, anywhere. <b>Auto-deletes</b> once they download it (or after 7 days) — or remove it now in <b>My shares</b>.</p>
                  )}
                </>
              )}
            </div>
          )}

          {/* RECEIVE */}
          {mode === 'receive' && (
            <div className="space-y-3">
              {!resolved ? (
                <>
                  <div className="flex items-center gap-2 text-sm text-neutral-300"><Link2 size={16} className="text-red-400" /> Paste a share link</div>
                  <textarea
                    value={linkInput} onChange={(e) => setLinkInput(e.target.value)} rows={3}
                    placeholder="prevplayer://share/…"
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-red-500 resize-none break-all"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => setMode('menu')} className="flex-1 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200">Back</button>
                    <button onClick={() => doResolve()} disabled={busy || !linkInput.trim()} className="flex-1 py-2 rounded-lg bg-gradient-to-r from-red-600 to-purple-600 text-sm font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2">
                      {busy && <Loader2 size={15} className="animate-spin" />} Open
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    {resolved.kind === 'folder' ? <Folder size={18} className="text-red-400" /> : <Play size={18} className="text-red-400" />}
                    <div className="min-w-0">
                      <div className="text-white text-sm font-medium truncate">{resolved.name}</div>
                      <div className="text-neutral-500 text-xs">
                        {resolved.items.length} file{resolved.items.length > 1 ? 's' : ''}
                        {allOwned && ' · already in your library'}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 pt-1">
                    <button onClick={doWatch} className="flex-1 py-2.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm font-medium text-white flex items-center justify-center gap-2">
                      <Play size={16} /> Watch now
                    </button>
                    <button onClick={doDownload} className="flex-1 py-2.5 rounded-lg bg-gradient-to-r from-red-600 to-purple-600 hover:from-red-500 hover:to-purple-500 text-sm font-bold text-white flex items-center justify-center gap-2">
                      {allOwned ? <Play size={16} /> : <Download size={16} />}
                      {allOwned ? 'Open' : 'Download'}
                    </button>
                  </div>
                  <p className="text-[11px] text-neutral-500 text-center">
                    {resolved.items.length > 1
                      ? 'Watch streams now while all files download in parallel · Download saves them (progress shows in the Downloads panel).'
                      : 'Watch streams instantly (and downloads in the background) · Download saves it where you choose.'}
                  </p>
                </>
              )}
            </div>
          )}

          {/* MANAGE (my GitHub shares) */}
          {mode === 'manage' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-neutral-300"><ListChecks size={16} className="text-red-400" /> Your shares</div>
              {myShares.length === 0 ? (
                <p className="text-xs text-neutral-500 py-3 text-center">No active shares. They also auto-delete after they’re downloaded, or after 7 days.</p>
              ) : (
                <div className="max-h-64 overflow-auto custom-scrollbar space-y-2 -mr-1 pr-1">
                  {myShares.map((s) => (
                    <div key={s.tag} className="flex items-center gap-2 bg-neutral-800/60 rounded-lg p-2.5">
                      {s.kind === 'folder' ? <Folder size={16} className="text-neutral-400 shrink-0" /> : <Play size={16} className="text-neutral-400 shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <div className="text-white text-xs font-medium truncate">{s.name}</div>
                        <div className="text-neutral-500 text-[10px]">{new Date(s.createdAt).toLocaleDateString()}</div>
                      </div>
                      <button
                        onClick={() => delShare(s.tag)} disabled={deleting === s.tag}
                        className="p-1.5 rounded-md text-neutral-400 hover:text-red-400 hover:bg-red-600/20 transition-colors disabled:opacity-50"
                        title="Delete this share"
                      >
                        {deleting === s.tag ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button onClick={() => setMode('menu')} className="w-full py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm text-neutral-200">Back</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShareModal;
