import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
import { skus } from '../catalog/index.js';
import { primaryId, timestamps } from '../columns.js';
import { fileObjects } from '../files/index.js';
import { journals, ledgerAccounts } from '../ledger/index.js';
import { branches, locations, organizations } from '../org/index.js';

/**
 * Suppliers and purchasing (architecture §7, §8; M09).
 *
 * This is the one schema in the repo where a purchase price is typed in, so
 * invariant 5 is a property of these tables rather than of the code above them:
 * `supply_lines.unit_cost_poisha` and `return_lines.original_unit_cost_poisha`
 * are the only columns here that carry cost, both are named `*_poisha` so
 * `COST_FIELDS` and `serializeFor` can recognise them by name, and no analytics
 * grant is issued on any table below (0036). A read-only role is still a role
 * that can read.
 *
 * ## Two columns that are deliberately absent
 *
 * **No total on a supply header.** An entry's value is Σ qty × unit cost over its
 * lines, summed on read. A stored total is a second number that can disagree with
 * the lines it came from, and the thing that would discover the disagreement is
 * the supplier's own statement, months later.
 *
 * **No supplier balance column.** What a supplier is owed and what they hold as an
 * advance are both derived from `ledger.journal_lines` for the party. A maintained
 * column drifts the first time a journal is posted by a path that forgot to update
 * it — and M09 check 2 (the statement equals the ledger's party balances) would
 * then be comparing a cache against itself.
 *
 * ## What lives in the hand-written migrations instead
 *
 * Drizzle can express a column, a key, a CHECK and an index. It cannot express
 * the rest of what makes this schema safe, so migrations 0036–0038 carry it and
 * this file names it here so the two are read together:
 *
 * - **0036** — RLS ENABLE and FORCE plus the org-isolation policy on every table
 *   (invariant 4), and the grants. `supplier_notes`, `returns`, `return_lines` and
 *   `advance_applications` get INSERT and SELECT only; `supplies` and
 *   `supply_lines` get UPDATE and DELETE for the draft flow; `supplier_payments`
 *   gets UPDATE and never DELETE. Emitted by `tenantTableSql()` and pasted
 *   verbatim, because a policy that differs by one character fails silently and
 *   returns the wrong rows rather than throwing (D-048).
 * - **0037** — the triggers: `branch_id` derived from the location and from the
 *   wallet rather than trusted, a received entry frozen and undeletable, a line's
 *   status held equal to its header's, a payment's terms frozen the moment it is
 *   raised, and the row lock that makes two concurrent advance applications
 *   serialize instead of both passing.
 * - **0038** — the two trigram indexes for the supplier picker and the
 *   supplier-statement lookup index. Not mirrored here, the way M06's catalog
 *   search indexes are not mirrored in `catalog/index.ts`: an operator-class
 *   index belongs with the migration that creates the extension it needs.
 *
 * Every foreign key between two tenant tables carries `org_id` on **both** sides
 * against a `unique (org_id, id)` on the parent (D-047). Money is integer poisha
 * in a `bigint` column (invariant 1), timestamps are `timestamptz` and a business
 * date is an Asia/Dhaka calendar date (invariant 8).
 */
export const supply = pgSchema('supply');

/**
 * A supply entry is a draft until it is received, and then it is history.
 *
 * Only two states, and no `cancelled`: a draft nobody wants is deleted, and a
 * received entry is corrected with a supplier return, because it has already
 * moved stock and posted a journal (invariants 2 and 3).
 */
export const supplyStatus = supply.enum('supply_status', ['draft', 'received']);

/**
 * An advance is money paid before the goods, a payment is money paid against what
 * is owed. They are different accounts, not a flag on one: `supplier_advance` is
 * an asset and `supplier_payable` a liability, so netting them would hide an
 * advance sitting with a supplier the brand also owes money to.
 */
export const supplierPaymentKind = supply.enum('supplier_payment_kind', ['advance', 'payment']);

