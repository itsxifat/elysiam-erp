import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the supply module runs (tenancy rules: raw SQL lives in
 * repositories, parameterised, never built by string interpolation).
 *
 * All of it runs inside a caller's `withOrg()` transaction, so RLS is what keeps one
 * brand's suppliers out of another's — the `org_id = …` predicates below are the
 * planner's help, not the isolation.
 *
 * **No statement here reads a stored supplier balance, because there is not one.**
 * What a supplier is owed and what they hold as an advance are both
 * `Σ credit − Σ debit` (or the reverse, per the account's normal side) over
 * `ledger.journal_lines` for the party, computed on every read — the same choice M08
 * made for wallets and for the same reason. It is what makes M09 check 2 true by
 * construction: the statement and the ledger's own party balances are the same query
 * over the same rows.
 */

// --- suppliers ---------------------------------------------------------------

export interface SupplierRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly payment_terms_days: number | null;
  readonly is_active: boolean;
}

const SUPPLIER_COLUMNS = sql`s.id, s.code, s.name, s.phone, s.email, s.address,
  s.payment_terms_days, s.is_active`;

export async function listSuppliers(
  tx: Tx,
  orgId: string,
  filters: { readonly q: string | undefined; readonly includeInactive: boolean },
): Promise<SupplierRow[]> {
  // `%` wrapped here rather than by the caller, so the caller never builds a
  // pattern and a literal `%` in somebody's supplier name stays a literal.
  const pattern = filters.q === undefined ? undefined : `%${filters.q}%`;
  const rows = await tx.execute<SupplierRow>(sql`
    select ${SUPPLIER_COLUMNS}
    from supply.suppliers s
    where s.org_id = ${orgId}
      and ${filters.includeInactive ? sql`true` : sql`s.is_active`}
      and ${
        pattern === undefined
          ? sql`true`
          : sql`(s.name ilike ${pattern}
                 or coalesce(s.code, '') || ' ' || coalesce(s.phone, '') ilike ${pattern})`
      }
    order by s.name
    limit 500
  `);
  return [...rows];
}

/**
 * The brand's active suppliers as a picker needs them: id, code and name (D-419).
 *
 * Nothing else is selected. The full list carries contacts and, for cost readers, the
 * balances; a warehouse clerk choosing who delivered a draft needs neither, and a column
 * that is never read cannot leak (invariant 5).
 */
export async function supplierOptions(
  tx: Tx,
  orgId: string,
): Promise<{ id: string; code: string; name: string }[]> {
  const rows = await tx.execute<{ id: string; code: string; name: string }>(sql`
    select s.id, s.code, s.name
    from supply.suppliers s
    where s.org_id = ${orgId} and s.is_active
    order by s.name
    limit 1000
  `);
  return [...rows];
}

/** Suppliers by code, active or not (M14a's supplier balances). */
export async function suppliersByCodes(
  tx: Tx,
  orgId: string,
  codes: readonly string[],
): Promise<{ id: string; code: string; is_active: boolean }[]> {
  if (codes.length === 0) return [];
  const rows = await tx.execute<{ id: string; code: string; is_active: boolean }>(sql`
    select id, code, is_active from supply.suppliers
    where org_id = ${orgId} and code = any (${sql.param([...new Set(codes)])}::text[])
  `);
  return [...rows];
}

export async function supplierById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SupplierRow | undefined> {
  const rows = await tx.execute<SupplierRow>(sql`
    select ${SUPPLIER_COLUMNS} from supply.suppliers s
    where s.org_id = ${orgId} and s.id = ${id}
  `);
  return rows[0];
}

export interface NewSupplier {
  readonly orgId: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly paymentTermsDays: number | null;
}

export async function insertSupplier(tx: Tx, supplier: NewSupplier): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into supply.suppliers (org_id, code, name, phone, email, address, payment_terms_days)
    values (${supplier.orgId}, ${supplier.code}, ${supplier.name}, ${supplier.phone},
            ${supplier.email}, ${supplier.address}, ${supplier.paymentTermsDays})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a supplier returned no id');
  return id;
}

