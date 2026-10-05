import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the wallets module runs (tenancy rules: raw SQL lives in
 * repositories, parameterised, never built by string interpolation).
 *
 * All of it runs inside a caller's `withOrg()` transaction. The consolidated reads
 * across brands left with M31 (D-471): a brand's ERP runs on its own database.
 *
 * **No statement in this file reads a stored balance, because there is not one.**
 * A wallet's balance is `Σ debit − Σ credit` over its account's journal lines,
 * computed here on every read (M08 check 1).
 */

// --- wallets -----------------------------------------------------------------

export interface WalletRow extends Record<string, unknown> {
  readonly id: string;
  readonly ledger_account_id: string;
  readonly branch_id: string | null;
  readonly provider: string | null;
  readonly account_ref_masked: string | null;
  readonly requires_daily_closing: boolean;
  readonly is_active: boolean;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  /**
   * Whether the *ledger account* behind the wallet is still active.
   *
   * Separate from `is_active`, which is the wallet's own flag, because the two can
   * disagree: an account deactivated in the chart leaves a wallet that still looks
   * usable, and a settlement posted into it is money that reconciles against nothing.
   * `wallets.api.ts` refuses on either.
   */
  readonly account_is_active: boolean;
}

const WALLET_COLUMNS = sql`w.id, w.ledger_account_id, w.branch_id, w.provider,
  w.account_ref_masked, w.requires_daily_closing, w.is_active,
  a.code, a.name, a.subtype::text as subtype, a.is_active as account_is_active`;

export async function listWallets(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly includeInactive: boolean },
): Promise<WalletRow[]> {
  const rows = await tx.execute<WalletRow>(sql`
    select ${WALLET_COLUMNS}
    from wallets.wallets w
    join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
    where w.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.includeInactive ? sql`true` : sql`w.is_active`}
    order by a.code
  `);
  return [...rows];
}

export async function walletById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<WalletRow | undefined> {
  const rows = await tx.execute<WalletRow>(sql`
    select ${WALLET_COLUMNS}
    from wallets.wallets w
    join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
    where w.org_id = ${orgId} and w.id = ${id}
  `);
  return rows[0];
}

/** Wallets whose ledger account carries one of these codes (M14a's wallet balances). */
export async function walletsByAccountCodes(
  tx: Tx,
  orgId: string,
  codes: readonly string[],
): Promise<WalletRow[]> {
  if (codes.length === 0) return [];
  const rows = await tx.execute<WalletRow>(sql`
    select ${WALLET_COLUMNS}
    from wallets.wallets w
    join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
    where w.org_id = ${orgId} and a.code = any (${sql.param([...new Set(codes)])}::text[])
  `);
  return [...rows];
}

export interface NewWallet {
  readonly orgId: string;
  readonly ledgerAccountId: string;
  readonly branchId: string | null;
  readonly provider: string | null;
  readonly accountRefMasked: string | null;
  readonly requiresDailyClosing: boolean;
}

export async function insertWallet(tx: Tx, wallet: NewWallet): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into wallets.wallets
      (org_id, ledger_account_id, branch_id, provider, account_ref_masked, requires_daily_closing)
    values (${wallet.orgId}, ${wallet.ledgerAccountId}, ${wallet.branchId}::uuid,
            ${wallet.provider}, ${wallet.accountRefMasked}, ${wallet.requiresDailyClosing})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a wallet returned no id');
  return id;
}

