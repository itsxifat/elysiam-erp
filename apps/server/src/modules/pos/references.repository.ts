import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/** What the till holds about a SKU or a location, counted for a delete (M39a, D-621, D-629). */

export async function tillLinesForSkus(
  tx: Tx,
  orgId: string,
  skuIds: readonly string[],
): Promise<number> {
  const ids = sql`(${sql.param([...skuIds])}::uuid[])`;
  const rows = await tx.execute<{ n: number }>(sql`
    select
      (select count(*)::int from pos.sale_lines where org_id = ${orgId} and sku_id = any ${ids})
      + (select count(*)::int from pos.return_lines where org_id = ${orgId} and sku_id = any ${ids})
      as n
  `);
  return rows[0]?.n ?? 0;
}

export async function tillUsesOfLocation(
  tx: Tx,
  orgId: string,
  locationId: string,
): Promise<{ registers: number; documents: number }> {
  const rows = await tx.execute<{ registers: number; documents: number }>(sql`
    select
      (select count(*)::int from pos.registers
        where org_id = ${orgId} and location_id = ${locationId}) as registers,
      (select count(*)::int from pos.sales where org_id = ${orgId} and location_id = ${locationId})
      + (select count(*)::int from pos.returns
          where org_id = ${orgId} and location_id = ${locationId}) as documents
  `);
  return { registers: rows[0]?.registers ?? 0, documents: rows[0]?.documents ?? 0 };
}

// --- a branch's own record (D-633) -----------------------------------------------------------

export interface BranchImage extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly is_active: boolean;
}

/** `org.branches` is §5's shared table; the till's module is where branches are run from. */
export async function lockBranch(
  tx: Tx,
  orgId: string,
  id: string,
  lock = true,
): Promise<BranchImage | undefined> {
  const rows = await tx.execute<BranchImage>(sql`
    select id, code, name, kind::text as kind, is_active
    from org.branches where org_id = ${orgId} and id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

/**
 * Whether a branch is switched on, read `for share` so a switch-off waits for a till or a
 * shift being opened there, and an opening waits for a switch-off (D-633).
 */
export async function branchIsActive(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ is_active: boolean }>(sql`
    select is_active from org.branches where org_id = ${orgId} and id = ${id} for share
  `);
  return rows[0]?.is_active === true;
}

export async function updateBranch(
  tx: Tx,
  orgId: string,
  id: string,
  patch: { readonly name?: string | undefined; readonly isActive?: boolean | undefined },
): Promise<void> {
  await tx.execute(sql`
    update org.branches
    set name = coalesce(${patch.name ?? null}, name),
        is_active = coalesce(${patch.isActive ?? null}::boolean, is_active),
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/** Tills still switched on at a branch, and shifts still open there. */
export async function tillsAtBranch(
  tx: Tx,
  orgId: string,
  branchId: string,
): Promise<{ registers: number; openShifts: number }> {
  const rows = await tx.execute<{ registers: number; open_shifts: number }>(sql`
    select
      (select count(*)::int from pos.registers
        where org_id = ${orgId} and branch_id = ${branchId} and is_active) as registers,
      (select count(*)::int from pos.shifts
        where org_id = ${orgId} and branch_id = ${branchId} and status = 'open') as open_shifts
  `);
  return { registers: rows[0]?.registers ?? 0, openShifts: rows[0]?.open_shifts ?? 0 };
}