export async function updateSupplier(
  tx: Tx,
  orgId: string,
  id: string,
  patch: {
    readonly name?: string;
    readonly phone?: string | null;
    readonly email?: string | null;
    readonly address?: string | null;
    readonly paymentTermsDays?: number | null;
    readonly isActive?: boolean;
  },
): Promise<void> {
  const sets: SQL[] = [];
  if (patch.name !== undefined) sets.push(sql`name = ${patch.name}`);
  if (patch.phone !== undefined) sets.push(sql`phone = ${patch.phone}`);
  if (patch.email !== undefined) sets.push(sql`email = ${patch.email}`);
  if (patch.address !== undefined) sets.push(sql`address = ${patch.address}`);
  if (patch.paymentTermsDays !== undefined) {
    sets.push(sql`payment_terms_days = ${patch.paymentTermsDays}`);
  }
  if (patch.isActive !== undefined) sets.push(sql`is_active = ${patch.isActive}`);
  if (sets.length === 0) return;
  sets.push(sql`updated_at = now()`);
  await tx.execute(sql`
    update supply.suppliers set ${sql.join(sets, sql`, `)}
    where org_id = ${orgId} and id = ${id}
  `);
}

export interface ContactRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly role: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly is_primary: boolean;
}

export async function listContacts(
  tx: Tx,
  orgId: string,
  supplierId: string,
): Promise<ContactRow[]> {
  const rows = await tx.execute<ContactRow>(sql`
    select id, name, role, phone, email, is_primary
    from supply.supplier_contacts
    where org_id = ${orgId} and supplier_id = ${supplierId}
    order by is_primary desc, name
  `);
  return [...rows];
}

