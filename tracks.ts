// ==========================================================================
// Which audio and subtitle tracks to play — the opt-in helpers in
// Settings › Audio & subtitles. Pure decisions over mpv's track list (plus a
// small store of what the user picked), so they can be tested without mpv.
//
//  - Smart audio: the track in your language, best version first — lossless
//    and Atmos / DTS:X over lossy, surround over stereo — never commentary.
//  - Remembered tracks: what you picked for a video comes back for it, and for
//    the rest of its folder (the next episode of a series).
//  - Forced subtitles: signs and foreign-language lines, even with subtitles off.
//  - A second subtitle line, in another language, above the first.
// ==========================================================================

import type { MpvTrack } from './mpv';

// ---------------------------------------------------------------------------
// Languages. Files tag tracks with ISO 639-2 ("eng", "fre"/"fra"), people and
// browsers use 639-1 ("en", "fr-CA"); everything is compared as 639-1.
// ---------------------------------------------------------------------------

const ALIASES: Record<string, string> = {
  eng: 'en', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', ita: 'it', por: 'pt', jpn: 'ja',
  zho: 'zh', chi: 'zh', cmn: 'zh', yue: 'zh', kor: 'ko', rus: 'ru', hin: 'hi', ara: 'ar', nld: 'nl', dut: 'nl',
  swe: 'sv', nor: 'no', nob: 'no', nno: 'no', dan: 'da', fin: 'fi', pol: 'pl', tur: 'tr', ces: 'cs', cze: 'cs',
  ell: 'el', gre: 'el', heb: 'he', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms', may: 'ms', tam: 'ta', tel: 'te',
  ben: 'bn', mar: 'mr', urd: 'ur', fas: 'fa', per: 'fa', ukr: 'uk', hun: 'hu', ron: 'ro', rum: 'ro', bul: 'bg',
  hrv: 'hr', srp: 'sr', slk: 'sk', slo: 'sk', slv: 'sl', cat: 'ca', eus: 'eu', baq: 'eu', glg: 'gl', isl: 'is',
  ice: 'is', est: 'et', lav: 'lv', lit: 'lt', fil: 'tl', tgl: 'tl', mal: 'ml', kan: 'kn', guj: 'gu', pan: 'pa',
  nb: 'no', nn: 'no', iw: 'he', in: 'id',
};

/** "eng", "en-US", "EN" → "en"; undefined for an untagged track. */
export function langKey(lang?: string): string | undefined {
  if (!lang) return undefined;
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  if (!base || base === 'und' || base === 'mul' || base === 'zxx') return undefined;
  return ALIASES[base] ?? base;
}

/** The language to prefer: the user's pick, else the app's (Windows display language). */
export function preferredLanguage(setting: string): string {
  return langKey(setting) ?? langKey(typeof navigator !== 'undefined' ? navigator.language : 'en') ?? 'en';
}

/** Languages offered in Settings, by 639-1 code. */
export const LANGUAGE_CODES = [
  'en', 'hi', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ru', 'ar', 'ta', 'te', 'bn', 'mr', 'ur', 'ml', 'kn',
  'gu', 'pa', 'nl', 'sv', 'no', 'da', 'fi', 'pl', 'tr', 'cs', 'el', 'he', 'th', 'vi', 'id', 'ms', 'fa', 'uk', 'hu',
  'ro', 'bg', 'hr', 'sr',
];

export function languageName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

// ---------------------------------------------------------------------------
// Smart audio
// ---------------------------------------------------------------------------

/** Commentary, audio description and the like — never the track to start on. */
const EXTRA = /comment|director|descri|narrat|visually|\bAD\b|karaoke|isolated|music only|score only/i;
const isExtra = (t: MpvTrack) => EXTRA.test(t.title ?? '') || !!t.hearingImpaired;
/** Signs and foreign-language lines only. */
const FORCED_TITLE = /forced|signs|foreign/i;
const isForced = (t: MpvTrack) => !!t.forced || FORCED_TITLE.test(t.title ?? '');

/** Higher is better: lossless, then object audio, then channels. */
export function audioRank(t: MpvTrack): number {
  const codec = (t.codec ?? '').toLowerCase();
  const text = `${t.profile ?? ''} ${t.title ?? ''}`;
  const tier =
    ['truehd', 'mlp', 'flac', 'alac', 'wavpack', 'ape', 'tak', 'tta'].includes(codec) || codec.startsWith('pcm')
      || /DTS-HD MA|Master Audio|lossless/i.test(text) ? 4
      : ['eac3', 'dts'].includes(codec) ? 3
        : ['ac3', 'opus'].includes(codec) ? 2
          : 1;
  const immersive = /atmos|dts[:\s-]?x\b/i.test(text) ? 1 : 0;
  return tier * 100 + immersive * 50 + Math.min(t.channels ?? 2, 16);
}

/**
 * The audio track to start on, or null to leave mpv's choice. In the preferred
 * language if the file has it, else in the language of the file's own default
 * (its original language) — the best version there either way.
 */
export function smartAudioPick(tracks: MpvTrack[], lang: string): number | null {
  const audio = tracks.filter(t => t.type === 'audio');
  if (audio.length < 2) return null;
  const main = audio.filter(t => !isExtra(t));
  const pool = main.length ? main : audio;
  const best = (list: MpvTrack[]) => list.reduce((a, b) => (audioRank(b) > audioRank(a) ? b : a));

  const mine = pool.filter(t => langKey(t.lang) === lang);
  if (mine.length) return best(mine).id;

  const original = audio.find(t => t.default) ?? audio.find(t => t.selected) ?? pool[0];
  const same = pool.filter(t => langKey(t.lang) === langKey(original.lang));
  return best(same.length ? same : pool).id;
}

