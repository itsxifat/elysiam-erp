/**
 * Copy `.sql` assets into `dist` after a build.
 *
 * `tsc` emits JavaScript and declarations; it does not copy data files. So
 * `dist/cli/bootstrap.js` resolving `../bootstrap.sql` found nothing, and
 * `node dist/cli/bootstrap.js` — which is how it runs in a container — failed
 * with ENOENT. Running under `tsx` hid it, because tsx executes from `src`.
 *
 * Found by running the built output rather than the source.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(PACKAGE_ROOT, 'src');
const DIST = path.join(PACKAGE_ROOT, 'dist');

let copied = 0;

function walk(directory) {
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith('.sql')) continue;

    const target = path.join(DIST, path.relative(SRC, full));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(full, target);
    copied += 1;
  }
}

walk(SRC);
console.log(`copy-sql-assets: ${copied} file(s) into dist`);
