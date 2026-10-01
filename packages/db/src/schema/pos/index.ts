import { sql } from 'drizzle-orm';
import {
  bigint,
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { skus } from '../catalog/index.js';
import { primaryId, timestamps } from '../columns.js';
import { journals } from '../ledger/index.js';
import { branches, locations, organizations } from '../org/index.js';
import { walletAccounts, walletClosings } from '../wallets/index.js';

/**
 * Branches and showroom POS (architecture §14, M23).
 *
 * ## The till's documents are the till's, and their ids are the till's too
 *
 * A sale, a return and a shift are identified by a UUID the PWA generated — often
 * offline, hours before the server heard of it. That id is the sale's identity
 * everywhere: the primary key here, the `ref_id` on its stock movements, and the
 * source of its journal's idempotency key (`pos_sale:<id>:sold`). A re-sync of the
 * same sale therefore lands on the same row, the same movements and the same
 * journal, and there is nothing to deduplicate after the fact.
 *
 * ## No balances, and no cost the cashier can read
 *
 * Money in a till is derived from the ledger (M08); these tables hold only what a
 * journal cannot say — which register, which shift, which receipt, which tender.
 * The one cost figure kept here is the unit cost each sold unit left the shelf at,
 * because a return months later must put it back at that cost (§8). It is named
 * `unit_cost_poisha` / `cogs_poisha`, which are in `COST_FIELDS`, so `serializeFor`
 * strips it from every response to a role without `read:cost` (invariant 5,
 * D-014): a branch manager sees revenue, never margin.
 *
 * Every table is tenant-scoped — `org_id NOT NULL`, indexed, RLS ENABLE and FORCE
 * in migration 0069 — and every foreign key between tenant tables carries `org_id`
 * on both sides (D-047).
 */
export const pos = pgSchema('pos');

/** Where a till document stands. `held` waits for a manager (§14 "review item"). */
export const posDocumentStatus = pos.enum('document_status', ['posted', 'held', 'voided']);

export const posShiftStatus = pos.enum('shift_status', ['open', 'closed']);

/** §14's tenders. Card settles to the bank, so it posts to a `wallet_bank` account. */
export const posTender = pos.enum('tender', ['cash', 'bkash', 'card']);

/** `HOLD_REASONS` in `packages/domain/src/pos/holds.ts`, in the same order. */
export const posHoldReason = pos.enum('hold_reason', [
  'stock_shortfall',
  'price_mismatch',
  'discount_above_ceiling',
  'shift_closed',
  'outside_posting_window',
  'sku_unavailable',
  'sale_not_posted',
  'return_mismatch',
  // 0073 (D-174).
  'outside_shift',
  // 0075 (D-195).
  'exchange_mismatch',
]);

export const posReviewStatus = pos.enum('review_status', ['open', 'posted', 'voided']);

export const posDocumentKind = pos.enum('document_kind', ['sale', 'return']);

/**
 * A till: one device at one branch, selling from one location into named wallets.
 *
 * The wallets are configuration rather than derived, because a branch can hold
 * two bKash numbers and "the branch's bKash" is not a question with one answer.
 * The cash tender must be the branch's own hand cash (0070 checks it against the
 * wallet's branch); bKash and card may be org-level wallets.
 */
export const posRegisters = pos.table(
  'registers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').notNull(),
    /** Where sold units leave from and returns come back to (§8: "POS uses its branch location"). */
    locationId: uuid('location_id').notNull(),
    /** Printed on every receipt number, so it is short and upper-case. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    cashWalletId: uuid('cash_wallet_id').notNull(),
    bkashWalletId: uuid('bkash_wallet_id'),
    cardWalletId: uuid('card_wallet_id'),
    isActive: boolean('is_active').notNull().default(true),
    /** The last shift number issued, so each shift's receipts carry a unique prefix. */
    lastShiftNo: integer('last_shift_no').notNull().default(0),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    index('pos_registers_org_idx').on(table.orgId),
    index('pos_registers_org_branch_idx').on(table.orgId, table.branchId),
    uniqueIndex('pos_registers_org_code_idx').on(table.orgId, table.code),
    unique('pos_registers_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'pos_registers_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_registers_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_registers_org_id_cash_wallet_id_fk',
      columns: [table.orgId, table.cashWalletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_registers_org_id_bkash_wallet_id_fk',
      columns: [table.orgId, table.bkashWalletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_registers_org_id_card_wallet_id_fk',
      columns: [table.orgId, table.cardWalletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    check('pos_registers_code_format', sql`${table.code} ~ '^[A-Z0-9]{2,8}$'`),
    check('pos_registers_name_length', sql`length(${table.name}) between 1 and 80`),
    check('pos_registers_last_shift_no', sql`${table.lastShiftNo} >= 0`),
  ],
);

/**
 * A cashier's shift on one register: opened with a counted float, closed with a
 * counted drawer (§14).
 *
 * Opening posts nothing — the float is cash already in the branch's hand-cash
 * wallet. The expected figure at close is derived from the shift's documents and
 * stored as evidence of what the drawer should have held, like M08's closings.
 */
export const posShifts = pos.table(
  'shifts',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    registerId: uuid('register_id').notNull(),
    /** The register's branch, copied for row scope and held equal by 0070. */
    branchId: uuid('branch_id').notNull(),
    shiftNo: integer('shift_no').notNull(),
    status: posShiftStatus('status').notNull().default('open'),
    openedBy: text('opened_by').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The Asia/Dhaka date the shift opened on (invariant 8). */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    openingFloatPoisha: bigint('opening_float_poisha', { mode: 'bigint' }).notNull(),
    closedBy: text('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    countedCashPoisha: bigint('counted_cash_poisha', { mode: 'bigint' }),
    expectedCashPoisha: bigint('expected_cash_poisha', { mode: 'bigint' }),
    variancePoisha: bigint('variance_poisha', { mode: 'bigint' }),
    closeNote: text('close_note'),
    ...timestamps,
  },
  (table) => [
    index('pos_shifts_org_idx').on(table.orgId),
    index('pos_shifts_org_branch_date_idx').on(table.orgId, table.branchId, table.businessDate),
    // One open shift per register. Two open shifts on one till would split one
    // drawer's cash across two counts, and each count would be wrong.
    uniqueIndex('pos_shifts_org_register_open_idx')
      .on(table.orgId, table.registerId)
      .where(sql`${table.status} = 'open'`),
    uniqueIndex('pos_shifts_org_register_no_idx').on(table.orgId, table.registerId, table.shiftNo),
    unique('pos_shifts_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'pos_shifts_org_id_register_id_fk',
      columns: [table.orgId, table.registerId],
      foreignColumns: [posRegisters.orgId, posRegisters.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_shifts_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    check('pos_shifts_float_not_negative', sql`${table.openingFloatPoisha} >= 0`),
    check('pos_shifts_no_positive', sql`${table.shiftNo} > 0`),
    check(
      'pos_shifts_close_shape',
      sql`case ${table.status}
            when 'open' then ${table.closedAt} is null and ${table.closedBy} is null
                 and ${table.countedCashPoisha} is null and ${table.variancePoisha} is null
            else ${table.closedAt} is not null and ${table.closedBy} is not null
                 and ${table.countedCashPoisha} >= 0 and ${table.expectedCashPoisha} is not null
                 and ${table.variancePoisha} = ${table.countedCashPoisha} - ${table.expectedCashPoisha}
          end`,
    ),
  ],
);

/**
 * A sale at the till.
 *
 * `held` means it reached the server and could not post as it stood — stock
 * short, a price or discount out of bounds, a closed shift (§14). It has lines and
 * tenders like any sale, and no journal, until a manager posts or voids it.
 */
/**
 * `pos.returns`'s key, for the sale that pairs with one. Sales and returns refer to
 * each other, and an accessor with a declared type is what lets TypeScript infer
 * both tables rather than giving up on the cycle (TS7022).
 */
function returnKey(): { readonly orgId: AnyPgColumn; readonly id: AnyPgColumn } {
  return posReturns;
}

export const posSales = pos.table(
  'sales',
  {
    /** The till's own id (see the schema comment). */
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    registerId: uuid('register_id').notNull(),
    shiftId: uuid('shift_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** Printed on the receipt, and how a return finds the sale. */
    receiptNo: text('receipt_no').notNull(),
    sellerId: text('seller_id').notNull(),
    /** The till's clock at the moment of payment. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** The date its journal carries — the sale's own, or later if it was held. */
    postedOn: date('posted_on', { mode: 'string' }),
    status: posDocumentStatus('status').notNull(),
    grossPoisha: bigint('gross_poisha', { mode: 'bigint' }).notNull(),
    discountPoisha: bigint('discount_poisha', { mode: 'bigint' }).notNull(),
    netPoisha: bigint('net_poisha', { mode: 'bigint' }).notNull(),
    cashReceivedPoisha: bigint('cash_received_poisha', { mode: 'bigint' }).notNull(),
    changePoisha: bigint('change_poisha', { mode: 'bigint' }).notNull(),
    /** Σ qty × unit cost at sale. A cost field (invariant 5). */
    cogsPoisha: bigint('cogs_poisha', { mode: 'bigint' }),
    journalId: uuid('journal_id'),
    /** SHA-256 of the canonical payload: tells a re-sync from a reused id. */
    payloadHash: text('payload_hash').notNull(),
    /** Set on the replacement sale of an exchange: the return it pairs with. */
    exchangeReturnId: uuid('exchange_return_id'),
    voidReason: text('void_reason'),
    voidedBy: text('voided_by'),
    ...timestamps,
  },
  (table) => [
    index('pos_sales_org_idx').on(table.orgId),
    index('pos_sales_org_branch_date_idx').on(table.orgId, table.branchId, table.businessDate),
    index('pos_sales_org_shift_idx').on(table.orgId, table.shiftId),
    index('pos_sales_org_receipt_idx').on(table.orgId, table.receiptNo),
    index('pos_sales_org_status_idx').on(table.orgId, table.status),
    unique('pos_sales_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'pos_sales_org_id_register_id_fk',
      columns: [table.orgId, table.registerId],
      foreignColumns: [posRegisters.orgId, posRegisters.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_sales_org_id_shift_id_fk',
      columns: [table.orgId, table.shiftId],
      foreignColumns: [posShifts.orgId, posShifts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_sales_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_sales_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_sales_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    // The return an exchange pairs with: the brand's own (D-047), and one sale per
    // return (D-195). The service checks the branch before it writes the link.
    foreignKey({
      name: 'pos_sales_org_id_exchange_return_id_fk',
      columns: [table.orgId, table.exchangeReturnId],
      foreignColumns: [returnKey().orgId, returnKey().id],
    }).onDelete('restrict'),
    uniqueIndex('pos_sales_org_exchange_return_key')
      .on(table.orgId, table.exchangeReturnId)
      .where(sql`${table.exchangeReturnId} is not null`),
    check(
      'pos_sales_net_is_difference',
      sql`${table.netPoisha} = ${table.grossPoisha} - ${table.discountPoisha}`,
    ),
    check(
      'pos_sales_discount_within_gross',
      sql`${table.discountPoisha} >= 0 and ${table.discountPoisha} <= ${table.grossPoisha}`,
    ),
    check(
      'pos_sales_cash_shape',
      sql`${table.changePoisha} >= 0 and ${table.cashReceivedPoisha} >= ${table.changePoisha}`,
    ),
    check('pos_sales_receipt_length', sql`length(${table.receiptNo}) between 1 and 40`),
    check(
      'pos_sales_status_shape',
      sql`case ${table.status}
            when 'posted' then ${table.postedOn} is not null and ${table.cogsPoisha} is not null
                 and (${table.journalId} is not null or (${table.netPoisha} = 0 and ${table.cogsPoisha} = 0))
            when 'held' then ${table.journalId} is null and ${table.postedOn} is null
            else ${table.journalId} is null and ${table.voidReason} is not null and ${table.voidedBy} is not null
          end`,
    ),
  ],
);

export const posSaleLines = pos.table(
  'sale_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    saleId: uuid('sale_id').notNull(),
    lineNo: integer('line_no').notNull(),
    skuId: uuid('sku_id').notNull(),
    qty: integer('qty').notNull(),
    unitPricePoisha: bigint('unit_price_poisha', { mode: 'bigint' }).notNull(),
    discountPoisha: bigint('discount_poisha', { mode: 'bigint' }).notNull(),
    netPoisha: bigint('net_poisha', { mode: 'bigint' }).notNull(),
    /** The catalog's selling price when the sale arrived, for the review screen. */
    catalogPricePoisha: bigint('catalog_price_poisha', { mode: 'bigint' }),
    /** What each unit left the shelf at — set once, when the sale posts. */
    unitCostPoisha: bigint('unit_cost_poisha', { mode: 'bigint' }),
    ...timestamps,
  },
  (table) => [
    index('pos_sale_lines_org_idx').on(table.orgId),
    unique('pos_sale_lines_org_sale_line_key').on(table.orgId, table.saleId, table.lineNo),
    foreignKey({
      name: 'pos_sale_lines_org_id_sale_id_fk',
      columns: [table.orgId, table.saleId],
      foreignColumns: [posSales.orgId, posSales.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_sale_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('pos_sale_lines_qty_positive', sql`${table.qty} > 0`),
    check('pos_sale_lines_line_no_positive', sql`${table.lineNo} > 0`),
    check('pos_sale_lines_price_not_negative', sql`${table.unitPricePoisha} >= 0`),
    check(
      'pos_sale_lines_net_is_difference',
      sql`${table.discountPoisha} >= 0
          and ${table.discountPoisha} <= ${table.unitPricePoisha} * ${table.qty}
          and ${table.netPoisha} = ${table.unitPricePoisha} * ${table.qty} - ${table.discountPoisha}`,
    ),
    check(
      'pos_sale_lines_cost_not_negative',
      sql`${table.unitCostPoisha} is null or ${table.unitCostPoisha} >= 0`,
    ),
  ],
);

export const posSaleTenders = pos.table(
  'sale_tenders',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    saleId: uuid('sale_id').notNull(),
    tender: posTender('tender').notNull(),
    /** What this tender paid towards the sale: never includes change. */
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    walletId: uuid('wallet_id').notNull(),
    /** A bKash transaction id or card slip number, as typed. Not personal data. */
    reference: text('reference'),
    ...timestamps,
  },
  (table) => [
    index('pos_sale_tenders_org_idx').on(table.orgId),
    uniqueIndex('pos_sale_tenders_org_sale_tender_idx').on(table.orgId, table.saleId, table.tender),
    foreignKey({
      name: 'pos_sale_tenders_org_id_sale_id_fk',
      columns: [table.orgId, table.saleId],
      foreignColumns: [posSales.orgId, posSales.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_sale_tenders_org_id_wallet_id_fk',
      columns: [table.orgId, table.walletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    check('pos_sale_tenders_amount_positive', sql`${table.amountPoisha} > 0`),
    check(
      'pos_sale_tenders_reference_length',
      sql`${table.reference} is null or length(${table.reference}) between 1 and 40`,
    ),
  ],
);

/** Goods brought back to a till, against a receipt (§14). */
export const posReturns = pos.table(
  'returns',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    registerId: uuid('register_id').notNull(),
    shiftId: uuid('shift_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** The receipt the goods were sold on. */
    saleId: uuid('sale_id').notNull(),
    receiptNo: text('receipt_no').notNull(),
    createdBy: text('created_by').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    postedOn: date('posted_on', { mode: 'string' }),
    status: posDocumentStatus('status').notNull(),
    refundPoisha: bigint('refund_poisha', { mode: 'bigint' }).notNull(),
    cogsPoisha: bigint('cogs_poisha', { mode: 'bigint' }),
    journalId: uuid('journal_id'),
    reason: text('reason'),
    payloadHash: text('payload_hash').notNull(),
    voidReason: text('void_reason'),
    voidedBy: text('voided_by'),
    ...timestamps,
  },
  (table) => [
    index('pos_returns_org_idx').on(table.orgId),
    index('pos_returns_org_branch_date_idx').on(table.orgId, table.branchId, table.businessDate),
    index('pos_returns_org_shift_idx').on(table.orgId, table.shiftId),
    index('pos_returns_org_sale_idx').on(table.orgId, table.saleId),
    unique('pos_returns_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'pos_returns_org_id_register_id_fk',
      columns: [table.orgId, table.registerId],
      foreignColumns: [posRegisters.orgId, posRegisters.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_returns_org_id_shift_id_fk',
      columns: [table.orgId, table.shiftId],
      foreignColumns: [posShifts.orgId, posShifts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_returns_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_returns_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_returns_org_id_sale_id_fk',
      columns: [table.orgId, table.saleId],
      foreignColumns: [posSales.orgId, posSales.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_returns_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('pos_returns_refund_not_negative', sql`${table.refundPoisha} >= 0`),
    check('pos_returns_receipt_length', sql`length(${table.receiptNo}) between 1 and 40`),
    check(
      'pos_returns_reason_length',
      sql`${table.reason} is null or length(${table.reason}) <= 200`,
    ),
    check(
      'pos_returns_status_shape',
      sql`case ${table.status}
            when 'posted' then ${table.postedOn} is not null and ${table.cogsPoisha} is not null
                 and (${table.journalId} is not null or (${table.refundPoisha} = 0 and ${table.cogsPoisha} = 0))
            when 'held' then ${table.journalId} is null and ${table.postedOn} is null
            else ${table.journalId} is null and ${table.voidReason} is not null and ${table.voidedBy} is not null
          end`,
    ),
  ],
);

export const posReturnLines = pos.table(
  'return_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id').notNull(),
    lineNo: integer('line_no').notNull(),
    saleId: uuid('sale_id').notNull(),
    saleLineNo: integer('sale_line_no').notNull(),
    skuId: uuid('sku_id').notNull(),
    qty: integer('qty').notNull(),
    refundPoisha: bigint('refund_poisha', { mode: 'bigint' }).notNull(),
    /** The sale line's unit cost, copied when the return posts. A cost field. */
    unitCostPoisha: bigint('unit_cost_poisha', { mode: 'bigint' }),
    ...timestamps,
  },
  (table) => [
    index('pos_return_lines_org_idx').on(table.orgId),
    index('pos_return_lines_org_sale_line_idx').on(table.orgId, table.saleId, table.saleLineNo),
    unique('pos_return_lines_org_return_line_key').on(table.orgId, table.returnId, table.lineNo),
    foreignKey({
      name: 'pos_return_lines_org_id_return_id_fk',
      columns: [table.orgId, table.returnId],
      foreignColumns: [posReturns.orgId, posReturns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_return_lines_org_id_sale_line_fk',
      columns: [table.orgId, table.saleId, table.saleLineNo],
      foreignColumns: [posSaleLines.orgId, posSaleLines.saleId, posSaleLines.lineNo],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_return_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('pos_return_lines_qty_positive', sql`${table.qty} > 0`),
    check('pos_return_lines_line_no_positive', sql`${table.lineNo} > 0`),
    check('pos_return_lines_refund_not_negative', sql`${table.refundPoisha} >= 0`),
    check(
      'pos_return_lines_cost_not_negative',
      sql`${table.unitCostPoisha} is null or ${table.unitCostPoisha} >= 0`,
    ),
  ],
);

export const posReturnTenders = pos.table(
  'return_tenders',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id').notNull(),
    tender: posTender('tender').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    walletId: uuid('wallet_id').notNull(),
    ...timestamps,
  },
  (table) => [
    index('pos_return_tenders_org_idx').on(table.orgId),
    uniqueIndex('pos_return_tenders_org_return_tender_idx').on(
      table.orgId,
      table.returnId,
      table.tender,
    ),
    foreignKey({
      name: 'pos_return_tenders_org_id_return_id_fk',
      columns: [table.orgId, table.returnId],
      foreignColumns: [posReturns.orgId, posReturns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_return_tenders_org_id_wallet_id_fk',
      columns: [table.orgId, table.walletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    check('pos_return_tenders_amount_positive', sql`${table.amountPoisha} > 0`),
  ],
);

/**
 * A document the server could not post as it arrived, waiting for a manager
 * (§14: "the conflict becomes a manager review item; it is never silently
 * dropped").
 *
 * One open item per document. A retry that fails again updates this row's
 * reasons and detail rather than opening a second, so the queue shows each stuck
 * sale once however often the till re-sent it.
 */
export const posReviewItems = pos.table(
  'review_items',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').notNull(),
    kind: posDocumentKind('kind').notNull(),
    saleId: uuid('sale_id'),
    returnId: uuid('return_id'),
    reasons: posHoldReason('reasons').array().notNull(),
    /** What the server saw: short lines, catalog prices, the ceiling applied. */
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    status: posReviewStatus('status').notNull().default('open'),
    attempts: integer('attempts').notNull().default(1),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    resolutionNote: text('resolution_note'),
    ...timestamps,
  },
  (table) => [
    index('pos_review_items_org_idx').on(table.orgId),
    index('pos_review_items_org_branch_status_idx').on(table.orgId, table.branchId, table.status),
    uniqueIndex('pos_review_items_org_open_sale_idx')
      .on(table.orgId, table.saleId)
      .where(sql`${table.status} = 'open' and ${table.saleId} is not null`),
    uniqueIndex('pos_review_items_org_open_return_idx')
      .on(table.orgId, table.returnId)
      .where(sql`${table.status} = 'open' and ${table.returnId} is not null`),
    unique('pos_review_items_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'pos_review_items_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_review_items_org_id_sale_id_fk',
      columns: [table.orgId, table.saleId],
      foreignColumns: [posSales.orgId, posSales.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_review_items_org_id_return_id_fk',
      columns: [table.orgId, table.returnId],
      foreignColumns: [posReturns.orgId, posReturns.id],
    }).onDelete('restrict'),
    check(
      'pos_review_items_document',
      sql`(${table.kind} = 'sale' and ${table.saleId} is not null and ${table.returnId} is null)
          or (${table.kind} = 'return' and ${table.returnId} is not null and ${table.saleId} is null)`,
    ),
    check('pos_review_items_has_reason', sql`cardinality(${table.reasons}) > 0`),
    check(
      'pos_review_items_resolution_shape',
      sql`(${table.status} = 'open') = (${table.resolvedAt} is null and ${table.resolvedBy} is null)`,
    ),
    check(
      'pos_review_items_note_length',
      sql`${table.resolutionNote} is null or length(${table.resolutionNote}) <= 500`,
    ),
  ],
);

/**
 * A branch's end of day: M08's closing for each counted wallet, plus the POS
 * summary a branch needs beside it.
 *
 * The counting, the variance and the `closing_variance` approval are M08's and are
 * not repeated here (`wallet_closing_id` points at M08's row). What this adds is the
 * readiness gate — no open shift, no unresolved review item — and a snapshot of the
 * day's till figures as they stood at close.
 */
export const posBranchClosings = pos.table(
  'branch_closings',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    closedBy: text('closed_by').notNull(),
    salesCount: integer('sales_count').notNull(),
    netSalesPoisha: bigint('net_sales_poisha', { mode: 'bigint' }).notNull(),
    refundsPoisha: bigint('refunds_poisha', { mode: 'bigint' }).notNull(),
    note: text('note'),
    ...timestamps,
  },
  (table) => [
    index('pos_branch_closings_org_idx').on(table.orgId),
    uniqueIndex('pos_branch_closings_org_branch_date_idx').on(
      table.orgId,
      table.branchId,
      table.businessDate,
    ),
    unique('pos_branch_closings_org_id_id_key').on(table.orgId, table.id),
    foreignKey({
      name: 'pos_branch_closings_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    check('pos_branch_closings_sales_count', sql`${table.salesCount} >= 0`),
    check(
      'pos_branch_closings_note_length',
      sql`${table.note} is null or length(${table.note}) <= 500`,
    ),
  ],
);

export const posBranchClosingWallets = pos.table(
  'branch_closing_wallets',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    branchClosingId: uuid('branch_closing_id').notNull(),
    walletId: uuid('wallet_id').notNull(),
    /** M08's closing row for this wallet and date. */
    walletClosingId: uuid('wallet_closing_id').notNull(),
    countedPoisha: bigint('counted_poisha', { mode: 'bigint' }).notNull(),
    ...timestamps,
  },
  (table) => [
    index('pos_branch_closing_wallets_org_idx').on(table.orgId),
    uniqueIndex('pos_branch_closing_wallets_org_closing_wallet_idx').on(
      table.orgId,
      table.branchClosingId,
      table.walletId,
    ),
    foreignKey({
      name: 'pos_branch_closing_wallets_org_id_closing_id_fk',
      columns: [table.orgId, table.branchClosingId],
      foreignColumns: [posBranchClosings.orgId, posBranchClosings.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_branch_closing_wallets_org_id_wallet_id_fk',
      columns: [table.orgId, table.walletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pos_branch_closing_wallets_org_id_wallet_closing_id_fk',
      columns: [table.orgId, table.walletClosingId],
      foreignColumns: [walletClosings.orgId, walletClosings.id],
    }).onDelete('restrict'),
    check('pos_branch_closing_wallets_counted', sql`${table.countedPoisha} >= 0`),
  ],
);
