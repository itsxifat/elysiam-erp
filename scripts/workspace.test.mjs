import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard against a fresh clone failing `pnpm install`.
 *
 * When a new dependency arrives with an install script, pnpm appends
 * `<pkg>: set this to true or false` to `allowBuilds` and then refuses to
 * install until somebody answers it. The machine that added the dependency
 * usually does not notice, because its store is already populated — so the
 * breakage only shows up on a clean clone and in CI.
 *
 * This happened in M00 (esbuild) and again in M01 (testcontainers' native
 * transitive dependencies), which is twice too many.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceYaml = readFileSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');

/** The `allowBuilds:` block, as `{ package: value }` over its raw text. */
function allowBuildsEntries() {
  const lines = workspaceYaml.split('\n');
  const start = lines.findIndex((line) => line.startsWith('allowBuilds:'));
  if (start === -1) return {};

  const entries = {};
  for (const line of lines.slice(start + 1)) {
    // The block ends at the next top-level key.
    if (/^\S/.test(line) && line.trim() !== '') break;
    const match = /^\s+("?)([\w@/.-]+)\1:\s*(.+?)\s*$/.exec(line);
    if (match?.[2] && match[3] !== undefined) entries[match[2]] = match[3];
  }
  return entries;
}

describe('pnpm workspace', () => {
  it('has answered every allowBuilds prompt', () => {
    const entries = allowBuildsEntries();
    const unanswered = Object.entries(entries)
      .filter(([, value]) => value !== 'true' && value !== 'false')
      .map(([name, value]) => `${name}: ${value}`);

    expect(
      unanswered,
      'pnpm left a placeholder in allowBuilds. Until it says true or false, ' +
        '`pnpm install` exits 1 on a fresh clone and in CI.',
    ).toEqual([]);
  });

  it('answers at least the packages we know need an answer', () => {
    // A sanity check that the parser above is actually reading the block,
    // rather than silently finding nothing and passing.
    expect(Object.keys(allowBuildsEntries())).toContain('esbuild');
  });

  it('pins every catalog version exactly', () => {
    const lines = workspaceYaml.split('\n');
    const start = lines.findIndex((line) => line.startsWith('catalog:'));
    expect(start, 'pnpm-workspace.yaml should have a catalog block').toBeGreaterThan(-1);

    const loose = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line) && line.trim() !== '') break;
      const match = /^\s+("?)([\w@/.-]+)\1:\s*(.+?)\s*$/.exec(line);
      const version = match?.[3];
      if (version && /^[\^~]|latest|\*/.test(version)) loose.push(`${match[2]}: ${version}`);
    }

    // M00 pinned everything exactly so a reinstall months from now resolves the
    // same tree. A range would quietly undo that.
    expect(loose).toEqual([]);
  });
});
