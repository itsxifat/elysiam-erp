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
import { fileObjects } from '../files/index.js';
import { journals, ledgerAccounts } from '../ledger/index.js';
import { organizations } from '../org/index.js';

/**
 * Investors, their capital, the profit declared to them and what they take out
 * (architecture §15, §7).
 *
 * ## No balance columns, for the same reason the wallets have none
 *
 * There is no `capital_poisha` on the investor row and no `paid_poisha` on a
 * distribution. A position is derived from the rows below — contributions less
 * capital withdrawn, profit declared less profit paid — and every one of those
 * rows names the immutable journal that moved the money. A maintained balance
 * would drift the first time a row was written by a path that forgot to update
 * it, and the drift is invisible until an investor's own statement disagrees with
 * the ledger. With an investor reading the number, that is the one failure worth
 * designing against.
 *
 * ## What is stored is what a journal cannot say
 *
 * A journal records that ৳5,00,000 moved from a bank account into investor
 * equity. It cannot record the lock-in that came with it, the agreed profit
 * share, the period a distribution is *for*, who reviewed a withdrawal before a
 * checker approved it, or which private document proves any of it. Those are the
 * columns here.
 *
 * ## Two accounts, never one balance
 *
 * §7 gives an investor `investor_capital` (equity) and `investor_payable`
 * (liability). A withdrawal names which one it draws on (`kind`), because adding
 * an equity balance to a liability balance produces a number that authorizes a
 * payment against the wrong account — see `packages/domain/src/investors/position.ts`.
 *
 * Every table is tenant-scoped: `org_id NOT NULL`, indexed, RLS ENABLE and FORCE
 * from `tenantTableSql()` in migration 0059, and every foreign key between two
 * tenant tables carries `org_id` on both sides (D-047).
 */
export const investorsSchema = pgSchema('investors');

/** Whether an investor is still in. An exited investor is kept, never deleted. */
export const investorStatus = investorsSchema.enum('investor_status', ['active', 'exited']);

/**
 * What a declared profit is divided by (D-019).
 *
 * D-019 leaves the *amount* to a manual declaration per period, and says nothing
 * about how it divides. Two bases are real and both are in use in Bangladeshi
 * family businesses: an agreed share per investor, and each investor's share of
 * the capital actually contributed. The basis is recorded on the distribution and
 * the weights are snapshotted onto its lines, so a share changed next year cannot
 * silently restate a distribution somebody already approved.
 */
export const distributionBasis = investorsSchema.enum('distribution_basis', [
  'share_bps',
  'capital',
]);

/**
 * Where a distribution stands.
 *
 * `pending_approval` has no journal: declaring profit is a maker-checker action
 * (§6 "investor withdrawals and distributions"), and nothing is posted until a
 * checker decides. Posting first and reversing on rejection would leave two
 * journals for a distribution that never happened.
 */
export const distributionStatus = investorsSchema.enum('distribution_status', [
  'pending_approval',
  'declared',
  'rejected',
]);

/**
 * A withdrawal's path: `requested → reviewed → approved → paid`, or `rejected`
 * (§15).
 *
 * Four steps rather than two, because they are four different decisions by
 * different people: the investor asks, the finance team checks the position
 * covers it and names the account it would be paid from, a checker approves, and
 * only then does money leave a wallet. **The journal is written at `paid` and
 * nowhere else** — an approval is a decision, not a payment, and a journal posted
 * at approval would show the money gone on a day the bank account still held it.
 */
export const withdrawalStatus = investorsSchema.enum('withdrawal_status', [
  'requested',
  'reviewed',
  'approved',
  'paid',
  'rejected',
]);

/** Which of an investor's two accounts a withdrawal draws on (§7). */
export const withdrawalKind = investorsSchema.enum('withdrawal_kind', ['capital', 'profit']);

/** What a private investor document is. */
export const investorDocumentKind = investorsSchema.enum('investor_document_kind', [
  /** NID, TIN, bank details: the investor's identity (§25 "investor KYC fields"). */
  'kyc',
  /** The investment agreement, and anything amending it. */
  'agreement',
  /** A rendered statement, or anything else the org files against the investor. */
  'other',
]);

/**
 * An investor of one org.
 *
 * Per-org by construction, not by a flag: each brand is an isolated org (§5), so
 * the same person backing two brands is two rows, and neither org can see the
 * other's. That is the intent — an investor in Oura has no business knowing what
 * Elysium raised.
 *
 * `user_id` is the login that may read this investor's own rows. It is plain text
 * with no foreign key, like `created_by` everywhere else: `iam.users` is global
 * rather than tenant-scoped, so a composite `(org_id, user_id)` key is not
 * available and a plain one would be a cross-org reference (D-047). The service
 * checks the user holds an `investor` membership of this org before linking, and
 * a trigger in 0060 refuses two investors of one org sharing a login — otherwise
 * `own` scope would quietly widen to "both of them".
 */
