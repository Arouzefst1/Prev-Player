// A release in one command:
//
//   npm run release -- "What changed, in one line"
//   npm run release -- "What changed" --announce     (shows the "update ready" toast)
//
// Builds the Windows installer, signs it for the updater with the release key,
// checks the signature really is the key installed apps trust, and writes
// latest.json (scripts/latest-json.mjs) — then says what to upload, with the
// GitHub release form pre-filled.
//
// It never asks for a password. The release key's password is empty, and
// PowerShell can't hold an empty environment variable (setting one to "" deletes
// it), so `tauri build` stopped to ask — and pressing Enter at that prompt
// didn't count as empty. So the build runs without the key, and the installer
// is signed right after with the password passed as an argument.
//
// The key: TAURI_SIGNING_PRIVATE_KEY (the key's text, or a path to it), else
// src-tauri/prev-player-updater.key, else ~/.tauri/prev-player-updater.key.
// Its password: TAURI_SIGNING_PRIVATE_KEY_PASSWORD, else empty.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const REPO = 'Arouzefst1/Prev-Player';
const NSIS_DIR = 'src-tauri/target/release/bundle/nsis';
const TAURI = 'node_modules/@tauri-apps/cli/tauri.js';

const args = process.argv.slice(2);
const flags = args.filter(a => a.startsWith('--'));
// npm on Windows can hand over a quoted sentence as separate words; rejoin them.
const notes = args.filter(a => !a.startsWith('--')).join(' ');

const fail = msg => { console.error(`\nrelease: ${msg}`); process.exit(1); };
const step = msg => console.log(`\n=== ${msg}`);

// --- Versions -----------------------------------------------------------------
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const version = conf.version;
const npmVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const cargoVersion = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (npmVersion !== version || cargoVersion !== version) {
  fail(`versions disagree — tauri.conf.json ${version}, package.json ${npmVersion}, Cargo.toml ${cargoVersion}`);
}
if (!notes) fail('say what changed: npm run release -- "What changed, in one line"');
if (!existsSync(TAURI)) fail('the Tauri CLI is missing — run `npm install` first');

// --- The key ----------------------------------------------------------------
/** A minisign key ID from a base64 public key or signature (Tauri's format). */
function keyIdOf(b64) {
  const line = Buffer.from(b64.trim(), 'base64').toString('utf8').split('\n')[1]?.trim();
  if (!line) return null;
  return Buffer.from(Buffer.from(line, 'base64').subarray(2, 10)).reverse().toString('hex').toUpperCase();
}

function findKey() {
  const fromEnv = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
  if (fromEnv) {
    return existsSync(fromEnv)
      ? { text: readFileSync(fromEnv, 'utf8').trim(), path: fromEnv }
      : { text: fromEnv, path: null };
  }
  for (const p of ['src-tauri/prev-player-updater.key', join(homedir(), '.tauri', 'prev-player-updater.key')]) {
    if (existsSync(p)) return { text: readFileSync(p, 'utf8').trim(), path: p };
  }
  return null;
}

const key = findKey();
if (!key) fail('no signing key — put prev-player-updater.key in src-tauri\\ (it is git-ignored), or set TAURI_SIGNING_PRIVATE_KEY');
const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '';
const trusted = keyIdOf(conf.plugins?.updater?.pubkey ?? '');
if (key.path && existsSync(`${key.path}.pub`)) {
  const id = keyIdOf(readFileSync(`${key.path}.pub`, 'utf8'));
  if (id !== trusted) fail(`${key.path} is key ${id}, but installed apps only trust ${trusted} — wrong key`);
}

// The build and the signer must not see a key of their own (see the top).
const env = { ...process.env };
delete env.TAURI_SIGNING_PRIVATE_KEY;
delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;

// --- Build --------------------------------------------------------------------
step(`Building PREV Player ${version} (a few minutes)`);
const started = Date.now();
const build = spawnSync(process.execPath, [TAURI, 'build', '--bundles', 'nsis'], { stdio: 'inherit', env });
const installer = existsSync(NSIS_DIR)
  ? readdirSync(NSIS_DIR).find(f => f.endsWith(`_${version}_x64-setup.exe`))
  : undefined;
const installerPath = installer && join(NSIS_DIR, installer);
// Without the key, `tauri build` ends by saying it couldn't sign the updater
// bundle — expected here, as long as it made a fresh installer first.
if (!installerPath || statSync(installerPath).mtimeMs < started - 5000) {
  fail(`the build didn't produce a new installer (exit code ${build.status}) — see the errors above`);
}
if (build.status !== 0) console.log('\n(That last error is expected: the installer is signed in the next step.)');

// --- Sign ---------------------------------------------------------------------
step('Signing the installer for the updater');
const sigPath = `${installerPath}.sig`;
rmSync(sigPath, { force: true });
const sign = spawnSync(process.execPath, [TAURI, 'signer', 'sign', '-k', key.text, `--password=${password}`, installerPath], { encoding: 'utf8', env });
if (sign.status !== 0 || !existsSync(sigPath)) {
  const why = `${sign.stdout ?? ''}${sign.stderr ?? ''}`.trim().split('\n').slice(-3).join('\n');
  fail(`couldn't sign the installer${/password/i.test(why) ? ' — wrong password (set TAURI_SIGNING_PRIVATE_KEY_PASSWORD)' : ''}:\n${why}`);
}
const signedBy = keyIdOf(readFileSync(sigPath, 'utf8'));
if (signedBy !== trusted) {
  rmSync(sigPath, { force: true });
  fail(`signed with key ${signedBy}, but installed apps only trust ${trusted} — wrong key, nothing written`);
}
console.log(`Signed with ${signedBy} — the key installed apps trust.`);

// --- latest.json --------------------------------------------------------------
step('Writing latest.json');
const manifest = spawnSync(process.execPath, ['scripts/latest-json.mjs', notes, ...flags], { stdio: 'inherit' });
if (manifest.status !== 0) fail('latest.json was not written — see above');

// --- What to do next ------------------------------------------------------------
const assetName = installer.replace(/ /g, '.');
const form = `https://github.com/${REPO}/releases/new?` + new URLSearchParams({
  tag: `v${version}`,
  target: 'main',
  title: `PREV Player ${version}`,
  body: notes,
}).toString();
console.log(`
=== Ready. Publish it:
  1. Open: ${form}
  2. Drag in these three files from ${NSIS_DIR.replace(/\//g, '\\')}:
       ${installer}
       ${installer}.sig
       latest.json
     (GitHub shows the first two as ${assetName} and ${assetName}.sig — that's expected.)
  3. Keep "Set as the latest release" ticked, then Publish release.
`);
