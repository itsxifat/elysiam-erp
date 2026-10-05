import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The SQL for stock in hand, the opening stock window and scanned counts (M38a, D-602,
 * D-606). Raw and parameterised, inside the caller's `withOrg()` transaction, like the
 * rest of the inventory module's repository. Nothing here reads another module's tables:
 * SKU names come from `CatalogApi`, journals are posted through `LedgerApi`.
 */

// --- the opening stock window -------------------------------------------------------------

/** Timestamps come back from the driver as text; `toInstant` turns one into a `Date`. */
export interface WindowRow extends Record<string, unknown> {
  readonly status: 'open' | 'closed';
  readonly closed_at: string | Date | null;
  readonly closed_by: string | null;
  readonly reopen_approval_id: string | null;
  readonly reopened_at: string | Date | null;
  readonly reopened_by: string | null;
}

export function toInstant(value: string | Date | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}

const WINDOW_COLUMNS = sql`status, closed_at, closed_by, reopen_approval_id, reopened_at, reopened_by`;

/** The window as it stands, or undefined for a brand that never touched it (open). */
export async function windowOf(tx: Tx, orgId: string): Promise<WindowRow | undefined> {
  const rows = await tx.execute<WindowRow>(sql`
    select ${WINDOW_COLUMNS} from inventory.opening_stock_windows where org_id = ${orgId}
  `);
  return rows[0];
}

/**
 * The window, locked: `share` while an entry is written or posted (several at once may
 * hold it, and a close waits for them), `update` while it is closed or reopened. The row
 * is created open first if the brand has none, so there is always a row to lock.
 */