export async function insertContact(
  tx: Tx,
  contact: {
    readonly orgId: string;
    readonly supplierId: string;
    readonly name: string;
    readonly role: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly isPrimary: boolean;
  },
): Promise<string> {
  // One primary at a time: demote the rest first, inside the same transaction, so a
  // list ordered by `is_primary desc` never shows two people as the main contact.
  if (contact.isPrimary) {
    await tx.execute(sql`
      update supply.supplier_contacts set is_primary = false, updated_at = now()
      where org_id = ${contact.orgId} and supplier_id = ${contact.supplierId} and is_primary
    `);
  }
  const rows = await tx.execute<{ id: string }>(sql`
    insert into supply.supplier_contacts
      (org_id, supplier_id, name, role, phone, email, is_primary)
    values (${contact.orgId}, ${contact.supplierId}, ${contact.name}, ${contact.role},
            ${contact.phone}, ${contact.email}, ${contact.isPrimary})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a supplier contact returned no id');
  return id;
}

export interface NoteRow extends Record<string, unknown> {
  readonly id: string;
  readonly body: string;
  readonly created_by: string;
  readonly created_at: Date;
}

export async function listNotes(tx: Tx, orgId: string, supplierId: string): Promise<NoteRow[]> {
  const rows = await tx.execute<NoteRow>(sql`
    select id, body, created_by, created_at
    from supply.supplier_notes
    where org_id = ${orgId} and supplier_id = ${supplierId}
    order by created_at desc
    limit 200
  `);
  return [...rows];
}

export async function insertNote(
  tx: Tx,
  note: {
    readonly orgId: string;
    readonly supplierId: string;
    readonly body: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into supply.supplier_notes (org_id, supplier_id, body, created_by)
    values (${note.orgId}, ${note.supplierId}, ${note.body}, ${note.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a supplier note returned no id');
  return id;
}

export interface DocumentRow extends Record<string, unknown> {
  readonly id: string;
  readonly file_object_id: string;
  readonly label: string;
  readonly created_at: Date;
}

export async function listDocuments(
  tx: Tx,
  orgId: string,
  supplierId: string,
): Promise<DocumentRow[]> {
  const rows = await tx.execute<DocumentRow>(sql`
    select id, file_object_id, label, created_at
    from supply.supplier_documents
    where org_id = ${orgId} and supplier_id = ${supplierId}
    order by created_at desc
  `);
  return [...rows];
}

export async function insertDocument(
  tx: Tx,
  document: {
    readonly orgId: string;
    readonly supplierId: string;
    readonly fileObjectId: string;
    readonly label: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into supply.supplier_documents
      (org_id, supplier_id, file_object_id, label, created_by)
    values (${document.orgId}, ${document.supplierId}, ${document.fileObjectId},
            ${document.label}, ${document.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a supplier document returned no id');
  return id;
}

// --- supply entries ----------------------------------------------------------

export interface SupplyRow extends Record<string, unknown> {
  readonly id: string;
  readonly supplier_id: string;
  readonly supplier_name: string;
  readonly location_id: string;
  readonly branch_id: string | null;
  readonly status: 'draft' | 'received';
  readonly invoice_number: string | null;
  readonly occurred_at: Date | null;
  readonly business_date: string | null;
  readonly attachment_file_id: string | null;
  readonly journal_id: string | null;
  readonly created_by: string;
  readonly received_by: string | null;
}

const SUPPLY_COLUMNS = sql`e.id, e.supplier_id, sup.name as supplier_name, e.location_id,
  e.branch_id, e.status::text as status, e.invoice_number, e.occurred_at, e.business_date,
  e.attachment_file_id, e.journal_id, e.created_by, e.received_by`;

export async function listSupplies(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly supplierId: string | undefined;
    readonly status: string | undefined;
    readonly from: string | undefined;
    readonly to: string | undefined;
  },
): Promise<SupplyRow[]> {
  const rows = await tx.execute<SupplyRow>(sql`
    select ${SUPPLY_COLUMNS}
    from supply.supplies e
    join supply.suppliers sup on sup.org_id = e.org_id and sup.id = e.supplier_id
    where e.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.supplierId === undefined ? sql`true` : sql`e.supplier_id = ${filters.supplierId}`}
      and ${filters.status === undefined ? sql`true` : sql`e.status::text = ${filters.status}`}
      and ${filters.from === undefined ? sql`true` : sql`e.business_date >= ${filters.from}`}
      and ${filters.to === undefined ? sql`true` : sql`e.business_date <= ${filters.to}`}
    order by coalesce(e.business_date, current_date) desc, e.created_at desc
    limit 500
  `);
  return [...rows];
}

export async function supplyById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SupplyRow | undefined> {
  const rows = await tx.execute<SupplyRow>(sql`
    select ${SUPPLY_COLUMNS}
    from supply.supplies e
    join supply.suppliers sup on sup.org_id = e.org_id and sup.id = e.supplier_id
    where e.org_id = ${orgId} and e.id = ${id}
  `);
  return rows[0];
}

/**
 * The entry's row, locked.
 *
 * Taken before receiving one, so two people pricing the same draft at the same moment
 * serialize: the second waits, then sees `status = 'received'` and is refused, rather
 * than both posting a journal and both creating movements for one delivery.
 */
export async function supplyForUpdate(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<
  | {
      id: string;
      status: 'draft' | 'received';
      supplier_id: string;
      location_id: string;
      branch_id: string | null;
    }
  | undefined
> {
  const rows = await tx.execute<{
    id: string;
    status: 'draft' | 'received';
    supplier_id: string;
    location_id: string;
    branch_id: string | null;
  }>(sql`
    select id, status::text as status, supplier_id, location_id, branch_id
    from supply.supplies
    where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

export interface SupplyLineRow extends Record<string, unknown> {
  readonly id: string;
  readonly sku_id: string;
  readonly sku_code: string;
  readonly product_name: string;
  readonly line_no: number;
  readonly qty: number;
  readonly unit_cost_poisha: string | null;
}

export async function supplyLines(
  tx: Tx,
  orgId: string,
  supplyId: string,
): Promise<SupplyLineRow[]> {
  const rows = await tx.execute<SupplyLineRow>(sql`
    select l.id, l.sku_id, s.code as sku_code, p.name as product_name, l.line_no, l.qty,
           l.unit_cost_poisha::text as unit_cost_poisha
    from supply.supply_lines l
    join catalog.skus s on s.org_id = l.org_id and s.id = l.sku_id
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    where l.org_id = ${orgId} and l.supply_id = ${supplyId}
    order by l.line_no
  `);
  return [...rows];
}

export async function insertSupply(
  tx: Tx,
  entry: {
    readonly orgId: string;
    readonly id: string;
    readonly supplierId: string;
    readonly locationId: string;
    readonly invoiceNumber: string | null;
    readonly createdBy: string;
  },
): Promise<void> {
  // `branch_id` is left to migration 0037's trigger, which derives it from the
  // location. Sending one would be a second copy of a fact the trigger owns.
  await tx.execute(sql`
    insert into supply.supplies (id, org_id, supplier_id, location_id, invoice_number,
                                 status, created_by)
    values (${entry.id}, ${entry.orgId}, ${entry.supplierId}, ${entry.locationId},
            ${entry.invoiceNumber}, 'draft', ${entry.createdBy})
  `);
}

export async function insertSupplyLine(
  tx: Tx,
  line: {
    readonly orgId: string;
    readonly supplyId: string;
    readonly skuId: string;
    readonly lineNo: number;
    readonly qty: number;
    readonly unitCostPoisha: bigint | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into supply.supply_lines (org_id, supply_id, sku_id, line_no, qty, unit_cost_poisha)
    values (${line.orgId}, ${line.supplyId}, ${line.skuId}, ${line.lineNo}, ${line.qty},
            ${line.unitCostPoisha === null ? null : line.unitCostPoisha.toString()}::bigint)
  `);
}

export async function deleteSupplyLines(tx: Tx, orgId: string, supplyId: string): Promise<void> {
  await tx.execute(sql`
    delete from supply.supply_lines where org_id = ${orgId} and supply_id = ${supplyId}
  `);
}

export async function priceSupplyLine(
  tx: Tx,
  orgId: string,
  supplyId: string,
  line: { readonly skuId: string; readonly qty: number | null; readonly unitCostPoisha: bigint },
): Promise<void> {
  await tx.execute(sql`
    update supply.supply_lines
    set unit_cost_poisha = ${line.unitCostPoisha.toString()}::bigint,
        qty = ${line.qty === null ? sql`qty` : sql`${line.qty}`},
        updated_at = now()
    where org_id = ${orgId} and supply_id = ${supplyId} and sku_id = ${line.skuId}
  `);
}

export async function updateSupplyDraft(
  tx: Tx,
  orgId: string,
  id: string,
  patch: { readonly invoiceNumber?: string | null; readonly locationId?: string },
): Promise<void> {
  const sets: SQL[] = [];
  if (patch.invoiceNumber !== undefined) sets.push(sql`invoice_number = ${patch.invoiceNumber}`);
  if (patch.locationId !== undefined) sets.push(sql`location_id = ${patch.locationId}`);
  if (sets.length === 0) return;
  sets.push(sql`updated_at = now()`);
  await tx.execute(sql`
    update supply.supplies set ${sql.join(sets, sql`, `)}
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function markSupplyReceived(
  tx: Tx,
  orgId: string,
  id: string,
  received: {
    readonly invoiceNumber: string | null;
    readonly occurredAt: Date;
    readonly businessDate: string;
    readonly attachmentFileId: string | null;
    readonly journalId: string;
    readonly receivedBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    update supply.supplies
    set status = 'received',
        invoice_number = coalesce(${received.invoiceNumber}, invoice_number),
        occurred_at = ${received.occurredAt.toISOString()}::timestamptz,
        business_date = ${received.businessDate},
        attachment_file_id = coalesce(${received.attachmentFileId}::uuid, attachment_file_id),
        journal_id = ${received.journalId},
        received_by = ${received.receivedBy},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function deleteSupplyDraft(tx: Tx, orgId: string, id: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from supply.supplies
    where org_id = ${orgId} and id = ${id} and status = 'draft'
    returning id
  `);
  return rows.length;
}

// --- returns -----------------------------------------------------------------

/**
 * A stock location's branch, so a journal's lines can carry it.
 *
 * `org.locations` is a fact about the org's physical footprint rather than another
 * module's private table (D-046), which is why reading it here does not cross
 * invariant 12's line the way reading `inventory.*` would. Migration 0037's trigger
 * derives the same value onto the row; this read is for the posting rule, which runs
 * before the row exists.
 */
export async function locationBranch(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<{ branch_id: string | null; kind: string } | undefined> {
  const rows = await tx.execute<{ branch_id: string | null; kind: string }>(sql`
    select branch_id, kind::text as kind from org.locations
    where org_id = ${orgId} and id = ${locationId}
  `);
  return rows[0];
}

export async function insertReturn(
  tx: Tx,
  entry: {
    readonly orgId: string;
    readonly id: string;
    readonly supplierId: string;
    readonly supplyId: string | null;
    readonly locationId: string;
    readonly occurredAt: Date;
    readonly businessDate: string;
    readonly reason: string;
    readonly journalId: string | null;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into supply.returns (id, org_id, supplier_id, supply_id, location_id, occurred_at,
                               business_date, reason, journal_id, created_by)
    values (${entry.id}, ${entry.orgId}, ${entry.supplierId}, ${entry.supplyId}::uuid,
            ${entry.locationId}, ${entry.occurredAt.toISOString()}::timestamptz, ${entry.businessDate}, ${entry.reason},
            ${entry.journalId}::uuid, ${entry.createdBy})
  `);
}

export async function insertReturnLine(
  tx: Tx,
  line: {
    readonly orgId: string;
    readonly returnId: string;
    readonly skuId: string;
    readonly qty: number;
    readonly originalUnitCostPoisha: bigint;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into supply.return_lines (org_id, return_id, sku_id, qty, original_unit_cost_poisha)
    values (${line.orgId}, ${line.returnId}, ${line.skuId}, ${line.qty},
            ${line.originalUnitCostPoisha.toString()}::bigint)
  `);
}

export interface ReturnRow extends Record<string, unknown> {
  readonly id: string;
  readonly supplier_id: string;
  readonly supplier_name: string;
  readonly supply_id: string | null;
  readonly location_id: string;
  readonly business_date: string;
  readonly reason: string;
  readonly journal_id: string | null;
  readonly credit_poisha: string;
  /** What leaving stock was worth, read off the journal's inventory credit. */
  readonly relief_poisha: string;
  readonly variance_poisha: string;
}

export async function listReturns(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly supplierId: string | undefined },
): Promise<ReturnRow[]> {
  const rows = await tx.execute<ReturnRow>(sql`
    select r.id, r.supplier_id, sup.name as supplier_name, r.supply_id, r.location_id,
           r.business_date, r.reason, r.journal_id,
           coalesce(sum(l.qty * l.original_unit_cost_poisha), 0)::text as credit_poisha,
           coalesce(max(relief.amount), 0)::text as relief_poisha,
           coalesce(max(variance.amount), 0)::text as variance_poisha
    from supply.returns r
    join supply.suppliers sup on sup.org_id = r.org_id and sup.id = r.supplier_id
    left join supply.return_lines l on l.org_id = r.org_id and l.return_id = r.id
    /*
     * The relief and the variance come from the journal, not from a column here.
     * They are decided by M07 under the cost row's lock, and a copy in this schema
     * would be a second number that can disagree with the ledger about one event.
     * max() because the lateral returns one row per return while the join over lines
     * multiplies it; the value is constant within the group.
     */
    left join lateral (
      select sum(jl.credit_poisha) as amount
      from ledger.journal_lines jl
      join ledger.accounts ja on ja.org_id = jl.org_id and ja.id = jl.account_id
      where jl.org_id = r.org_id and jl.journal_id = r.journal_id and ja.subtype = 'inventory'
    ) relief on true
    left join lateral (
      select sum(jl.credit_poisha) - sum(jl.debit_poisha) as amount
      from ledger.journal_lines jl
      join ledger.accounts ja on ja.org_id = jl.org_id and ja.id = jl.account_id
      where jl.org_id = r.org_id and jl.journal_id = r.journal_id
        and ja.subtype = 'purchase_price_variance'
    ) variance on true
    where r.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.supplierId === undefined ? sql`true` : sql`r.supplier_id = ${filters.supplierId}`}
    group by r.id, sup.name
    order by r.business_date desc, r.created_at desc
    limit 500
  `);
  return [...rows];
}

// --- payments and advances ---------------------------------------------------

export interface PaymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly supplier_id: string;
  readonly supplier_name: string;
  readonly wallet_account_id: string;
  readonly wallet_code: string;
  readonly wallet_name: string;
  readonly branch_id: string | null;
  readonly kind: 'advance' | 'payment';
  readonly status: 'pending_approval' | 'posted' | 'rejected';
  readonly amount_poisha: string;
  /**
   * Selected as text and parsed by the caller.
   *
   * The driver hands a `timestamptz` back as a string here, and the executor feeds it
   * straight to a posting rule that calls `getTime()` on it. Typing it `Date` made that
   * a 500 inside the transaction that approved a payment — an approval that appeared to
   * fail while the checker's decision had already been written. Selected explicitly as
   * text so the shape is what the type says.
   */
  readonly occurred_at: string;
  readonly business_date: string;
  readonly memo: string | null;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly applied_poisha: string;
}

const PAYMENT_COLUMNS = sql`p.id, p.supplier_id, sup.name as supplier_name, p.wallet_account_id,
  a.code as wallet_code, a.name as wallet_name, p.branch_id, p.kind::text as kind,
  p.status::text as status, p.amount_poisha::text as amount_poisha,
  p.occurred_at::text as occurred_at, p.business_date,
  p.memo,
  p.approval_request_id, p.journal_id,
  coalesce((select sum(ap.amount_poisha) from supply.advance_applications ap
            where ap.org_id = p.org_id and ap.payment_id = p.id), 0)::text as applied_poisha`;

export async function listPayments(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly supplierId: string | undefined;
    readonly kind: string | undefined;
    readonly status: string | undefined;
    readonly from: string | undefined;
    readonly to: string | undefined;
  },
): Promise<PaymentRow[]> {
  const rows = await tx.execute<PaymentRow>(sql`
    select ${PAYMENT_COLUMNS}
    from supply.supplier_payments p
    join supply.suppliers sup on sup.org_id = p.org_id and sup.id = p.supplier_id
    join ledger.accounts a on a.org_id = p.org_id and a.id = p.wallet_account_id
    where p.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.supplierId === undefined ? sql`true` : sql`p.supplier_id = ${filters.supplierId}`}
      and ${filters.kind === undefined ? sql`true` : sql`p.kind::text = ${filters.kind}`}
      and ${filters.status === undefined ? sql`true` : sql`p.status::text = ${filters.status}`}
      and ${filters.from === undefined ? sql`true` : sql`p.business_date >= ${filters.from}`}
      and ${filters.to === undefined ? sql`true` : sql`p.business_date <= ${filters.to}`}
    order by p.business_date desc, p.created_at desc
    limit 500
  `);
  return [...rows];
}

export async function paymentById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<PaymentRow | undefined> {
  const rows = await tx.execute<PaymentRow>(sql`
    select ${PAYMENT_COLUMNS}
    from supply.supplier_payments p
    join supply.suppliers sup on sup.org_id = p.org_id and sup.id = p.supplier_id
    join ledger.accounts a on a.org_id = p.org_id and a.id = p.wallet_account_id
    where p.org_id = ${orgId} and p.id = ${id}
  `);
  return rows[0];
}

/**
 * Today in Asia/Dhaka by the database's clock, the same clock that stamps `created_at`, so
 * the day a payment is checked against is the day it is stored on (the re-audit's note 1).
 */
export async function enteredToday(tx: Tx): Promise<string> {
  const rows = await tx.execute<{ day: string }>(
    sql`select (now() at time zone 'Asia/Dhaka')::date::text as day`,
  );
  const day = rows[0]?.day;
  if (day === undefined) throw new Error('The database did not say what day it is.');
  return day;
}

/**
 * Serialise one person's supplier payments on the day they enter them (C7, D-415).
 *
 * Taken before the day's total is read and held until the payment is written, so two
 * payments sent at once each count the other: without it both read the same earlier total
 * and both stay under the threshold. Keyed on the day of entry, not the payment's business
 * date, which the person may set to yesterday (the ledger audit's W1).
 */
export async function lockPaymentDay(
  tx: Tx,
  orgId: string,
  createdBy: string,
  enteredOn: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`supply.payment-day:${orgId}:${createdBy}:${enteredOn}`}, 0))`,
  );
}

/**
 * What one person paid out to suppliers on the day they enter a payment, without a checker
 * (C7, D-415): their posted payments and advances that carry no approval, to any supplier,
 * entered that Asia/Dhaka day whatever business date they carry. Any supplier, because the
 * same role adds suppliers without a checker, so a per-supplier day was ten new suppliers
 * away from no limit at all (the ledger audit's W2). A payment a checker approved is left
 * out: a second person has already looked at it.
 */
export async function unheldPaymentsEnteredOn(
  tx: Tx,
  orgId: string,
  filter: { readonly createdBy: string; readonly enteredOn: string },
): Promise<bigint> {
  const rows = await tx.execute<{ total: string }>(sql`
    select coalesce(sum(p.amount_poisha), 0)::text as total
    from supply.supplier_payments p
    where p.org_id = ${orgId}
      and p.created_by = ${filter.createdBy}
      and (p.created_at at time zone 'Asia/Dhaka')::date = ${filter.enteredOn}::date
      and p.status = 'posted'::supply.supplier_payment_status
      and p.approval_request_id is null
  `);
  return BigInt(rows[0]?.total ?? '0');
}

export async function insertPayment(
  tx: Tx,
  payment: {
    readonly orgId: string;
    readonly id: string;
    readonly supplierId: string;
    readonly walletAccountId: string;
    readonly kind: 'advance' | 'payment';
    readonly status: 'pending_approval' | 'posted';
    readonly amountPoisha: bigint;
    readonly occurredAt: Date;
    readonly businessDate: string;
    readonly memo: string | null;
    readonly approvalRequestId: string | null;
    readonly journalId: string | null;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into supply.supplier_payments
      (id, org_id, supplier_id, wallet_account_id, kind, status, amount_poisha, occurred_at,
       business_date, memo, approval_request_id, journal_id, created_by)
    values (${payment.id}, ${payment.orgId}, ${payment.supplierId}, ${payment.walletAccountId},
            ${payment.kind}::supply.supplier_payment_kind,
            ${payment.status}::supply.supplier_payment_status,
            ${payment.amountPoisha.toString()}::bigint,
            ${payment.occurredAt.toISOString()}::timestamptz,
            ${payment.businessDate}, ${payment.memo}, ${payment.approvalRequestId}::uuid,
            ${payment.journalId}::uuid, ${payment.createdBy})
  `);
}

export async function settlePayment(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: { readonly status: 'posted' | 'rejected'; readonly journalId: string | null },
): Promise<void> {
  await tx.execute(sql`
    update supply.supplier_payments
    set status = ${outcome.status}::supply.supplier_payment_status,
        journal_id = ${outcome.journalId}::uuid,
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/**
 * An advance's terms and what is already drawn from it, with the payment row **locked**.
 *
 * The lock is the concurrency control for over-application, and it is taken here rather
 * than left to the trigger only so the refusal happens before a journal is posted and
 * rolled back. Two clerks applying one advance to two deliveries otherwise each sum the
 * applications they can see — neither can see the other's uncommitted row — and both
 * pass, leaving `supplier_advance` credit-balanced: an asset account holding a negative
 * asset.
 */
export async function advanceForUpdate(
  tx: Tx,
  orgId: string,
  paymentId: string,
): Promise<
  | {
      id: string;
      kind: string;
      status: string;
      supplier_id: string;
      amount_poisha: string;
      applied_poisha: string;
    }
  | undefined
> {
  const rows = await tx.execute<{
    id: string;
    kind: string;
    status: string;
    supplier_id: string;
    amount_poisha: string;
  }>(sql`
    select id, kind::text as kind, status::text as status, supplier_id,
           amount_poisha::text as amount_poisha
    from supply.supplier_payments
    where org_id = ${orgId} and id = ${paymentId}
    for update
  `);
  const payment = rows[0];
  if (payment === undefined) return undefined;

  // After the lock, so the sum cannot grow under us.
  const applied = await tx.execute<{ applied: string }>(sql`
    select coalesce(sum(amount_poisha), 0)::text as applied
    from supply.advance_applications
    where org_id = ${orgId} and payment_id = ${paymentId}
  `);
  return { ...payment, applied_poisha: applied[0]?.applied ?? '0' };
}

export async function insertAdvanceApplication(
  tx: Tx,
  application: {
    readonly orgId: string;
    readonly id: string;
    readonly supplierId: string;
    readonly paymentId: string;
    readonly supplyId: string;
    readonly amountPoisha: bigint;
    readonly businessDate: string;
    readonly journalId: string;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into supply.advance_applications
      (id, org_id, supplier_id, payment_id, supply_id, amount_poisha, business_date, journal_id,
       created_by)
    values (${application.id}, ${application.orgId}, ${application.supplierId},
            ${application.paymentId}, ${application.supplyId},
            ${application.amountPoisha.toString()}::bigint, ${application.businessDate},
            ${application.journalId}, ${application.createdBy})
  `);
}

export async function advanceApplicationById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ id: string; journal_id: string; amount_poisha: string } | undefined> {
  const rows = await tx.execute<{ id: string; journal_id: string; amount_poisha: string }>(sql`
    select id, journal_id, amount_poisha::text as amount_poisha
    from supply.advance_applications
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

// --- ledger reads: the balances and the statement ----------------------------

/**
 * A supplier's ledger accounts, by subtype: the payable, the advance, the variance.
 *
 * Read from `ledger.accounts` rather than passed in, because §7's chart is seeded per
 * org (D-084) and the ids differ per brand. A missing one is a broken chart, and the
 * service says so rather than posting the value somewhere else.
 */
export async function accountBySubtype(
  tx: Tx,
  orgId: string,
  subtype: string,
): Promise<{ id: string; code: string; subtype: string; branch_id: string | null } | undefined> {
  const rows = await tx.execute<{
    id: string;
    code: string;
    subtype: string;
    branch_id: string | null;
  }>(sql`
    select id, code, subtype::text as subtype, branch_id
    from ledger.accounts
    where org_id = ${orgId} and subtype = ${subtype}::ledger.account_subtype and is_active
    order by code
    limit 1
  `);
  return rows[0];
}

export async function accountById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<
  | {
      id: string;
      code: string;
      name: string;
      subtype: string;
      branch_id: string | null;
      is_active: boolean;
    }
  | undefined
> {
  const rows = await tx.execute<{
    id: string;
    code: string;
    name: string;
    subtype: string;
    branch_id: string | null;
    is_active: boolean;
  }>(sql`
    select id, code, name, subtype::text as subtype, branch_id, is_active
    from ledger.accounts
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export interface SupplierBalanceRow extends Record<string, unknown> {
  readonly party_id: string;
  readonly subtype: string;
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

/**
 * What every supplier is owed and holds, as of a business date.
 *
 * One grouped query over `ledger.journal_lines`, exactly as
 * `GET /v1/ledger/party-balances` computes it — same rows, same predicate, same
 * grouping. That is not duplication for its own sake: it is what makes M09 check 2 a
 * real check rather than a tautology, because the two are computed by different code
 * in different modules and the test asserts they agree.
 */
export async function supplierBalances(
  tx: Tx,
  orgId: string,
  filters: { readonly asOf: string; readonly supplierId: string | undefined },
): Promise<SupplierBalanceRow[]> {
  const rows = await tx.execute<SupplierBalanceRow>(sql`
    select l.party_id, a.subtype::text as subtype,
           sum(l.debit_poisha)::text as debit_poisha,
           sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and l.party_type = 'supplier'
      and j.business_date <= ${filters.asOf}
      and a.subtype in ('supplier_payable', 'supplier_advance')
      and ${filters.supplierId === undefined ? sql`true` : sql`l.party_id = ${filters.supplierId}`}
    group by l.party_id, a.subtype
  `);
  return [...rows];
}

export interface StatementLineRow extends Record<string, unknown> {
  readonly journal_id: string;
  readonly line_no: number;
  readonly business_date: string;
  readonly source_type: string;
  readonly subtype: string;
  readonly memo: string | null;
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

/** Every journal line against one supplier in a range, oldest first. */
export async function statementLines(
  tx: Tx,
  orgId: string,
  supplierId: string,
  range: { readonly from: string | undefined; readonly to: string },
  limit: number,
): Promise<StatementLineRow[]> {
  const rows = await tx.execute<StatementLineRow>(sql`
    select l.journal_id, l.line_no, j.business_date, j.source_type, a.subtype::text as subtype,
           coalesce(l.memo, j.memo) as memo,
           l.debit_poisha::text as debit_poisha, l.credit_poisha::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and l.party_type = 'supplier'
      and l.party_id = ${supplierId}
      and a.subtype in ('supplier_payable', 'supplier_advance')
      and ${range.from === undefined ? sql`true` : sql`j.business_date >= ${range.from}`}
      and j.business_date <= ${range.to}
    order by j.business_date, j.created_at, l.line_no
    limit ${limit}
  `);
  return [...rows];
}

/** The two opening balances: everything before the range starts. */
export async function statementOpening(
  tx: Tx,
  orgId: string,
  supplierId: string,
  from: string | undefined,
): Promise<SupplierBalanceRow[]> {
  if (from === undefined) return [];
  const rows = await tx.execute<SupplierBalanceRow>(sql`
    select l.party_id, a.subtype::text as subtype,
           sum(l.debit_poisha)::text as debit_poisha,
           sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and l.party_type = 'supplier'
      and l.party_id = ${supplierId}
      and a.subtype in ('supplier_payable', 'supplier_advance')
      and j.business_date < ${from}
    group by l.party_id, a.subtype
  `);
  return [...rows];
}

/** The attachment a supply or a supplier document names, and whether it is usable. */
export async function attachment(
  tx: Tx,
  orgId: string,
  fileId: string,
): Promise<{ id: string; purpose: string; visibility: string; status: string } | undefined> {
  const rows = await tx.execute<{
    id: string;
    purpose: string;
    visibility: string;
    status: string;
  }>(sql`
    select id, purpose, visibility::text as visibility, status::text as status
    from files.objects
    where org_id = ${orgId} and id = ${fileId}
  `);
  return rows[0];
}
