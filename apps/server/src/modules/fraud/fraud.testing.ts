import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { fraudConfig, type FraudConfig } from './fraud.config.js';

/**
 * Test-only setup for the fraud suites.
 *
 * A safety net, and usually a no-op. `packages/db/migrations/meta/_journal.json` already
 * carries 0045–0047, so `startTestDatabase()`'s `migrate()` applies them and the first
 * check below returns early. It exists because that journal is one file several milestones
 * write to at once: if an entry is lost in a merge, a fraud suite should fail with a missing
 * table on its own terms rather than with a confusing error from inside the harness.
 *
 * Unlike M07's equivalent there is no other milestone to apply first. The only thing the
 * `fraud` schema references is `org.organizations`, which the seed migrations already
 * create — deliberately: this module has no foreign key into `sales.orders`, so its
 * migrations stand alone and a fraud test needs no order desk to make a row.
 */

const MIGRATIONS = [
  '0045_fraud_schema.sql',
  '0046_fraud_policies.sql',
  '0047_fraud_integrity.sql',
] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the repository
  // root as cwd, but a suite run from `apps/server` must find the same files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyFraudMigrations(): Promise<void> {
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('fraud') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (already) return;

  const directory = migrationsDir();
  for (const name of MIGRATIONS) {
    const contents = await readFile(path.join(directory, name), 'utf8');
    // The same separator the real migrator splits on. Comment-only fragments are valid
    // no-op statements, so they need no filtering.
    for (const statement of contents.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed === '') continue;
      await withSystem(async (tx) => {
        await tx.execute(sql.raw(trimmed));
      });
    }
  }
}

/**
 * A hash key for a test run.
 *
 * Long enough to satisfy the 32-character floor and obviously not a real secret. Set into
 * `process.env` rather than passed around, because the module's config provider is a
 * factory that reads the environment at `app.init()` — which is the behaviour under test
 * in `fails loudly without a key`.
 */
export const TEST_HASH_KEY = 'fraud-test-hmac-key-at-least-32-chars';

export function useTestFraudConfig(overrides: Partial<FraudConfig> = {}): FraudConfig {
  process.env.FRAUD_PHONE_HASH_KEY ??= TEST_HASH_KEY;
  return { ...fraudConfig(), ...overrides };
}

/**
 * Write cross-org counters straight into `fraud.phone_signals`.
 *
 * A fixture, not a production path — which is why it is here and not in the service. The
 * real path is an order event, and a suite that wanted "this buyer has nine returns" would
 * otherwise have to drive nine orders through a module it is not testing.
 *
 * Written as `erp_owner` because the table has no policy to satisfy (§5 exception 1); no
 * org context is needed, and that absence is itself part of what the isolation test proves.
 */
export async function seedSignals(
  phoneHash: string,
  counts: {
    readonly ordersTotal?: number;
    readonly delivered?: number;
    readonly returned?: number;
    readonly cancelled?: number;
    readonly lastIncidentAt?: Date | null;
  },
): Promise<void> {
  await withSystem(async (tx) => {
    await tx.execute(sql`
      insert into fraud.phone_signals (
        phone_hash, orders_total, delivered, returned, cancelled, last_incident_at
      ) values (
        ${phoneHash}, ${counts.ordersTotal ?? 0}, ${counts.delivered ?? 0},
        ${counts.returned ?? 0}, ${counts.cancelled ?? 0},
        ${counts.lastIncidentAt?.toISOString() ?? null}::timestamptz
      )
      on conflict (phone_hash) do update set
        orders_total = excluded.orders_total,
        delivered = excluded.delivered,
        returned = excluded.returned,
        cancelled = excluded.cancelled,
        last_incident_at = excluded.last_incident_at,
        updated_at = now()
    `);
  });
}
