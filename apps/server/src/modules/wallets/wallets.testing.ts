import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Test-only setup for the wallets suites, following `catalog.testing.ts`.
 *
 * Two jobs, and both exist because of how this session is split rather than because
 * of anything about wallets:
 *
 * 1. **Apply the migrations.** `packages/db/migrations/meta/_journal.json` is the
 *    file the Drizzle migrator reads to decide what to run, and it is edited by
 *    several milestones at once — so M08's four files are handed to the integrator
 *    as INTEGRATION lines instead of appended here, and until they are appended
 *    `startTestDatabase()`'s `migrate()` does not run them. The statements are
 *    exactly the files that ship, split on the marker the migrator splits on, so
 *    this runs the real migrations rather than a fixture that could drift from them.
 *    Once the journal carries them this becomes a no-op: the schema already exists
 *    and the guard returns early.
 * 2. **Register a wallet.** `POST /v1/accounts/wallets` is `create Wallet`, which
 *    §6 gives to accounts alone — so a suite that needs a wallet to *exist* before
 *    it tests who may touch one cannot get there through the API without first
 *    assuming the answer. The row is written directly instead. A fixture, not a
 *    production path, which is why it lives here and not in the service.
 *
 * `wallets.e2e.test.ts` has its own copy of the migration step and keeps it: that
 * suite is M08's own and is asserted against, and rewriting it is not this file's
 * business.
 */

const MIGRATIONS = [
  '0027_wallets_schema.sql',
  '0028_wallets_policies.sql',
  '0029_wallets_integrity.sql',
  // The analytics role's read of the ledger (§5 exception 3).
  '0030_ledger_analytics_reads.sql',
] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the
  // repository root as cwd, but a suite run from `apps/server` must find the same
  // files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyWalletsMigrations(): Promise<void> {
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('wallets') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (already) return;

  const directory = migrationsDir();
  for (const name of MIGRATIONS) {
    const contents = await readFile(path.join(directory, name), 'utf8');
    // Comment-only fragments are valid no-op statements, so they need no filtering.
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

export interface SeededWallet {
  readonly id: string;
  readonly ledgerAccountId: string;
  readonly branchId: string | null;
}

/**
 * Register a wallet on one of the seed's `wallet_*` accounts, by its code.
 *
 * The branch is taken from the ledger account rather than passed in, because
 * `wallets.assert_wallet_account()` refuses a wallet whose branch differs from its
 * account's — hand cash is per branch (§7) and a bank account is org-level, and a
 * caller guessing wrong would get a trigger error instead of a wallet.
 *
 * Written as `erp_owner` inside the org's context, so RLS applies exactly as it does
 * to the application: an uncontexted insert would fail, which is itself a small
 * check that this milestone's policies are on.
 */
export async function seedWallet(
  orgId: string,
  accountCode: string,
  options: { readonly provider?: string; readonly requiresDailyClosing?: boolean } = {},
): Promise<SeededWallet> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{
        id: string;
        ledger_account_id: string;
        branch_id: string | null;
      }>(sql`
        insert into wallets.wallets
          (org_id, ledger_account_id, branch_id, provider, requires_daily_closing)
        select ${orgId}, a.id, a.branch_id, ${options.provider ?? null},
               ${options.requiresDailyClosing ?? true}
        from ledger.accounts a
        where a.org_id = ${orgId} and a.code = ${accountCode}
        on conflict (org_id, ledger_account_id) do update set provider = excluded.provider
        returning id, ledger_account_id, branch_id
      `);

      const row = rows[0];
      if (row === undefined) {
        // No row means the SELECT found no account: the seed's chart has no such
        // code in this org. Said plainly, because the alternative symptom is a
        // fixture pointing at an empty string.
        throw new Error(`the seed has no ledger account ${accountCode} in ${orgId}`);
      }
      return { id: row.id, ledgerAccountId: row.ledger_account_id, branchId: row.branch_id };
    },
    { orgId },
  );
}
