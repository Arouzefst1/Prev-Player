import React, { useState, useEffect } from 'react';
import {
  X, Settings as SettingsIcon, FolderOpen, RotateCcw,
  SlidersHorizontal, Play, PictureInPicture2, Download, RefreshCw, Tv, Check, Minus, Keyboard, Languages,
} from 'lucide-react';
import { AppSettings } from '../settings';
import * as engine from '../engine';
import { mpvCapabilities } from '../mpv';
import { capabilitiesFrom, type DisplayHdr } from '../media';
import { currentDisplayHdr } from '../display';
import ShortcutsEditor from './ShortcutsEditor';
import { LANGUAGE_CODES, languageName, preferredLanguage } from '../tracks';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  /** Running version, shown next to the manual update check. */
  appVersion?: string;
  /** Result of the last manual check, for the button's label. */
  updateState?: 'idle' | 'checking' | 'uptodate' | 'error';
  /** Run a check now. Omitted → the row is hidden (e.g. plain browser). */
  onCheckUpdates?: () => void;
}

type SectionId = 'general' | 'playback' | 'av' | 'tracks' | 'keys' | 'pip' | 'downloads';

const SECTION_ORDER: SectionId[] = ['general', 'playback', 'av', 'tracks', 'keys', 'pip', 'downloads'];

const SECTION_META: Record<SectionId, { title: string; desc: string; Icon: React.ElementType }> = {
  general:   { title: 'General',            desc: 'Library layout and what happens when you add videos', Icon: SlidersHorizontal },
  playback:  { title: 'Playback',           desc: 'How videos start, resume, and move through a queue',  Icon: Play },
  av:        { title: 'Picture & sound',    desc: 'HDR, Dolby Vision, Dolby Atmos and DTS:X',            Icon: Tv },
  tracks:    { title: 'Audio & subtitles',  desc: 'Pick and remember tracks, forced and second subtitles', Icon: Languages },
  keys:      { title: 'Keyboard shortcuts', desc: 'Change the keys that control the player',             Icon: Keyboard },
  pip:       { title: 'Picture-in-Picture', desc: 'Behaviour and geometry of the floating mini player',  Icon: PictureInPicture2 },
  downloads: { title: 'Downloads & updates', desc: 'Where files land and when to look for new versions', Icon: Download },
};

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

/**
 * The expand affordance: a plus whose vertical stroke collapses into a minus as
 * the section opens, with the whole glyph rotating a quarter turn so the change
 * reads as one motion rather than an icon swap.
 */
const PlusMinus: React.FC<{ open: boolean }> = ({ open }) => (
  <svg
    width="16" height="16" viewBox="0 0 16 16"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    className={`transition-transform duration-300 ease-out ${open ? 'rotate-90' : 'rotate-0'}`}
  >
    <line x1="3" y1="8" x2="13" y2="8" />
    <line
      x1="8" y1="3" x2="8" y2="13"
      className="transition-transform duration-300 ease-out origin-center"
      style={{ transform: open ? 'scaleY(0)' : 'scaleY(1)' }}
    />
  </svg>
);