export const supplierPaymentStatus = supply.enum('supplier_payment_status', [
  'pending_approval',
  'posted',
  'rejected',
]);

/**
 * A supplier: the mill, the accessories house, the printer.
 *
 * `code` is what the purchasing team says out loud and types into the picker, so
 * it is unique per org and shaped rather than free text — a code with a space or a
 * lower-case letter in it is a code somebody will fail to find again.
 *
 * There is no DELETE grant (0036). Deleting a supplier would orphan every entry,
 * return and payment that names it, and a supplier the brand once bought from is
 * part of the record; `is_active` is how one stops being used, and 0037's trigger
 * refuses new purchases from an inactive one while leaving the old ones readable
 * and their payables payable.
 */
export const suppliers = supply.table(
  'suppliers',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    /**
     * Net terms in days, or null when the brand pays on delivery.
     *
     * Informational: nothing here computes a due date from it yet. Bounded anyway,
     * because a typo of 3650 would drive whatever ageing report reads it next.
     */
    paymentTermsDays: integer('payment_terms_days'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    unique('suppliers_org_id_id_key').on(table.orgId, table.id),
    index('suppliers_org_idx').on(table.orgId),
    uniqueIndex('suppliers_org_code_idx').on(table.orgId, table.code),
    check('suppliers_code_shape', sql`${table.code} ~ '^[0-9A-Z][0-9A-Z-]{0,23}$'`),
    check('suppliers_name_length', sql`length(${table.name}) between 1 and 160`),
    check('suppliers_phone_length', sql`${table.phone} is null or length(${table.phone}) <= 32`),
    check('suppliers_email_length', sql`${table.email} is null or length(${table.email}) <= 160`),
    check(
      'suppliers_address_length',
      sql`${table.address} is null or length(${table.address}) <= 500`,
    ),
    check(
      'suppliers_terms_range',
      sql`${table.paymentTermsDays} is null or (${table.paymentTermsDays} between 0 and 365)`,
    ),
  ],
);

/**
 * The people at a supplier: a merchandiser, an accounts contact, a driver.
 *
 * `is_primary` is kept to one per supplier by the repository, inside the same
 * transaction that inserts, so a list ordered by `is_primary desc` never shows two
 * people as the main contact.
 *
 * This table gets DELETE (0036), unlike most of the schema: a merchandiser who
 * left is a correction with no accounting weight.
 */
