import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Apply M06's own migrations to a test database.
 *
 * Test-only, and it exists because of how this session is split rather than
 * because of anything about the catalog: `packages/db/migrations/meta/_journal.json`
 * is edited by several milestones at once, so M06's four migrations are handed to
 * the integrator as INTEGRATION lines instead of appended here — and until they
 * are appended, `startTestDatabase()`'s `migrate()` does not run them.
 *
 * So this runs the same four files, in order, as `erp_owner`, which is the role
 * the real migrator uses. Once the journal carries them this becomes a no-op: the
 * schema will already exist and the guard below returns early. It is therefore
 * safe to leave in place, and leaving it in place is better than deleting it,
 * because it is the only thing that makes these suites runnable before
 * integration.
 */

const MIGRATIONS = [
  '0023_catalog_schema.sql',
  '0024_catalog_policies.sql',
  '0025_catalog_search.sql',
  '0026_catalog_integrity.sql',
] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the
  // repository root as cwd, but a suite run from `apps/server` must find the same
  // files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyCatalogMigrations(): Promise<void> {
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('catalog') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (already) return;

  const directory = migrationsDir();
  for (const name of MIGRATIONS) {
    const contents = await readFile(path.join(directory, name), 'utf8');
    // The same separator the real migrator splits on. Comment-only fragments are
    // valid no-op statements, so they need no filtering.
    const statements = contents.split('--> statement-breakpoint');
    await withSystem(async (tx) => {
      for (const statement of statements) {
        const trimmed = statement.trim();
        if (trimmed === '') continue;
        await tx.execute(sql.raw(trimmed));
      }
    });
  }
}