/** Collapsible card. Height animates via the 0fr→1fr grid trick — no fixed max-height to guess. */
const Section: React.FC<{
  id: SectionId;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ id, open, onToggle, children }) => {
  const { title, desc, Icon } = SECTION_META[id];
  return (
    <div className={`rounded-xl border transition-colors duration-200 ${open ? 'border-neutral-700 bg-neutral-900/40' : 'border-neutral-800 hover:border-neutral-700'}`}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-3.5 py-3 text-left group"
      >
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors ${open ? 'bg-red-600/15 text-red-400' : 'bg-neutral-800 text-neutral-400 group-hover:text-neutral-200'}`}>
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="text-xs text-neutral-500 mt-0.5 leading-snug truncate">{desc}</div>
        </div>
        <span className={`flex-shrink-0 transition-colors ${open ? 'text-red-400' : 'text-neutral-500 group-hover:text-neutral-300'}`}>
          <PlusMinus open={open} />
        </span>
      </button>

      <div className={`grid transition-all duration-300 ease-out ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
        <div className="overflow-hidden">
          <div className="px-3.5 pb-1 pt-0 border-t border-neutral-800/70 divide-y divide-neutral-800/60">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};

const SettingsModal: React.FC<SettingsModalProps> = ({
  open, onClose, settings, onChange, appVersion, updateState = 'idle', onCheckUpdates,
}) => {
  // Everything starts collapsed so the modal opens as a clean list of topics.
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>({
    general: false, playback: false, av: false, tracks: false, keys: false, pip: false, downloads: false,
  });

  // Picture & sound: the screen's HDR state (asked of Windows) and what the
  // bundled mpv can decode (recorded the last time it ran).
  const [display, setDisplay] = useState<DisplayHdr | null>(null);
  useEffect(() => { if (open) currentDisplayHdr().then(setDisplay); }, [open]);
  const caps = open ? mpvCapabilities() : null;

  // Engine tuning lives in the backend, not in AppSettings: it has to be read
  // before the first window exists, and a running stream can't be re-sized.
  const [tuning, setTuning] = useState<engine.Tuning | null>(null);
  const [tuningDirty, setTuningDirty] = useState(false);
  useEffect(() => {
    if (open) engine.getTuning().then(setTuning).catch(() => {});
  }, [open]);
  const changeTuning = (patch: Partial<engine.Tuning>) => {
    if (!tuning) return;
    const next = { ...tuning, ...patch };
    setTuning(next);
    setTuningDirty(true);
    engine.setTuning(next).catch(() => {});
  };

  if (!open) return null;

  const allOpen = SECTION_ORDER.every(id => openSections[id]);
  const toggleAll = () => {
    const next = !allOpen;
    setOpenSections({ general: next, playback: next, av: next, tracks: next, keys: next, pip: next, downloads: next });
  };
  const toggle = (id: SectionId) => setOpenSections(s => ({ ...s, [id]: !s[id] }));

  // Pick a folder for downloaded/received videos.
  const chooseDownloadFolder = async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const dir = await openDialog({ directory: true, multiple: false, title: 'Choose download folder' });
      if (dir && typeof dir === 'string') onChange({ downloadPath: dir });
    } catch {}
  };

  const downloadLabel = settings.downloadPath || 'Downloads / PREV Player (default)';
  const languageOptions = LANGUAGE_CODES.map(c => [c, languageName(c)] as const).sort((a, b) => a[1].localeCompare(b[1]));

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

        {/* expand-all bar */}
        <div className="flex items-center justify-between px-5 py-2.5 border-b border-neutral-800/70">
          <span className="text-[11px] font-semibold text-neutral-500 uppercase tracking-[0.15em]">
            {SECTION_ORDER.length} categories
          </span>
          <button
            onClick={toggleAll}
            className="flex items-center gap-1.5 text-xs font-medium text-neutral-300 hover:text-white bg-neutral-800/80 hover:bg-neutral-700 rounded-lg px-2.5 py-1.5 transition-colors active:scale-95"
          >
            <PlusMinus open={allOpen} />
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        </div>

        {/* body */}
        <div className="p-4 overflow-auto custom-scrollbar flex flex-col gap-2.5">
          {/* General */}
          <Section id="general" open={openSections.general} onToggle={() => toggle('general')}>
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
          </Section>

          {/* Playback */}
          <Section id="playback" open={openSections.playback} onToggle={() => toggle('playback')}>
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
            <Row title={`Speed step — ${settings.speedStep}×`} desc="How much the > / < keys and the speed panel's +/− buttons change speed.">
              <select
                value={settings.speedStep}
                onChange={(e) => onChange({ speedStep: parseFloat(e.target.value) })}
                className="bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                {[0.05, 0.1, 0.25, 0.5, 1].map(s => (
                  <option key={s} value={s}>{s}×</option>
                ))}
              </select>
            </Row>
            <Row
              title="Blu-ray & DVD"
              desc="Open Blu-ray and DVD ISO images and BDMV / VIDEO_TS folders as discs: the main feature plays with its chapters and every audio and subtitle track, and other titles are in the right-click menu. Copy-protected discs have to be decrypted first."
            >
              <Toggle checked={settings.discPlayback} onChange={(v) => onChange({ discPlayback: v })} />
            </Row>
            <Row
              title={`Stats for nerds — ${Math.round((1 - settings.statsOpacity) * 100)}% see-through`}
              desc="How much of the video shows through the stats panel (player settings › Stats for nerds)."
            >
              <div className="flex items-center gap-2">
                {/* What the panel will look like over a picture. */}
                <span className="relative w-9 h-6 rounded-md overflow-hidden border border-neutral-700 bg-[linear-gradient(135deg,#ef4444,#f59e0b_45%,#3b82f6)]">
                  <span className="absolute inset-1 rounded-sm" style={{ background: `rgba(8,8,10,${settings.statsOpacity})` }} />
                </span>
                <input
                  type="range" min={0} max={0.85} step={0.05} value={+(1 - settings.statsOpacity).toFixed(2)}
                  onChange={(e) => onChange({ statsOpacity: +(1 - parseFloat(e.target.value)).toFixed(2) })}
                  className="w-24 accent-red-600 cursor-pointer"
                  aria-label="Stats for nerds transparency"
                />
              </div>
            </Row>
          </Section>

          {/* Picture & sound */}
          <Section id="av" open={openSections.av} onToggle={() => toggle('av')}>
            <Row
              title="HDR"
              desc={display?.enabled
                ? 'This screen is in HDR — HDR10, HDR10+, HLG and Dolby Vision play in HDR.'
                : display?.supported
                  ? 'This screen supports HDR but it’s off, so HDR video is converted to SDR. Turn on “Use HDR” in Windows Settings › System › Display.'
                  : display
                    ? 'This screen is SDR. HDR10, HDR10+, HLG and Dolby Vision are tone-mapped to look right on it.'
                    : 'HDR10, HDR10+, HLG and Dolby Vision play in HDR on an HDR screen, and are tone-mapped on others.'}
            >
              {display && (
                <span className={`text-[11px] font-semibold px-2 py-1 rounded-md border ${display.enabled
                  ? 'text-amber-200 border-amber-300/40 bg-amber-400/10'
                  : 'text-neutral-300 border-neutral-700 bg-neutral-800/60'}`}
                >
                  {display.enabled ? 'HDR on' : display.supported ? 'HDR off' : 'SDR screen'}
                </span>
              )}
            </Row>
            <Row
              title="Switch to HDR for HDR videos"
              desc={display && !display.supported
                ? 'This screen can’t show HDR, so there’s nothing to switch.'
                : 'Turns on Windows HDR for this screen while an HDR10, HDR10+, HLG or Dolby Vision video plays, and back off afterwards. If HDR is already on, it’s left alone.'}
            >
              <Toggle checked={settings.autoHdr} onChange={(v) => onChange({ autoHdr: v })} />
            </Row>
            <Row
              title="Match the refresh rate"
              desc="Switches the screen to a rate the video’s frame rate divides evenly — 23.976 fps films on 23.976 Hz (or 120 Hz), 25 fps on 50 Hz — so motion doesn’t judder. Your usual rate comes back when you close the player."
            >
              <Toggle checked={settings.matchRefreshRate} onChange={(v) => onChange({ matchRefreshRate: v })} />
            </Row>
            <Row
              title="Send Dolby Atmos & DTS:X to my receiver"
              desc="For an AV receiver or soundbar on HDMI or optical: Dolby Digital, Dolby Digital Plus, TrueHD and DTS (incl. DTS-HD MA) go out untouched, so it can play Atmos and DTS:X. Leave off for speakers or headphones on this PC — they’d get silence. Volume is set on the receiver while it’s on."
            >
              <Toggle checked={settings.audioPassthrough} onChange={(v) => onChange({ audioPassthrough: v })} />
            </Row>
            <div className="py-3">
              <div className="text-sm font-medium text-white">Formats this player decodes</div>
              {caps ? (
                <>
                  <div className="text-xs text-neutral-500 mt-0.5 leading-snug">
                    {[caps.mpv, caps.ffmpeg && `FFmpeg ${caps.ffmpeg}`].filter(Boolean).join(' · ')}
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {capabilitiesFrom(caps.decoders).map(c => (
                      <span
                        key={c.label}
                        title={c.ok ? undefined : 'Not in the bundled mpv — a newer mpv.exe adds it'}
                        className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border ${c.ok
                          ? 'text-neutral-200 border-neutral-700 bg-neutral-800/60'
                          : 'text-neutral-500 border-neutral-800 bg-transparent line-through decoration-neutral-600'}`}
                      >
                        {c.ok ? <Check size={11} className="text-green-400" /> : <Minus size={11} />}
                        {c.label}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-xs text-neutral-500 mt-0.5 leading-snug">Play any video once and this fills in.</div>
              )}
            </div>
          </Section>

          {/* Audio & subtitles — all opt-in */}
          <Section id="tracks" open={openSections.tracks} onToggle={() => toggle('tracks')}>
            <Row title="Language" desc="For smart audio, forced subtitles and subtitles on skip-back.">
              <select
                value={settings.preferredLanguage}
                onChange={(e) => onChange({ preferredLanguage: e.target.value })}
                className="max-w-[150px] bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                <option value="">Same as Windows ({languageName(preferredLanguage(''))})</option>
                {languageOptions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </Row>
            <Row title="Smart audio track" desc="Start on the best audio in your language — lossless and Dolby Atmos / DTS:X first, surround over stereo — and never on a commentary track.">
              <Toggle checked={settings.smartAudio} onChange={(v) => onChange({ smartAudio: v })} />
            </Row>
            <Row title="Remember my picks" desc="The audio and subtitles you choose come back next time, and carry over to the other videos in the same folder — like the next episode.">
              <Toggle checked={settings.rememberTracks} onChange={(v) => onChange({ rememberTracks: v })} />
            </Row>
            <Row title="Forced subtitles" desc="Show signs and foreign-language lines even with subtitles off, in the language you're hearing.">
              <Toggle checked={settings.forcedSubtitles} onChange={(v) => onChange({ forcedSubtitles: v })} />
            </Row>
            <Row title="Second subtitle" desc="A second line in another language above the main subtitles — handy for learning one. Text subtitles only.">
              <select
                value={settings.secondSubtitleLanguage}
                onChange={(e) => onChange({ secondSubtitleLanguage: e.target.value })}
                className="max-w-[150px] bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
              >
                <option value="">Off</option>
                {languageOptions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </Row>
            <Row title="Subtitles when skipping back" desc="Missed a line? Skip back with subtitles off and they show until you're past where you were.">
              <Toggle checked={settings.subtitlesOnSkipBack} onChange={(v) => onChange({ subtitlesOnSkipBack: v })} />
            </Row>
          </Section>

          {/* Keyboard shortcuts */}
          <Section id="keys" open={openSections.keys} onToggle={() => toggle('keys')}>
            <ShortcutsEditor settings={settings} onChange={onChange} />
          </Section>

          {/* Picture-in-Picture */}
          <Section id="pip" open={openSections.pip} onToggle={() => toggle('pip')}>
            <Row title="Keep the queue playing" desc="When the mini player is open, roll on to the next video in the queue. Turn off to stop on the last frame instead.">
              <Toggle checked={settings.pipAutoplayQueue} onChange={(v) => onChange({ pipAutoplayQueue: v })} />
            </Row>
            <Row title="Scroll to change volume" desc="Let the mouse wheel change volume in the mini player. Off by default — it floats over other windows, so a scroll aimed past it would move the volume. (At full size the wheel always works.)">
              <Toggle checked={settings.pipScrollVolume} onChange={(v) => onChange({ pipScrollVolume: v })} />
            </Row>
          </Section>

          {/* Downloads & updates */}
          <Section id="downloads" open={openSections.downloads} onToggle={() => toggle('downloads')}>
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
            {tuning && (
              <>
                <Row
                  title="Streaming buffer"
                  desc="RAM held for a video you're watching online. Bigger absorbs a rougher connection and makes seeking backwards instant; smaller leaves more memory to everything else."
                >
                  <select
                    value={tuning.streamCacheMb}
                    onChange={(e) => changeTuning({ streamCacheMb: parseInt(e.target.value, 10) })}
                    className="bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
                  >
                    {[50, 100, 256, 500, 1024].map(mb => (
                      <option key={mb} value={mb}>{mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}</option>
                    ))}
                  </select>
                </Row>
                <Row
                  title="Download connections"
                  desc="How many parts of a file are fetched at once. Automatic scales with your CPU; fewer is gentler on a slow or metered link."
                >
                  <select
                    value={tuning.downloadWorkers}
                    onChange={(e) => changeTuning({ downloadWorkers: parseInt(e.target.value, 10) })}
                    className="bg-neutral-800 text-white text-xs rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-red-500 cursor-pointer"
                  >
                    <option value={0}>Automatic</option>
                    {[1, 2, 4, 8, 16].map(w => <option key={w} value={w}>{w}</option>)}
                  </select>
                </Row>
                {tuningDirty && (
                  <p className="pb-3 -mt-1 text-[11px] text-neutral-500">
                    Takes effect the next time you open PREV Player — transfers already running keep the settings they started with.
                  </p>
                )}
              </>
            )}
            <Row title="Check for updates on launch" desc="Look for a newer version automatically a few seconds after startup.">
              <Toggle checked={settings.autoCheckUpdates} onChange={(v) => onChange({ autoCheckUpdates: v })} />
            </Row>
            {/* A check you can run right now — the launch one is invisible by nature,
                and the home-screen button is out of reach while a video is open. */}
            {onCheckUpdates && (
              <Row
                title="Check now"
                desc={appVersion ? `You're running version ${appVersion}.` : 'Ask GitHub for the latest release.'}
              >
                <button
                  onClick={onCheckUpdates}
                  disabled={updateState === 'checking'}
                  className="flex items-center gap-1.5 text-xs font-medium text-neutral-200 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-60 rounded-lg px-2.5 py-1.5 transition-colors active:scale-95"
                >
                  <RefreshCw size={13} className={updateState === 'checking' ? 'animate-spin' : ''} />
                  {updateState === 'checking'
                    ? 'Checking…'
                    : updateState === 'uptodate'
                      ? 'Up to date'
                      : updateState === 'error'
                        ? 'Failed — retry'
                        : 'Check'}
                </button>
              </Row>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
