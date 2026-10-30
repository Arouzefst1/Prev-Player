// Write the updater manifest (latest.json) for the installer `npx tauri build`
// just produced. Tauri doesn't emit one, and a hand-written manifest with a
// wrong URL or signature breaks updates for every install at once.
//
//   node scripts/latest-json.mjs "What changed, in one line"
//   node scripts/latest-json.mjs "..." --announce
//
// By default the release is marked `"silent": true`: installed apps download it
// in the background and install it when the user closes the app — no dialog, no
// toast, and the next launch is simply the new version (see src-tauri/src/updater.rs).
// `--announce` leaves the flag off, so a minor/major bump shows the
// "ready — installs when you close the app" toast instead.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'Arouzefst1/Prev-Player';
const NSIS_DIR = 'src-tauri/target/release/bundle/nsis';

const args = process.argv.slice(2);
const announce = args.includes('--announce');
// npm on Windows can hand over a quoted sentence as separate words; rejoin them.
const notes = args.filter(a => !a.startsWith('--')).join(' ');

const fail = msg => { console.error(`latest-json: ${msg}`); process.exit(1); };

// The three files the README says to bump must agree, or the build ships one
// version while the manifest advertises another.
const version = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
const npmVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
const cargoVersion = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (npmVersion !== version || cargoVersion !== version) {
  fail(`versions disagree — tauri.conf.json ${version}, package.json ${npmVersion}, Cargo.toml ${cargoVersion}`);
}

let files;
try { files = readdirSync(NSIS_DIR); } catch { fail(`${NSIS_DIR} not found — run \`npx tauri build --bundles nsis\` first`); }
const installer = files.find(f => f.endsWith(`_${version}_x64-setup.exe`));
if (!installer) fail(`no ${version} installer in ${NSIS_DIR} — build this version first`);
if (!files.includes(`${installer}.sig`)) fail(`${installer}.sig missing — was TAURI_SIGNING_PRIVATE_KEY set for the build?`);

// GitHub turns spaces in an uploaded asset's name into dots
// ("PREV Player_1.5.4_x64-setup.exe" → "PREV.Player_1.5.4_x64-setup.exe").
const assetName = installer.replace(/ /g, '.');
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  ...(announce ? {} : { silent: true }),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(join(NSIS_DIR, `${installer}.sig`), 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/v${version}/${assetName}`,
    },
  },
};

const out = join(NSIS_DIR, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Wrote ${out} — v${version}, ${announce ? 'announced' : 'silent'}`);
console.log(`Publish as the latest release, tag v${version}: ${assetName}, ${assetName}.sig, latest.json`);
