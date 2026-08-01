// ===========================================================================
// Sharing — the two backends, and the one link that hides which is which.
//
// Local Wi-Fi shares are served by the engine itself, so the link it mints is
// already an engine link and this file just wraps it for the `prevplayer://`
// scheme the OS knows about.
//
// GitHub shares need work that isn't the engine's business: an account, a token,
// and a REST API. So the upload and the release lookup live here — but the
// result is turned straight back into an engine link (`httpLink`), because a
// release asset is a range-serving HTTP source like any other. From
// `toEngineLink` onwards there is only one kind of share.
// ===========================================================================

import { invoke } from '@tauri-apps/api/core';
import * as engine from './engine';

const LS_TOKEN = 'prevplayer_gh_token';
const LS_USER = 'prevplayer_gh_user';
export const SHARE_REPO = 'prev-shares';

// ---- token / account (stored locally, per device) ------------------------
export function getShareToken(): string | null { return localStorage.getItem(LS_TOKEN); }
export function getShareUser(): string | null { return localStorage.getItem(LS_USER); }
export function isShareConnected(): boolean { return !!getShareToken() && !!getShareUser(); }
export function disconnectShare() { localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER); }

// ---- low-level GitHub REST via the Rust passthrough (avoids WebView CORS) --
async function gh(method: string, url: string, token?: string | null, body?: any) {
  const resp = await invoke<{ status: number; body: string }>('github_api', {
    method, url, token: token ?? null, body: body ? JSON.stringify(body) : null,
  });
  let json: any = null;
  try { json = resp.body ? JSON.parse(resp.body) : null; } catch { /* non-JSON */ }
  return { status: resp.status, json, raw: resp.body };
}

/** Validate a Personal Access Token, remember the user, and ensure prev-shares exists. */
export async function connectGitHub(token: string): Promise<string> {
  const me = await gh('GET', 'https://api.github.com/user', token);
  if (me.status !== 200 || !me.json?.login) {
    throw new Error('Invalid token. Create a token with "repo" (or Contents: read/write) access.');
  }
  const user: string = me.json.login;

  const repo = await gh('GET', `https://api.github.com/repos/${user}/${SHARE_REPO}`, token);
  if (repo.status === 404) {
    const created = await gh('POST', 'https://api.github.com/user/repos', token, {
      name: SHARE_REPO, private: false, auto_init: true,
      description: 'PREV Player — shared media (public downloads).',
    });
    if (created.status >= 300) throw new Error('Could not create prev-shares repo: ' + created.raw);
  } else if (repo.status >= 300) {
    throw new Error('GitHub error: ' + repo.raw);
  }

  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_USER, user);
  return user;
}

// ---- link format: prevplayer://share/<base64url(payload)> -----------------
export interface SharePayload {
  v: 1;
  /**
   * `engine` is what everything new mints — the payload carries a ready engine
   * link and needs no lookup at all. `file`/`folder` are GitHub shares, which
   * still need a release lookup. `lan-*` are links from before the engine, kept
   * readable so an old sender's link doesn't dead-end.
   */
  k: 'engine' | 'file' | 'folder' | 'lan-file' | 'lan-folder';
  r?: string;   // GitHub owner
  t?: string;   // GitHub release tag
  n: string;    // display name
  u?: string;   // legacy LAN direct/manifest URL
  e?: string;   // engine link (k === 'engine')
}

function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(escape(atob(s)));
}
/** Readable link: prevplayer://share/video|folder/<name>/<payload>. The name is
 *  cosmetic; the trailing payload carries the actual location. */
export function encodeShareLink(
  p: SharePayload,
  isFolder = p.k === 'folder' || p.k === 'lan-folder',
): string {
  const kind = isFolder ? 'folder' : 'video';
  const slug = encodeURIComponent(p.n.replace(/\.[^.]+$/, '')).replace(/%20/g, '-').slice(0, 60) || kind;
  return `prevplayer://share/${kind}/${slug}/${b64urlEncode(JSON.stringify(p))}`;
}
export function parseShareLink(link: string): SharePayload | null {
  const t = link.trim();
  // New readable form: …/share/<video|folder>/<name>/<payload>
  let m = t.match(/prevplayer:\/\/share\/(?:video|folder)\/[^/]*\/([A-Za-z0-9\-_]+)/);
  // Back-compat: old …/share/<payload>
  if (!m) m = t.match(/prevplayer:\/\/share\/([A-Za-z0-9\-_]+)\s*$/);
  if (!m) return null;
  try { const p = JSON.parse(b64urlDecode(m[1])); return p?.v === 1 ? p : null; } catch { return null; }
}

// ---- content types (so streamed assets play in <video>/mpv) ---------------
const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', ogg: 'video/ogg',
  mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv', ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  opus: 'audio/opus', oga: 'audio/ogg', wma: 'audio/x-ms-wma',
};
function contentTypeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return MIME[ext] || 'application/octet-stream';
}
function sanitizeAssetName(name: string): string {
  // GitHub asset names can't contain spaces safely for URLs — keep it clean.
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}
const rid = () => Math.random().toString(36).slice(2, 10);

