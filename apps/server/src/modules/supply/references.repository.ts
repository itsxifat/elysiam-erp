import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What supply holds about a SKU, a location or a supplier, counted for a delete (M39a,
 * D-621, D-629, D-630). Every supply line, entry, return, payment, advance and note is a
 * record of money or goods that moved, so each one keeps what it names. So does a journal
 * line naming the supplier as its party (an opening due M14a imported, with no supply row
 * behind it): the supplier ledger is read from those lines (`supplierBalances`).
 */

export async function supplyLinesForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  const ids = sql`(${sql.param([...skuIds])}::uuid[])`;
  const rows = await tx.execute<{ n: number }>(sql`
    select
      (select count(*)::int from supply.supply_lines where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from supply.return_lines where org_id = ${orgId} and sku_id = any ${ids})
      as n
  `);
  return rows[0]?.n ?? 0;
}

export async function supplyEntriesAtLocation(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select
      (select count(*)::int from supply.supplies where org_id = ${orgId} and location_id = ${locationId})
      + (select count(*)::int from supply.returns where org_id = ${orgId} and location_id = ${locationId})
      as n
  `);
  return rows[0]?.n ?? 0;
}

export interface SupplierUses {
  readonly entries: number;
  readonly payments: number;
  readonly notes: number;
  /** Journal lines naming the supplier as their party: an opening due or advance (M14a). */
  readonly ledgerLines: number;
}

/** Entries (drafts included) and returns, payments and advance applications, and notes. */
export async function supplierUses(
  tx: Tx,
  orgId: string,
  supplierId: string,
): Promise<SupplierUses> {
  const rows = await tx.execute<{
    entries: number;
    payments: number;
    notes: number;
    ledger_lines: number;
  }>(sql`
    select
      (select count(*)::int from supply.supplies where org_id = ${orgId} and supplier_id = ${supplierId})
      + (select count(*)::int from supply.returns where org_id = ${orgId} and supplier_id = ${supplierId})
      as entries,
      (select count(*)::int from supply.supplier_payments
        where org_id = ${orgId} and supplier_id = ${supplierId})
      + (select count(*)::int from supply.advance_applications
          where org_id = ${orgId} and supplier_id = ${supplierId}) as payments,
      (select count(*)::int from supply.supplier_notes
        where org_id = ${orgId} and supplier_id = ${supplierId}) as notes,
      (select count(*)::int from ledger.journal_lines
        where org_id = ${orgId} and party_type = 'supplier' and party_id = ${supplierId})
        as ledger_lines
  `);
  return {
    entries: rows[0]?.entries ?? 0,
    payments: rows[0]?.payments ?? 0,
    notes: rows[0]?.notes ?? 0,
    ledgerLines: rows[0]?.ledger_lines ?? 0,
  };
}

export interface SupplierImage extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly is_active: boolean;
}

export async function lockSupplier(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<SupplierImage | undefined> {
  const rows = await tx.execute<SupplierImage>(sql`
    select s.* from supply.suppliers s where s.org_id = ${orgId} and s.id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

/**
 * What the audit row keeps of a deleted supplier and of the contacts and documents that go
 * with it: identities and labels, never a phone, an email or an address. The audit log is
 * read far more widely than the supplier's own screen (`suppliers.service.ts`, invariant 10).
 */
export async function supplierImage(
  tx: Tx,
  orgId: string,
  supplierId: string,
): Promise<Record<string, unknown>> {
  const supplier = await tx.execute<Record<string, unknown>>(sql`
    select s.id, s.code, s.name, s.is_active, s.payment_terms_days, s.created_at, s.updated_at
    from supply.suppliers s where s.org_id = ${orgId} and s.id = ${supplierId}
  `);
  const contacts = await tx.execute<Record<string, unknown>>(sql`
    select c.id, c.is_primary from supply.supplier_contacts c
    where c.org_id = ${orgId} and c.supplier_id = ${supplierId}
  `);
  const documents = await tx.execute<Record<string, unknown>>(sql`
    select d.id, d.label, d.file_object_id from supply.supplier_documents d
    where d.org_id = ${orgId} and d.supplier_id = ${supplierId}
  `);
  // The supplier's own standard buying prices go with it by cascade (M39b, D-638): counted
  // here, never their figures, which stay out of the append-only log.
  const prices = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count from supply.sku_purchase_prices
    where org_id = ${orgId} and supplier_id = ${supplierId}
  `);
  return {
    ...supplier[0],
    contacts: [...contacts],
    documents: [...documents],
    standardBuyingPrices: prices[0]?.count ?? 0,
  };
}

/**
 * Remove the standard buying prices of variants being deleted (M39b, D-638), how many went.
 * A setting, not evidence: no receipt, movement or journal points at one. The database would
 * cascade them anyway; removing them here lets the delete's audit trail say how many.
 */
export async function releaseStandardPrices(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  if (skuIds.length === 0) return 0;
  const rows = await tx.execute<{ id: string }>(sql`
    delete from supply.sku_purchase_prices
    where org_id = ${orgId} and sku_id = any (${sql.param([...skuIds])}::uuid[])
    returning id
  `);
  return rows.length;
}

/** Who is acting in this transaction, as `withOrg` set it (for a row written mid-delete). */
export async function sessionActor(
  tx: Tx,
): Promise<{ userId: string | null; requestId: string | null }> {
  const rows = await tx.execute<{ user_id: string | null; request_id: string | null }>(sql`
    select nullif(current_setting('app.user_id', true), '') as user_id,
           nullif(current_setting('app.request_id', true), '') as request_id
  `);
  return { userId: rows[0]?.user_id ?? null, requestId: rows[0]?.request_id ?? null };
}

export async function deleteSupplier(tx: Tx, orgId: string, id: string): Promise<boolean> {
  await tx.execute(sql`
    delete from supply.supplier_contacts where org_id = ${orgId} and supplier_id = ${id}
  `);
  await tx.execute(sql`
    delete from supply.supplier_documents where org_id = ${orgId} and supplier_id = ${id}
  `);
  const rows = await tx.execute<{ id: string }>(sql`
    delete from supply.suppliers where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}