export async function updateWallet(
  tx: Tx,
  orgId: string,
  id: string,
  patch: {
    readonly provider?: string | null;
    readonly requiresDailyClosing?: boolean;
    readonly isActive?: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    update wallets.wallets
    set provider = ${patch.provider === undefined ? sql`provider` : sql`${patch.provider}`},
        requires_daily_closing = ${
          patch.requiresDailyClosing === undefined
            ? sql`requires_daily_closing`
            : sql`${patch.requiresDailyClosing}`
        },
        is_active = ${patch.isActive === undefined ? sql`is_active` : sql`${patch.isActive}`},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/**
 * Create a wallet's ledger account.
 *
 * A documented exception to invariant 12, and the narrowest one that works
 * (D-121). §7 says an org may add accounts but never delete one, and the wallet
 * setup screen is the only place in the product where that happens: registering a
 * second bank account or a Nagad wallet has to create the `wallet_*` account its
 * balance will be derived from. The alternatives were worse — a `LedgerApi` method
 * added to another milestone's module while both are in flight, or a wallet whose
 * "account" is a free-text label with no double entry behind it.
 *
 * The exception is bounded to four subtypes, all of them wallets, and everything
 * else about the account follows from the subtype rather than from the caller: its
 * class, its normal balance and its party type are not a client's to choose. The
 * insert is `on conflict (org_id, code) do nothing` so re-registering a wallet is
 * not a way to fork the chart of accounts.
 */
export interface NewLedgerAccount {
  readonly orgId: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly class: string;
  readonly normalBalance: 'debit' | 'credit';
  readonly branchId: string | null;
}

export async function insertLedgerAccount(
  tx: Tx,
  account: NewLedgerAccount,
): Promise<{ id: string } | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance, branch_id)
    values (${account.orgId}, ${account.code}, ${account.name},
            ${account.class}::ledger.account_class, ${account.subtype}::ledger.account_subtype,
            ${account.normalBalance}::ledger.normal_balance, ${account.branchId}::uuid)
    on conflict (org_id, code) do nothing
    returning id
  `);
  return rows[0];
}

export async function accountByCode(
  tx: Tx,
  orgId: string,
  code: string,
): Promise<{ id: string; subtype: string } | undefined> {
  const rows = await tx.execute<{ id: string; subtype: string }>(sql`
    select id, subtype::text as subtype from ledger.accounts
    where org_id = ${orgId} and code = ${code}
  `);
  return rows[0];
}

/** One account, by id, with everything a posting rule needs from it. */
export interface CategoryRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly class: string;
  readonly subtype: string;
  readonly branch_id: string | null;
  readonly is_active: boolean;
}

export async function accountById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CategoryRow | undefined> {
  const rows = await tx.execute<CategoryRow>(sql`
    select id, code, name, class::text as class, subtype::text as subtype, branch_id, is_active
    from ledger.accounts
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

/** The org's categories: the income and expense accounts a cash entry can name. */
export async function listCategories(tx: Tx, orgId: string, scope: SQL): Promise<CategoryRow[]> {
  const rows = await tx.execute<CategoryRow>(sql`
    select id, code, name, class::text as class, subtype::text as subtype, branch_id, is_active
    from ledger.accounts
    where org_id = ${orgId}
      and ${scope}
      and is_active
      and subtype::text in ('other_income', 'operating_expense', 'ad_spend')
    order by class, code
  `);
  return [...rows];
}

/** The account a subtype is kept on, when the org has exactly one of them. */
export async function accountBySubtype(
  tx: Tx,
  orgId: string,
  subtype: string,
): Promise<CategoryRow | undefined> {
  const rows = await tx.execute<CategoryRow>(sql`
    select id, code, name, class::text as class, subtype::text as subtype, branch_id, is_active
    from ledger.accounts
    where org_id = ${orgId} and subtype::text = ${subtype} and is_active and branch_id is null
    order by code
    limit 1
  `);
  return rows[0];
}

// --- derived balances --------------------------------------------------------

export interface AccountBalanceRow extends Record<string, unknown> {
  readonly account_id: string;
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

/**
 * `Σ debit` and `Σ credit` per account on or before a business date.
 *
 * The whole of a wallet balance, and the reason there is no balance column. A
 * caller adds these into the account's normal side with `aggregateBalanceOf`.
 */
export async function balancesAsOf(
  tx: Tx,
  orgId: string,
  asOf: string,
  accountIds: readonly string[],
): Promise<AccountBalanceRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await tx.execute<AccountBalanceRow>(sql`
    select l.account_id,
           coalesce(sum(l.debit_poisha), 0)::text as debit_poisha,
           coalesce(sum(l.credit_poisha), 0)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    where l.org_id = ${orgId}
      and j.business_date <= ${asOf}
      and l.account_id = any (${sql.param([...accountIds])}::uuid[])
    group by l.account_id
  `);
  return [...rows];
}

// --- cash entries ------------------------------------------------------------

export interface CashEntryRow extends Record<string, unknown> {
  readonly id: string;
  readonly wallet_id: string;
  readonly branch_id: string | null;
  readonly kind: string;
  readonly status: string;
  readonly category_account_id: string;
  readonly category_code: string;
  readonly category_name: string;
  readonly amount_poisha: string;
  readonly occurred_at: string;
  readonly business_date: string;
  readonly memo: string | null;
  readonly receipt_file_id: string | null;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly created_by: string;
}

const CASH_ENTRY_COLUMNS = sql`e.id, e.wallet_id, e.branch_id, e.kind::text as kind,
  e.status::text as status, e.category_account_id, a.code as category_code, a.name as category_name,
  e.amount_poisha::text as amount_poisha, e.occurred_at::text as occurred_at,
  to_char(e.business_date, 'YYYY-MM-DD') as business_date,
  e.memo, e.receipt_file_id, e.approval_request_id, e.journal_id, e.created_by`;

export interface NewCashEntry {
  readonly orgId: string;
  readonly id: string;
  readonly walletId: string;
  readonly branchId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly categoryAccountId: string;
  readonly amountPoisha: bigint;
  readonly occurredAt: Date;
  readonly businessDate: string;
  readonly memo: string | null;
  readonly receiptFileId: string | null;
  readonly approvalRequestId: string | null;
  readonly journalId: string | null;
  readonly createdBy: string;
}

/**
 * Serialise one person's petty-cash-ruled entries on one business day (C7, D-415).
 *
 * Taken before the day's total is read and held until the entry is written, so two entries
 * sent at once each count the other.
 */
export async function lockPettyCashDay(
  tx: Tx,
  orgId: string,
  createdBy: string,
  businessDate: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`wallets.petty-cash-day:${orgId}:${createdBy}:${businessDate}`}, 0))`,
  );
}

/**
 * What one person spent today, under petty cash's rules, without a checker (C7, D-415):
 * their posted entries of these kinds that carry no approval, from any wallet.
 */
export async function unheldEntriesToday(
  tx: Tx,
  orgId: string,
  filter: {
    readonly createdBy: string;
    readonly kinds: readonly ('petty_cash' | 'cash_out')[];
    readonly businessDate: string;
  },
): Promise<bigint> {
  const rows = await tx.execute<{ total: string }>(sql`
    select coalesce(sum(e.amount_poisha), 0)::text as total
    from wallets.cash_entries e
    where e.org_id = ${orgId}
      and e.created_by = ${filter.createdBy}
      and e.kind::text = any (${sql.param([...filter.kinds])}::text[])
      and e.business_date = ${filter.businessDate}
      and e.status = 'posted'::wallets.cash_entry_status
      and e.approval_request_id is null
  `);
  return BigInt(rows[0]?.total ?? '0');
}

export async function insertCashEntry(tx: Tx, entry: NewCashEntry): Promise<void> {
  await tx.execute(sql`
    insert into wallets.cash_entries
      (id, org_id, branch_id, wallet_id, kind, status, category_account_id, amount_poisha,
       occurred_at, business_date, memo, receipt_file_id, approval_request_id, journal_id,
       created_by)
    values (${entry.id}, ${entry.orgId}, ${entry.branchId}::uuid, ${entry.walletId},
            ${entry.kind}::wallets.cash_entry_kind, ${entry.status}::wallets.cash_entry_status,
            ${entry.categoryAccountId}, ${entry.amountPoisha.toString()}::bigint,
            ${entry.occurredAt.toISOString()}::timestamptz, ${entry.businessDate},
            ${entry.memo}, ${entry.receiptFileId}::uuid, ${entry.approvalRequestId}::uuid,
            ${entry.journalId}::uuid, ${entry.createdBy})
  `);
}

export async function cashEntryById(
  tx: Tx,
  orgId: string,
  id: string,
  lock = false,
): Promise<CashEntryRow | undefined> {
  const rows = await tx.execute<CashEntryRow>(sql`
    select ${CASH_ENTRY_COLUMNS}
    from wallets.cash_entries e
    join ledger.accounts a on a.org_id = e.org_id and a.id = e.category_account_id
    where e.org_id = ${orgId} and e.id = ${id}
    ${lock ? sql`for no key update of e` : sql``}
  `);
  return rows[0];
}

export async function listCashEntries(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly from: string | undefined;
    readonly to: string;
    readonly walletId: string | undefined;
    readonly status: string | undefined;
    readonly limit: number;
  },
): Promise<CashEntryRow[]> {
  const rows = await tx.execute<CashEntryRow>(sql`
    select ${CASH_ENTRY_COLUMNS}
    from wallets.cash_entries e
    join ledger.accounts a on a.org_id = e.org_id and a.id = e.category_account_id
    where e.org_id = ${orgId}
      and ${filters.scope}
      and e.business_date <= ${filters.to}
      and ${filters.from === undefined ? sql`true` : sql`e.business_date >= ${filters.from}`}
      and ${filters.walletId === undefined ? sql`true` : sql`e.wallet_id = ${filters.walletId}`}
      and ${
        filters.status === undefined
          ? sql`true`
          : sql`e.status = ${filters.status}::wallets.cash_entry_status`
      }
    order by e.business_date desc, e.created_at desc
    limit ${filters.limit}
  `);
  return [...rows];
}

/** Settle a waiting entry: posted with its journal, or rejected. 0029 allows only this. */
export async function settleCashEntry(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: { readonly status: 'posted' | 'rejected'; readonly journalId: string | null },
): Promise<void> {
  await tx.execute(sql`
    update wallets.cash_entries
    set status = ${outcome.status}::wallets.cash_entry_status,
        journal_id = ${outcome.journalId}::uuid,
        updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'pending_approval'
  `);
}

/**
 * A receipt photo's file row, for the checks the trigger in 0029 cannot explain.
 *
 * Reads `files.objects` directly rather than through the files service, and this
 * is the narrow kind of cross-module read invariant 12 allows: three columns of
 * metadata inside the caller's own transaction, so the entry and its receipt
 * commit together. Everything that *serves* a file — authorizing the purpose,
 * signing a URL — stays in the files module, which is where the bytes are.
 */
export async function receiptFile(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<
  | {
      id: string;
      purpose: string;
      visibility: string;
      status: string;
      owner_user_id: string | null;
      /** The cash entry this receipt already backs, if any. */
      used_by_entry_id: string | null;
    }
  | undefined
> {
  const rows = await tx.execute<{
    id: string;
    purpose: string;
    visibility: string;
    status: string;
    owner_user_id: string | null;
    used_by_entry_id: string | null;
  }>(sql`
    select f.id, f.purpose, f.visibility::text as visibility, f.status::text as status,
           f.owner_user_id,
           (select c.id from wallets.cash_entries c
             where c.org_id = f.org_id and c.receipt_file_id = f.id
             limit 1) as used_by_entry_id
    from files.objects f
    where f.org_id = ${orgId} and f.id = ${id}
  `);
  return rows[0];
}

// --- transfers ---------------------------------------------------------------

export interface NewTransfer {
  readonly orgId: string;
  readonly id: string;
  readonly fromWalletId: string;
  readonly toWalletId: string;
  readonly amountPoisha: bigint;
  readonly chargePoisha: bigint;
  readonly chargeAccountId: string | null;
  readonly occurredAt: Date;
  readonly businessDate: string;
  readonly memo: string | null;
  readonly journalId: string;
  readonly createdBy: string;
}

export async function insertTransfer(tx: Tx, transfer: NewTransfer): Promise<void> {
  await tx.execute(sql`
    insert into wallets.transfers
      (id, org_id, from_wallet_id, to_wallet_id, amount_poisha, charge_poisha, charge_account_id,
       occurred_at, business_date, memo, journal_id, created_by)
    values (${transfer.id}, ${transfer.orgId}, ${transfer.fromWalletId}, ${transfer.toWalletId},
            ${transfer.amountPoisha.toString()}::bigint, ${transfer.chargePoisha.toString()}::bigint,
            ${transfer.chargeAccountId}::uuid, ${transfer.occurredAt.toISOString()}::timestamptz,
            ${transfer.businessDate}, ${transfer.memo}, ${transfer.journalId},
            ${transfer.createdBy})
  `);
}

export async function transferById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<TransferRow | undefined> {
  // The stored amounts come back too, so a replay can be *compared* rather than
  // echoed. The generic is intersected with `Record<string, unknown>` because
  // `tx.execute` constrains it that way and an interface — which the lint rule
  // requires here — carries no implicit index signature. Answering a retry with the request's own numbers told an operator that
  // ৳9,000 had moved when ৳50 had — see the conflict check in `transfers.service.ts`.
  const rows = await tx.execute<TransferRow & Record<string, unknown>>(sql`
    select id, journal_id, to_char(business_date, 'YYYY-MM-DD') as business_date,
           from_wallet_id, to_wallet_id,
           amount_poisha::text as amount_poisha, charge_poisha::text as charge_poisha
    from wallets.transfers where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export interface TransferRow {
  readonly id: string;
  readonly journal_id: string;
  readonly business_date: string;
  readonly from_wallet_id: string;
  readonly to_wallet_id: string;
  readonly amount_poisha: string;
  readonly charge_poisha: string;
}

