import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from '../approvals/index.js';
import { primaryId, timestamps } from '../columns.js';
import { branches, organizations } from '../org/index.js';

/**
 * The double-entry ledger (architecture §7).
 *
 * Drizzle declares the tables, keys and CHECKs. What makes the ledger one the
 * database itself refuses to corrupt lives in the hand-written migration next
 * to the generated one, because Drizzle cannot express it:
 *
 * - deferred constraint triggers: every journal has ≥ 2 lines and balances;
 * - `erp_app` holds INSERT and SELECT only on journals and lines, and a
 *   trigger refuses UPDATE and DELETE for every role;
 * - a line can only be added in the transaction that created its journal;
 * - the period lock, and the rules for closing and reopening a period.
 *
 * Every foreign key between two tenant tables carries `org_id` (D-047).
 */
export const ledger = pgSchema('ledger');

/** Kept in step with `ACCOUNT_CLASSES` in @elysium/domain by a test. */
export const accountClass = ledger.enum('account_class', [
  'asset',
  'liability',
  'equity',
  'income',
  'expense',
]);

/** Kept in step with `ACCOUNT_SUBTYPES` in @elysium/domain by a test. */
export const accountSubtype = ledger.enum('account_subtype', [
  'wallet_cash',
  'wallet_bank',
  'wallet_bkash',
  'wallet_mfs_other',
  'courier_receivable',
  'inventory',
  'goods_in_transit',
  'supplier_advance',
  'employee_loan_receivable',
  'other_receivable',
  'supplier_payable',
  'reseller_payable',
  'salary_payable',
  'investor_payable',
  'loan_payable',
  'customer_advance',
  'other_payable',
  'owner_capital',
  'investor_capital',
  'retained_earnings',
  'profit_distribution',
  'sales_revenue',
  'sales_discounts',
  'delivery_charge_income',
  'other_income',
  'inventory_adjustment_gain',
  'cogs',
  'courier_charges',
  'return_charges',
  'ad_spend',
  'salary_expense',
  'bonus_expense',
  'interest_expense',
  'inventory_writeoff',
  'purchase_price_variance',
  'cash_over_short',
  'bank_charges',
  'operating_expense',
  // 0080 (M14a, D-213). Appended, because `ALTER TYPE … ADD VALUE` appends.
  'opening_equity',
]);

export const normalBalance = ledger.enum('normal_balance', ['debit', 'credit']);

/** Kept in step with `PARTY_TYPES` in @elysium/domain by a test. */
export const partyType = ledger.enum('party_type', [
  'supplier',
  'courier',
  'reseller',
  'investor',
  'employee',
  'lender',
]);

export const periodStatus = ledger.enum('period_status', ['open', 'closed']);

/**
 * `xid8`: a 64-bit, epoch-extended transaction id that never wraps. Drizzle
 * has no built-in for it.
 */
const xid8 = customType<{ data: string; driverData: string }>({
  dataType: () => 'xid8',
});

export const ledgerAccounts = ledger.table(
  'accounts',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Stable and human-facing: `1010-HQ`, `4300`. Unique within the org. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    class: accountClass('class').notNull(),
    subtype: accountSubtype('subtype').notNull(),
    normalBalance: normalBalance('normal_balance').notNull(),
    /** A branch-level account (a showroom's hand cash). Null for org-level. */
    branchId: uuid('branch_id'),
    /** Every line on this account must name a party of this type. */
    partyType: partyType('party_type'),
    /** Seeded from the template; cannot be deleted (§7). */
    isSystem: boolean('is_system').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('accounts_org_code_idx').on(table.orgId, table.code),
    index('accounts_org_idx').on(table.orgId),
    index('accounts_org_subtype_idx').on(table.orgId, table.subtype),
    index('accounts_branch_idx').on(table.orgId, table.branchId),
    unique('accounts_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'accounts_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    // §7: hand cash is kept per branch.
    check(
      'accounts_wallet_cash_has_branch',
      sql`${table.subtype} <> 'wallet_cash' or ${table.branchId} is not null`,
    ),
    check('accounts_code_format', sql`${table.code} ~ '^[0-9A-Z][0-9A-Z-]{0,31}$'`),
  ],
);

