import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What supply holds about a SKU, a location or a supplier, counted for a delete (M39a,
 * D-621, D-629, D-630). Every supply line, entry, return, payment, advance and note is a
 * record of money or goods that moved, so each one keeps what it names.
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
}

/** Entries (drafts included) and returns, payments and advance applications, and notes. */
export async function supplierUses(
  tx: Tx,
  orgId: string,
  supplierId: string,
): Promise<SupplierUses> {
  const rows = await tx.execute<{ entries: number; payments: number; notes: number }>(sql`
    select
      (select count(*)::int from supply.supplies where org_id = ${orgId} and supplier_id = ${supplierId})
      + (select count(*)::int from supply.returns where org_id = ${orgId} and supplier_id = ${supplierId})
      as entries,
      (select count(*)::int from supply.supplier_payments
        where org_id = ${orgId} and supplier_id = ${supplierId})
      + (select count(*)::int from supply.advance_applications
          where org_id = ${orgId} and supplier_id = ${supplierId}) as payments,
      (select count(*)::int from supply.supplier_notes
        where org_id = ${orgId} and supplier_id = ${supplierId}) as notes
  `);
  return {
    entries: rows[0]?.entries ?? 0,
    payments: rows[0]?.payments ?? 0,
    notes: rows[0]?.notes ?? 0,
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

/** The supplier's contacts and documents, which go with it, for the before image. */
export async function supplierAttachments(
  tx: Tx,
  orgId: string,
  supplierId: string,
): Promise<{ contacts: Record<string, unknown>[]; documents: Record<string, unknown>[] }> {
  const contacts = await tx.execute<Record<string, unknown>>(sql`
    select c.* from supply.supplier_contacts c
    where c.org_id = ${orgId} and c.supplier_id = ${supplierId}
  `);
  const documents = await tx.execute<Record<string, unknown>>(sql`
    select d.* from supply.supplier_documents d
    where d.org_id = ${orgId} and d.supplier_id = ${supplierId}
  `);
  return { contacts: [...contacts], documents: [...documents] };
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