// --- closings ----------------------------------------------------------------

export interface ClosingRow extends Record<string, unknown> {
  readonly id: string;
  readonly wallet_id: string;
  readonly branch_id: string | null;
  readonly business_date: string;
  readonly expected_poisha: string;
  readonly counted_poisha: string;
  readonly variance_poisha: string;
  readonly status: string;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly counted_by: string;
}

const CLOSING_COLUMNS = sql`c.id, c.wallet_id, c.branch_id,
  to_char(c.business_date, 'YYYY-MM-DD') as business_date,
  c.expected_poisha::text as expected_poisha, c.counted_poisha::text as counted_poisha,
  c.variance_poisha::text as variance_poisha, c.status::text as status, c.approval_request_id,
  c.journal_id, c.counted_by`;

export interface NewClosing {
  readonly orgId: string;
  readonly id: string;
  readonly walletId: string;
  readonly branchId: string | null;
  readonly businessDate: string;
  readonly expectedPoisha: bigint;
  readonly countedPoisha: bigint;
  readonly variancePoisha: bigint;
  readonly status: string;
  readonly approvalRequestId: string | null;
  readonly journalId: string | null;
  readonly countedBy: string;
}

export async function insertClosing(tx: Tx, closing: NewClosing): Promise<void> {
  await tx.execute(sql`
    insert into wallets.closings
      (id, org_id, branch_id, wallet_id, business_date, expected_poisha, counted_poisha,
       variance_poisha, status, approval_request_id, journal_id, counted_by)
    values (${closing.id}, ${closing.orgId}, ${closing.branchId}::uuid, ${closing.walletId},
            ${closing.businessDate}, ${closing.expectedPoisha.toString()}::bigint,
            ${closing.countedPoisha.toString()}::bigint, ${closing.variancePoisha.toString()}::bigint,
            ${closing.status}::wallets.closing_status, ${closing.approvalRequestId}::uuid,
            ${closing.journalId}::uuid, ${closing.countedBy})
  `);
}