// ---- sharer: upload ------------------------------------------------------
async function createRelease(user: string, token: string, tag: string, title: string) {
  const rel = await gh('POST', `https://api.github.com/repos/${user}/${SHARE_REPO}/releases`, token, {
    tag_name: tag, name: title, body: 'Shared via PREV Player.', draft: false, prerelease: false,
  });
  if (!rel.json?.upload_url) throw new Error('Create release failed: ' + rel.raw);
  return String(rel.json.upload_url).replace(/\{.*\}$/, ''); // strip {?name,label}
}

async function uploadAsset(uploadBase: string, token: string, filePath: string, assetName: string) {
  const uploadUrl = `${uploadBase}?name=${encodeURIComponent(sanitizeAssetName(assetName))}`;
  await invoke<string>('upload_github_asset', {
    uploadUrl, token, filePath, contentType: contentTypeFor(assetName),
  });
}

/** Share a single file → returns the share link. */
export async function shareFile(localPath: string, name: string): Promise<string> {
  const token = getShareToken(); const user = getShareUser();
  if (!token || !user) throw new Error('Connect GitHub first.');
  const tag = 's-' + rid();
  const uploadBase = await createRelease(user, token, tag, `share: ${name}`);
  await uploadAsset(uploadBase, token, localPath, name);
  recordShare({ tag, name, kind: 'file', createdAt: Date.now() });
  return encodeShareLink({ v: 1, k: 'file', r: user, t: tag, n: name });
}

/** Share a folder (multiple files) → returns the share link. */
export async function shareFolder(
  files: { path: string; name: string }[],
  folderName: string,
  onEach?: (i: number, total: number, name: string) => void,
): Promise<string> {
  const token = getShareToken(); const user = getShareUser();
  if (!token || !user) throw new Error('Connect GitHub first.');
  const tag = 'f-' + rid();
  const uploadBase = await createRelease(user, token, tag, `share folder: ${folderName}`);
  for (let i = 0; i < files.length; i++) {
    onEach?.(i, files.length, files[i].name);
    await uploadAsset(uploadBase, token, files[i].path, files[i].name);
  }
  // manifest keeps original names + order (asset names are sanitized).
  const manifest = JSON.stringify({ folder: folderName, items: files.map(f => f.name) });
  const uploadUrl = `${uploadBase}?name=manifest.json`;
  await invoke('upload_github_asset', {
    uploadUrl, token, filePath: await writeTempManifest(manifest), contentType: 'application/json',
  });
  recordShare({ tag, name: folderName, kind: 'folder', createdAt: Date.now() });
  return encodeShareLink({ v: 1, k: 'folder', r: user, t: tag, n: folderName });
}

// ---- share management: auto-expiry + manual delete (so nothing lingers) -----
const LS_MYSHARES = 'prevplayer_my_shares';
export interface MyShare { tag: string; name: string; kind: 'file' | 'folder'; createdAt: number; }

function readMyShares(): MyShare[] {
  try { return JSON.parse(localStorage.getItem(LS_MYSHARES) || '[]'); } catch { return []; }
}
function writeMyShares(s: MyShare[]) {
  try { localStorage.setItem(LS_MYSHARES, JSON.stringify(s)); } catch {}
}
function recordShare(m: MyShare) { writeMyShares([m, ...readMyShares()].slice(0, 300)); }
export function listMyShares(): MyShare[] { return readMyShares(); }

/** Delete a GitHub share (its release + tag) and forget it locally. */
export async function deleteShare(tag: string): Promise<void> {
  const token = getShareToken(); const user = getShareUser();
  if (token && user) {
    const rel = await gh('GET', `https://api.github.com/repos/${user}/${SHARE_REPO}/releases/tags/${tag}`, token);
    if (rel.json?.id) {
      await gh('DELETE', `https://api.github.com/repos/${user}/${SHARE_REPO}/releases/${rel.json.id}`, token);
    }
    await gh('DELETE', `https://api.github.com/repos/${user}/${SHARE_REPO}/git/refs/tags/${tag}`, token);
  }
  writeMyShares(readMyShares().filter(s => s.tag !== tag));
}

/**
 * On launch: auto-delete a GitHub share once the receiver has downloaded it
 * (GitHub's asset download counter goes > 0), OR after `maxAgeDays` as a backstop.
 * This is what makes shares "delete themselves once the other device is done."
 */