// ---------------------------------------------------------------------------
// Remembered tracks
// ---------------------------------------------------------------------------

export interface TrackRef { lang?: string; title?: string; forced?: boolean }
export interface Remembered {
  audio?: TrackRef;
  /** 'off' = the user turned subtitles off. */
  sub?: TrackRef | 'off';
}

const STORE = 'prevplayer_tracks';
const MAX_VIDEOS = 1000;
interface Store { videos: Record<string, Remembered>; folders: Record<string, Remembered> }

function read(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (raw && typeof raw === 'object') return { videos: raw.videos ?? {}, folders: raw.folders ?? {} };
  } catch {}
  return { videos: {}, folders: {} };
}

/** The folder a local file sits in — the "series" its choice carries over to. */
export function folderOf(path: string | undefined): string | undefined {
  if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return undefined;
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut > 0 ? path.slice(0, cut).toLowerCase() : undefined;
}

export const refOf = (t: MpvTrack): TrackRef => ({ lang: t.lang, title: t.title, forced: isForced(t) || undefined });

/** Record a choice the user made by hand, for this video and its folder. */
export function rememberChoice(videoId: string | undefined, path: string | undefined, patch: Remembered): void {
  const store = read();
  const folder = folderOf(path);
  if (videoId) {
    // Re-insert so the newest are last; the oldest fall off past the cap.
    const next = { ...store.videos[videoId], ...patch };
    delete store.videos[videoId];
    store.videos[videoId] = next;
    const ids = Object.keys(store.videos);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_VIDEOS))) delete store.videos[id];
  }
  if (folder) store.folders[folder] = { ...store.folders[folder], ...patch };
  try { localStorage.setItem(STORE, JSON.stringify(store)); } catch {}
}

/** What to restore for a video: its own choice, else its folder's. */
export function recallChoice(videoId: string | undefined, path: string | undefined): Remembered | undefined {
  const store = read();
  const own = videoId ? store.videos[videoId] : undefined;
  const folder = folderOf(path);
  const shared = folder ? store.folders[folder] : undefined;
  if (!own && !shared) return undefined;
  return { ...shared, ...own };
}

/**
 * The track that best matches a remembered one: same language and title, then
 * same language (and forced-ness). Null when the file has nothing close —
 * better to keep mpv's pick than to guess.
 */
export function matchTrack(tracks: MpvTrack[], type: 'audio' | 'sub', want: TrackRef): number | null {
  // A forced track never stands in for a full one, or the other way round.
  const list = tracks.filter(t => t.type === type && (type === 'audio' || isForced(t) === !!want.forced));
  const lang = langKey(want.lang);
  const exact = list.find(t => langKey(t.lang) === lang && (t.title ?? '') === (want.title ?? ''));
  if (exact) return exact.id;
  const sameLang = list.filter(t => langKey(t.lang) === lang && !isExtra(t));
  if (sameLang.length && lang) return (type === 'audio' ? sameLang.reduce((a, b) => (audioRank(b) > audioRank(a) ? b : a)) : sameLang[0]).id;
  return null;
}

// ---------------------------------------------------------------------------
// Subtitle extras
// ---------------------------------------------------------------------------

/** The forced track for the audio being heard, or null when the file has none. */
export function forcedSubtitle(tracks: MpvTrack[], audioLang?: string): number | null {
  const forced = tracks.filter(t => t.type === 'sub' && isForced(t));
  if (!forced.length) return null;
  const lang = langKey(audioLang);
  return (forced.find(t => langKey(t.lang) === lang) ?? forced.find(t => !langKey(t.lang)) ?? (lang ? null : forced[0]))?.id ?? null;
}

export const isForcedTrack = (tracks: MpvTrack[], id: number | null) =>
  id !== null && tracks.some(t => t.type === 'sub' && t.id === id && isForced(t));

/** Picture subtitles (Blu-ray PGS, DVD VobSub): mpv can't draw these as the second line. */
const BITMAP = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub', 'pgssub', 'vobsub']);

/**
 * A full (not forced) subtitle in `lang`, other than `except`; null when there
 * is none. `textOnly` for the second line, which mpv can only draw from text.
 */
export function subtitleIn(tracks: MpvTrack[], lang: string, except: number | null = null, textOnly = false): number | null {
  const want = langKey(lang);
  const subs = tracks.filter(t => t.type === 'sub' && t.id !== except && !isForced(t) && langKey(t.lang) === want
    && !(textOnly && BITMAP.has((t.codec ?? '').toLowerCase())));
  return (subs.find(t => !t.hearingImpaired) ?? subs[0])?.id ?? null;
}

/** Subtitles to bring up for a moment after skipping back with them off. */
export function replaySubtitle(tracks: MpvTrack[], lang: string, last: number | null): number | null {
  const subs = tracks.filter(t => t.type === 'sub' && !isForced(t));
  if (last !== null && subs.some(t => t.id === last)) return last;
  return subtitleIn(tracks, lang) ?? subs.find(t => t.default)?.id ?? subs[0]?.id ?? null;
}