export const investors = investorsSchema.table(
  'investors',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** A short human reference, unique per org: `INV-01`. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** The portal login, or null for an investor who has none yet. */
    userId: text('user_id'),
    /**
     * Masked on the way in, never on the way out (invariant 10, §25).
     *
     * A column that accepts a full phone number will receive one, and it is then
     * in every backup and CSV export of this table. The service masks before it
     * writes; a CHECK bounds the length so a full number does not fit anyway.
     */
    phoneMasked: text('phone_masked'),
    email: text('email'),
    /**
     * The agreed profit share, in basis points (10000 = 100%).
     *
     * Basis points rather than a percentage with decimals, for the same reason
     * money is poisha: 12.5% is exact as 1250 and inexact as a float. Zero means
     * "no agreed share", and a distribution by `share_bps` with every share at
     * zero is refused rather than split equally — an org that has not set its
     * shares has not decided who gets what.
     */
    shareBps: integer('share_bps').notNull().default(0),
    status: investorStatus('status').notNull().default('active'),
    joinedOn: date('joined_on', { mode: 'string' }).notNull(),
    notes: text('notes'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('investors_org_idx').on(table.orgId),
    index('investors_org_status_idx').on(table.orgId, table.status),
    uniqueIndex('investors_org_code_idx').on(table.orgId, table.code),
    // One investor row per login per org: `own` scope resolves through this, and
    // two rows sharing a login would show one investor the other's position.
    uniqueIndex('investors_org_user_idx')
      .on(table.orgId, table.userId)
      .where(sql`user_id is not null`),
    unique('investors_org_id_id_key').on(table.orgId, table.id),
    check('investors_code_length', sql`length(${table.code}) between 1 and 32`),
    check('investors_name_length', sql`length(${table.name}) between 1 and 160`),
    check(
      'investors_phone_masked_length',
      sql`${table.phoneMasked} is null or length(${table.phoneMasked}) <= 20`,
    ),
    check('investors_share_bps_range', sql`${table.shareBps} between 0 and 10000`),
    check('investors_notes_length', sql`${table.notes} is null or length(${table.notes}) <= 2000`),
  ],
);

/**
 * One capital contribution: amount, date, terms, lock-in (§15).
 *
 * Append-only, and `journal_id` is NOT NULL — a contribution row exists only
 * because money arrived and was posted. There is no draft state: capital coming
 * *in* needs no approval, because nothing about it can be recovered by refusing
 * it, and the journal is the record.
 *
 * **Lock-in is per contribution.** An investor who put in ৳5,00,000 two years ago
 * and ৳10,00,000 last month under a one-year term may withdraw the first and not
 * the second; one `locked_until` on the investor row could not express that
 * without either freezing the old money or releasing the new.
 */
