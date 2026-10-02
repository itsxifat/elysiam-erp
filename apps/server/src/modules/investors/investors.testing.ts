import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Test-only setup for the investor suites.
 *
 * M25's three migrations **are** registered in
 * `packages/db/migrations/meta/_journal.json`, so `startTestDatabase()`'s `migrate()`
 * creates the schema and `applyInvestorMigrations` returns at its first check. It
 * stays for two reasons: a suite run against a database migrated before those entries
 * landed still works, and the fallback path applies the files **one statement per
 * transaction**, which the real migrator does not — 0058 adds two values to
 * `approvals.approval_type`, and PostgreSQL refuses to *use* an enum value added
 * earlier in the same transaction.
 *
 * Nothing here seeds a chart of accounts. `startTestDatabase()` runs the real seed,
 * which gives every org D-084's 41 system accounts — including `investor_capital`,
 * `investor_payable` and `profit_distribution`. A fixture that inserted its own
 * would be testing a chart production does not have.
 */

const MIGRATIONS = [
  '0058_investors_schema.sql',
  '0059_investors_policies.sql',
  '0060_investors_integrity.sql',
] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the
  // repository root as cwd, but a suite run from `apps/server` must find the same
  // files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyInvestorMigrations(): Promise<void> {
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('investors') is not null as present`,
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

/** A seeded account of one subtype, which every posting rule needs by id. */
export async function accountIdBySubtype(orgId: string, subtype: string): Promise<string> {
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

/**
 * One investor, written directly.
 *
 * A fixture rather than the production path, because the suites that need an
 * investor are testing what happens *to* one. Written as `erp_owner` inside the
 * org's context, so RLS applies exactly as it does to the application — an
 * uncontexted insert fails, which is itself a small check that 0059's policies are
 * on.
 */
export async function seedInvestor(
  orgId: string,
  input: {
    readonly code: string;
    readonly name: string;
    readonly shareBps?: number;
    readonly userId?: string;
    readonly joinedOn?: string;
  },
): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into investors.investors
          (org_id, code, name, share_bps, user_id, joined_on, created_by)
        values (${orgId}, ${input.code}, ${input.name}, ${input.shareBps ?? 0},
                ${input.userId ?? null}, ${input.joinedOn ?? '2025-01-01'}::date, 'seed')
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('inserting an investor returned no id');
      return id;
    },
    { orgId },
  );
}

/**
 * A stored, private file, as the upload flow would leave it.
 *
 * The id is generated here rather than by the database because `files.objects` has
 * a CHECK that the storage key contains the row's own id (§22): a key built from
 * anything else is refused, which is the point of that constraint.
 */
export async function seedFileObject(
  orgId: string,
  input: {
    readonly ownerUserId: string;
    readonly purpose?: string;
    readonly visibility?: 'private' | 'public';
  },
): Promise<string> {
  const id = randomUUID();
  const visibility = input.visibility ?? 'private';
  const key = `${visibility}/${orgId}/${id}.pdf`;
  return withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into files.objects
          (id, org_id, purpose, visibility, status, storage_key, driver, mime, sha256, size_bytes,
           original_name, owner_user_id)
        values (${id}, ${orgId}, ${input.purpose ?? 'investor-document'},
                ${visibility}::files.file_visibility, 'stored', ${key}, 'local', 'application/pdf',
                ${'a'.repeat(64)}, 4096, 'agreement.pdf', ${input.ownerUserId})
      `);
      return id;
    },
    { orgId },
  );
}
