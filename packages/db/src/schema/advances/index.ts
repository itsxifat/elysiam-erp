import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { journals, ledgerAccounts } from '../ledger/index.js';
import { orders, sales } from '../orders/index.js';
import { organizations } from '../org/index.js';

/**
 * Advances against an order, and why parcels come back (architecture §7, §9, M17).
 *
 * In the `sales` schema beside the orders they belong to; their own file because they
 * arrive with M17 and the orders schema file is M10's.
 */

/**
 * Money a buyer sent before the parcel moved, from claim to ending (D-013, D-230 to D-233).
 *
 * The agent records a claim: nothing posts and the COD does not move. Accounts verifies it
 * into a wallet, which posts Dr Wallet / Cr Customer advance, or rejects it. The CHECKs make
 * "an unverified advance never reaches the books" a property of every row: a pending or
 * rejected claim has no journal, and everything past them has one. Migration 0082's trigger
 * keeps a claim's terms fixed and its status on its own path.
 *
 * At every status, amount = applied + kept + (refunded, or still owed): the money is on a
 * delivery, kept as income, back with the buyer, or still a liability, and the row says which.
 */
export const orderAdvances = sales.table(
  'order_advances',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    /** `bkash`, `nagad` or `bank` (D-013 names bKash). */
    method: text('method').notNull(),
    /** Normalised: upper case, no spaces or dashes (`normalizeTransactionRef`). */
    transactionRef: text('transaction_ref').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    /** What deliveries have used of it (D-233). */
    appliedPoisha: bigint('applied_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    status: text('status').notNull().default('pending'),
    note: text('note'),
    recordedBy: text('recorded_by').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Who verified or rejected it. Never the recorder. */
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    rejectReason: text('reject_reason'),
    /** The wallet the money arrived in, named by whoever verified it. */
    walletAccountId: uuid('wallet_account_id'),
    receivedJournalId: uuid('received_journal_id'),
    /**
     * What the brand kept at the order's ending (D-232): at most the delivery charge, posted
     * Dr Customer advance / Cr Other income by `kept_journal_id`.
     */
    keptPoisha: bigint('kept_poisha', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    keptJournalId: uuid('kept_journal_id'),
    /** Who ended it and when: the kept part at the ending, or the refund when it was paid. */
    settledBy: text('settled_by'),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),
    /** The refund: the journal, the wallet it went out of, and the outgoing reference. */
    refundJournalId: uuid('refund_journal_id'),
    refundWalletAccountId: uuid('refund_wallet_account_id'),
    refundRef: text('refund_ref'),
    /**
     * A verification undone (D-236): the reversal journal of `received_journal_id`, who and
     * why. Only before the parcel moves and before any of it was used.
     */
    voidJournalId: uuid('void_journal_id'),
    voidReason: text('void_reason'),
    voidedBy: text('voided_by'),
    voidedAt: timestamp('voided_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    unique('order_advances_org_id_id_key').on(table.orgId, table.id),
    index('order_advances_org_idx').on(table.orgId),
    index('order_advances_org_order_idx').on(table.orgId, table.orderId),
    index('order_advances_org_status_idx').on(table.orgId, table.status),
    // One payment backs one live claim, whatever method it was typed under. A rejected or
    // voided claim frees its reference.
    uniqueIndex('order_advances_org_live_ref_idx')
      .on(table.orgId, table.transactionRef)
      .where(sql`${table.status} not in ('rejected', 'voided')`),
    foreignKey({
      name: 'order_advances_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_advances_org_id_wallet_account_id_fk',
      columns: [table.orgId, table.walletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_advances_org_id_refund_wallet_account_id_fk',
      columns: [table.orgId, table.refundWalletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_advances_org_id_received_journal_id_fk',
      columns: [table.orgId, table.receivedJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_advances_org_id_kept_journal_id_fk',
      columns: [table.orgId, table.keptJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_advances_org_id_refund_journal_id_fk',
      columns: [table.orgId, table.refundJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_advances_org_id_void_journal_id_fk',
      columns: [table.orgId, table.voidJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('order_advances_method', sql`${table.method} in ('bkash', 'nagad', 'bank')`),
    check('order_advances_ref_format', sql`${table.transactionRef} ~ '^[A-Z0-9]{6,30}$'`),
    check(
      'order_advances_amounts',
      sql`${table.amountPoisha} > 0 and ${table.amountPoisha} <= 9000000000000000
          and ${table.appliedPoisha} >= 0 and ${table.keptPoisha} >= 0
          and ${table.appliedPoisha} + ${table.keptPoisha} <= ${table.amountPoisha}`,
    ),
    check(
      'order_advances_status',
      sql`${table.status} in ('pending', 'rejected', 'verified', 'applied', 'refund_due', 'refunded', 'forfeited', 'voided')`,
    ),
    // Decided means somebody other than the recorder decided it.
    check(
      'order_advances_four_eyes',
      sql`(${table.status} = 'pending') = (${table.decidedBy} is null)
          and (${table.decidedBy} is null or ${table.decidedBy} <> ${table.recordedBy})
          and (${table.decidedBy} is null) = (${table.decidedAt} is null)`,
    ),
    check(
      'order_advances_rejected_has_reason',
      sql`(${table.status} = 'rejected') = (${table.rejectReason} is not null)`,
    ),
    // Check 2 in the database: no journal before verification, and none for a rejected claim.
    check(
      'order_advances_received_journal',
      sql`(${table.status} in ('pending', 'rejected')) = (${table.receivedJournalId} is null)
          and (${table.receivedJournalId} is null) = (${table.walletAccountId} is null)`,
    ),
    // Kept money has its journal, and only an ending keeps any.
    check(
      'order_advances_kept',
      sql`(${table.keptPoisha} > 0) = (${table.keptJournalId} is not null)
          and (${table.keptPoisha} = 0 or ${table.status} in ('forfeited', 'refund_due', 'refunded'))`,
    ),
    // Each status says exactly where the money is.
    check(
      'order_advances_where_the_money_is',
      sql`case ${table.status}
            when 'pending' then ${table.appliedPoisha} = 0
            when 'rejected' then ${table.appliedPoisha} = 0
            when 'verified' then ${table.appliedPoisha} < ${table.amountPoisha}
            when 'applied' then ${table.appliedPoisha} = ${table.amountPoisha}
            when 'voided' then ${table.appliedPoisha} = 0 and ${table.keptPoisha} = 0
            when 'forfeited' then ${table.keptPoisha} > 0
              and ${table.appliedPoisha} + ${table.keptPoisha} = ${table.amountPoisha}
            else ${table.appliedPoisha} + ${table.keptPoisha} < ${table.amountPoisha}
          end`,
    ),
    check(
      'order_advances_settled',
      sql`(${table.status} in ('refunded', 'forfeited')) = (${table.settledBy} is not null)
          and (${table.settledBy} is null) = (${table.settledAt} is null)
          and (${table.status} = 'refunded') = (${table.refundJournalId} is not null)
          and (${table.status} = 'refunded') = (${table.refundWalletAccountId} is not null)
          and (${table.refundRef} is null or ${table.status} = 'refunded')`,
    ),
    // A voided advance has its reversal journal, its reason and who undid it; nothing else does.
    check(
      'order_advances_voided',
      sql`(${table.status} = 'voided') = (${table.voidJournalId} is not null)
          and (${table.voidJournalId} is null) = (${table.voidedBy} is null)
          and (${table.voidedBy} is null) = (${table.voidedAt} is null)
          and (${table.voidedBy} is null) = (${table.voidReason} is null)`,
    ),
    check(
      'order_advances_text_lengths',
      sql`(${table.note} is null or length(${table.note}) <= 500)
          and (${table.rejectReason} is null or length(${table.rejectReason}) between 1 and 500)
          and (${table.voidReason} is null or length(${table.voidReason}) between 1 and 500)
          and (${table.refundRef} is null or ${table.refundRef} ~ '^[A-Z0-9]{6,30}$')`,
    ),
  ],
);

/**
 * Why each returned or exchanged order came back (M17 check 3, D-234). One row per order,
 * written by the transition's `record_return_reason` effect. INSERT and SELECT only, and
 * migration 0082's deferred trigger refuses a move into `returned` or `exchange` that has
 * no row by commit.
 */
export const orderReturns = sales.table(
  'order_returns',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    /** `return` (a parcel received back) or `exchange` (a delivered order swapped). */
    kind: text('kind').notNull(),
    reasonCode: text('reason_code').notNull(),
    /** The free-text reason the transition carried. */
    note: text('note'),
    /** The Asia/Dhaka date of the return (invariant 8); what the report filters on. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    recordedBy: text('recorded_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('order_returns_org_id_id_key').on(table.orgId, table.id),
    index('order_returns_org_idx').on(table.orgId),
    uniqueIndex('order_returns_org_order_idx').on(table.orgId, table.orderId),
    index('order_returns_org_date_idx').on(table.orgId, table.businessDate),
    foreignKey({
      name: 'order_returns_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    check('order_returns_kind', sql`${table.kind} in ('return', 'exchange')`),
    check(
      'order_returns_reason_code',
      sql`${table.reasonCode} in ('customer_refused', 'customer_unreachable', 'wrong_address', 'changed_mind', 'size_issue', 'quality_issue', 'wrong_item', 'damaged_in_transit', 'late_delivery', 'price_dispute', 'other')`,
    ),
    check('order_returns_note_length', sql`${table.note} is null or length(${table.note}) <= 500`),
  ],
);
