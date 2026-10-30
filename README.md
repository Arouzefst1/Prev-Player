# PREV Player — mpv front end, engine back end

This folder is the two halves of the project joined up: the mpv-based player from
`full-engine/`, with every byte that moves between devices handled by the chunk
engine from `prev-engine/`.

Both source folders are left untouched. This one is a copy of what each needed —
the app's own source and the six engine crates — plus the wiring between them.

```
prev-player/
  App.tsx, components/, mpv.ts, pip.ts, utils.ts, settings.ts   the player
  engine.ts                    the bridge: every engine_* command, one event feed
  share.ts                     GitHub accounts/uploads, and link ⇄ engine link
  engine/crates/               prev-core · transport · share · download · stream · engine
  src-tauri/src/engine.rs      the engine as Tauri state + a thin command layer
  src-tauri/src/share.rs       what the engine has no opinion about: GitHub REST
  src-tauri/src/lib.rs         plugins, commands, startup, shutdown
```

## What changed against `full-engine/`

| Before | Now |
|---|---|
| `share.rs::download_file` — one stream, append-only, resumes by file length | `Engine::download` — N workers, chunk map, verified, resumes by chunk |
| `share.rs::download_control` | `Engine::pause` / `resume` / `cancel` |
| `lan.rs` — whole file, ids from nanotime, **no `Content-Length` over 32 KB so receivers couldn't seek** | `Engine::share_file` / `share_folder` — hash-derived ids, lazy digests, ranges that work |
| *(nothing)* | `Engine::watch` — watch online against a bounded RAM buffer |
| *(nothing)* | `Engine::save_stream` — keep what you're watching, out of the buffer |
| downloads vanished on quit | the chunk map is on disk; they come back resumable |

`lan.rs` is gone entirely. `share.rs` kept only the GitHub REST passthrough and
the streaming asset upload — a release asset URL is a range-serving HTTP source
like any other, so the engine downloads and streams it directly.

## How a share flows

Everything reduces to **one engine link**, and after that there is only one path:

- **Local Wi-Fi** — `engine.shareFile()` mints the link; `share.ts` wraps it in a
  `prevplayer://` URL so the OS hands clicks back to the app.
- **GitHub** — `share.ts` uploads the assets and looks the release up (that part
  needs a token and the REST API), then `engine_http_link` turns the asset list
  into an engine link. The wire format stays in Rust.
- **Pasted `prev://` or bare `https://`** — passes straight through.

Then: `engine.resolve(link)` → what's in it, `engine.watch(link, i)` → a local
seekable URL for mpv, `engine.download(link, indices, dir)` → transfers.

A Local Wi-Fi link carries **every** LAN address the sender has (a VPN, WSL or
Hyper-V adapter, or a second network card can each own the "obvious" one), and
the receiver asks all of them at once and uses whichever serves the share. When
none answers, the usual cause is Windows Firewall on the sender — Windows marks
home Wi-Fi as *Public* and blocks incoming connections there — which the
**Allow through firewall** button in the sender's Share window fixes with one
UAC prompt.

A folder share you are watching online opens one stream at a time — the session
for an item is created when you reach it and freed when you leave, because
opening all of them up front would mean one prefetching buffer per file.

## Settings

Under *Downloads & updates*: **streaming buffer** (50 MB – 1 GB, default 256 MB)
and **download connections** (default: from the CPU count). They live in Rust —
`%APPDATA%/com.prev-player.app/engine.json` — because they are read before the
first window exists, and a live stream can't be re-sized. Both apply on the next
launch, which the panel says.

## Running it

```bash
npm install
npm run dev      # vite + tauri
npm run build    # installer → src-tauri/target/release/bundle/nsis/
```

**mpv is not in this repo.** The app bundles `mpv.exe` (~115 MB) plus
`d3dcompiler_43.dll` at `src-tauri/resources/mpv/`, declared in
`bundle.resources` and resolved at runtime via `resolveResource`. That directory
is gitignored because of its size — drop a Windows mpv build there before
packaging. In development the app falls back to whatever `mpv` is on `PATH`, so
`npm run dev` works without it.