export async function closingById(
  tx: Tx,
  orgId: string,
  id: string,
  lock = false,
): Promise<ClosingRow | undefined> {
  const rows = await tx.execute<ClosingRow>(sql`
    select ${CLOSING_COLUMNS} from wallets.closings c
    where c.org_id = ${orgId} and c.id = ${id}
    ${lock ? sql`for no key update` : sql``}
  `);
  return rows[0];
}

export async function listClosings(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly from: string | undefined; readonly to: string },
): Promise<ClosingRow[]> {
  const rows = await tx.execute<ClosingRow>(sql`
    select ${CLOSING_COLUMNS} from wallets.closings c
    where c.org_id = ${orgId}
      and ${filters.scope}
      and c.business_date <= ${filters.to}
      and ${filters.from === undefined ? sql`true` : sql`c.business_date >= ${filters.from}`}
    order by c.business_date desc, c.created_at desc
    limit 500
  `);
  return [...rows];
}

export async function settleClosing(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: { readonly status: 'posted' | 'rejected'; readonly journalId: string | null },
): Promise<void> {
  await tx.execute(sql`
    update wallets.closings
    set status = ${outcome.status}::wallets.closing_status,
        journal_id = ${outcome.journalId}::uuid,
        updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'pending_approval'
  `);
}