export const investments = investorsSchema.table(
  'investments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    investorId: uuid('investor_id').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    /** The wallet's ledger account the money arrived in (§7's W). */
    walletAccountId: uuid('wallet_account_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The Asia/Dhaka date of `occurred_at`, computed in the domain (invariant 8). */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** The date this lot's lock-in ends. Null when the money was never locked. */
    lockInUntil: date('lock_in_until', { mode: 'string' }),
    /** The agreed terms in words (D-019 defines no formula). */
    terms: text('terms'),
    memo: text('memo'),
    journalId: uuid('journal_id').notNull(),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('investments_org_idx').on(table.orgId),
    index('investments_org_investor_idx').on(table.orgId, table.investorId, table.businessDate),
    unique('investments_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'investments_org_id_investor_id_fk',
      columns: [table.orgId, table.investorId],
      foreignColumns: [investors.orgId, investors.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'investments_org_id_wallet_account_id_fk',
      columns: [table.orgId, table.walletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'investments_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('investments_amount_positive', sql`${table.amountPoisha} > 0`),
    // A lock-in that ended before the money arrived is a typo, and it would
    // silently mean "not locked at all".
    check(
      'investments_lock_in_after_date',
      sql`${table.lockInUntil} is null or ${table.lockInUntil} >= ${table.businessDate}`,
    ),
    check(
      'investments_terms_length',
      sql`${table.terms} is null or length(${table.terms}) <= 2000`,
    ),
    check('investments_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

/**
 * A profit distribution declared for one period (D-019).
 *
 * The period is `period_starts_on`/`period_ends_on`, and it is **metadata, not the
 * journal's date**. The journal is dated the day the declaration is approved, so a
 * September declaration of August profit is a September equity movement. That is
 * the honest reading, and it is also why declaring can never post into a closed
 * month: the month a declaration is dated in is the month that is still running
 * (D-037 covers the settlement case, where the event genuinely belongs to the
 * closed period; a declaration does not).
 *
 * `total_poisha` is the declared amount and the lines below must sum to exactly
 * it — a trigger in 0060 says so, because that equality is what makes the journal
 * balance.
 */
export const distributions = investorsSchema.table(
  'distributions',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** The period the profit was earned in. Business dates (invariant 8). */
    periodStartsOn: date('period_starts_on', { mode: 'string' }).notNull(),
    periodEndsOn: date('period_ends_on', { mode: 'string' }).notNull(),
    totalPoisha: bigint('total_poisha', { mode: 'bigint' }).notNull(),
    basis: distributionBasis('basis').notNull(),
    status: distributionStatus('status').notNull(),
    /** The maker-checker request; null only on a row that predates approval. */
    approvalRequestId: uuid('approval_request_id'),
    journalId: uuid('journal_id'),
    /** The Asia/Dhaka date the journal was posted on. Null until declared. */
    declaredOn: date('declared_on', { mode: 'string' }),
    memo: text('memo'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('distributions_org_idx').on(table.orgId),
    index('distributions_org_status_idx').on(table.orgId, table.status),
    // One live distribution per period. A second declaration for the same month
    // is almost always a duplicate submit; a genuine top-up is a different
    // period or a correcting reversal, never two rows claiming the same profit.
    uniqueIndex('distributions_org_period_idx')
      .on(table.orgId, table.periodStartsOn, table.periodEndsOn)
      .where(sql`status <> 'rejected'`),
    unique('distributions_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'distributions_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'distributions_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('distributions_total_positive', sql`${table.totalPoisha} > 0`),
    check('distributions_period_ordered', sql`${table.periodEndsOn} >= ${table.periodStartsOn}`),
    // Declared names its journal and the day it posted; anything else has
    // neither, so it is in no report, no balance and no investor's statement.
    check(
      'distributions_status_journal',
      sql`case ${table.status}
            when 'declared' then ${table.journalId} is not null and ${table.declaredOn} is not null
            when 'pending_approval' then ${table.journalId} is null and ${table.approvalRequestId} is not null
            else ${table.journalId} is null
          end`,
    ),
    check('distributions_memo_length', sql`${table.memo} is null or length(${table.memo}) <= 500`),
  ],
);

/**
 * One investor's share of one distribution, with the weight it was computed from.
 *
 * The weight is snapshotted rather than looked up later, and that is the
 * difference between a record and a reconstruction: an investor whose agreed
 * share changes next year must not silently restate a distribution a checker
 * already approved and an investor has already been paid.
 *
 * A zero amount is allowed here and is *not* posted (a journal line must have one
 * positive side). One poisha across two investors is 1 and 0, and the row records
 * that the second participated in a distribution that left them nothing.
 */
export const distributionLines = investorsSchema.table(
  'distribution_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    distributionId: uuid('distribution_id').notNull(),
    investorId: uuid('investor_id').notNull(),
    /** The weight used: basis points, or poisha of capital. `basis` says which. */
    weight: bigint('weight', { mode: 'bigint' }).notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    ...timestamps,
  },
  (table) => [
    index('distribution_lines_org_idx').on(table.orgId),
    index('distribution_lines_org_investor_idx').on(table.orgId, table.investorId),
    uniqueIndex('distribution_lines_org_distribution_investor_idx').on(
      table.orgId,
      table.distributionId,
      table.investorId,
    ),
    unique('distribution_lines_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'distribution_lines_org_id_distribution_id_fk',
      columns: [table.orgId, table.distributionId],
      foreignColumns: [distributions.orgId, distributions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'distribution_lines_org_id_investor_id_fk',
      columns: [table.orgId, table.investorId],
      foreignColumns: [investors.orgId, investors.id],
    }).onDelete('restrict'),
    check('distribution_lines_amount_not_negative', sql`${table.amountPoisha} >= 0`),
    check('distribution_lines_weight_not_negative', sql`${table.weight} >= 0`),
  ],
);

/**
 * A withdrawal request and its life (§15).
 *
 * `requested → reviewed → approved → paid`, or rejected. The three people are
 * different on purpose and the database holds them apart: `reviewed_by` is the
 * maker of the approval request, the checker who decides it is somebody else
 * (`approvals.approval_requests` enforces that), and a trigger in 0060 confines
 * the row to that one path so an amount cannot change after a checker saw it.
 *
 * `wallet_account_id` is chosen at review, before a checker is asked: "approve a
 * payment" is not answerable without knowing which account it leaves. It is a
 * `wallet_*` ledger account rather than a `wallets.wallets` row, because a module
 * reaches another module's tables through nothing at all (invariant 12) — the
 * chart of accounts is the shared vocabulary, and it is what the posting rule
 * needs anyway.
 */
export const withdrawals = investorsSchema.table(
  'withdrawals',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    investorId: uuid('investor_id').notNull(),
    kind: withdrawalKind('kind').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    status: withdrawalStatus('status').notNull(),
    reason: text('reason'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    /** The wallet account the payment would leave, chosen at review. */
    walletAccountId: uuid('wallet_account_id'),
    approvalRequestId: uuid('approval_request_id'),
    journalId: uuid('journal_id'),
    /** The Asia/Dhaka date the money left. Null until paid (invariant 8). */
    paidOn: date('paid_on', { mode: 'string' }),
    paidBy: text('paid_by'),
    ...timestamps,
  },
  (table) => [
    index('withdrawals_org_idx').on(table.orgId),
    index('withdrawals_org_investor_idx').on(table.orgId, table.investorId),
    index('withdrawals_org_status_idx').on(table.orgId, table.status),
    unique('withdrawals_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'withdrawals_org_id_investor_id_fk',
      columns: [table.orgId, table.investorId],
      foreignColumns: [investors.orgId, investors.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'withdrawals_org_id_wallet_account_id_fk',
      columns: [table.orgId, table.walletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'withdrawals_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'withdrawals_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('withdrawals_amount_positive', sql`${table.amountPoisha} > 0`),
    check(
      'withdrawals_reason_length',
      sql`${table.reason} is null or length(${table.reason}) <= 500`,
    ),
    // What each state must carry. The shape *is* the state machine: a paid row
    // names its journal, the day it left and who paid it; an approved row names
    // the approval and the account it will leave and has no journal at all.
    check(
      'withdrawals_status_shape',
      sql`case ${table.status}
            when 'requested' then ${table.reviewedBy} is null and ${table.approvalRequestId} is null
                 and ${table.journalId} is null and ${table.paidOn} is null
            when 'reviewed' then ${table.reviewedBy} is not null and ${table.walletAccountId} is not null
                 and ${table.approvalRequestId} is not null and ${table.journalId} is null
            when 'approved' then ${table.reviewedBy} is not null and ${table.walletAccountId} is not null
                 and ${table.approvalRequestId} is not null and ${table.journalId} is null
            when 'paid' then ${table.journalId} is not null and ${table.paidOn} is not null
                 and ${table.paidBy} is not null and ${table.walletAccountId} is not null
            else ${table.journalId} is null
          end`,
    ),
    // The one that is about people rather than shape: whoever reviewed a
    // withdrawal may not also be the person who asked for it.
    check(
      'withdrawals_reviewer_is_not_requester',
      sql`${table.reviewedBy} is null or ${table.reviewedBy} <> ${table.requestedBy}`,
    ),
  ],
);

/**
 * A private document about an investor or one of their investments (§15, §22).
 *
 * The row points at a `files.objects` id and nothing else — no URL, ever. A
 * signed URL is a bearer token: once it exists it works for whoever holds it, so
 * it is minted per request by the files module after that module has authorized
 * this caller for this purpose (check 3, D-115). A column holding one would
 * authorize every investor document to anybody who could read this table.
 */
export const investorDocuments = investorsSchema.table(
  'documents',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    investorId: uuid('investor_id').notNull(),
    /** The investment this document is the paperwork for, when it is about one. */
    investmentId: uuid('investment_id'),
    kind: investorDocumentKind('kind').notNull(),
    title: text('title').notNull(),
    fileId: uuid('file_id').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('investor_documents_org_idx').on(table.orgId),
    index('investor_documents_org_investor_idx').on(table.orgId, table.investorId),
    // One row per file: two rows pointing at one object would be two documents
    // that cannot be told apart, and deleting either would orphan the other.
    uniqueIndex('investor_documents_org_file_idx').on(table.orgId, table.fileId),
    unique('investor_documents_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'investor_documents_org_id_investor_id_fk',
      columns: [table.orgId, table.investorId],
      foreignColumns: [investors.orgId, investors.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'investor_documents_org_id_investment_id_fk',
      columns: [table.orgId, table.investmentId],
      foreignColumns: [investments.orgId, investments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'investor_documents_org_id_file_id_fk',
      columns: [table.orgId, table.fileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    check('investor_documents_title_length', sql`length(${table.title}) between 1 and 200`),
  ],
);