export async function lockWindow(
  tx: Tx,
  orgId: string,
  mode: 'share' | 'update',
): Promise<WindowRow> {
  await tx.execute(sql`
    insert into inventory.opening_stock_windows (org_id) values (${orgId})
    on conflict (org_id) do nothing
  `);
  const rows = await tx.execute<WindowRow>(sql`
    select ${WINDOW_COLUMNS} from inventory.opening_stock_windows
    where org_id = ${orgId}
    ${mode === 'share' ? sql`for share` : sql`for update`}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The opening stock window has no row.');
  return row;
}

/** `closed_at` is stamped by the window's trigger, to the millisecond (D-602). */
export async function closeWindow(tx: Tx, orgId: string, userId: string): Promise<WindowRow> {
  const rows = await tx.execute<WindowRow>(sql`
    update inventory.opening_stock_windows
    set status = 'closed', closed_by = ${userId}
    where org_id = ${orgId}
    returning ${WINDOW_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The opening stock window has no row.');
  return row;
}

export async function reopenWindow(
  tx: Tx,
  orgId: string,
  input: { readonly approvalId: string; readonly userId: string },
): Promise<WindowRow | undefined> {
  // `reopened_at` is stamped by the trigger, which also checks the approval (D-602).
  const rows = await tx.execute<WindowRow>(sql`
    update inventory.opening_stock_windows
    set status = 'open', reopen_approval_id = ${input.approvalId}, reopened_by = ${input.userId}
    where org_id = ${orgId} and status = 'closed'
    returning ${WINDOW_COLUMNS}
  `);
  return rows[0];
}

// --- entries ------------------------------------------------------------------------------

export type EntryStatus = 'draft' | 'posted' | 'reversed';

export interface EntryRow extends Record<string, unknown> {
  readonly id: string;
  readonly location_id: string;
  readonly branch_id: string | null;
  readonly status: EntryStatus;
  readonly memo: string | null;
  readonly occurred_at: string | Date | null;
  readonly business_date: string | null;
  readonly journal_id: string | null;
  readonly created_by: string;
  readonly posted_by: string | null;
  readonly posted_at: string | Date | null;
  readonly created_at: string | Date;
  readonly reversal_journal_id: string | null;
  readonly reversed_by: string | null;
  readonly reversed_at: string | Date | null;
}

const ENTRY_COLUMNS = sql`e.id, e.location_id, e.branch_id, e.status, e.memo, e.occurred_at,
  e.business_date::text as business_date, e.journal_id, e.created_by, e.posted_by, e.posted_at,
  e.created_at, e.reversal_journal_id, e.reversed_by, e.reversed_at`;

export async function entryById(tx: Tx, orgId: string, id: string): Promise<EntryRow | undefined> {
  const rows = await tx.execute<EntryRow>(sql`
    select ${ENTRY_COLUMNS} from inventory.stock_in_hand_entries e
    where e.org_id = ${orgId} and e.id = ${id}
  `);
  return rows[0];
}

/** The entry, locked: two people posting one draft at once must not both post it. */
export async function lockEntry(tx: Tx, orgId: string, id: string): Promise<EntryRow | undefined> {
  const rows = await tx.execute<EntryRow>(sql`
    select ${ENTRY_COLUMNS} from inventory.stock_in_hand_entries e
    where e.org_id = ${orgId} and e.id = ${id}
    for update
  `);
  return rows[0];
}

export async function insertEntry(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly locationId: string;
    readonly branchId: string | null;
    readonly memo: string | null;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into inventory.stock_in_hand_entries
      (id, org_id, location_id, branch_id, status, memo, created_by)
    values (${input.id}, ${input.orgId}, ${input.locationId}, ${input.branchId}, 'draft',
            ${input.memo}, ${input.createdBy})
  `);
}

export async function updateDraft(
  tx: Tx,
  orgId: string,
  id: string,
  patch: {
    readonly locationId?: string;
    readonly branchId?: string | null;
    readonly memo?: string | null;
  },
): Promise<void> {
  const sets: SQL[] = [];
  if (patch.locationId !== undefined) {
    sets.push(sql`location_id = ${patch.locationId}`);
    sets.push(sql`branch_id = ${patch.branchId ?? null}`);
  }
  if (patch.memo !== undefined) sets.push(sql`memo = ${patch.memo}`);
  if (sets.length === 0) return;
  await tx.execute(sql`
    update inventory.stock_in_hand_entries set ${sql.join(sets, sql`, `)}
    where org_id = ${orgId} and id = ${id} and status = 'draft'
  `);
}

export async function markPosted(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    readonly occurredAt: Date;
    readonly businessDate: string;
    readonly journalId: string;
    readonly postedBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    update inventory.stock_in_hand_entries
    set status = 'posted', occurred_at = ${input.occurredAt.toISOString()}::timestamptz,
        business_date = ${input.businessDate}::date,
        journal_id = ${input.journalId}, posted_by = ${input.postedBy}, posted_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'draft'
  `);
}

/**
 * A posted entry, taken back out by its approved reversal (D-602). The trigger checks the
 * journal reverses the entry's and the approval names it; `reversed_at` is the clock's.
 */
export async function markReversed(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    readonly reversalJournalId: string;
    readonly approvalId: string;
    readonly reversedBy: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inventory.stock_in_hand_entries
    set status = 'reversed', reversal_journal_id = ${input.reversalJournalId},
        reversal_approval_id = ${input.approvalId}, reversed_by = ${input.reversedBy},
        reversed_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'posted'
    returning id
  `);
  return rows.length === 1;
}

export async function deleteDraft(tx: Tx, orgId: string, id: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from inventory.stock_in_hand_entries
    where org_id = ${orgId} and id = ${id} and status = 'draft'
    returning id
  `);
  return rows.length;
}

export interface EntryListRow extends EntryRow {
  readonly line_count: number;
  readonly total_qty: number;
  /** Σ qty × cost, null while any line is unpriced. Cost: only for `read:cost` callers. */
  readonly stock_value_poisha: string | null;
}

export async function listEntries(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly status?: EntryStatus | undefined },
): Promise<EntryListRow[]> {
  const rows = await tx.execute<EntryListRow>(sql`
    select ${ENTRY_COLUMNS},
           count(l.id)::int as line_count,
           coalesce(sum(l.qty), 0)::int as total_qty,
           case when count(l.id) = count(l.unit_cost_poisha)
                then sum(l.qty::bigint * l.unit_cost_poisha)::text end as stock_value_poisha
    from inventory.stock_in_hand_entries e
    left join inventory.stock_in_hand_lines l on l.org_id = e.org_id and l.entry_id = e.id
    where e.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.status === undefined ? sql`true` : sql`e.status = ${filters.status}`}
    group by e.id
    order by e.created_at desc
    limit 200
  `);
  return [...rows];
}

// --- lines --------------------------------------------------------------------------------

export interface LineRow extends Record<string, unknown> {
  readonly id: string;
  readonly line_no: number;
  readonly sku_id: string;
  readonly qty: number;
  /** Decimal string, or null on a draft line. */
  readonly unit_cost_poisha: string | null;
}

