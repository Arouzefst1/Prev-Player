// One version's notes, from its section in RELEASE_NOTES.md:
//
//   ## 1.6.1 — the one-line summary
//   The description, up to the next "## ".
//
//   node scripts/release-notes.mjs 1.6.1          → the summary
//   node scripts/release-notes.mjs 1.6.1 --body   → the description

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** `{ summary, body }` for `version`, or null when it has no section. */
export function releaseNotes(version, file = 'RELEASE_NOTES.md') {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}(\\s|$)`);
  const start = lines.findIndex(l => heading.test(l));
  if (start < 0) return null;
  const summary = lines[start].replace(/^##\s+\S+\s*[—–-]*\s*/, '').trim();
  if (!summary) return null;
  const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const body = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  return { summary, body: body || summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [version, part] = process.argv.slice(2);
  const notes = version && releaseNotes(version);
  if (!notes) {
    console.error(`release-notes: RELEASE_NOTES.md has no "## ${version ?? '<version>'} — <summary>" section`);
    process.exit(1);
  }
  console.log(part === '--body' ? notes.body : notes.summary);
}
