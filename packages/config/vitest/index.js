import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Map every `@elysium/<pkg>` to its source entry point.
 *
 * Package `exports` point at `dist`, which is right for builds but would make
 * `pnpm test` depend on build order. Tests resolve source directly instead, so
 * they run on a clean checkout and always reflect the code being edited.
 *
 * @returns {Record<string, string>}
 */
export function workspaceAliases() {
  const packagesDir = path.join(repoRoot, 'packages');
  /** @type {Record<string, string>} */
  const aliases = {};

  for (const name of fs.readdirSync(packagesDir)) {
    const entry = path.join(packagesDir, name, 'src', 'index.ts');
    if (fs.existsSync(entry)) aliases[`@elysium/${name}`] = entry;
  }

  return aliases;
}