export async function linesOf(tx: Tx, orgId: string, entryId: string): Promise<LineRow[]> {
  const rows = await tx.execute<LineRow>(sql`
    select id, line_no, sku_id, qty, unit_cost_poisha::text as unit_cost_poisha
    from inventory.stock_in_hand_lines
    where org_id = ${orgId} and entry_id = ${entryId}
    order by line_no
  `);
  return [...rows];
}

export async function replaceLines(
  tx: Tx,
  orgId: string,
  entryId: string,
  lines: readonly {
    readonly skuId: string;
    readonly qty: number;
    readonly unitCostPoisha: bigint | null;
  }[],
): Promise<void> {
  await tx.execute(sql`
    delete from inventory.stock_in_hand_lines where org_id = ${orgId} and entry_id = ${entryId}
  `);
  if (lines.length === 0) return;
  await tx.execute(sql`
    insert into inventory.stock_in_hand_lines (org_id, entry_id, line_no, sku_id, qty, unit_cost_poisha)
    values ${sql.join(
      lines.map(
        (line, index) =>
          sql`(${orgId}, ${entryId}, ${index + 1}, ${line.skuId}, ${line.qty},
               ${line.unitCostPoisha === null ? null : line.unitCostPoisha.toString()}::bigint)`,
      ),
      sql`, `,
    )}
  `);
}

export async function priceLine(
  tx: Tx,
  orgId: string,
  entryId: string,
  skuId: string,
  unitCostPoisha: bigint,
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update inventory.stock_in_hand_lines
    set unit_cost_poisha = ${unitCostPoisha.toString()}::bigint
    where org_id = ${orgId} and entry_id = ${entryId} and sku_id = ${skuId}
    returning id
  `);
  return rows.length === 1;
}

// --- scanned counts -----------------------------------------------------------------------

export async function scanById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ session_id: string; sku_id: string } | undefined> {
  const rows = await tx.execute<{ session_id: string; sku_id: string }>(sql`
    select session_id, sku_id from inventory.count_scans where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function insertScan(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly sessionId: string;
    readonly skuId: string;
    readonly code: string;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into inventory.count_scans (id, org_id, session_id, sku_id, code, qty, created_by)
    values (${input.id}, ${input.orgId}, ${input.sessionId}, ${input.skuId}, ${input.code}, 1,
            ${input.createdBy})
  `);
}

/** One more piece on a count line, in one statement. Undefined: the SKU is not on the count. */
export async function countOneMore(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly sessionId: string;
    readonly skuId: string;
    readonly countedBy: string;
  },
): Promise<{ counted_qty: number; snapshot_qty: number } | undefined> {
  const rows = await tx.execute<{ counted_qty: number; snapshot_qty: number }>(sql`
    update inventory.count_lines
    set counted_qty = coalesce(counted_qty, 0) + 1, counted_by = ${input.countedBy},
        updated_at = now()
    where org_id = ${input.orgId} and session_id = ${input.sessionId} and sku_id = ${input.skuId}
    returning counted_qty, snapshot_qty
  `);
  return rows[0];
}

export async function countLine(
  tx: Tx,
  input: { readonly orgId: string; readonly sessionId: string; readonly skuId: string },
): Promise<{ counted_qty: number | null; snapshot_qty: number } | undefined> {
  const rows = await tx.execute<{ counted_qty: number | null; snapshot_qty: number }>(sql`
    select counted_qty, snapshot_qty from inventory.count_lines
    where org_id = ${input.orgId} and session_id = ${input.sessionId} and sku_id = ${input.skuId}
  `);
  return rows[0];
}

/** Per SKU, on hand and available at every location that holds it: a scan's stock summary. */
export async function stockOfSku(
  tx: Tx,
  orgId: string,
  skuId: string,
): Promise<
  {
    location_id: string;
    location_code: string;
    location_name: string;
    on_hand: number;
    reserved: number;
  }[]
> {
  const rows = await tx.execute<{
    location_id: string;
    location_code: string;
    location_name: string;
    on_hand: number;
    reserved: number;
  }>(sql`
    select sl.location_id, l.code as location_code, l.name as location_name, sl.on_hand,
           sl.reserved
    from inventory.stock_levels sl
    join org.locations l on l.org_id = sl.org_id and l.id = sl.location_id
    where sl.org_id = ${orgId} and sl.sku_id = ${skuId} and sl.on_hand > 0
    order by l.code
  `);
  return [...rows];
}