// --- reports ----------------------------------------------------------------

export interface ClassTotalRow extends Record<string, unknown> {
  readonly account_id: string;
  readonly code: string;
  readonly name: string;
  readonly class: string;
  readonly subtype: string;
  readonly normal_balance: 'debit' | 'credit';
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

/**
 * Σ debit and Σ credit per account over a range of business dates, for the P&L.
 *
 * The range matters here in a way it does not for a balance sheet: income and
 * expense are flows, so a P&L is the movement *within* the period, while an asset
 * or liability is a position as of a date.
 */
export async function movementsInRange(
  tx: Tx,
  orgId: string,
  range: { readonly from: string; readonly to: string },
  filters: { readonly lineScope: SQL; readonly classes: readonly string[] },
): Promise<ClassTotalRow[]> {
  const rows = await tx.execute<ClassTotalRow>(sql`
    select a.id as account_id, a.code, a.name, a.class::text as class, a.subtype::text as subtype,
           a.normal_balance::text as normal_balance,
           sum(l.debit_poisha)::text as debit_poisha, sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and j.business_date between ${range.from} and ${range.to}
      and a.class::text = any (${sql.param([...filters.classes])}::text[])
      and ${filters.lineScope}
    group by a.id, a.code, a.name, a.class, a.subtype, a.normal_balance
    order by a.code
  `);
  return [...rows];
}

/** Σ debit and Σ credit per account on or before a date, for the balance sheet. */
export async function positionsAsOf(
  tx: Tx,
  orgId: string,
  asOf: string,
  filters: { readonly lineScope: SQL; readonly classes: readonly string[] },
): Promise<ClassTotalRow[]> {
  const rows = await tx.execute<ClassTotalRow>(sql`
    select a.id as account_id, a.code, a.name, a.class::text as class, a.subtype::text as subtype,
           a.normal_balance::text as normal_balance,
           sum(l.debit_poisha)::text as debit_poisha, sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and j.business_date <= ${asOf}
      and a.class::text = any (${sql.param([...filters.classes])}::text[])
      and ${filters.lineScope}
    group by a.id, a.code, a.name, a.class, a.subtype, a.normal_balance
    order by a.code
  `);
  return [...rows];
}

export interface AgingRow extends Record<string, unknown> {
  readonly party_type: string;
  readonly party_id: string;
  readonly account_id: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly normal_balance: 'debit' | 'credit';
  readonly business_date: string;
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

/**
 * Each party's movements by business date, for §7's aging (D-193).
 *
 * The buckets are not computed here. Aging matches settlements to the oldest
 * amount still open, which is a fold over the days in order, so the query hands
 * back one row per party, account and day and `ageOpenItems` in the domain does
 * the matching. The rows still sum to the party balance the trial balance shows.
 */
export async function agingAsOf(
  tx: Tx,
  orgId: string,
  asOf: string,
  filters: {
    readonly lineScope: SQL;
    readonly classes: readonly string[];
    readonly excludePartyTypes: readonly string[];
  },
): Promise<AgingRow[]> {
  const rows = await tx.execute<AgingRow>(sql`
    select l.party_type::text as party_type, l.party_id, a.id as account_id, a.code, a.name,
           a.subtype::text as subtype, a.normal_balance::text as normal_balance,
           j.business_date::text as business_date,
           sum(l.debit_poisha)::text as debit_poisha, sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and l.party_type is not null
      and j.business_date <= ${asOf}
      and a.class::text = any (${sql.param([...filters.classes])}::text[])
      and ${filters.lineScope}
      and ${
        filters.excludePartyTypes.length === 0
          ? sql`true`
          : sql`l.party_type::text <> all (${sql.param([...filters.excludePartyTypes])}::text[])`
      }
    group by l.party_type, l.party_id, a.id, a.code, a.name, a.subtype, a.normal_balance,
             j.business_date
    order by l.party_type, l.party_id, j.business_date, a.code
  `);
  return [...rows];
}

/**
 * A wallet row for an account, unless one exists (M34's system wallets): `on conflict do
 * nothing` on the one-wallet-per-account index, so two callers racing to set it up both end
 * with the same row.
 */
/**
 * A provider's org-level wallet (a gateway's clearing wallet, M34): the one row
 * `ensureSystemWallet` reuses, found by what it is rather than by the code it was given.
 */
export async function systemWalletByProvider(
  tx: Tx,
  orgId: string,
  provider: string,
  subtype: string,
): Promise<{ ledger_account_id: string } | undefined> {
  const rows = await tx.execute<{ ledger_account_id: string }>(sql`
    select w.ledger_account_id
    from wallets.wallets w
    join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
    where w.org_id = ${orgId} and w.provider = ${provider} and w.branch_id is null
      and a.subtype = ${subtype}::ledger.account_subtype
    order by a.code
    limit 1
  `);
  return rows[0];
}

export async function insertWalletIfMissing(tx: Tx, wallet: NewWallet): Promise<void> {
  await tx.execute(sql`
    insert into wallets.wallets
      (org_id, ledger_account_id, branch_id, provider, account_ref_masked, requires_daily_closing)
    values (${wallet.orgId}, ${wallet.ledgerAccountId}, ${wallet.branchId}::uuid,
            ${wallet.provider}, ${wallet.accountRefMasked}, ${wallet.requiresDailyClosing})
    on conflict (org_id, ledger_account_id) do nothing
  `);
}
