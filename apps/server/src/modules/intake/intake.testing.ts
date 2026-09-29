import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { applyOrderMigrations } from '../orders/orders.testing.js';

/**
 * Apply M11's intake migrations (0062, 0063) to a test database.
 *
 * Test-only, for the reason `applyCatalogMigrations` gives: the migration journal is shared
 * and the integrator registers these files, so until then a test database's own migrator
 * has not run them. Guarded on the `intake` schema, so once the journal carries them this
 * is a no-op — which is why it is safe to leave in place.
 *
 * The orders migrations come first because `intake.submissions` has a foreign key into
 * `sales.orders`.
 */

const MIGRATIONS = ['0062_intake_schema.sql', '0063_intake_policies.sql'] as const;

function migrationsDir(): string {
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyIntakeMigrations(): Promise<void> {
  await applyOrderMigrations();

  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('intake') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (already) return;

  const directory = migrationsDir();
  for (const name of MIGRATIONS) {
    const contents = await readFile(path.join(directory, name), 'utf8');
    for (const statement of contents.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed === '') continue;
      await withSystem(async (tx) => {
        await tx.execute(sql.raw(trimmed));
      });
    }
  }
}

/** The environment the intake suites run under: a fixed master key, memory counters. */
export const TEST_INTAKE_KEY_SECRET = 'test-intake-key-secret-at-least-32-characters';

export function setIntakeTestEnv(overrides: Record<string, string> = {}): void {
  process.env.INTAKE_KEY_SECRET ??= TEST_INTAKE_KEY_SECRET;
  process.env.INTAKE_RATE_LIMIT_STORE ??= 'memory';
  for (const [name, value] of Object.entries(overrides)) process.env[name] = value;
}
