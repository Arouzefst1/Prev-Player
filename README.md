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

Bump the version in **three** files — `package.json`, `src-tauri/tauri.conf.json`
and `src-tauri/Cargo.toml` — then:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat <path-to>/prev-player-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npx tauri build --bundles nsis
```

That produces the installer and its `.sig` under
`src-tauri/target/release/bundle/nsis/`. The updater manifest (`latest.json`) is
written by hand — Tauri doesn't emit one — with the `.sig` contents as
`signature`, and published alongside the installer on a GitHub release.

The **private signing key lives outside this repository and must stay there.**
Only the signature and the public key (in `tauri.conf.json`) are ever published.

The updater only moves forward and the identifier is unchanged
(`com.prev-player.app`), so a release from here upgrades every existing install.
