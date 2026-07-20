# Releasing & Auto-Update

PREV Player has a built-in **auto-updater**. On launch the app fetches a signed
`latest.json` manifest from GitHub; if a newer version exists it shows the
**Update Available** dialog. Clicking **Update Now** downloads + installs the new
build and relaunches automatically — no manual download.

```
App checks  →  github.com/Arouzefst1/Prev-Player/releases/latest/download/latest.json
            →  if newer + valid signature → "Update Available" → Update Now → installs → relaunch
```

---

## One-time setup

### 1. The signing key (already generated)

Updates must be signed with the key created during setup:

- **Private key:** `src-tauri/prev-player-updater.key` — **secret, git-ignored, BACK IT UP.**
- **Public key:** `src-tauri/prev-player-updater.key.pub` — embedded in `tauri.conf.json` (`plugins.updater.pubkey`).

> ⚠️ If you lose the private key you can **no longer push auto-updates** — every
> client only accepts updates signed by the matching key. Recovering means
> generating a new key, shipping a fresh manual install to everyone, and starting over.
> Save a copy somewhere safe (password manager / private backup).

The key has **no password**.

### 2. Add GitHub secrets (for the automated workflow)

In the **Prev-Player** repo → Settings → Secrets and variables → Actions → *New repository secret*:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | the entire contents of `src-tauri/prev-player-updater.key` |

That's the only secret you need — the key has no password, so **don't** create
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (GitHub won't save an empty secret; the workflow
already falls back to an empty password).

---

## Cutting a release (recommended: automated)

1. **Bump the version** in all three files to the same number (e.g. `1.0.1`):
   - `src-tauri/tauri.conf.json` → `"version"`
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `version`
2. Commit, then tag and push to the **Prev-Player** repo:
   ```bash
   git commit -am "Release v1.0.1"
   git tag v1.0.1
   git push prev-player main      # your remote for Prev-Player
   git push prev-player v1.0.1
   ```
3. The [`release.yml`](.github/workflows/release.yml) workflow builds + signs the app,
   creates the GitHub Release, and uploads the installer **and** `latest.json`.

Anyone on an older version gets the **Update Available** dialog within a few seconds
of launching (they must already be on a build that contains the updater — i.e. `1.0.1`
or later; the very first updater-enabled build has to be installed manually).

> The endpoint uses GitHub's `releases/latest/download/...` redirect, so the manifest
> URL never changes between versions — you only ever publish new releases.

---

## Manual release (fallback, no CI)

```bash
# 1. bump versions (see above), then build with the signing key in the environment
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw src-tauri/prev-player-updater.key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npm run build
```

This produces, under `src-tauri/target/release/bundle/`:

- `nsis/PREV Player_<version>_x64-setup.exe` — the installer
- `nsis/PREV Player_<version>_x64-setup.exe.sig` — its signature

Create a GitHub Release on **Prev-Player** tagged `v<version>`, upload the
`-setup.exe`, and add a `latest.json` asset:

```json
{
  "version": "1.0.1",
  "notes": "What changed in this release",
  "pub_date": "2026-01-01T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<paste the full contents of the .exe.sig file>",
      "url": "https://github.com/Arouzefst1/Prev-Player/releases/download/v1.0.1/PREV.Player_1.0.1_x64-setup.exe"
    }
  }
}
```

> ⚠️ GitHub replaces **spaces with dots** in download URLs — note `PREV.Player`
> (not `PREV Player`) in the `url`. The automated workflow handles all of this for you.

---

## Notes

- The updater is desktop-only and is gated behind `#[cfg(desktop)]` in `src-tauri/src/lib.rs`.
- Update check + install lives in `App.tsx` (`check()` → `downloadAndInstall()` → `relaunch()`).
- To test the dialog without publishing, temporarily lower the running app's version
  below the published release.
