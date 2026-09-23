#!/usr/bin/env node
/**
 * Committed migrations are immutable (CLAUDE.md invariant 9).
 *
 * Editing a migration that has already run somewhere leaves every database in a
 * different state from the one the file describes, and nothing detects the
 * drift until a query fails months later. The fix for a bad migration is always
 * a new migration.
 *
 * This fails the build if a migration file that exists on the base branch has
 * been modified, deleted or renamed — whether the change is committed or still
 * sitting in the working tree.
 *
 * Usage:
 *   node scripts/check-migrations.mjs               # compare against origin/main, then main
 *   node scripts/check-migrations.mjs --base <ref>  # compare against an explicit ref
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repository containing the current working directory, not the one this
 * script happens to live in. `pnpm verify` runs it from the root either way,
 * but resolving from cwd means it also works on a worktree, from a
 * subdirectory, and under test against a throwaway repository.
 */
function findRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  }
}

const REPO_ROOT = findRepoRoot();
const MIGRATIONS_DIR = 'packages/db/migrations';

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function parseArgs(argv) {
  const baseIndex = argv.indexOf('--base');
  return { base: baseIndex === -1 ? null : (argv[baseIndex + 1] ?? null) };
}

function resolveBase(explicit) {
  if (explicit) {
    if (git(['rev-parse', '--verify', '--quiet', explicit], { allowFailure: true }) === null) {
      return { ref: null, reason: `the ref "${explicit}" does not exist` };
    }
    return { ref: explicit, reason: null };
  }

  for (const candidate of ['origin/main', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', candidate], { allowFailure: true }) !== null) {
      return { ref: candidate, reason: null };
    }
  }

  return { ref: null, reason: 'neither origin/main nor main exists yet' };
}

/** Files under the migrations directory that the base ref already contains. */
function migrationsOnBase(base) {
  const listing = git(['ls-tree', '-r', '--name-only', base, '--', MIGRATIONS_DIR], {
    allowFailure: true,
  });
  return new Set(listing ? listing.split('\n').filter(Boolean) : []);
}

/**
 * Every change to the migrations directory, committed or not, as
 * `{ status, file }`. Working-tree state is included deliberately: the point is
 * to catch the edit before it becomes a commit.
 */
function changesSince(base) {
  const changes = new Map();

  const add = (raw) => {
    for (const line of raw.split('\n').filter(Boolean)) {
      const [status, ...files] = line.split('\t');
      const file = files.at(-1);
      if (status && file) changes.set(file, status[0]);
    }
  };

  const mergeBase = git(['merge-base', base, 'HEAD'], { allowFailure: true });
  add(git(['diff', '--name-status', mergeBase ?? base, '--', MIGRATIONS_DIR]) ?? '');
  add(git(['diff', '--name-status', '--cached', mergeBase ?? base, '--', MIGRATIONS_DIR]) ?? '');

  return changes;
}

/**
 * The journal may only gain entries.
 *
 * Rewriting an existing one would re-point a tag at different SQL, or renumber
 * a migration that has already run — the same corruption as editing the file
 * itself, one level of indirection away.
 */
function journalViolations(base) {
  const file = `${MIGRATIONS_DIR}/meta/_journal.json`;
  const committed = git(['show', `${base}:${file}`], { allowFailure: true });
  if (committed === null) return [];

  let before;
  let after;
  try {
    before = JSON.parse(committed).entries ?? [];
    after = JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')).entries ?? [];
  } catch {
    return [{ file, what: 'is not readable as JSON' }];
  }

  if (after.length < before.length) {
    return [{ file, what: `lost ${before.length - after.length} entr(ies)` }];
  }

  const changed = before
    .map((entry, index) => ({ entry, current: after[index] }))
    .filter(
      ({ entry, current }) =>
        current === undefined || current.idx !== entry.idx || current.tag !== entry.tag,
    )
    .map(({ entry }) => ({ file, what: `re-pointed entry ${entry.idx} (${entry.tag})` }));

  return changed;
}

function main() {
  const { base: explicitBase } = parseArgs(process.argv.slice(2));

  if (git(['rev-parse', '--git-dir'], { allowFailure: true }) === null) {
    console.log('check-migrations: not a git repository, nothing to compare. SKIP');
    return 0;
  }

  const { ref: base, reason } = resolveBase(explicitBase);
  if (base === null) {
    console.log(`check-migrations: ${reason}, so there is no committed history to protect. SKIP`);
    return 0;
  }

  const protectedFiles = migrationsOnBase(base);
  if (protectedFiles.size === 0) {
    console.log(`check-migrations: ${base} has no migrations to protect yet. PASS`);
    return 0;
  }

  const violations = [];
  for (const [file, status] of changesSince(base)) {
    if (!protectedFiles.has(file)) continue;

    // `meta/_journal.json` necessarily changes when a migration is added: it
    // is the index, not a migration. Its existing entries are checked for
    // tampering separately below, because rewriting one would silently
    // re-point a tag at different SQL.
    if (file.endsWith('meta/_journal.json')) continue;

    if (status === 'M') violations.push({ file, what: 'modified' });
    else if (status === 'D') violations.push({ file, what: 'deleted' });
    else if (status === 'R') violations.push({ file, what: 'renamed' });
  }

  violations.push(...journalViolations(base));

  if (violations.length > 0) {
    console.error(`check-migrations: FAIL — ${violations.length} committed migration(s) changed\n`);
    for (const { file, what } of violations) console.error(`  ${what}: ${file}`);
    console.error(
      `\nA migration on ${base} has already run against other databases, so editing it\n` +
        `leaves them describing a schema they do not have. Add a new migration instead\n` +
        `(CLAUDE.md invariant 9).`,
    );
    return 1;
  }

  console.log(
    `check-migrations: ${protectedFiles.size} migration(s) on ${base} are unchanged. PASS`,
  );
  return 0;
}

process.exit(main());
