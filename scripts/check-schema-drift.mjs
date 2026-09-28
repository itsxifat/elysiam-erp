#!/usr/bin/env node
/**
 * The Drizzle schema, the drizzle-kit snapshot and the migrations must agree.
 *
 * Some DDL cannot be expressed in a Drizzle schema — RLS policies, grants,
 * roles — so those migrations are written by hand. The hazard is that a
 * hand-written migration changes the database while the TypeScript schema and
 * the snapshot still describe the old shape. They then agree with each other
 * and disagree with reality, `drizzle-kit generate` reports "no schema
 * changes", and the divergence is invisible.
 *
 * That happened once already: migration 0002 replaced a single-column foreign
 * key with a composite one to close a cross-org hole (D-047), while the schema
 * kept the old `.references()`. The next generate would have diffed against a
 * false baseline and could have emitted a migration reopening it.
 *
 * This runs the generator and fails if it produces anything, then puts the
 * migrations folder back exactly as it found it.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PACKAGE = path.join(REPO_ROOT, 'packages/db');
const MIGRATIONS = path.join(DB_PACKAGE, 'migrations');

function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function main() {
  if (!existsSync(MIGRATIONS)) {
    console.log('check-schema-drift: no migrations folder yet. SKIP');
    return 0;
  }

  const before = migrationFiles();
  // A full copy, because generate rewrites the journal and adds a snapshot.
  const backup = mkdtempSync(path.join(tmpdir(), 'elysium-migrations-'));
  cpSync(MIGRATIONS, backup, { recursive: true });

  /** @type {string[]} */
  let generated;
  /** @type {string | undefined} */
  let output;
  try {
    // `shell: true` because the Windows binstub is a .cmd, which execFileSync
    // cannot launch directly.
    output = execFileSync('drizzle-kit', ['generate', '--name=__drift_check'], {
      cwd: DB_PACKAGE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: {
        ...process.env,
        PATH: `${path.join(DB_PACKAGE, 'node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    // drizzle-kit exits 0 even when it refuses to run.
    //
    // A corrupt snapshot chain — two snapshots sharing an id, which is what a
    // hand-copied snapshot file produces — makes it print
    // "Error: ... is a collision" and stop, without generating and without a
    // non-zero status. This check then saw no new files and reported PASS, so
    // the gate sat green from migration 0018 to 0060 while comparing nothing at
    // all. Trusting the exit code alone is what made that invisible, so the
    // output is inspected too.
    if (output !== undefined && /^\s*Error:/m.test(output)) {
      console.error('check-schema-drift: FAIL — drizzle-kit refused to run');
      console.error(output);
      return 1;
    }

    generated = migrationFiles().filter((name) => !before.includes(name));
  } catch (error) {
    console.error('check-schema-drift: drizzle-kit generate failed\n');
    console.error(String(error.stdout ?? '') + String(error.stderr ?? ''));
    return 1;
  } finally {
    // Restore whatever generate touched, whether it added a file or not.
    rmSync(MIGRATIONS, { recursive: true, force: true });
    cpSync(backup, MIGRATIONS, { recursive: true });
    rmSync(backup, { recursive: true, force: true });
  }

  if (generated.length > 0) {
    console.error('check-schema-drift: FAIL — the schema and the migrations disagree\n');
    console.error(`  drizzle-kit would emit: ${generated.join(', ')}\n`);
    console.error(
      'A hand-written migration changed the database without the Drizzle schema\n' +
        'being updated to match, or a schema change has no migration. Update\n' +
        'packages/db/src/schema to describe the real shape, then reconcile: the\n' +
        'generator output is the measure of the divergence, and must not simply be\n' +
        'committed if the migration it duplicates has already run.',
    );
    return 1;
  }

  console.log(`check-schema-drift: schema, snapshot and ${before.length} migration(s) agree. PASS`);
  return 0;
}

process.exit(main());
