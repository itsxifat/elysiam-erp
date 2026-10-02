import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
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
import { journals, ledgerAccounts } from '../ledger/index.js';
import { notifyMessages } from '../notify/index.js';
import { organizations } from '../org/index.js';

/**
 * Company loans: who lent, what was borrowed, the schedule, repayments and reminders
 * (architecture §15, §7; M26).
 *
 * Owned by the `loans` module. Every table carries `org_id` with RLS ENABLE + FORCE
 * (migration 0090) and every tenant foreign key carries `org_id` on both sides (D-047).
 *
 * - **No balance columns.** What is still owed is derived: the schedule less the posted
 *   payments, and the ledger's `loan_payable` lines for the lender, which the statement
 *   shows side by side.
 * - **A loan and its schedule are append-only.** The terms are what was signed, and the
 *   receipt journal was posted from them; a deferred trigger in 0090 checks at commit
 *   that a loan has exactly `tenure_months` instalments whose principal sums to the
 *   loan's (M26 check 1, in the database as well as in the domain).
 * - **One live payment per instalment**, by a partial unique index, and the journal key
 *   is the instalment's — so a repayment cannot post twice whatever the rows say.
 * - **One reminder per instalment**, by a unique index (M26 check 3).
 */
export const loansSchema = pgSchema('loans');

export const loanLenders = loansSchema.table(
  'lenders',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** A bank, a person, or anything else that lends (§15). */
    kind: text('kind').notNull(),
    notes: text('notes'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('lenders_org_id_id_key').on(table.orgId, table.id),
    index('lenders_org_idx').on(table.orgId),
    check('lenders_name_length', sql`length(${table.name}) between 1 and 160`),
    check('lenders_kind', sql`${table.kind} in ('bank', 'person', 'other')`),
    check('lenders_notes_length', sql`${table.notes} is null or length(${table.notes}) <= 2000`),
  ],
);