export async function cleanupExpiredShares(maxAgeDays = 7): Promise<void> {
  if (!isShareConnected()) return;
  const token = getShareToken(); const user = getShareUser();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const s of readMyShares()) {
    let remove = s.createdAt < cutoff;
    if (!remove) {
      try {
        const rel = await gh('GET', `https://api.github.com/repos/${user}/${SHARE_REPO}/releases/tags/${s.tag}`, token);
        if (rel.status === 404) {
          remove = true; // already gone on GitHub
        } else {
          const assets: any[] = rel.json?.assets || [];
          const downloaded = assets.some(a => a.name !== 'manifest.json' && (a.download_count || 0) > 0);
          if (downloaded) remove = true;
        }
      } catch { /* network — try again next launch */ }
    }
    if (remove) { try { await deleteShare(s.tag); } catch { /* keep for next launch */ } }
  }
}

async function writeTempManifest(json: string): Promise<string> {
  return invoke<string>('write_temp_file', { content: json, ext: 'json' });
}

/** Folder where received downloads are saved (…/Downloads/PREV Player). */
export const shareDownloadDir = engine.downloadDir;

// ---- LAN (same-Wi-Fi) sharing — ephemeral, no account, nothing stored -------
//
// The engine serves these itself: hash-derived ids, lazy whole-file digests so
// the receiver can verify, and range support that actually lets them seek.

export async function lanShareFile(path: string, name: string): Promise<{ link: string; id: string }> {
  const r = await engine.shareFile(path);
  return { link: encodeShareLink({ v: 1, k: 'engine', n: r.name || name, e: r.link }, false), id: r.id };
}

export async function lanShareFolder(
  files: { path: string; name: string }[],
  folderName: string,
): Promise<{ link: string; id: string }> {
  const r = await engine.shareFolder(files.map(f => f.path), folderName);
  return { link: encodeShareLink({ v: 1, k: 'engine', n: r.name, e: r.link }, true), id: r.id };
}

export function lanStop(id: string): Promise<void> { return engine.stopShare(id).then(() => {}); }
export function lanStopAll(): Promise<void> { return engine.stopAllShares(); }

// ---- receiver: any link → one engine link ---------------------------------

/**
 * Reduce whatever was pasted to a single engine link. A `prev://` or bare
 * `http(s)://` URL passes straight through; a `prevplayer://` link is unwrapped;
 * a GitHub share is looked up and its assets become an HTTP link.
 *
 * From here on the caller talks only to the engine: `resolve` for the file list,
 * then `watch` or `download`.
 */
export async function toEngineLink(input: string): Promise<string> {
  const text = input.trim();
  if (/^(prev:\/\/|https?:\/\/)/i.test(text)) return text;

  const p = parseShareLink(text);
  if (!p) throw new Error('That doesn’t look like a PREV share link.');

  // Minted by this version — the payload already is the link.
  if (p.k === 'engine' && p.e) return p.e;

  // Pre-engine LAN links: the sender is a running app on this network, and its
  // URLs are plain HTTP, so they still resolve.
  if (p.k === 'lan-file' && p.u) return p.u;
  if (p.k === 'lan-folder' && p.u) {
    // Fetch the folder manifest through Rust (avoids WebView CORS on the LAN server).
    const resp = await invoke<{ status: number; body: string }>('github_api', {
      method: 'GET', url: p.u, token: null, body: null,
    });
    if (resp.status >= 300) throw new Error('The sharer is offline or the link expired.');
    const m = JSON.parse(resp.body);
    const files = (m.items || []).map((it: any) => ({
      name: it.name, size: it.size || 0, url: `${p.u}/${it.index}`,
    }));
    if (!files.length) throw new Error('This share has no playable files.');
    return engine.httpLink(p.n, files);
  }

  return githubLink(p);
}

/** Look up a GitHub share's release and turn its assets into an engine link. */
async function githubLink(p: SharePayload): Promise<string> {
  const rel = await gh('GET', `https://api.github.com/repos/${p.r}/${SHARE_REPO}/releases/tags/${p.t}`, getShareToken());
  if (rel.status === 404) throw new Error('This shared link no longer exists (it may have been removed).');
  if (rel.status >= 300) throw new Error('Could not open share: ' + rel.raw);
  const assets: any[] = rel.json.assets || [];

  // Optional manifest gives back the original names/order (asset names are sanitized).
  const manifestAsset = assets.find(a => a.name === 'manifest.json');
  let order: string[] | null = null;
  if (manifestAsset) {
    try {
      const raw = await invoke<{ status: number; body: string }>('github_api', {
        method: 'GET', url: manifestAsset.browser_download_url, token: getShareToken() ?? null, body: null,
      });
      order = JSON.parse(raw.body).items || null;
    } catch { /* ignore manifest errors */ }
  }

  const media = assets
    .filter(a => a.name !== 'manifest.json')
    .map(a => ({ name: a.name as string, size: a.size as number, url: a.browser_download_url as string }));
  if (!media.length) throw new Error('This share has no playable files.');
  if (order) media.sort((a, b) => order!.indexOf(a.name) - order!.indexOf(b.name));

  return engine.httpLink(p.n, media);
}
