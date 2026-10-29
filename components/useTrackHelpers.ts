import { useCallback, useEffect, useRef } from 'react';
import { useSettings, settingsStore } from '../settings';
import {
  mpvSetAudioTrack, mpvSetSubtitleTrack, mpvSetSecondarySubtitle, mpvSetSubtitleVisible,
  type MpvState, type MpvTrack,
} from '../mpv';
import {
  preferredLanguage, smartAudioPick, recallChoice, rememberChoice, matchTrack, refOf,
  forcedSubtitle, isForcedTrack, subtitleIn, replaySubtitle,
} from '../tracks';

// ---------------------------------------------------------------------------
// The opt-in track helpers (Settings › Audio & subtitles), applied to the
// player. Each does nothing unless its setting is on:
//
//  - when a file's tracks arrive: the remembered choice, else smart audio,
//    then forced subtitles if subtitles ended up off;
//  - a second subtitle line follows the first;
//  - skipping back with subtitles off shows them until playback is back where
//    it was, then puts things back as they were.
// ---------------------------------------------------------------------------

interface Options {
  videoId?: string;
  path?: string;
  /** Bumped by the player for every file it opens. */
  loadGen: number;
  tracks: MpvTrack[];
  audioId: number | null;
  subId: number | null;
  secondarySubId: number | null;
  subtitlesEnabled: boolean;
  /** Latest mpv state, for the callbacks (they run outside React renders). */
  mpvStateRef: React.MutableRefObject<MpvState>;
}

export function useTrackHelpers({
  videoId, path, loadGen, tracks, audioId, subId, secondarySubId, subtitlesEnabled, mpvStateRef,
}: Options) {
  const [settings] = useSettings();
  const appliedFor = useRef<number | null>(null);
  /**
   * A skip-back replay in progress. `armed` once playback is seen behind
   * `until` — right after the skip, mpv can still report the old position.
   */
  const replay = useRef<{ until: number; sid: number | null; visible: boolean; armed: boolean } | null>(null);
  /** The last full subtitle the user had on — what skip-back brings up. */
  const lastFull = useRef<number | null>(null);
  const subtitlesEnabledRef = useRef(subtitlesEnabled);
  subtitlesEnabledRef.current = subtitlesEnabled;
  const where = useRef({ videoId, path });
  where.current = { videoId, path };

  // A new file's tracks: restore, pick, or leave mpv's choice.
  useEffect(() => {
    if (!tracks.length || appliedFor.current === loadGen) return;
    appliedFor.current = loadGen;
    replay.current = null;
    const s = settingsStore.get();
    const lang = preferredLanguage(s.preferredLanguage);
    const memory = s.rememberTracks ? recallChoice(videoId, path) : undefined;
    // `selected` in the track list is mpv's own pick; aid/sid may not have arrived yet.
    const mpvAid = tracks.find(t => t.type === 'audio' && t.selected)?.id ?? null;
    const mpvSid = tracks.find(t => t.type === 'sub' && t.selected)?.id ?? null;

    let aid = memory?.audio ? matchTrack(tracks, 'audio', memory.audio) : null;
    if (aid === null && s.smartAudio) aid = smartAudioPick(tracks, lang);
    if (aid !== null && aid !== mpvAid) mpvSetAudioTrack(aid).catch(() => {});

    let sid: number | null | undefined; // undefined → leave mpv's
    if (memory?.sub === 'off') sid = null;
    else if (memory?.sub) sid = matchTrack(tracks, 'sub', memory.sub) ?? undefined;
    if (s.forcedSubtitles && (sid === undefined ? mpvSid : sid) === null) {
      const heard = tracks.find(t => t.type === 'audio' && t.id === (aid ?? mpvAid))?.lang;
      const forced = forcedSubtitle(tracks, heard);
      if (forced !== null) sid = forced;
    }
    if (sid !== undefined && sid !== mpvSid) mpvSetSubtitleTrack(sid).catch(() => {});
  }, [tracks, loadGen, videoId, path]);

  // Switching audio language keeps the forced track in step with what's heard.
  useEffect(() => {
    if (!settings.forcedSubtitles || audioId === null || appliedFor.current !== loadGen) return;
    if (subId !== null && !isForcedTrack(tracks, subId)) return; // real subtitles are on
    const heard = tracks.find(t => t.type === 'audio' && t.id === audioId)?.lang;
    const forced = forcedSubtitle(tracks, heard);
    if (forced !== null && forced !== subId) mpvSetSubtitleTrack(forced).catch(() => {});
    // Only on an audio change — a subtitle change is the user's own say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioId, settings.forcedSubtitles]);

  // The second subtitle line follows the first.
  useEffect(() => {
    const lang = settings.secondSubtitleLanguage;
    const want = lang && subId !== null && !isForcedTrack(tracks, subId) ? subtitleIn(tracks, lang, subId, true) : null;
    if (want !== secondarySubId && (want !== null || secondarySubId !== null)) {
      mpvSetSecondarySubtitle(want).catch(() => {});
    }
  }, [settings.secondSubtitleLanguage, subId, secondarySubId, tracks]);

  useEffect(() => {
    if (subId !== null && !isForcedTrack(tracks, subId)) lastFull.current = subId;
  }, [subId, tracks]);

  /** The user picked an audio track by hand. */
  const pickedAudio = useCallback((t: MpvTrack) => {
    replay.current = null;
    if (settingsStore.get().rememberTracks) rememberChoice(where.current.videoId, where.current.path, { audio: refOf(t) });
  }, []);

  /** The user picked a subtitle track (or Off, as null) by hand. */
  const pickedSubtitle = useCallback((t: MpvTrack | null) => {
    replay.current = null;
    if (settingsStore.get().rememberTracks) rememberChoice(where.current.videoId, where.current.path, { sub: t ? refOf(t) : 'off' });
  }, []);

  /** "Off" in the subtitle menu: forced lines stay when that's turned on. */
  const offTrack = useCallback((): number | null => {
    const st = mpvStateRef.current;
    if (!settingsStore.get().forcedSubtitles) return null;
    const heard = st.tracks.find(t => t.type === 'audio' && t.id === st.audioId)?.lang;
    return forcedSubtitle(st.tracks, heard);
  }, [mpvStateRef]);

  /** After a skip back from `from` seconds. */
  const skippedBack = useCallback((from: number) => {
    const s = settingsStore.get();
    if (!s.subtitlesOnSkipBack) return;
    if (replay.current) { replay.current.until = Math.max(replay.current.until, from); return; }
    const st = mpvStateRef.current;
    const showing = st.subId !== null && !isForcedTrack(st.tracks, st.subId) && subtitlesEnabledRef.current;
    if (showing) return;
    const id = replaySubtitle(st.tracks, preferredLanguage(s.preferredLanguage), lastFull.current);
    if (id === null) return;
    replay.current = { until: from, sid: st.subId, visible: subtitlesEnabledRef.current, armed: false };
    mpvSetSubtitleTrack(id).catch(() => {});
    mpvSetSubtitleVisible(true).catch(() => {});
  }, [mpvStateRef]);

  /** Every playback tick: end a skip-back replay once we're back where we were. */
  const tick = useCallback((time: number) => {
    const r = replay.current;
    if (!r) return;
    if (time < r.until - 0.25) { r.armed = true; return; }
    if (!r.armed) return;
    replay.current = null;
    mpvSetSubtitleTrack(r.sid).catch(() => {});
    mpvSetSubtitleVisible(r.visible).catch(() => {});
  }, []);

  return { pickedAudio, pickedSubtitle, offTrack, skippedBack, tick };
}
