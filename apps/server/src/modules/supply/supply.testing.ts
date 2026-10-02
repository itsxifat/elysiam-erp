import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { applyInventoryMigrations } from '../inventory/inventory.testing.js';

/**
 * Test-only setup for the supply suites.
 *
 * `packages/db/migrations/meta/_journal.json` is edited by several milestones at once,
 * so M09's four files are handed to the integrator as INTEGRATION lines instead of
 * appended here — and until they are, `startTestDatabase()`'s `migrate()` does not run
 * them. M06's catalog and M07's inventory migrations come first, because every supply
 * line points at `catalog.skus` and every receipt goes through `inventory.*`;
 * `applyInventoryMigrations` is M07's own helper and is idempotent.
 *
 * The one thing this file does not do is seed a chart of accounts. `startTestDatabase()`
 * runs the real seed, which gives every org the 41 system accounts from D-084's
 * template — including `supplier_payable`, `supplier_advance` and
 * `purchase_price_variance`. A test fixture that inserted its own accounts would be
 * testing a chart production does not have.
 */

const MIGRATIONS = [
  '0035_supply_schema.sql',
  '0036_supply_policies.sql',
  '0037_supply_integrity.sql',
  '0038_supply_search.sql',
] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the
  // repository root as cwd, but a suite run from `apps/server` must find the same files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applySupplyMigrations(): Promise<void> {
  await applyInventoryMigrations();

  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('supply') is not null as present`,
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
 * One supplier, written directly.
 *
 * A fixture rather than a production path, because the suites that need a supplier are
 * testing what happens *to* one. Written as `erp_owner` inside the org's context, so RLS
 * applies exactly as it does to the application — an uncontexted insert would fail,
 * which is itself a small check that 0036's policies are on.
 */
export async function seedSupplier(
  orgId: string,
  input: { code: string; name: string },
): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into supply.suppliers (org_id, code, name)
        values (${orgId}, ${input.code}, ${input.name})
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('inserting a supplier returned no id');
      return id;
    },
    { orgId },
  );
}

/** The org's `wallet_bkash` ledger account, which a payment is made from. */
export async function walletAccountId(orgId: string, subtype = 'wallet_bkash'): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from ledger.accounts
        where org_id = ${orgId} and subtype = ${subtype}::ledger.account_subtype and is_active
        order by code
        limit 1
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error(`the seeded chart has no ${subtype} account`);
      return id;
    },
    { orgId },
  );
}
