import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from '../approvals/index.js';
import { primaryId, timestamps } from '../columns.js';
import { fileObjects } from '../files/index.js';
import { journals, ledgerAccounts } from '../ledger/index.js';
import { branches, organizations } from '../org/index.js';

/**
 * Wallets and the paperwork behind every movement of cash (architecture §6, §7).
 *
 * ## There is no balance column here, and that is the design
 *
 * A wallet's balance is `Σ debit − Σ credit` over `ledger.journal_lines` for its
 * account, computed on read. A `balance_poisha` column kept in step by
 * application code is the obvious alternative and it is the one failure this
 * milestone exists to avoid: it drifts the first time a journal is posted by a
 * path that forgets to update it, and the drift is silent until somebody counts
 * the till and finds the ERP disagrees with the money in their hand. Deriving it
 * makes the cash book and the ledger the same number by construction rather than
 * by discipline (M08 check 1).
 *
 * So these tables hold only what a journal cannot say: which wallet a person
 * chose, which category, which receipt photo, which approval, and what was
 * counted at close. Every row that moved money names the journal that moved it.
 *
 * Every table is tenant-scoped — `org_id NOT NULL`, indexed, RLS ENABLE and
 * FORCE from `tenantTableSql()` in migration 0028 — and every foreign key
 * between two tenant tables carries `org_id` on both sides (D-047).
 */
export const wallets = pgSchema('wallets');

/** What kind of movement a cash entry is. Decides its posting rule and its paperwork. */
export const cashEntryKind = wallets.enum('cash_entry_kind', [
  /** Money into a wallet against an income category: Dr W / Cr income. */
  'cash_in',
  /** Money out against an expense category: Dr expense / Cr W. */
  'cash_out',
  /**
   * Money out of hand cash for a small operating cost. Same journal as a cash
   * out; different paperwork — a receipt photo is required (check 2) and an
   * amount at or above the org's `wallet_adjustment` threshold waits for a
   * checker before it posts.
   */
  'petty_cash',
]);

/**
 * Where a cash entry stands.
 *
 * `pending_approval` is a request, not a transaction: it has no journal, so it
 * appears in no report and changes no balance. Nothing is posted and then
 * un-posted, because a journal never changes after posting (invariant 2).
 */
export const cashEntryStatus = wallets.enum('cash_entry_status', [
  'pending_approval',
  'posted',
  'rejected',
]);

/** Where a daily closing stands. `balanced` means counted equals derived. */
export const closingStatus = wallets.enum('closing_status', [
  'balanced',
  'pending_approval',
  'posted',
  'rejected',
]);

/**
 * A wallet: hand cash at a branch, a bank account, bKash, or another mobile
 * wallet (§7's `wallet_*` subtypes).
 *
 * A wallet *is* its ledger account, plus the operational facts a chart of
 * accounts has no column for. It deliberately does not repeat the account's
 * subtype: two spellings of "this is a bKash wallet" is one more thing that can
 * disagree, and the report would then have to pick a winner. `branch_id` is the
 * one field that is repeated, because row scope and the composite branch foreign
 * key both need it on this row — so a trigger in migration 0029 holds it equal
 * to the account's own branch rather than trusting the writer.
 */
export const walletAccounts = wallets.table(
  'wallets',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The `wallet_*` ledger account this wallet's balance is derived from. */
    ledgerAccountId: uuid('ledger_account_id').notNull(),
    /** The branch whose till this is. Null for an org-level wallet (bank, bKash). */
    branchId: uuid('branch_id'),
    /** `bKash`, `Nagad`, `BRAC Bank` — a label, for people. */
    provider: text('provider'),
    /**
     * The last digits of the account or wallet number, already masked.
     *
     * Masked on the way in, never on the way out (§25, invariant 10). A full
     * bank account number in a column is a full bank account number in every
     * backup, log line and CSV export that ever touches this table.
     */
    accountRefMasked: text('account_ref_masked'),
    /** Whether this wallet is counted at the end of every business day. */
    requiresDailyClosing: boolean('requires_daily_closing').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index('wallets_org_idx').on(table.orgId),
    index('wallets_org_branch_idx').on(table.orgId, table.branchId),
    // One wallet per ledger account: two wallet rows over one account would
    // show the same money twice in the consolidated total.
    uniqueIndex('wallets_org_account_idx').on(table.orgId, table.ledgerAccountId),
    unique('wallets_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'wallets_org_id_ledger_account_id_fk',
      columns: [table.orgId, table.ledgerAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'wallets_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    check(
      'wallets_provider_length',
      sql`${table.provider} is null or length(${table.provider}) between 1 and 80`,
    ),
    check(
      'wallets_account_ref_length',
      sql`${table.accountRefMasked} is null or length(${table.accountRefMasked}) <= 40`,
    ),
  ],
);

