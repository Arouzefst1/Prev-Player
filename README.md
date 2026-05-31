# PREV Player

A fast, lightweight desktop video player for Windows built with Tauri + React.  
Videos play **directly from their original location** — nothing is ever copied or duplicated.

---

## Download

**[Download latest release →](https://github.com/Arouzefst1/Prev-Player/releases/latest)**

> The installer is in the **Releases** section (right sidebar on GitHub), not inside the source code folders.  
> The source code is the code that builds the app — the actual installer (`.exe`) is attached to each release.

---

## Installation

1. Go to [Releases](https://github.com/Arouzefst1/Prev-Player/releases/latest)
2. Download `PREV Player_x.x.x_x64-setup.exe`
3. Run it and follow the installer
4. Done — video files (`.mp4`, `.mkv`, `.avi`, etc.) will automatically open in PREV Player when double-clicked

> **Windows SmartScreen warning?**  
> Click **"More info"** → **"Run anyway"**. This appears because the app isn't signed with a paid certificate yet. It contains no malware.

**Requires:** Windows 10 or Windows 11 (64-bit)  
WebView2 is bundled — no extra software needed.

---

## Features

- **Zero double storage** — library stores file paths only, not copies of your videos
- **Video library** — add videos and folders, with thumbnails and duration
- **Folder playlists** — import a folder; clicking any video loads the whole folder as a playlist
- **Drag-to-reorder** — reorder library and queue with Spotify-style drop indicators
- **File associations** — double-click any supported video file to open it directly
- **Single instance** — opening a file while the app is running adds it to the queue
- **Resume watching** — remembers where you left off for each video
- **Subtitles** — VTT and SRT support
- **Playback speed** — 0.25× to 2×
- **Keyboard shortcuts** — Space/K (play/pause), J/L (skip), F (fullscreen), M (mute), C (subtitles)
- **Picture-in-Picture** — native PiP with fullscreen restore on return
- **Queue panel** — drag-to-reorder the current playlist while playing
- **Auto-updater** — notified on launch when a new version is available

**Supported formats:** MP4, MKV, AVI, MOV, WMV, WebM, FLV, M4V, OGV, OGG, 3GP, 3G2, TS, MTS, M2TS, VOB, MPG, MPEG

---

## Building from source

**Prerequisites**
- [Node.js 20+](https://nodejs.org)
- [Rust + cargo](https://rustup.rs)
- [VS 2022 Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022) with the **Desktop development with C++** workload

```bash
# Clone the repo
git clone https://github.com/Arouzefst1/Prev-Player.git
cd Prev-Player

# Install JS dependencies
npm install

# Dev mode (hot-reload)
npm run dev

# Build installer
npm run build
# Output: src-tauri/target/release/bundle/nsis/PREV Player_x.x.x_x64-setup.exe
```

> `src-tauri/target/` is excluded from git (it's multi-GB compiled output).  
> Run `npm run build` to generate it locally.

---

## Publishing a new release

1. Bump `version` in `src-tauri/tauri.conf.json` (e.g. `"1.0.1"`)
2. Run `npm run build`
3. Create a GitHub release with tag `v1.0.1` and attach the new setup.exe
4. All installed copies will show the update dialog on their next launch

---

## Tech stack

| Layer | Technology |
|---|---|
| UI | React 19 + TypeScript + Tailwind CSS |
| Desktop shell | Tauri v2 (Rust + Windows WebView2) |
| Drag-and-drop | @dnd-kit/sortable |
| Local storage | IndexedDB (metadata only) + localStorage |
| Icons | Lucide React |
