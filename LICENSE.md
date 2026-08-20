# License

PREV Player is **free and open source software** released under the **MIT License**.

The plain-text license, which is the legally operative document, is in
[LICENSE](LICENSE). This page says the same thing in readable form, adds the warranty
warning, and records the one component that MIT does not cover: the bundled **mpv**
playback engine.

---

## 1. License type — MIT

**SPDX identifier:** `MIT`
**Copyright (c) 2026 Arouzefst1**

### You are free to

| | |
|---|---|
| ✅ **Use** | Anything — personal, commercial, internal, whatever |
| ✅ **Modify** | Change any part of it, no need to explain or publish your changes |
| ✅ **Sell** | Charge money for it, sell it, build a paid product around it |
| ✅ **Distribute** | Share it, upload it, ship it, bundle it into something else |
| ✅ **Sublicense** | Relicense your version under different terms, including closed source |
| ✅ **Fork & rebrand** | Rename it, restyle it, call it your own product |
| ✅ **Do it commercially** | No fee, no royalty, no permission request, no notification |

### The only condition

**Keep the copyright notice.** Include the [LICENSE](LICENSE) file, or its text, with any
substantial portion of the code you redistribute. That is the entire obligation —
attribution, nothing else.

Suggested credit line:

```
Based on PREV Player — https://github.com/Arouzefst1/Prev-Player
Copyright (c) 2026 Arouzefst1 — MIT License
```

### Scope

This license applies to **every version of PREV Player, including all previously
published releases** — not only the current one. Any release you already downloaded is
covered by these terms.

It covers all first-party code in this project: the React/TypeScript front end, the Rust
Tauri shell, and the `prev-*` engine crates.

---

## 2. Warning — no warranty, no liability

> [!WARNING]
> **THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.**

In plain terms:

- **No guarantee it works.** It may crash, hang, fail to play a file, or behave
  incorrectly. Nothing here promises fitness for any particular purpose.
- **No liability for damage.** The authors and copyright holders are not liable for any
  claim, damage, data loss, corrupted files, or other loss arising from using this
  software — in contract, tort, or otherwise.
- **You use it at your own risk.** If you deploy or resell it, that risk is yours and
  you carry it for your own users too.
- **No support is owed.** Issues and fixes are voluntary, not an entitlement.
- **Unsigned installer.** Releases are not signed with a paid code-signing certificate,
  so Windows SmartScreen will warn on first run. Only download builds from the official
  releases page, or build from source yourself.

This warranty disclaimer is part of the MIT License and cannot be separated from the
permissions above.

---

## 3. Third-party notice — mpv (IMPORTANT)

The MIT license above covers **our** code. It does not — and cannot — cover code written
by other people that ships inside the installer.

### The component

| | |
|---|---|
| **File** | `src-tauri/resources/mpv/mpv.exe` |
| **Project** | mpv — <https://mpv.io> · <https://github.com/mpv-player/mpv> |
| **Version** | `v0.41.0-244-gaf9c81fa1` (FFmpeg `N-123099-g862338fe3`, libplacebo `v7.360.0`) |
| **License** | **GPL v2 or later** — standard Windows builds enable GPL components |
| **Source** | <https://github.com/mpv-player/mpv> · FFmpeg: <https://ffmpeg.org/download.html> |

### Why mpv's GPL does not make PREV Player GPL

PREV Player **launches `mpv.exe` as a separate operating-system process** and
communicates with it over an IPC pipe. It does **not** link against `libmpv`, does not
statically or dynamically include mpv or FFmpeg code in its own binary, and is not a
derivative work of either.

Under the GPL this is *aggregation of independent programs*, not a combined work. mpv's
copyleft therefore stays with `mpv.exe` and **does not extend to this codebase**. PREV
Player also runs against any mpv found on `PATH` and is fully functional with no bundled
copy at all, which reinforces that the two are independent programs.

**Your modifications to PREV Player do not have to be open-sourced.**

### If you redistribute the installer

Handing someone a GPL binary comes with two obligations. Both are easy to meet:

1. **Keep this notice** with whatever you ship, so recipients know mpv is included and
   under which terms.
2. **Make mpv's source available** to those recipients. Linking to the upstream tag you
   built from (above) satisfies this for unmodified upstream builds. If you *patch* mpv,
   you must publish your patched source under the GPL.

### How to avoid the GPL entirely

Ship your build **without** `src-tauri/resources/mpv/` and let the app use whatever mpv
is on the user's `PATH`. Then nothing you distribute is GPL and **MIT is the only
license involved**. (mpv can alternatively be built LGPL-only with `--enable-lgpl`, at
the cost of some codecs and filters.)

---

## 4. Other bundled components

### d3dcompiler_43.dll

| | |
|---|---|
| **File** | `src-tauri/resources/mpv/d3dcompiler_43.dll` |
| **Owner** | Microsoft Corporation |
| **Terms** | Redistributable under the DirectX SDK EULA |

Required by mpv's Direct3D output path on systems lacking it. Redistribution alongside
an application is permitted; the file must not be modified.

### Microsoft Edge WebView2

The UI renders in WebView2, which ships with Windows or is installed by the bundled
evergreen bootstrapper. Governed by the
[Microsoft Edge WebView2 Runtime terms](https://developer.microsoft.com/microsoft-edge/webview2/).
Not redistributed as source by this project.

### Permissive libraries

All of the following are MIT, Apache-2.0, or ISC. They impose no obligation beyond
retaining their copyright notices, which happens automatically in build artifacts and in
`node_modules/` / `~/.cargo/`.

| Component | License |
|---|---|
| Tauri v2 + official plugins (`dialog`, `fs`, `opener`, `process`, `updater`, `deep-link`) | MIT / Apache-2.0 |
| `tokio`, `reqwest`, `serde`, `serde_json`, `anyhow`, `thiserror`, `bytes`, `futures-util`, `async-trait` | MIT / Apache-2.0 |
| `sha2`, `base64`, `tiny_http` | MIT / Apache-2.0 |
| `rusqlite` (bundled SQLite) | MIT — SQLite itself is public domain |
| React 19 · React DOM | MIT |
| TypeScript · Vite | Apache-2.0 · MIT |
| Tailwind CSS · PostCSS · Autoprefixer | MIT |
| `@dnd-kit/core`, `/sortable`, `/utilities` | MIT |
| `lucide-react` | ISC |

A complete dependency inventory is available with `npm ls --all` and `cargo tree`.

---

## Summary

| What you redistribute | What you must honour |
|---|---|
| Source code | **MIT** — keep the copyright notice |
| A build **without** bundled mpv | **MIT** — keep the copyright notice |
| The installer **with** bundled mpv | **MIT** for the app **+ GPL v2+** for `mpv.exe` — keep this notice and offer mpv's source |

Short version: **do whatever you want, just give credit — and if you pass along the
bundled mpv, pass along this notice with it.**

Author (Arouzefst1) is/will not be responsible for any complaints and legal claim/actions after redistribution/modification or anything face by other entity.
