import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Map every `@elysium/<pkg>` and its declared subpaths to source entry points.
 *
 * Package `exports` point at `dist`, which is right for builds but would make
 * `pnpm test` depend on build order. Tests resolve source directly instead, so
 * they run on a clean checkout and always reflect the code being edited.
 *
 * Subpaths (`@elysium/db/testing`, `@elysium/config/env`) are derived from each
 * package's own `exports` rather than hard-coded, by mapping the `dist` target
 * back to its `src` sibling. An export that does not point into `dist` is left
 * alone: it is already plain JavaScript in the repo, so node resolves it.
 *
 * Subpaths are inserted *before* the bare name, because Vite matches a string
 * alias by prefix: `@elysium/db` listed first would swallow
 * `@elysium/db/testing` and resolve it to `src/index.ts/testing`.
 *
 * @returns {Record<string, string>}
 */
export function workspaceAliases() {
  const packagesDir = path.join(repoRoot, 'packages');
  /** @type {Record<string, string>} */
  const aliases = {};

  for (const name of fs.readdirSync(packagesDir)) {
    const packageDir = path.join(packagesDir, name);
    const entry = path.join(packageDir, 'src', 'index.ts');
    if (!fs.existsSync(entry)) continue;

    const manifestPath = path.join(packageDir, 'package.json');
    /** @type {{ exports?: Record<string, unknown> }} */
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : {};

    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      if (key === '.' || key.includes('*')) continue;

      const file =
        typeof target === 'string'
          ? target
          : typeof target === 'object' && target !== null && 'default' in target
            ? String(/** @type {{ default: unknown }} */ (target).default)
            : '';

      const match = /^\.\/dist\/(.+)\.js$/.exec(file);
      if (match === null) continue;

      const source = path.join(packageDir, 'src', `${match[1]}.ts`);
      if (fs.existsSync(source)) aliases[`@elysium/${name}${key.slice(1)}`] = source;
    }

    aliases[`@elysium/${name}`] = entry;
  }

  return aliases;
}