export const journals = ledger.table(
  'journals',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The Asia/Dhaka date of the business event (invariant 8). */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** `<source_type>:<source_id>:<event>`. Unique per org. */
    idempotencyKey: text('idempotency_key').notNull(),
    memo: text('memo'),
    /** Set only on a reversal journal; points at the journal it reverses. */
    reversesJournalId: uuid('reverses_journal_id'),
    /** sha256 of the canonical draft, so a replay can be told from a clash (D-082). */
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by').notNull(),
    /**
     * The top-level transaction that inserted the journal, stamped by a
     * trigger (any supplied value is overwritten). Lines may only be added by
     * that same transaction, so a posted journal cannot grow a balanced pair
     * of extra lines later.
     */
    createdTxid: xid8('created_txid').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('journals_org_idempotency_key_idx').on(table.orgId, table.idempotencyKey),
    unique('journals_org_id_id_key').on(table.orgId, table.id),
    index('journals_org_idx').on(table.orgId),
    index('journals_org_business_date_idx').on(table.orgId, table.businessDate),
    // A journal is reversed at most once.
    uniqueIndex('journals_reverses_journal_idx')
      .on(table.orgId, table.reversesJournalId)
      .where(sql`${table.reversesJournalId} is not null`),
    foreignKey({
      name: 'journals_org_id_reverses_journal_id_fk',
      columns: [table.orgId, table.reversesJournalId],
      foreignColumns: [table.orgId, table.id],
    }).onDelete('restrict'),
    check(
      'journals_idempotency_key_matches_source',
      sql`${table.idempotencyKey} = ${table.sourceType} || ':' || ${table.sourceId}::text || ':' || split_part(${table.idempotencyKey}, ':', 3)
          and split_part(${table.idempotencyKey}, ':', 3) ~ '^[a-z][a-z0-9_]{0,39}$'`,
    ),
    check('journals_source_type_format', sql`${table.sourceType} ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check('journals_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
    check('journals_not_self_reversal', sql`${table.reversesJournalId} <> ${table.id}`),
    // A reversal is keyed on what it reverses (`journal:<id>:reversed`), so a
    // mis-built draft cannot take a journal's one reversal slot (audit N3).
    check(
      'journals_reversal_shape',
      sql`${table.reversesJournalId} is null or (${table.sourceType} = 'journal'
          and ${table.sourceId} = ${table.reversesJournalId}
          and split_part(${table.idempotencyKey}, ':', 3) = 'reversed')`,
    ),
  ],
);

export const journalLines = ledger.table(
  'journal_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    journalId: uuid('journal_id').notNull(),
    lineNo: integer('line_no').notNull(),
    accountId: uuid('account_id').notNull(),
    branchId: uuid('branch_id'),
    partyType: partyType('party_type'),
    partyId: uuid('party_id'),
    /** Money is integer poisha (invariant 1). */
    debitPoisha: bigint('debit_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    creditPoisha: bigint('credit_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    memo: text('memo'),
  },
  (table) => [
    index('journal_lines_org_idx').on(table.orgId),
    uniqueIndex('journal_lines_journal_line_idx').on(table.journalId, table.lineNo),
    index('journal_lines_org_journal_idx').on(table.orgId, table.journalId),
    index('journal_lines_org_account_idx').on(table.orgId, table.accountId),
    index('journal_lines_org_branch_idx').on(table.orgId, table.branchId),
    index('journal_lines_org_party_idx').on(table.orgId, table.partyType, table.partyId),
    foreignKey({
      name: 'journal_lines_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'journal_lines_org_id_account_id_fk',
      columns: [table.orgId, table.accountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'journal_lines_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    check('journal_lines_debit_not_negative', sql`${table.debitPoisha} >= 0`),
    check('journal_lines_credit_not_negative', sql`${table.creditPoisha} >= 0`),
    // Exactly one side is positive (§7).
    check('journal_lines_one_side', sql`(${table.debitPoisha} > 0) <> (${table.creditPoisha} > 0)`),
    check(
      'journal_lines_party_complete',
      sql`(${table.partyType} is null) = (${table.partyId} is null)`,
    ),
    check('journal_lines_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

/**
 * Monthly accounting periods (§7 "Periods and dates").
 *
 * A row exists once a month has been closed at least once; a month with no
 * row is open. The migration's trigger allows exactly two transitions —
 * open → closed, and closed → open with an approved `period_reopen` decided
 * after the close — and `erp_app` cannot delete a row.
 */
export const periods = ledger.table(
  'periods',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    status: periodStatus('status').notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    closedBy: text('closed_by'),
    reopenedAt: timestamp('reopened_at', { withTimezone: true, mode: 'date' }),
    /** The approved `period_reopen` request that authorised the latest reopen. */
    reopenApprovalId: uuid('reopen_approval_id'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('periods_org_starts_on_idx').on(table.orgId, table.startsOn),
    unique('periods_org_id_id_key').on(table.orgId, table.id),
    index('periods_org_idx').on(table.orgId),
    foreignKey({
      name: 'periods_org_id_reopen_approval_id_fk',
      columns: [table.orgId, table.reopenApprovalId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    check(
      'periods_whole_month',
      sql`extract(day from ${table.startsOn}) = 1
          and ${table.endsOn} = (${table.startsOn} + interval '1 month' - interval '1 day')::date`,
    ),
    check(
      'periods_closed_has_closer',
      sql`${table.status} <> 'closed' or (${table.closedAt} is not null and ${table.closedBy} is not null)`,
    ),
  ],
);