export const supplierContacts = supply.table(
  'supplier_contacts',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').notNull(),
    name: text('name').notNull(),
    role: text('role'),
    phone: text('phone'),
    email: text('email'),
    isPrimary: boolean('is_primary').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    unique('supplier_contacts_org_id_id_key').on(table.orgId, table.id),
    index('supplier_contacts_org_idx').on(table.orgId),
    index('supplier_contacts_org_supplier_idx').on(table.orgId, table.supplierId),
    foreignKey({
      name: 'supplier_contacts_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('restrict'),
    check('supplier_contacts_name_length', sql`length(${table.name}) between 1 and 120`),
    check(
      'supplier_contacts_phone_length',
      sql`${table.phone} is null or length(${table.phone}) <= 32`,
    ),
  ],
);

/**
 * Somebody's account of what a supplier said: a late shipment, a shade they
 * promised to match, a price they refused to hold.
 *
 * Append-only (0036 grants INSERT and SELECT; 0037 refuses UPDATE and DELETE for
 * every role including the migration one). An editable note is a note that can be
 * made to agree with whatever happened next, and the reason anybody reads these is
 * to find out what was said *before* it happened.
 */
export const supplierNotes = supply.table(
  'supplier_notes',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('supplier_notes_org_id_id_key').on(table.orgId, table.id),
    index('supplier_notes_org_idx').on(table.orgId),
    index('supplier_notes_org_supplier_idx').on(table.orgId, table.supplierId),
    foreignKey({
      name: 'supplier_notes_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('restrict'),
    check('supplier_notes_body_length', sql`length(${table.body}) between 1 and 2000`),
  ],
);

/**
 * A trade licence, a quotation, a signed rate sheet.
 *
 * A row per (supplier, file) rather than an array on the supplier, because §22's
 * files are rows with their own lifecycle: an upload that never completed must not
 * appear on a supplier page, and that is a join rather than a JSON array.
 *
 * The service checks that the file is a **private** object with the
 * `supply-document` purpose before it writes this row, and that check is the
 * access control: `PURPOSE_RULES` maps the purpose to `read Supply`, so a quotation
 * uploaded as a `product-image` would be readable by every role with
 * `read Catalog`, and a public one by anyone holding the URL.
 *
 * The unique index on (org, file) is what stops the same object being attached
 * twice, which would make revoking it a question of how many rows point at it.
 */
export const supplierDocuments = supply.table(
  'supplier_documents',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').notNull(),
    fileObjectId: uuid('file_object_id').notNull(),
    label: text('label').notNull(),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('supplier_documents_org_id_id_key').on(table.orgId, table.id),
    index('supplier_documents_org_idx').on(table.orgId),
    index('supplier_documents_org_supplier_idx').on(table.orgId, table.supplierId),
    uniqueIndex('supplier_documents_org_file_idx').on(table.orgId, table.fileObjectId),
    foreignKey({
      name: 'supplier_documents_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplier_documents_org_id_file_object_id_fk',
      columns: [table.orgId, table.fileObjectId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    check('supplier_documents_label_length', sql`length(${table.label}) between 1 and 160`),
  ],
);

/**
 * One delivery from one supplier: the header.
 *
 * Received in a single transaction that creates the stock movements, blends the
 * weighted average, posts `Dr Inventory / Cr Supplier payable` and flips this row
 * (M09 check 1). Everything that decided those three is on the row afterwards —
 * the journal, the instant, the business date, who received it — and 0037 freezes
 * all of them, because none of the three can be taken back.
 *
 * `branch_id` repeats the location's branch. Two copies of one fact is the shape
 * that drifts, and the drift here would be a delivery whose cost a manager of
 * another branch can see, so 0037 derives the copy on every write rather than
 * trusting the caller — and refuses a location that is not a warehouse or a
 * showroom, because a receipt into `in_transit` or `damaged` would blend purchase
 * cost into an average nothing sells from.
 *
 * The partial unique index is the one constraint here that saves real money:
 * paying one invoice twice is the expensive mistake in purchasing. Partial, on
 * `received` rows with a number, because a draft legitimately has no invoice
 * number yet and two drafts with none are not duplicates.
 *
 * `attachment_file_id` stays editable after receipt on purpose: the scanned challan
 * usually arrives after the goods do.
 */
export const supplies = supply.table(
  'supplies',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** Derived from the location by 0037, for §6's branch row scope and the branch FK. */
    branchId: uuid('branch_id'),
    status: supplyStatus('status').notNull().default('draft'),
    invoiceNumber: text('invoice_number'),
    /** Null while it is a draft: nothing has happened yet to have happened at a time. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }),
    /** The Asia/Dhaka date of `occurred_at`, computed in the domain (invariant 8). */
    businessDate: date('business_date', { mode: 'string' }),
    attachmentFileId: uuid('attachment_file_id'),
    journalId: uuid('journal_id'),
    createdBy: text('created_by').notNull(),
    receivedBy: text('received_by'),
    ...timestamps,
  },
  (table) => [
    unique('supplies_org_id_id_key').on(table.orgId, table.id),
    index('supplies_org_idx').on(table.orgId),
    index('supplies_org_supplier_idx').on(table.orgId, table.supplierId),
    index('supplies_org_status_idx').on(table.orgId, table.status),
    index('supplies_org_date_idx').on(table.orgId, table.businessDate),
    index('supplies_org_branch_idx').on(table.orgId, table.branchId),
    uniqueIndex('supplies_org_supplier_invoice_idx')
      .on(table.orgId, table.supplierId, table.invoiceNumber)
      // Unqualified on purpose: this is the predicate as the index carries it, and
      // a qualified column reference in a partial index renders differently in the
      // catalog than migration 0035 wrote it.
      .where(sql`status = 'received' and invoice_number is not null`),
    foreignKey({
      name: 'supplies_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplies_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplies_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplies_org_id_attachment_file_id_fk',
      columns: [table.orgId, table.attachmentFileId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    /*
     * The journal, referenced composite so it can only be satisfied from within
     * this org (D-047), and `restrict` so it cannot be deleted out from under a
     * received purchase — which is what keeps "what did this delivery post"
     * answerable a year later.
     */
    foreignKey({
      name: 'supplies_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check(
      'supplies_invoice_length',
      sql`${table.invoiceNumber} is null or length(${table.invoiceNumber}) between 1 and 64`,
    ),
    /*
     * A received entry with no journal, or a draft that claims a receiver, is a
     * state nothing produces on purpose and a partial update produces easily.
     */
    check(
      'supplies_status_journal',
      sql`case ${table.status}
            when 'received' then ${table.journalId} is not null and ${table.occurredAt} is not null
                 and ${table.businessDate} is not null and ${table.receivedBy} is not null
            else ${table.journalId} is null and ${table.receivedBy} is null
          end`,
    ),
  ],
);

/**
 * One SKU on one delivery: how many, and what each cost.
 *
 * `unit_cost_poisha` is nullable, and that is D-005: the warehouse records a
 * qty-only draft and accounts prices it. The line carries a copy of the header's
 * `status` so the "a received line has a cost" rule can be a CHECK — a CHECK sees
 * only its own row — and 0037 both derives that copy and refuses to let a received
 * line change again. The failure mode this arrangement exists to prevent is a
 * received line with a null cost, which is a purchase whose value entered inventory
 * as nothing.
 *
 * `line_no` is the order on the paper challan, so a printed entry reads in the
 * order it was counted. Unique on (org, supply, sku) as well: the same SKU twice on
 * one entry is two quantities nobody reconciled, and the repository replaces a
 * draft's lines wholesale rather than diffing them.
 */
export const supplyLines = supply.table(
  'supply_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplyId: uuid('supply_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    lineNo: integer('line_no').notNull(),
    qty: integer('qty').notNull(),
    /** Purchase cost (invariant 5). Null only while the entry is a draft (D-005). */
    unitCostPoisha: bigint('unit_cost_poisha', { mode: 'bigint' }),
    /** The header's status, derived by 0037 so the CHECK below can see it. */
    status: supplyStatus('status').notNull().default('draft'),
    ...timestamps,
  },
  (table) => [
    unique('supply_lines_org_id_id_key').on(table.orgId, table.id),
    index('supply_lines_org_idx').on(table.orgId),
    index('supply_lines_org_supply_idx').on(table.orgId, table.supplyId),
    index('supply_lines_org_sku_idx').on(table.orgId, table.skuId),
    uniqueIndex('supply_lines_org_supply_sku_idx').on(table.orgId, table.supplyId, table.skuId),
    /*
     * Cascade, alone in this schema, and only because a draft header may be
     * deleted: the alternative is a delete that fails on its own children. A
     * received header cannot be deleted at all (0037), so nothing cascades from
     * one.
     */
    foreignKey({
      name: 'supply_lines_org_id_supply_id_fk',
      columns: [table.orgId, table.supplyId],
      foreignColumns: [supplies.orgId, supplies.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'supply_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('supply_lines_qty_positive', sql`${table.qty} > 0`),
    check('supply_lines_line_no_positive', sql`${table.lineNo} > 0`),
    /*
     * Zero is allowed. Free stock is real — samples, replacements against a bad
     * lot — and refusing a zero cost would push it through a stock adjustment,
     * where it would look like a count error rather than a delivery.
     */
    check(
      'supply_lines_cost_not_negative',
      sql`${table.unitCostPoisha} is null or ${table.unitCostPoisha} >= 0`,
    ),
    check(
      'supply_lines_costed_when_received',
      sql`${table.status} <> 'received' or ${table.unitCostPoisha} is not null`,
    ),
  ],
);

/**
 * Stock going back to a supplier.
 *
 * Append-only, header and lines both (0036's grants, 0037's trigger). The row owns
 * a journal and a journal never changes after posting (invariant 2), so a row that
 * could be edited afterwards would let the paperwork and the ledger disagree about
 * one event — with the ledger, correctly, refusing to move. A return sent in error
 * is corrected by receiving the goods back in, not by editing this.
 *
 * `supply_id` is optional because a return is not always traceable to one delivery:
 * a shade problem found across two lots is one credit note to the supplier.
 *
 * `journal_id` is nullable in the column and never null in practice — the service
 * posts before it inserts. It stays nullable because making it NOT NULL would
 * force a placeholder id in the one case that matters, a partially built row, and
 * the honest shape of "no journal" is null.
 */
export const supplyReturns = supply.table(
  'returns',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').notNull(),
    supplyId: uuid('supply_id'),
    locationId: uuid('location_id').notNull(),
    /** Derived from the location by 0037, exactly as on a supply header. */
    branchId: uuid('branch_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** Required: a return with no stated reason is a dispute nobody can reconstruct. */
    reason: text('reason').notNull(),
    journalId: uuid('journal_id'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('supply_returns_org_id_id_key').on(table.orgId, table.id),
    index('returns_org_idx').on(table.orgId),
    index('returns_org_supplier_idx').on(table.orgId, table.supplierId),
    index('returns_org_date_idx').on(table.orgId, table.businessDate),
    index('returns_org_branch_idx').on(table.orgId, table.branchId),
    foreignKey({
      name: 'supply_returns_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supply_returns_org_id_supply_id_fk',
      columns: [table.orgId, table.supplyId],
      foreignColumns: [supplies.orgId, supplies.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supply_returns_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supply_returns_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supply_returns_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('supply_returns_reason_length', sql`length(${table.reason}) between 1 and 500`),
  ],
);

/**
 * One returned SKU: how many, and what the supplier originally charged for one.
 *
 * `original_unit_cost_poisha` is what goes on the credit note, and it is **not**
 * what inventory is relieved at — that is the weighted average, captured under the
 * cost row's lock as the movement is written (§8, M09 check 3). The gap between the
 * two is a purchase price variance with its own account, so a price movement between
 * the purchase and the return shows up in the P&L instead of quietly distorting the
 * average. Storing only one of the two costs here would make the variance
 * unexplainable afterwards.
 */
export const supplyReturnLines = supply.table(
  'return_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    returnId: uuid('return_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    qty: integer('qty').notNull(),
    /** Purchase cost (invariant 5): what the supplier charged, per unit. */
    originalUnitCostPoisha: bigint('original_unit_cost_poisha', { mode: 'bigint' }).notNull(),
    ...timestamps,
  },
  (table) => [
    unique('supply_return_lines_org_id_id_key').on(table.orgId, table.id),
    index('return_lines_org_idx').on(table.orgId),
    index('return_lines_org_return_idx').on(table.orgId, table.returnId),
    uniqueIndex('supply_return_lines_org_return_sku_idx').on(
      table.orgId,
      table.returnId,
      table.skuId,
    ),
    foreignKey({
      name: 'supply_return_lines_org_id_return_id_fk',
      columns: [table.orgId, table.returnId],
      foreignColumns: [supplyReturns.orgId, supplyReturns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'supply_return_lines_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('restrict'),
    check('supply_return_lines_qty_positive', sql`${table.qty} > 0`),
    check('supply_return_lines_cost_not_negative', sql`${table.originalUnitCostPoisha} >= 0`),
  ],
);

/**
 * Money going to a supplier: an advance before the goods, or a payment against
 * what is owed (§7: `Dr Supplier advance / Cr W` and `Dr Supplier payable / Cr W`).
 *
 * `wallet_account_id` points at a `ledger.accounts` row, and 0037 checks its
 * subtype is a `wallet_*` on every write. Crediting anything else would balance
 * the journal and misstate where the money came from, and the posting rule's own
 * check can be bypassed by anything that writes this table without going through
 * it.
 *
 * ## Waiting for a checker means no journal at all
 *
 * §6 routes supplier payments above the org's threshold through approvals. Such a
 * row is born `pending_approval` with `journal_id` null, so it is in no report, no
 * balance and no supplier statement until a checker decides it — and the CHECK
 * below is what makes "posted with no journal" impossible rather than merely
 * unlikely. Posting first and reversing on rejection would leave two journals in
 * the day book for money that never left the bank, and a supplier statement that
 * said, for a week, that the brand had paid.
 *
 * There is UPDATE but no DELETE (0036), and 0037 freezes every term the moment the
 * row is raised: the amount a checker approved has to be the amount that gets
 * paid, and an UPDATE between the reading and the posting is the classic
 * maker-checker bypass — one that needs no privilege beyond the UPDATE this table
 * already grants.
 */
export const supplierPayments = supply.table(
  'supplier_payments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    supplierId: uuid('supplier_id').notNull(),
    /** The `wallet_*` ledger account the money left. Checked by 0037. */
    walletAccountId: uuid('wallet_account_id').notNull(),
    /** Derived from the wallet by 0037: a branch's till pays from that branch. */
    branchId: uuid('branch_id'),
    kind: supplierPaymentKind('kind').notNull(),
    /** No default: a payment is raised either already posted or waiting, never by accident. */
    status: supplierPaymentStatus('status').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    memo: text('memo'),
    approvalRequestId: uuid('approval_request_id'),
    journalId: uuid('journal_id'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('supplier_payments_org_id_id_key').on(table.orgId, table.id),
    index('supplier_payments_org_idx').on(table.orgId),
    index('supplier_payments_org_supplier_idx').on(table.orgId, table.supplierId),
    index('supplier_payments_org_status_idx').on(table.orgId, table.status),
    index('supplier_payments_org_date_idx').on(table.orgId, table.businessDate),
    index('supplier_payments_org_branch_idx').on(table.orgId, table.branchId),
    foreignKey({
      name: 'supplier_payments_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplier_payments_org_id_wallet_account_id_fk',
      columns: [table.orgId, table.walletAccountId],
      foreignColumns: [ledgerAccounts.orgId, ledgerAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplier_payments_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplier_payments_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'supplier_payments_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('supplier_payments_amount_positive', sql`${table.amountPoisha} > 0`),
    check(
      'supplier_payments_memo_length',
      sql`${table.memo} is null or length(${table.memo}) <= 500`,
    ),
    check(
      'supplier_payments_status_journal',
      sql`case ${table.status}
            when 'posted' then ${table.journalId} is not null
            when 'pending_approval' then ${table.journalId} is null and ${table.approvalRequestId} is not null
            else ${table.journalId} is null
          end`,
    ),
  ],
);

/**
 * An advance set against a received supply (§7: `Dr Supplier payable / Cr
 * Supplier advance`).
 *
 * Separate from the receipt, and that separation is the point. A receipt credits
 * the payable for what the invoice says, whatever was paid ahead; this cancels the
 * two balances against each other afterwards. Netting inside the receipt would
 * post a payable that does not match the supplier's own invoice, and the first
 * reconciliation against their statement would be unexplainable.
 *
 * Append-only, like a return, because it owns a journal. One row per (payment,
 * supply), so an advance can be split across several deliveries but not applied to
 * the same one twice — and 0037 sums the applications **after locking the payment
 * row**, which is what makes two clerks applying one advance at the same moment
 * serialize instead of both passing. Over-application would leave
 * `supplier_advance` — an asset — carrying a credit balance, and the balance sheet
 * would show a negative asset for a supplier who is in fact owed money.
 */
export const advanceApplications = supply.table(
  'advance_applications',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Denormalized from the payment so 0037 can refuse a cross-supplier application. */
    supplierId: uuid('supplier_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    supplyId: uuid('supply_id').notNull(),
    amountPoisha: bigint('amount_poisha', { mode: 'bigint' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    /** NOT NULL: this row exists only because a journal was posted for it. */
    journalId: uuid('journal_id').notNull(),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('advance_applications_org_id_id_key').on(table.orgId, table.id),
    index('advance_applications_org_idx').on(table.orgId),
    index('advance_applications_org_payment_idx').on(table.orgId, table.paymentId),
    index('advance_applications_org_supply_idx').on(table.orgId, table.supplyId),
    uniqueIndex('advance_applications_org_payment_supply_idx').on(
      table.orgId,
      table.paymentId,
      table.supplyId,
    ),
    foreignKey({
      name: 'advance_applications_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'advance_applications_org_id_payment_id_fk',
      columns: [table.orgId, table.paymentId],
      foreignColumns: [supplierPayments.orgId, supplierPayments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'advance_applications_org_id_supply_id_fk',
      columns: [table.orgId, table.supplyId],
      foreignColumns: [supplies.orgId, supplies.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'advance_applications_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check('advance_applications_amount_positive', sql`${table.amountPoisha} > 0`),
  ],
);

/**
 * A variant's standard buying price, for any supplier or for one (M39b, D-638).
 *
 * What the next receipt of this variant is **prefilled** with (the receive dialog, Supply →
 * Entries, a draft being priced, the new-product form), and nothing more: the cost that
 * enters inventory and the books is still the one on the posted receipt (invariants 2 and
 * 5). It never feeds the weighted average and no journal reads it.
 *
 * Purchase cost, so it lives here in supply rather than on `catalog.skus` (invariant 5):
 * `standard_unit_cost_poisha` is in `COST_FIELDS`, every route that reads it declares
 * `read Cost`, and the catalog's responses and the reseller allow-list never join it.
 *
 * One row per (variant, supplier), the supplier null for "any supplier": the unique index
 * coalesces a null supplier so two "any" rows cannot exist. Both foreign keys cascade: a
 * standard price is a preference, and a variant or supplier deleted because it was never
 * used (M39a) takes its preference with it rather than being refused over one. RLS and the
 * grants are in M39b's policies migration.
 */
export const skuPurchasePrices = supply.table(
  'sku_purchase_prices',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    skuId: uuid('sku_id').notNull(),
    /** Null: the standard for any supplier. */
    supplierId: uuid('supplier_id'),
    /** Purchase cost (invariant 5): integer poisha, above zero. */
    standardUnitCostPoisha: bigint('standard_unit_cost_poisha', { mode: 'bigint' }).notNull(),
    updatedBy: text('updated_by'),
    ...timestamps,
  },
  (table) => [
    unique('sku_purchase_prices_org_id_id_key').on(table.orgId, table.id),
    index('sku_purchase_prices_org_idx').on(table.orgId),
    index('sku_purchase_prices_org_supplier_idx').on(table.orgId, table.supplierId),
    uniqueIndex('sku_purchase_prices_org_sku_supplier_idx').on(
      table.orgId,
      table.skuId,
      sql`coalesce(${table.supplierId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    foreignKey({
      name: 'sku_purchase_prices_org_id_sku_id_fk',
      columns: [table.orgId, table.skuId],
      foreignColumns: [skus.orgId, skus.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sku_purchase_prices_org_id_supplier_id_fk',
      columns: [table.orgId, table.supplierId],
      foreignColumns: [suppliers.orgId, suppliers.id],
    }).onDelete('cascade'),
    check(
      'sku_purchase_prices_cost_positive',
      sql`${table.standardUnitCostPoisha} > 0 and ${table.standardUnitCostPoisha} <= 9000000000000000`,
    ),
    check(
      'sku_purchase_prices_updated_by_length',
      sql`${table.updatedBy} is null or length(${table.updatedBy}) <= 120`,
    ),
  ],
);
