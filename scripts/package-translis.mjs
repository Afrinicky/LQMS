/**
 * Package TransLis, and leave the repository exactly as it was found.
 *
 * `extraMetadata` in the builder config means electron-builder has to produce a
 * package.json that differs from this project's own — a different `name`, and a
 * `main` pointing at the TransLis bundle. It writes that transformed copy into
 * the application. A build step that computes a rewritten package.json next to
 * the real one is a step worth watching, because if it ever wrote it in place
 * the project would silently lose every npm script, and the next command to
 * fail would fail for a reason that had nothing to do with what was changed.
 *
 * So: read the file, run the build, put it back if it moved, and say so. It
 * costs a file read and removes a whole class of surprise. The workflow asserts
 * the same thing independently.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const MANIFEST = join(ROOT, 'package.json');

const original = readFileSync(MANIFEST, 'utf8');

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', '--config', 'electron-builder.translis.json', ...process.argv.slice(2)],
  { cwd: ROOT, stdio: 'inherit' },
);

// Before reporting the build's own outcome, whatever that was.
let restored = false;
try {
  if (readFileSync(MANIFEST, 'utf8') !== original) {
    writeFileSync(MANIFEST, original);
    restored = true;
  }
} catch (error) {
  console.error('\npackage-translis: package.json could not be restored:', error);
  console.error('Recover it with:  git checkout package.json');
  process.exit(1);
}

if (restored) {
  console.log('\npackage-translis: package.json was rewritten by electron-builder and has been put back.');
}

if (result.error) {
  console.error('package-translis: electron-builder could not be started:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
