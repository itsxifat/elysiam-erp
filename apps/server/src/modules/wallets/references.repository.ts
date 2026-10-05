import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What the wallets module holds for a branch's switch-off and for the brand's own expense
 * and income heads (M39a, D-633, D-634).
 *
 * The heads are `ledger.accounts` rows of the two category subtypes, written here under the
 * documented exception D-121 already makes for wallets: the wallets module adds accounts and
 * never deletes one (§7). `ledger.accounts` has no DELETE grant; a head is archived.
 */

/**
 * The branch's wallet accounts that still hold money (any balance but zero, all time).
 *
 * Every wallet-subtype ledger account of the branch, whether or not a `wallets.wallets` row
 * names it: the seed makes each branch's hand-cash account before any wallet row, and payroll
 * and loans pay out through a wallet account by id (ledger audit W2).
 */
export async function walletsHoldingMoney(
  tx: Tx,
  orgId: string,
  branchId: string,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n
    from ledger.accounts a
    where a.org_id = ${orgId} and a.branch_id = ${branchId}
      and a.subtype::text in ('wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other')
      and coalesce((
        select sum(l.debit_poisha) - sum(l.credit_poisha) from ledger.journal_lines l
        where l.org_id = a.org_id and l.account_id = a.id
      ), 0) <> 0
  `);
  return rows[0]?.n ?? 0;
}

// --- expense and income heads --------------------------------------------------------------

export interface HeadRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly is_active: boolean;
  readonly is_system: boolean;
}

/** Every head a cash entry could name, archived ones too (for the setup screen). */
export async function heads(tx: Tx, orgId: string): Promise<HeadRow[]> {
  const rows = await tx.execute<HeadRow>(sql`
    select id, code, name, subtype::text as subtype, is_active, is_system
    from ledger.accounts
    where org_id = ${orgId} and branch_id is null
      and subtype::text in ('other_income', 'operating_expense')
    order by subtype, code
  `);
  return [...rows];
}

export async function lockHead(tx: Tx, orgId: string, id: string): Promise<HeadRow | undefined> {
  const rows = await tx.execute<HeadRow>(sql`
    select id, code, name, subtype::text as subtype, is_active, is_system
    from ledger.accounts
    where org_id = ${orgId} and id = ${id} and branch_id is null
      and subtype::text in ('other_income', 'operating_expense')
    for update
  `);
  return rows[0];
}

/** The next free code in a head range (`4500`–`4599` income, `5900`–`5999` expense). */
export async function nextHeadCode(
  tx: Tx,
  orgId: string,
  from: number,
  to: number,
): Promise<string | undefined> {
  const rows = await tx.execute<{ code: string }>(sql`
    select candidate::text as code
    from generate_series(${from}::int, ${to}::int) as candidate
    where not exists (
      select 1 from ledger.accounts a where a.org_id = ${orgId} and a.code = candidate::text
    )
    order by candidate
    limit 1
  `);
  return rows[0]?.code;
}

export async function insertHead(
  tx: Tx,
  orgId: string,
  head: { readonly code: string; readonly name: string; readonly kind: 'income' | 'expense' },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance)
    values (${orgId}, ${head.code}, ${head.name},
            ${head.kind}::ledger.account_class,
            ${head.kind === 'income' ? 'other_income' : 'operating_expense'}::ledger.account_subtype,
            ${head.kind === 'income' ? 'credit' : 'debit'}::ledger.normal_balance)
    on conflict (org_id, code) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function updateHead(
  tx: Tx,
  orgId: string,
  id: string,
  patch: { readonly name?: string | undefined; readonly isActive?: boolean | undefined },
): Promise<void> {
  await tx.execute(sql`
    update ledger.accounts
    set name = coalesce(${patch.name ?? null}, name),
        is_active = coalesce(${patch.isActive ?? null}::boolean, is_active),
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/** How many journal lines a head carries (posted to: it is part of the books). */
export async function headLines(tx: Tx, orgId: string, id: string): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ledger.journal_lines where org_id = ${orgId} and account_id = ${id}
  `);
  return rows[0]?.n ?? 0;
}