Verify the engine on its own:

```bash
cd engine && cargo test --workspace     # 110 tests
```

## Releasing

Releases go out by themselves. Bump the version in **three** files —
`package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` — and
add a section for it at the top of [RELEASE_NOTES.md](RELEASE_NOTES.md):

```md
## 1.6.2 — one line on what changed

What's new, for the release page.
```

When that lands on `main`, the **Release** workflow (`.github/workflows/release.yml`)
builds the installer on a Windows runner, bundles the same mpv the last release
shipped, signs it for the updater, checks the signature is the key installed
apps trust (and refuses to go on with any other), and publishes the installer,
its `.sig` and `latest.json` as the latest release, tagged `v<version>`. A push
that doesn't change the version does nothing. Every pull request gets a test
build instead: the same build, nothing published, with the installer attached
to the run to try out. Run the workflow by hand from the Actions tab to retry a
release or to announce one (see below).

It needs one repository secret, set once: **`TAURI_SIGNING_PRIVATE_KEY`**, the
text of `src-tauri/prev-player-updater.key` (Settings → Secrets and variables →
Actions → New repository secret).

### By hand

With the signing key at `src-tauri/prev-player-updater.key` (git-ignored, never
committed):

```bash
npm run release              # notes from RELEASE_NOTES.md
npm run release -- "What changed, in one line"
```

That does the same build, signing and checks, writes `latest.json` marked
`"silent": true`, and prints a link to a pre-filled GitHub release form. Publish
the installer, its `.sig` and `latest.json` on a release tagged `v<version>`,
marked **latest** (not a draft or pre-release — the updater only reads
`releases/latest`).

It never asks for a password: the key's password is empty, and PowerShell can't
hold an empty environment variable, so the build runs without the key and the
installer is signed right after. A key kept elsewhere can be given as
`TAURI_SIGNING_PRIVATE_KEY` (its text or path), with
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if it has a password.

### Silent or announced

A silent release reaches every install on 1.5.2 or newer without anyone doing
anything: it downloads in the background, installs when the user closes the
app, and the next launch is the new version. Announce it (`--announce`, or tick
*Announce* when running the workflow by hand) to leave the flag off: a minor or
major bump then shows a "ready, installs when you close the app" toast with a
*Restart now* button (a patch bump stays quiet either way). Installs older than
1.5.2 apply it the way their own build does (1.3.2–1.5.1: installs and relaunches
at launch; 1.3.1 and earlier: a dialog).

The **private signing key is never committed** — `.gitignore` blocks every
`*.key` and `*.key.pub`, so it can sit in `src-tauri/` on the release PC. Only
the signature and the public key (in `tauri.conf.json`) are ever published.

The updater only moves forward and the identifier is unchanged
(`com.prev-player.app`), so a release from here upgrades every existing install.

## License

**[MIT](LICENSE)** — use it, modify it, sell it, redistribute it, fork it, rebrand it,
sublicense it. Commercial use included. No permission needed, no fees, no restrictions.

The one condition is that the copyright notice travels with the code:

```
Based on PREV Player — https://github.com/Arouzefst1/Prev-Player
Copyright (c) 2026 Arouzefst1 — MIT License
```

This covers **every release**, past and present.

The engine crates under `engine/` are MIT too — the workspace has declared
`license = "MIT"` since it was written.

No warranty — the software is provided **"as is"**, with no liability for damage or data
loss.

**Redistributing the installer:** the bundled `mpv.exe` is GPL and is not ours to
relicense. The app talks to it over IPC as a separate process, so the copyleft stops at
that binary and never reaches this code. Keep [LICENSE.md](LICENSE.md) alongside anything
you ship that includes it — or ship without it and let mpv come from `PATH`, in which
case MIT is the only license involved.

📄 **[LICENSE.md](LICENSE.md)** — license type, warranty warning, and the full mpv /
third-party notice in one place.