export const companyLoans = loansSchema.table(
  'loans',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    lenderId: uuid('lender_id').notNull(),
    /** The lender's own reference: an account or sanction number. */
    reference: text('reference'),
    principalPoisha: bigint('principal_poisha', { mode: 'bigint' }).notNull(),
    /** Nominal annual rate in basis points: 1200 = 12% a year (D-294). */
    rateBps: integer('rate_bps').notNull(),
    method: text('method').notNull(),
    tenureMonths: integer('tenure_months').notNull(),
    /** The Asia/Dhaka date the principal arrived: the receipt journal's business date. */
    receivedOn: date('received_on', { mode: 'string' }).notNull(),
    firstDueOn: date('first_due_on', { mode: 'string' }).notNull(),
    /** How many days before each due date the reminder goes out (D-300). */
    reminderDays: integer('reminder_days').notNull().default(3),
    /** The brand's own staff number for the SMS reminder, E.164; null for in-app only. */
    reminderPhone: text('reminder_phone'),
    walletAccountId: uuid('wallet_account_id').notNull(),
    receivedJournalId: uuid('received_journal_id').notNull(),
    memo: text('memo'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('loans_org_id_id_key').on(table.orgId, table.id),
    index('loans_org_idx').on(table.orgId),
    index('loans_org_lender_idx').on(table.orgId, table.lenderId),
    foreignKey({
      name: 'loans_org_id_lender_id_fk',
      columns: [table.orgId, table.lenderId],
      foreignColumns: [loanLenders.orgId, loanLenders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loans_org_id_wallet_account_id_fk',
      columns: [table.orgId, table.walletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loans_org_id_received_journal_id_fk',
      columns: [table.orgId, table.receivedJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('loans_principal_positive', sql`${table.principalPoisha} > 0`),
    check('loans_rate_range', sql`${table.rateBps} between 0 and 10000`),
    check('loans_method', sql`${table.method} in ('flat', 'reducing')`),
    check('loans_tenure_range', sql`${table.tenureMonths} between 1 and 360`),
    check('loans_reminder_days_range', sql`${table.reminderDays} between 0 and 30`),
    check(
      'loans_reminder_phone_e164',
      sql`${table.reminderPhone} is null or ${table.reminderPhone} ~ '^\\+8801[3-9][0-9]{8}$'`,
    ),
    check('loans_first_due_after_receipt', sql`${table.firstDueOn} > ${table.receivedOn}`),
    check(
      'loans_reference_length',
      sql`${table.reference} is null or length(${table.reference}) <= 80`,
    ),
    check('loans_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

export const companyLoanInstalments = loansSchema.table(
  'instalments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    loanId: uuid('loan_id').notNull(),
    seq: integer('seq').notNull(),
    dueOn: date('due_on', { mode: 'string' }).notNull(),
    principalPoisha: bigint('principal_poisha', { mode: 'bigint' }).notNull(),
    interestPoisha: bigint('interest_poisha', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('loan_instalments_org_id_id_key').on(table.orgId, table.id),
    index('loan_instalments_org_idx').on(table.orgId),
    uniqueIndex('loan_instalments_org_loan_seq_idx').on(table.orgId, table.loanId, table.seq),
    index('loan_instalments_org_due_idx').on(table.orgId, table.dueOn),
    foreignKey({
      name: 'loan_instalments_org_id_loan_id_fk',
      columns: [table.orgId, table.loanId],
      foreignColumns: [companyLoans.orgId, companyLoans.id],
    }).onDelete('restrict'),
    check('loan_instalments_seq_positive', sql`${table.seq} >= 1`),
    check(
      'loan_instalments_parts',
      sql`${table.principalPoisha} >= 0 and ${table.interestPoisha} >= 0
        and ${table.principalPoisha} + ${table.interestPoisha} > 0`,
    ),
  ],
);

export const companyLoanPayments = loansSchema.table(
  'payments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    loanId: uuid('loan_id').notNull(),
    instalmentId: uuid('instalment_id').notNull(),
    walletAccountId: uuid('wallet_account_id').notNull(),
    principalPoisha: bigint('principal_poisha', { mode: 'bigint' }).notNull(),
    interestPoisha: bigint('interest_poisha', { mode: 'bigint' }).notNull(),
    /** `pending_approval` → `posted` | `rejected`, and nothing else (0090). */
    status: text('status').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The Asia/Dhaka date the payment was recorded on (invariant 8). */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    approvalRequestId: uuid('approval_request_id'),
    journalId: uuid('journal_id'),
    memo: text('memo'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('loan_payments_org_id_id_key').on(table.orgId, table.id),
    index('loan_payments_org_idx').on(table.orgId),
    index('loan_payments_org_loan_idx').on(table.orgId, table.loanId),
    // One live payment per instalment: waiting for a checker, or posted.
    uniqueIndex('loan_payments_org_instalment_live_idx')
      .on(table.orgId, table.instalmentId)
      .where(sql`status <> 'rejected'`),
    foreignKey({
      name: 'loan_payments_org_id_loan_id_fk',
      columns: [table.orgId, table.loanId],
      foreignColumns: [companyLoans.orgId, companyLoans.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loan_payments_org_id_instalment_id_fk',
      columns: [table.orgId, table.instalmentId],
      foreignColumns: [companyLoanInstalments.orgId, companyLoanInstalments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loan_payments_org_id_wallet_account_id_fk',
      columns: [table.orgId, table.walletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loan_payments_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loan_payments_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check(
      'loan_payments_status',
      sql`${table.status} in ('pending_approval', 'posted', 'rejected')`,
    ),
    // A posted payment has its journal; nothing else has one.
    check(
      'loan_payments_status_journal',
      sql`(${table.status} = 'posted') = (${table.journalId} is not null)`,
    ),
    // Only a payment that waited for a checker names an approval, and it always does.
    check(
      'loan_payments_pending_has_approval',
      sql`${table.status} <> 'pending_approval' or ${table.approvalRequestId} is not null`,
    ),
    check(
      'loan_payments_parts',
      sql`${table.principalPoisha} >= 0 and ${table.interestPoisha} >= 0
        and ${table.principalPoisha} + ${table.interestPoisha} > 0`,
    ),
    check('loan_payments_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

export const companyLoanReminders = loansSchema.table(
  'reminders',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    loanId: uuid('loan_id').notNull(),
    instalmentId: uuid('instalment_id').notNull(),
    /** The Asia/Dhaka date the reminder went out. */
    remindedOn: date('reminded_on', { mode: 'string' }).notNull(),
    /** What happened to the SMS; the in-app reminder always goes (D-300). */
    smsState: text('sms_state').notNull(),
    messageId: uuid('message_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('loan_reminders_org_id_id_key').on(table.orgId, table.id),
    index('loan_reminders_org_idx').on(table.orgId),
    // Check 3: once per instalment, in the database.
    uniqueIndex('loan_reminders_org_instalment_idx').on(table.orgId, table.instalmentId),
    foreignKey({
      name: 'loan_reminders_org_id_loan_id_fk',
      columns: [table.orgId, table.loanId],
      foreignColumns: [companyLoans.orgId, companyLoans.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loan_reminders_org_id_instalment_id_fk',
      columns: [table.orgId, table.instalmentId],
      foreignColumns: [companyLoanInstalments.orgId, companyLoanInstalments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'loan_reminders_org_id_message_id_fk',
      columns: [table.orgId, table.messageId],
      foreignColumns: [notifyMessages.orgId, notifyMessages.id],
    }).onDelete('restrict'),
    check(
      'loan_reminders_sms_state',
      sql`${table.smsState} in ('queued', 'suppressed', 'no_phone', 'failed')`,
    ),
    check(
      'loan_reminders_sms_message',
      sql`(${table.smsState} in ('queued', 'suppressed')) = (${table.messageId} is not null)`,
    ),
  ],
);
