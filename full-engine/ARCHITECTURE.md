# PREV Player — Native Engine (full-engine)

A fork of the WebView2-based PREV Player that swaps the **decoding engine** from the
HTML `<video>` element to **mpv** (libmpv-class), so it plays *everything*: MKV, AVI,
WMV, FLV, HEVC/H.265, **Dolby Vision/Atmos**, **HDR10** — on the GPU.

**The entire UI, style, fonts, layout, and features stay identical to the original.**
Only the invisible "player core" changes: instead of driving a `<video>` element, the
React controls send commands to mpv.

---

## Chosen approach

Use the community plugin **[`tauri-plugin-mpv`](https://github.com/nini22P/tauri-plugin-mpv)**
(nini22P). Windows is ✅ fully tested. It embeds a real **mpv process** into the Tauri
window via `--wid` (the hard native window-embedding part is solved for us) and exposes a
JSON-IPC control API.

Why this over `tauri-plugin-libmpv`: that one's window embedding is "experimental / not
working" per its README. The process+wid approach is the proven one on Windows.

### How rendering works
- The Tauri window is set **`transparent: true`**; `html, body { background: transparent }`.
- mpv renders the video **behind** the transparent WebView, filling the window.
- Our React UI (control bar, library, overlays, home screen) renders **on top**, unchanged.
- A click on the "video area" is just a transparent React layer → calls `cycle pause`.

### JS API (from the plugin)
```ts
import { init, command, setProperty, getProperty, observeProperties, destroy } from 'tauri-plugin-mpv-api'
await init(mpvConfig)
await command('loadfile', [path])
await command('seek', [10, 'relative'])
await setProperty('volume', 75)        // 0..100 (mpv scale)
await setProperty('speed', 1.5)
await setProperty('pause', true)
const t = await getProperty('time-pos')
const un = await observeProperties(['pause','time-pos','duration','filename','volume','speed','eof-reached'], ({name,data}) => {...})
```

### mpv config we use
```ts
const mpvConfig = {
  args: ['--vo=gpu-next', '--hwdec=auto-safe', '--keep-open=yes', '--force-window=yes',
         '--target-colorspace-hint=yes' /* HDR passthrough */],
  observedProperties: ['pause','time-pos','duration','filename','volume','speed','eof-reached','track-list'],
  ipcTimeoutMs: 2000,
  // mpvPath: points at the bundled mpv.exe (see "Bundling mpv")
}
```

---

## Property/command mapping (old `<video>` → mpv)

| Feature | `<video>` (old) | mpv (new) |
|---|---|---|
| load | `video.src = url` | `command('loadfile', [path])` |
| play/pause | `video.play()/pause()` | `setProperty('pause', false/true)` |
| current time | `video.currentTime` | observe `time-pos` / `setProperty('time-pos', t)` |
| duration | `video.duration` | observe `duration` |
| seek | `video.currentTime = t` | `command('seek',[t,'absolute'])` |
| volume (0..1) | `video.volume` | `setProperty('volume', v*100)` |
| mute | `video.muted` | `setProperty('mute', bool)` |
| speed | `video.playbackRate` | `setProperty('speed', r)` |
| ended | `'ended'` event | observe `eof-reached`==true |
| subtitles | `<track>` | `command('sub-add', [path])` / `sub-visibility` |
| loop | `video.loop` | `setProperty('loop-file','inf')` |

> Note: mpv takes **native file paths**, NOT `convertFileSrc` asset URLs. The library
> already stores native paths (`StoredVideo.path`) — pass those straight to `loadfile`.

---

## Bundling mpv (Windows)
- mpv shared build (libmpv + mpv.exe) from zhongfly's builds (same source the plugins use).
- Place `mpv.exe` (or libmpv) under `src-tauri/binaries/` (or `resources/`), add to
  `tauri.conf.json > bundle.resources`, and point `mpvConfig.mpvPath` at the resolved
  resource path at runtime.
- Installer size grows from ~3.4 MB to ~50–70 MB (expected — that's the codecs).

---

## Features to rebuild (browser-only today)
1. **PiP** — browser PiP won't work with mpv. Re-implement as a small **always-on-top
   borderless Tauri mini-window** that hosts mpv (or moves the mpv wid into it). UX same.
2. **Library thumbnails** — currently `<video>`+canvas. Generate via
   `mpv --vo=image` / a one-shot ffmpeg call, or `mpv screenshot-to-file`.
3. **Codec-support error card** — replace with mpv error reporting (mpv plays ~everything,
   so this mostly goes away; keep a generic error path).

## Features that carry over UNCHANGED (React only)
Home screen, library, folders, drag-reorder queue, playlist nav, keyboard shortcuts,
resume (`saveVideoProgress`/`loadVideoProgress` in utils.ts), Start-over button, speed
overlay, action overlays, settings menu, update modal UI. They just call the mpv bridge.

---

## Phases
- **Phase 0 (spike):** plugin added, transparent window, mpv plays ONE file inside the
  window with the control bar on top. ← prove it on the user's machine.
- **Phase 1:** full VideoPlayer core conversion (all controls → mpv, property observation).
- **Phase 2:** subtitles, loop, audio poster, resume wiring through mpv.
- **Phase 3:** PiP mini-window + thumbnails.
- **Phase 4:** bundle mpv into installer, signing/updater, release as a separate product
  (`com.prev-player.engine`, productName "PREV Player Engine") so it doesn't collide with
  the original install.

## Build / run
```
cd full-engine
npm install
npm run tauri add mpv      # adds plugin (or add deps manually — see package.json/Cargo.toml)
npm run dev                # tauri dev
```
mpv.exe must be on PATH (dev) or bundled (release).

## Status
See the session todo list. Start at Phase 0.