/**
 * One cash in, cash out or petty cash entry.
 *
 * The journal is the transaction; this row is why it exists — which category a
 * person picked, which receipt they photographed, which checker let it through.
 * `journal_id` is null exactly while the entry is waiting for a checker or was
 * rejected, and the CHECK below is what makes "posted with no journal"
 * impossible rather than merely unlikely.
 */
export const cashEntries = wallets.table(
  'cash_entries',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The wallet's branch, copied for row scope (§6 `branch`) and the branch FK. */
    branchId: uuid('branch_id'),
    walletId: uuid('wallet_id').notNull(),
    kind: cashEntryKind('kind').notNull(),
    status: cashEntryStatus('status').notNull(),
    /** The income or expense account this is against: §7's "category". */
    categoryAccountId: uuid('category_account_id').notNull(),
    /** Money is integer poisha (invariant 1). Always positive; `kind` gives direction. */
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The Asia/Dhaka date of `occurred_at`, computed in the domain (invariant 8). */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    memo: text('memo'),
    /**
     * The receipt photo, a **private** file (§22, check 2).
     *
     * NOT NULL for petty cash, by the CHECK below rather than by the service
     * that inserts: "petty cash without a receipt is rejected" has to hold for
     * the next caller of this table too, and a service-only rule is one
     * refactor away from being a comment.
     */
    receiptFileId: uuid('receipt_file_id'),
    approvalRequestId: uuid('approval_request_id'),
    journalId: uuid('journal_id'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('cash_entries_org_idx').on(table.orgId),
    index('cash_entries_org_wallet_date_idx').on(table.orgId, table.walletId, table.businessDate),
    index('cash_entries_org_branch_idx').on(table.orgId, table.branchId),
    index('cash_entries_org_status_idx').on(table.orgId, table.status),
    unique('cash_entries_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'cash_entries_org_id_wallet_id_fk',
      columns: [table.orgId, table.walletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'cash_entries_org_id_category_account_id_fk',
      columns: [table.orgId, table.categoryAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'cash_entries_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'cash_entries_org_id_receipt_file_id_fk',
      columns: [table.orgId, table.receiptFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'cash_entries_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'cash_entries_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('cash_entries_amount_positive', sql`${table.amountPoisha} > 0`),
    // Check 2, in the database.
    check(
      'cash_entries_petty_cash_has_receipt',
      sql`${table.kind} <> 'petty_cash' or ${table.receiptFileId} is not null`,
    ),
    // A posted entry names its journal; one that is waiting names its approval
    // and has no journal at all, so it is in no report and no balance.
    check(
      'cash_entries_status_journal',
      sql`case ${table.status}
            when 'posted' then ${table.journalId} is not null
            when 'pending_approval' then ${table.journalId} is null and ${table.approvalRequestId} is not null
            else ${table.journalId} is null
          end`,
    ),
    check('cash_entries_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

/**
 * A transfer between two of the org's own wallets — cash banked, bKash cashed
 * out, money moved between branches.
 *
 * §7: **Dr W2 (+ Dr Bank charges) / Cr W1.** The charge is a third line on the
 * journal and a column here, because the alternative — netting it into the
 * amount — loses it: ৳5,000 banked with a ৳20 charge becomes "৳4,980
 * transferred", the expense never reaches the P&L, and the two wallets still
 * balance, so nothing complains.
 */
export const walletTransfers = wallets.table(
  'transfers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    fromWalletId: uuid('from_wallet_id').notNull(),
    toWalletId: uuid('to_wallet_id').notNull(),
    /** What the receiving wallet gains. The sending wallet loses this plus the charge. */
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    chargePoisha: bigint('charge_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    /** The `bank_charges` account the charge is debited to. Null when there is none. */
    chargeAccountId: uuid('charge_account_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    memo: text('memo'),
    journalId: uuid('journal_id').notNull(),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('wallet_transfers_org_idx').on(table.orgId),
    index('wallet_transfers_org_date_idx').on(table.orgId, table.businessDate),
    unique('wallet_transfers_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'wallet_transfers_org_id_from_wallet_id_fk',
      columns: [table.orgId, table.fromWalletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'wallet_transfers_org_id_to_wallet_id_fk',
      columns: [table.orgId, table.toWalletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'wallet_transfers_org_id_charge_account_id_fk',
      columns: [table.orgId, table.chargeAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'wallet_transfers_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('wallet_transfers_amount_positive', sql`${table.amountPoisha} > 0`),
    check('wallet_transfers_charge_not_negative', sql`${table.chargePoisha} >= 0`),
    check('wallet_transfers_distinct_wallets', sql`${table.fromWalletId} <> ${table.toWalletId}`),
    // A charge with nowhere to post is a charge that vanishes.
    check(
      'wallet_transfers_charge_has_account',
      sql`(${table.chargePoisha} > 0) = (${table.chargeAccountId} is not null)`,
    ),
    check(
      'wallet_transfers_memo_length',
      sql`${table.memo} is null or length(${table.memo}) <= 500`,
    ),
  ],
);

/**
 * The end of a business day for one wallet: what the ledger says, what was
 * counted, and the difference.
 *
 * `expected_poisha` is stored, and it is the one derived number that is worth
 * keeping: it is evidence about what the books said *at the moment of the
 * count*, which is what an argument about a shortfall is actually about. It is
 * not read back as a balance — reports always re-derive — so it cannot drift
 * into being the truth.
 *
 * A non-zero variance never posts by itself. It raises a `closing_variance`
 * approval (§6 maker-checker) and posts to cash over/short only when a checker
 * decides it (check 4).
 */
export const walletClosings = wallets.table(
  'closings',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id'),
    walletId: uuid('wallet_id').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** The derived ledger balance at the close, recorded as evidence. */
    expectedPoisha: bigint('expected_poisha', { mode: 'bigint' }).notNull(),
    countedPoisha: bigint('counted_poisha', { mode: 'bigint' }).notNull(),
    /** `counted − expected`: positive is cash over, negative is cash short. */
    variancePoisha: bigint('variance_poisha', { mode: 'bigint' }).notNull(),
    status: closingStatus('status').notNull(),
    approvalRequestId: uuid('approval_request_id'),
    journalId: uuid('journal_id'),
    countedBy: text('counted_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('wallet_closings_org_idx').on(table.orgId),
    index('wallet_closings_org_branch_idx').on(table.orgId, table.branchId),
    // One close per wallet per day. A second count of the same till on the same
    // day is an amendment, and an amendment to a posted variance is a reversal.
    uniqueIndex('wallet_closings_org_wallet_date_idx').on(
      table.orgId,
      table.walletId,
      table.businessDate,
    ),
    unique('wallet_closings_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'wallet_closings_org_id_wallet_id_fk',
      columns: [table.orgId, table.walletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'wallet_closings_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'wallet_closings_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'wallet_closings_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check(
      'wallet_closings_variance_is_difference',
      sql`${table.variancePoisha} = ${table.countedPoisha} - ${table.expectedPoisha}`,
    ),
    check('wallet_closings_counted_not_negative', sql`${table.countedPoisha} >= 0`),
    // A balanced close has nothing to post; a posted one names its journal; one
    // waiting for a checker names its approval and has no journal.
    check(
      'wallet_closings_status_shape',
      sql`case ${table.status}
            when 'balanced' then ${table.variancePoisha} = 0 and ${table.journalId} is null
            when 'posted' then ${table.variancePoisha} <> 0 and ${table.journalId} is not null
            when 'pending_approval' then ${table.variancePoisha} <> 0 and ${table.journalId} is null
                 and ${table.approvalRequestId} is not null
            else ${table.journalId} is null
          end`,
    ),
  ],
);
