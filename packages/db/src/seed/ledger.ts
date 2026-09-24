import { sql } from 'drizzle-orm';

import { withSystem, type Tx } from '../client.js';
import { branchCashCode, COA_TEMPLATE } from './coa-template.js';
import { deterministicUuid } from './orgs.js';

/**
 * Seed one org's chart of accounts (architecture §7, M03).
 *
 * Idempotent like the rest of the seed: account ids derive from the org and
 * the code, and every insert is an upsert on `(org_id, code)` that touches
 * only the name. The database refuses any change to what an account *is*
 * (0014), so an upsert that tried would fail loudly rather than quietly
 * rewrite history.
 */

const ACCOUNT_NAMESPACE = 'elysium-erp/account';

export function seedAccountId(orgId: string, code: string): string {
  return deterministicUuid(ACCOUNT_NAMESPACE, `${orgId}:${code}`);
}

async function upsertAccount(
  tx: Tx,
  orgId: string,
  account: {
    code: string;
    name: string;
    subtype: string;
    class: string;
    normalBalance: string;
    party: string | null;
    branchId: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into ledger.accounts
      (id, org_id, code, name, class, subtype, normal_balance, branch_id, party_type, is_system)
    values (
      ${seedAccountId(orgId, account.code)},
      ${orgId},
      ${account.code},
      ${account.name},
      ${account.class}::ledger.account_class,
      ${account.subtype}::ledger.account_subtype,
      ${account.normalBalance}::ledger.normal_balance,
      ${account.branchId}::uuid,
      ${account.party}::ledger.party_type,
      true
    )
    on conflict (org_id, code) do update
      set name = excluded.name, updated_at = now()
      where ledger.accounts.name is distinct from excluded.name
  `);
}

/**
 * Hand-cash wallets for every branch of the org that lacks one (§7:
 * `wallet_cash` per branch). Runs inside the caller's org-scoped transaction,
 * so it is also what a branch-creation flow calls once one exists.
 */
export async function ensureBranchWallets(tx: Tx, orgId: string): Promise<void> {
  const branchRows = await tx.execute<{ id: string; code: string; name: string }>(
    sql`select id, code, name from org.branches where org_id = ${orgId} order by code`,
  );
  for (const branch of branchRows) {
    const code = branchCashCode(branch.code);
    // Two branch codes that sanitise to the same account code would share a
    // wallet. Refuse rather than let one showroom's cash land in another's.
    const clash = await tx.execute<{ branch_id: string | null }>(
      sql`select branch_id from ledger.accounts where org_id = ${orgId} and code = ${code}`,
    );
    const owner = clash[0]?.branch_id;
    if (owner !== undefined && owner !== branch.id) {
      throw new Error(`Account code ${code} already belongs to another branch's wallet.`);
    }
    await upsertAccount(tx, orgId, {
      code,
      name: `Hand cash — ${branch.name}`,
      subtype: 'wallet_cash',
      class: 'asset',
      normalBalance: 'debit',
      party: null,
      branchId: branch.id,
    });
  }
}

export async function seedChartOfAccounts(orgId: string): Promise<number> {
  return withSystem(
    async (tx) => {
      for (const account of COA_TEMPLATE) {
        await upsertAccount(tx, orgId, { ...account, branchId: null });
      }
      await ensureBranchWallets(tx, orgId);

      const rows = await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from ledger.accounts`,
      );
      return Number(rows[0]?.count ?? 0);
    },
    { orgId },
  );
}
