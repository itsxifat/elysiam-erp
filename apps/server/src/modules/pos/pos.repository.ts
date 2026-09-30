import type { Tx } from '@elysium/db';
import { PosError } from '@elysium/domain/pos';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the POS runs, and nothing else (tenancy rules: raw SQL
 * lives only in repositories, parameterized, never interpolated).
 *
 * Reads only `pos.*` and the platform's `org.*` rows (branches, the brand's
 * receipt header). Stock, catalog, wallets and the ledger are reached through
 * their `*.api.ts` interfaces or this module's ports (invariant 12).
 *
 * Amounts come back as decimal strings — the driver's spelling of `bigint` — and
 * are turned into `bigint` by the services, never into `number`.
 */

/**
 * A `timestamptz` as an ISO-8601 UTC string.
 *
 * The driver hands timestamps back in PostgreSQL's own spelling
 * (`2026-09-30 07:40:14.5+00`), which `new Date()` is not required to parse. Asked
 * for in ISO form here, every instant this module reads round-trips exactly.
 */
function iso(column: SQL): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

// --- registers ------------------------------------------------------------------

export interface RegisterRow extends Record<string, unknown> {
  readonly id: string;
  readonly branch_id: string;
  readonly location_id: string;
  readonly code: string;
  readonly name: string;
  readonly cash_wallet_id: string;
  readonly bkash_wallet_id: string | null;
  readonly card_wallet_id: string | null;
  readonly is_active: boolean;
  readonly branch_name: string;
  readonly location_name: string;
}

const REGISTER_SELECT = sql`
  select r.id, r.branch_id, r.location_id, r.code, r.name, r.cash_wallet_id,
         r.bkash_wallet_id, r.card_wallet_id, r.is_active,
         b.name as branch_name, l.name as location_name
  from pos.registers r
  join org.branches b on b.org_id = r.org_id and b.id = r.branch_id
  join org.locations l on l.org_id = r.org_id and l.id = r.location_id
`;

export async function registers(tx: Tx, orgId: string, scope: SQL): Promise<RegisterRow[]> {
  const rows = await tx.execute<RegisterRow>(sql`
    ${REGISTER_SELECT}
    where r.org_id = ${orgId} and ${scope}
    order by b.code, r.code
  `);
  return [...rows];
}

export async function registerById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<RegisterRow | undefined> {
  const rows = await tx.execute<RegisterRow>(sql`
    ${REGISTER_SELECT}
    where r.org_id = ${orgId} and r.id = ${id}
  `);
  return rows[0];
}

export async function insertRegister(
  tx: Tx,
  row: {
    orgId: string;
    branchId: string;
    locationId: string;
    code: string;
    name: string;
    cashWalletId: string;
    bkashWalletId: string | null;
    cardWalletId: string | null;
    createdBy: string;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into pos.registers
      (org_id, branch_id, location_id, code, name, cash_wallet_id, bkash_wallet_id,
       card_wallet_id, created_by)
    values (${row.orgId}, ${row.branchId}, ${row.locationId}, ${row.code}, ${row.name},
            ${row.cashWalletId}, ${row.bkashWalletId}, ${row.cardWalletId}, ${row.createdBy})
    on conflict (org_id, code) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function updateRegister(
  tx: Tx,
  orgId: string,
  id: string,
  patch: {
    name?: string | undefined;
    isActive?: boolean | undefined;
    bkashWalletId?: string | null | undefined;
    cardWalletId?: string | null | undefined;
  },
): Promise<void> {
  await tx.execute(sql`
    update pos.registers set
      name = coalesce(${patch.name ?? null}, name),
      is_active = coalesce(${patch.isActive ?? null}::boolean, is_active),
      bkash_wallet_id = case when ${patch.bkashWalletId !== undefined}
                             then ${patch.bkashWalletId ?? null}::uuid else bkash_wallet_id end,
      card_wallet_id = case when ${patch.cardWalletId !== undefined}
                            then ${patch.cardWalletId ?? null}::uuid else card_wallet_id end,
      updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/** The next shift number on a register, taken under the row's own lock. */
export async function nextShiftNo(tx: Tx, orgId: string, registerId: string): Promise<number> {
  const rows = await tx.execute<{ last_shift_no: number }>(sql`
    update pos.registers set last_shift_no = last_shift_no + 1, updated_at = now()
    where org_id = ${orgId} and id = ${registerId}
    returning last_shift_no
  `);
  const next = rows[0]?.last_shift_no;
  if (next === undefined) throw new Error('numbering a shift matched no register');
  return next;
}

// --- shifts ---------------------------------------------------------------------

export interface ShiftRow extends Record<string, unknown> {
  readonly id: string;
  readonly register_id: string;
  readonly branch_id: string;
  readonly shift_no: number;
  readonly status: 'open' | 'closed';
  readonly opened_by: string;
  readonly opened_at: string;
  readonly business_date: string;
  readonly opening_float_poisha: string;
  readonly closed_by: string | null;
  readonly closed_at: string | null;
  readonly counted_cash_poisha: string | null;
  readonly expected_cash_poisha: string | null;
  readonly variance_poisha: string | null;
  readonly close_note: string | null;
  readonly register_code: string;
}

const SHIFT_SELECT = sql`
  select s.id, s.register_id, s.branch_id, s.shift_no, s.status, s.opened_by, ${iso(sql`s.opened_at`)} as opened_at,
         s.business_date::text as business_date, s.opening_float_poisha::text as opening_float_poisha,
         s.closed_by, ${iso(sql`s.closed_at`)} as closed_at, s.counted_cash_poisha::text as counted_cash_poisha,
         s.expected_cash_poisha::text as expected_cash_poisha,
         s.variance_poisha::text as variance_poisha, s.close_note, r.code as register_code
  from pos.shifts s
  join pos.registers r on r.org_id = s.org_id and r.id = s.register_id
`;

export async function insertShift(
  tx: Tx,
  row: {
    orgId: string;
    id: string;
    registerId: string;
    branchId: string;
    shiftNo: number;
    openedBy: string;
    openedAt: Date;
    businessDate: string;
    openingFloatPoisha: bigint;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into pos.shifts
      (id, org_id, register_id, branch_id, shift_no, opened_by, opened_at, business_date,
       opening_float_poisha)
    values (${row.id}, ${row.orgId}, ${row.registerId}, ${row.branchId}, ${row.shiftNo},
            ${row.openedBy}, ${row.openedAt.toISOString()}::timestamptz, ${row.businessDate},
            ${row.openingFloatPoisha.toString()}::bigint)
    on conflict (id) do nothing
    returning id
  `);
  return rows.length === 1;
}

/**
 * One shift. `lock` is `true` (or `'update'`) for the close, which changes it, and
 * `'share'` for a sync, which only needs it not to close underneath: without that
 * a sale that read "open" just before a close was posted into a drawer that had
 * already been counted without it.
 */
export async function shiftById(
  tx: Tx,
  orgId: string,
  id: string,
  lock: boolean | 'update' | 'share' = false,
): Promise<ShiftRow | undefined> {
  const locking =
    lock === 'share' ? sql`for share of s` : lock === false ? sql`` : sql`for update of s`;
  const rows = await tx.execute<ShiftRow>(sql`
    ${SHIFT_SELECT}
    where s.org_id = ${orgId} and s.id = ${id}
    ${locking}
  `);
  return rows[0];
}

export async function openShiftOn(
  tx: Tx,
  orgId: string,
  registerId: string,
): Promise<ShiftRow | undefined> {
  const rows = await tx.execute<ShiftRow>(sql`
    ${SHIFT_SELECT}
    where s.org_id = ${orgId} and s.register_id = ${registerId} and s.status = 'open'
  `);
  return rows[0];
}

export async function shifts(
  tx: Tx,
  orgId: string,
  filter: {
    scope: SQL;
    branchId?: string | undefined;
    registerId?: string | undefined;
    status?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
): Promise<ShiftRow[]> {
  const rows = await tx.execute<ShiftRow>(sql`
    ${SHIFT_SELECT}
    where s.org_id = ${orgId} and ${filter.scope}
      and ${filter.branchId === undefined ? sql`true` : sql`s.branch_id = ${filter.branchId}`}
      and ${filter.registerId === undefined ? sql`true` : sql`s.register_id = ${filter.registerId}`}
      and ${filter.status === undefined ? sql`true` : sql`s.status::text = ${filter.status}`}
      and ${filter.from === undefined ? sql`true` : sql`s.business_date >= ${filter.from}`}
      and ${filter.to === undefined ? sql`true` : sql`s.business_date <= ${filter.to}`}
    order by s.opened_at desc
    limit 200
  `);
  return [...rows];
}

export async function closeShift(
  tx: Tx,
  orgId: string,
  id: string,
  close: {
    closedBy: string;
    countedCashPoisha: bigint;
    expectedCashPoisha: bigint;
    variancePoisha: bigint;
    note: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update pos.shifts set
      status = 'closed', closed_by = ${close.closedBy}, closed_at = now(),
      counted_cash_poisha = ${close.countedCashPoisha.toString()}::bigint,
      expected_cash_poisha = ${close.expectedCashPoisha.toString()}::bigint,
      variance_poisha = ${close.variancePoisha.toString()}::bigint, close_note = ${close.note}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'open'
  `);
}

export interface DrawerTotals extends Record<string, unknown> {
  readonly cash_sales_poisha: string;
  readonly cash_refunds_poisha: string;
  readonly sales_count: number;
  readonly held_count: number;
  readonly net_sales_poisha: string;
  readonly refunds_poisha: string;
}

/**
 * What went through one shift's drawer, from its documents.
 *
 * Held sales count: the customer paid, the cash is in the drawer, and only the
 * journal is waiting. Voided documents do not — a void is a sale that did not
 * happen, and its cash went back to the customer.
 */
export async function drawerTotals(tx: Tx, orgId: string, shiftId: string): Promise<DrawerTotals> {
  const rows = await tx.execute<DrawerTotals>(sql`
    select
      coalesce((select sum(t.amount_poisha) from pos.sale_tenders t
                join pos.sales s on s.org_id = t.org_id and s.id = t.sale_id
                where s.org_id = ${orgId} and s.shift_id = ${shiftId}
                  and s.status <> 'voided' and t.tender = 'cash'), 0)::text as cash_sales_poisha,
      coalesce((select sum(t.amount_poisha) from pos.return_tenders t
                join pos.returns r on r.org_id = t.org_id and r.id = t.return_id
                where r.org_id = ${orgId} and r.shift_id = ${shiftId}
                  and r.status <> 'voided' and t.tender = 'cash'), 0)::text as cash_refunds_poisha,
      (select count(*) from pos.sales s where s.org_id = ${orgId} and s.shift_id = ${shiftId}
         and s.status <> 'voided')::int as sales_count,
      (select count(*) from pos.sales s where s.org_id = ${orgId} and s.shift_id = ${shiftId}
         and s.status = 'held')::int as held_count,
      coalesce((select sum(s.net_poisha) from pos.sales s where s.org_id = ${orgId}
                and s.shift_id = ${shiftId} and s.status <> 'voided'), 0)::text as net_sales_poisha,
      coalesce((select sum(r.refund_poisha) from pos.returns r where r.org_id = ${orgId}
                and r.shift_id = ${shiftId} and r.status <> 'voided'), 0)::text as refunds_poisha
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('drawer totals returned no row');
  return row;
}

// --- sales ----------------------------------------------------------------------

export interface SaleRow extends Record<string, unknown> {
  readonly id: string;
  readonly register_id: string;
  readonly shift_id: string;
  readonly branch_id: string;
  readonly location_id: string;
  readonly receipt_no: string;
  readonly seller_id: string;
  readonly occurred_at: string;
  readonly business_date: string;
  readonly posted_on: string | null;
  readonly status: 'posted' | 'held' | 'voided';
  readonly gross_poisha: string;
  readonly discount_poisha: string;
  readonly net_poisha: string;
  readonly cash_received_poisha: string;
  readonly change_poisha: string;
  readonly cogs_poisha: string | null;
  readonly journal_id: string | null;
  readonly payload_hash: string;
  readonly exchange_return_id: string | null;
  readonly void_reason: string | null;
}

const SALE_COLUMNS = sql`
  id, register_id, shift_id, branch_id, location_id, receipt_no, seller_id,
  ${iso(sql`occurred_at`)} as occurred_at, business_date::text as business_date, posted_on::text as posted_on, status,
  gross_poisha::text as gross_poisha, discount_poisha::text as discount_poisha,
  net_poisha::text as net_poisha, cash_received_poisha::text as cash_received_poisha,
  change_poisha::text as change_poisha, cogs_poisha::text as cogs_poisha, journal_id,
  payload_hash, exchange_return_id, void_reason
`;

export async function insertHeldSale(
  tx: Tx,
  row: {
    orgId: string;
    id: string;
    registerId: string;
    shiftId: string;
    branchId: string;
    locationId: string;
    receiptNo: string;
    sellerId: string;
    occurredAt: Date;
    businessDate: string;
    grossPoisha: bigint;
    discountPoisha: bigint;
    netPoisha: bigint;
    cashReceivedPoisha: bigint;
    changePoisha: bigint;
    payloadHash: string;
    exchangeReturnId: string | null;
  },
): Promise<boolean> {
  /*
   * `on conflict do nothing`, and it is the concurrency guarantee rather than a
   * convenience. Two deliveries of one sale racing each other both reach this
   * insert; the second blocks on the first's uncommitted index entry, and when the
   * first commits it inserts nothing and returns no row. Only the delivery that
   * inserted goes on to move stock and post — a select-then-insert would let both
   * see "not there yet" and both post.
   */
  const rows = await tx.execute<{ id: string }>(sql`
    insert into pos.sales
      (id, org_id, register_id, shift_id, branch_id, location_id, receipt_no, seller_id,
       occurred_at, business_date, status, gross_poisha, discount_poisha, net_poisha,
       cash_received_poisha, change_poisha, payload_hash, exchange_return_id)
    values (${row.id}, ${row.orgId}, ${row.registerId}, ${row.shiftId}, ${row.branchId},
            ${row.locationId}, ${row.receiptNo}, ${row.sellerId},
            ${row.occurredAt.toISOString()}::timestamptz,
            ${row.businessDate}, 'held', ${row.grossPoisha.toString()}::bigint, ${row.discountPoisha.toString()}::bigint,
            ${row.netPoisha.toString()}::bigint, ${row.cashReceivedPoisha.toString()}::bigint, ${row.changePoisha.toString()}::bigint, ${row.payloadHash},
            ${row.exchangeReturnId})
    on conflict (id) do nothing
    returning id
  `);
  return rows.length === 1;
}

export async function saleById(
  tx: Tx,
  orgId: string,
  id: string,
  lock = false,
): Promise<SaleRow | undefined> {
  const rows = await tx.execute<SaleRow>(sql`
    select ${SALE_COLUMNS} from pos.sales
    where org_id = ${orgId} and id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function salesByReceipt(
  tx: Tx,
  orgId: string,
  receiptNo: string,
  scope: SQL,
): Promise<SaleRow[]> {
  const rows = await tx.execute<SaleRow>(sql`
    select ${SALE_COLUMNS} from pos.sales
    where org_id = ${orgId} and receipt_no = ${receiptNo} and ${scope}
    order by occurred_at desc
    limit 5
  `);
  return [...rows];
}

export interface SaleLineRow extends Record<string, unknown> {
  readonly line_no: number;
  readonly sku_id: string;
  readonly qty: number;
  readonly unit_price_poisha: string;
  readonly discount_poisha: string;
  readonly net_poisha: string;
  readonly catalog_price_poisha: string | null;
  readonly unit_cost_poisha: string | null;
}

export async function insertSaleLines(
  tx: Tx,
  orgId: string,
  saleId: string,
  lines: readonly {
    lineNo: number;
    skuId: string;
    qty: number;
    unitPricePoisha: bigint;
    discountPoisha: bigint;
    netPoisha: bigint;
    catalogPricePoisha: bigint | null;
  }[],
): Promise<void> {
  for (const line of lines) {
    await tx.execute(sql`
      insert into pos.sale_lines
        (org_id, sale_id, line_no, sku_id, qty, unit_price_poisha, discount_poisha, net_poisha,
         catalog_price_poisha)
      values (${orgId}, ${saleId}, ${line.lineNo}, ${line.skuId}, ${line.qty},
              ${line.unitPricePoisha.toString()}::bigint, ${line.discountPoisha.toString()}::bigint, ${line.netPoisha.toString()}::bigint,
              ${line.catalogPricePoisha === null ? null : line.catalogPricePoisha.toString()}::bigint)
    `);
  }
}

/**
 * A sale's lines. Labels (SKU code, product name) come from `CatalogApi` in the
 * service, never from a join into `catalog.*` here (invariant 12).
 */
export async function saleLines(
  tx: Tx,
  orgId: string,
  saleId: string,
  lock = false,
): Promise<SaleLineRow[]> {
  const rows = await tx.execute<SaleLineRow>(sql`
    select l.line_no, l.sku_id, l.qty, l.unit_price_poisha::text as unit_price_poisha,
           l.discount_poisha::text as discount_poisha, l.net_poisha::text as net_poisha,
           l.catalog_price_poisha::text as catalog_price_poisha,
           l.unit_cost_poisha::text as unit_cost_poisha
    from pos.sale_lines l
    where l.org_id = ${orgId} and l.sale_id = ${saleId}
    order by l.line_no
    ${lock ? sql`for update` : sql``}
  `);
  return [...rows];
}

export async function setSaleLineCost(
  tx: Tx,
  orgId: string,
  saleId: string,
  lineNo: number,
  unitCostPoisha: bigint,
): Promise<void> {
  await tx.execute(sql`
    update pos.sale_lines set unit_cost_poisha = ${unitCostPoisha.toString()}::bigint, updated_at = now()
    where org_id = ${orgId} and sale_id = ${saleId} and line_no = ${lineNo}
      and unit_cost_poisha is null
  `);
}

export interface TenderRow extends Record<string, unknown> {
  readonly tender: 'cash' | 'bkash' | 'card';
  readonly amount_poisha: string;
  readonly wallet_id: string;
  readonly reference: string | null;
}

export async function insertSaleTenders(
  tx: Tx,
  orgId: string,
  saleId: string,
  tenders: readonly {
    tender: string;
    amountPoisha: bigint;
    walletId: string;
    reference: string | null;
  }[],
): Promise<void> {
  for (const tender of tenders) {
    await tx.execute(sql`
      insert into pos.sale_tenders (org_id, sale_id, tender, amount_poisha, wallet_id, reference)
      values (${orgId}, ${saleId}, ${tender.tender}::pos.tender, ${tender.amountPoisha.toString()}::bigint,
              ${tender.walletId}, ${tender.reference})
    `);
  }
}

export async function saleTenders(tx: Tx, orgId: string, saleId: string): Promise<TenderRow[]> {
  const rows = await tx.execute<TenderRow>(sql`
    select tender, amount_poisha::text as amount_poisha, wallet_id, reference
    from pos.sale_tenders where org_id = ${orgId} and sale_id = ${saleId}
    order by tender
  `);
  return [...rows];
}

export async function markPosted(
  tx: Tx,
  table: 'sales' | 'returns',
  orgId: string,
  id: string,
  posted: { postedOn: string; cogsPoisha: bigint; journalId: string | null },
): Promise<void> {
  const target = table === 'sales' ? sql`pos.sales` : sql`pos.returns`;
  await tx.execute(sql`
    update ${target} set status = 'posted', posted_on = ${posted.postedOn},
      cogs_poisha = ${posted.cogsPoisha.toString()}::bigint, journal_id = ${posted.journalId}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'held'
  `);
}

export async function markVoided(
  tx: Tx,
  table: 'sales' | 'returns',
  orgId: string,
  id: string,
  voided: { reason: string; by: string },
): Promise<void> {
  const target = table === 'sales' ? sql`pos.sales` : sql`pos.returns`;
  await tx.execute(sql`
    update ${target} set status = 'voided', void_reason = ${voided.reason},
      voided_by = ${voided.by}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'held'
  `);
}

// --- returns --------------------------------------------------------------------

export interface ReturnRow extends Record<string, unknown> {
  readonly id: string;
  readonly register_id: string;
  readonly shift_id: string;
  readonly branch_id: string;
  readonly location_id: string;
  readonly sale_id: string;
  readonly receipt_no: string;
  readonly created_by: string;
  readonly occurred_at: string;
  readonly business_date: string;
  readonly posted_on: string | null;
  readonly status: 'posted' | 'held' | 'voided';
  readonly refund_poisha: string;
  readonly cogs_poisha: string | null;
  readonly journal_id: string | null;
  readonly reason: string | null;
  readonly payload_hash: string;
}

export async function insertHeldReturn(
  tx: Tx,
  row: {
    orgId: string;
    id: string;
    registerId: string;
    shiftId: string;
    branchId: string;
    locationId: string;
    saleId: string;
    receiptNo: string;
    createdBy: string;
    occurredAt: Date;
    businessDate: string;
    refundPoisha: bigint;
    reason: string | null;
    payloadHash: string;
  },
): Promise<boolean> {
  // `on conflict do nothing` for the reason `insertHeldSale` gives.
  const rows = await tx.execute<{ id: string }>(sql`
    insert into pos.returns
      (id, org_id, register_id, shift_id, branch_id, location_id, sale_id, receipt_no,
       created_by, occurred_at, business_date, status, refund_poisha, reason, payload_hash)
    values (${row.id}, ${row.orgId}, ${row.registerId}, ${row.shiftId}, ${row.branchId},
            ${row.locationId}, ${row.saleId}, ${row.receiptNo}, ${row.createdBy},
            ${row.occurredAt.toISOString()}::timestamptz, ${row.businessDate}, 'held',
            ${row.refundPoisha.toString()}::bigint, ${row.reason},
            ${row.payloadHash})
    on conflict (id) do nothing
    returning id
  `);
  return rows.length === 1;
}

export async function returnById(
  tx: Tx,
  orgId: string,
  id: string,
  lock = false,
): Promise<ReturnRow | undefined> {
  const rows = await tx.execute<ReturnRow>(sql`
    select id, register_id, shift_id, branch_id, location_id, sale_id, receipt_no, created_by,
           ${iso(sql`occurred_at`)} as occurred_at, business_date::text as business_date, posted_on::text as posted_on,
           status, refund_poisha::text as refund_poisha, cogs_poisha::text as cogs_poisha,
           journal_id, reason, payload_hash
    from pos.returns
    where org_id = ${orgId} and id = ${id}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export interface ReturnLineRow extends Record<string, unknown> {
  readonly line_no: number;
  readonly sale_line_no: number;
  readonly sku_id: string;
  readonly qty: number;
  readonly refund_poisha: string;
}

export async function insertReturnLines(
  tx: Tx,
  orgId: string,
  returnId: string,
  saleId: string,
  lines: readonly {
    lineNo: number;
    saleLineNo: number;
    skuId: string;
    qty: number;
    refundPoisha: bigint;
  }[],
): Promise<void> {
  for (const line of lines) {
    await tx.execute(sql`
      insert into pos.return_lines
        (org_id, return_id, line_no, sale_id, sale_line_no, sku_id, qty, refund_poisha)
      values (${orgId}, ${returnId}, ${line.lineNo}, ${saleId}, ${line.saleLineNo},
              ${line.skuId}, ${line.qty}, ${line.refundPoisha.toString()}::bigint)
    `);
  }
}

export async function returnLines(
  tx: Tx,
  orgId: string,
  returnId: string,
): Promise<ReturnLineRow[]> {
  const rows = await tx.execute<ReturnLineRow>(sql`
    select line_no, sale_line_no, sku_id, qty, refund_poisha::text as refund_poisha
    from pos.return_lines where org_id = ${orgId} and return_id = ${returnId}
    order by line_no
  `);
  return [...rows];
}

export async function setReturnLineCost(
  tx: Tx,
  orgId: string,
  returnId: string,
  lineNo: number,
  unitCostPoisha: bigint,
): Promise<void> {
  await tx.execute(sql`
    update pos.return_lines set unit_cost_poisha = ${unitCostPoisha.toString()}::bigint, updated_at = now()
    where org_id = ${orgId} and return_id = ${returnId} and line_no = ${lineNo}
      and unit_cost_poisha is null
  `);
}

export async function insertReturnTenders(
  tx: Tx,
  orgId: string,
  returnId: string,
  tenders: readonly { tender: string; amountPoisha: bigint; walletId: string }[],
): Promise<void> {
  for (const tender of tenders) {
    await tx.execute(sql`
      insert into pos.return_tenders (org_id, return_id, tender, amount_poisha, wallet_id)
      values (${orgId}, ${returnId}, ${tender.tender}::pos.tender, ${tender.amountPoisha.toString()}::bigint,
              ${tender.walletId})
    `);
  }
}

export async function returnTenders(tx: Tx, orgId: string, returnId: string): Promise<TenderRow[]> {
  const rows = await tx.execute<TenderRow>(sql`
    select tender, amount_poisha::text as amount_poisha, wallet_id, null as reference
    from pos.return_tenders where org_id = ${orgId} and return_id = ${returnId}
    order by tender
  `);
  return [...rows];
}

/**
 * Units of each sale line already brought back by other, non-voided returns —
 * posted or still held, because a held return's refund already left the drawer.
 */
export async function returnedQty(
  tx: Tx,
  orgId: string,
  saleId: string,
  excludeReturnId: string | null,
): Promise<Map<number, number>> {
  const rows = await tx.execute<{ sale_line_no: number; qty: number }>(sql`
    select l.sale_line_no, sum(l.qty)::int as qty
    from pos.return_lines l
    join pos.returns r on r.org_id = l.org_id and r.id = l.return_id
    where l.org_id = ${orgId} and l.sale_id = ${saleId} and r.status <> 'voided'
      and ${excludeReturnId === null ? sql`true` : sql`r.id <> ${excludeReturnId}`}
    group by l.sale_line_no
  `);
  return new Map(rows.map((row) => [row.sale_line_no, row.qty]));
}

/**
 * Units and refunds already returned per sale line, voided returns excluded, held
 * ones included: a held return's refund has already left the drawer (D-175).
 */
export async function returnedSoFar(
  tx: Tx,
  orgId: string,
  saleId: string,
  excludeReturnId: string | null,
): Promise<Map<number, { qty: number; refundPoisha: bigint }>> {
  const rows = await tx.execute<{ sale_line_no: number; qty: number; refund_poisha: string }>(sql`
    select l.sale_line_no, sum(l.qty)::int as qty, sum(l.refund_poisha)::text as refund_poisha
    from pos.return_lines l
    join pos.returns r on r.org_id = l.org_id and r.id = l.return_id
    where l.org_id = ${orgId} and l.sale_id = ${saleId} and r.status <> 'voided'
      and ${excludeReturnId === null ? sql`true` : sql`r.id <> ${excludeReturnId}`}
    group by l.sale_line_no
  `);
  return new Map(
    rows.map((row) => [
      row.sale_line_no,
      { qty: row.qty, refundPoisha: BigInt(row.refund_poisha) },
    ]),
  );
}

// --- review items ---------------------------------------------------------------

export interface ReviewRow extends Record<string, unknown> {
  readonly id: string;
  readonly branch_id: string;
  readonly kind: 'sale' | 'return';
  readonly sale_id: string | null;
  readonly return_id: string | null;
  readonly reasons: string[];
  readonly detail: Record<string, unknown>;
  readonly status: 'open' | 'posted' | 'voided';
  readonly attempts: number;
  readonly created_at: string;
  readonly last_attempt_at: string;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
  readonly resolution_note: string | null;
  readonly receipt_no: string;
  readonly amount_poisha: string;
  readonly occurred_at: string;
  readonly seller_id: string;
}

const REVIEW_SELECT = sql`
  select v.id, v.branch_id, v.kind, v.sale_id, v.return_id, v.reasons::text[] as reasons,
         v.detail, v.status, v.attempts, ${iso(sql`v.created_at`)} as created_at,
         ${iso(sql`v.last_attempt_at`)} as last_attempt_at, v.resolved_by,
         ${iso(sql`v.resolved_at`)} as resolved_at, v.resolution_note,
         coalesce(s.receipt_no, r.receipt_no) as receipt_no,
         coalesce(s.net_poisha, r.refund_poisha)::text as amount_poisha,
         ${iso(sql`coalesce(s.occurred_at, r.occurred_at)`)} as occurred_at,
         coalesce(s.seller_id, r.created_by) as seller_id
  from pos.review_items v
  left join pos.sales s on s.org_id = v.org_id and s.id = v.sale_id
  left join pos.returns r on r.org_id = v.org_id and r.id = v.return_id
`;

export async function openReviewFor(
  tx: Tx,
  orgId: string,
  kind: 'sale' | 'return',
  documentId: string,
): Promise<ReviewRow | undefined> {
  const rows = await tx.execute<ReviewRow>(sql`
    ${REVIEW_SELECT}
    where v.org_id = ${orgId} and v.status = 'open'
      and ${kind === 'sale' ? sql`v.sale_id = ${documentId}` : sql`v.return_id = ${documentId}`}
  `);
  return rows[0];
}

export async function latestReviewFor(
  tx: Tx,
  orgId: string,
  kind: 'sale' | 'return',
  documentId: string,
): Promise<ReviewRow | undefined> {
  const rows = await tx.execute<ReviewRow>(sql`
    ${REVIEW_SELECT}
    where v.org_id = ${orgId}
      and ${kind === 'sale' ? sql`v.sale_id = ${documentId}` : sql`v.return_id = ${documentId}`}
    order by v.created_at desc
    limit 1
  `);
  return rows[0];
}

export async function insertReview(
  tx: Tx,
  row: {
    orgId: string;
    branchId: string;
    kind: 'sale' | 'return';
    documentId: string;
    reasons: readonly string[];
    detail: Record<string, unknown>;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into pos.review_items (org_id, branch_id, kind, sale_id, return_id, reasons, detail)
    values (${row.orgId}, ${row.branchId}, ${row.kind}::pos.document_kind,
            ${row.kind === 'sale' ? row.documentId : null}::uuid,
            ${row.kind === 'return' ? row.documentId : null}::uuid,
            ${sql.param([...row.reasons])}::pos.hold_reason[], ${JSON.stringify(row.detail)}::jsonb)
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('raising a review item returned no id');
  return id;
}

export async function reviewById(
  tx: Tx,
  orgId: string,
  id: string,
  lock = false,
): Promise<ReviewRow | undefined> {
  const rows = await tx.execute<ReviewRow>(sql`
    ${REVIEW_SELECT}
    where v.org_id = ${orgId} and v.id = ${id}
    ${lock ? sql`for update of v` : sql``}
  `);
  return rows[0];
}

export async function refreshReview(
  tx: Tx,
  orgId: string,
  id: string,
  reasons: readonly string[],
  detail: Record<string, unknown>,
): Promise<void> {
  await tx.execute(sql`
    update pos.review_items set reasons = ${sql.param([...reasons])}::pos.hold_reason[],
      detail = ${JSON.stringify(detail)}::jsonb, attempts = attempts + 1,
      last_attempt_at = now(), updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'open'
  `);
}

export async function resolveReview(
  tx: Tx,
  orgId: string,
  id: string,
  resolution: { status: 'posted' | 'voided'; by: string; note: string },
): Promise<void> {
  await tx.execute(sql`
    update pos.review_items set status = ${resolution.status}::pos.review_status,
      resolved_by = ${resolution.by}, resolved_at = now(), resolution_note = ${resolution.note},
      updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'open'
  `);
}

export async function reviews(
  tx: Tx,
  orgId: string,
  filter: { scope: SQL; branchId?: string | undefined; status?: string | undefined },
): Promise<ReviewRow[]> {
  const rows = await tx.execute<ReviewRow>(sql`
    ${REVIEW_SELECT}
    where v.org_id = ${orgId} and ${filter.scope}
      and ${filter.branchId === undefined ? sql`true` : sql`v.branch_id = ${filter.branchId}`}
      and ${filter.status === undefined ? sql`true` : sql`v.status::text = ${filter.status}`}
    order by v.created_at desc
    limit 200
  `);
  return [...rows];
}

// --- branches -------------------------------------------------------------------

export interface BranchRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
}

/** The platform's `org.branches`, which every module reads (§5: org is shared). */
export async function branches(tx: Tx, orgId: string, scope: SQL): Promise<BranchRow[]> {
  const rows = await tx.execute<BranchRow>(sql`
    select b.id, b.code, b.name, b.kind::text as kind
    from org.branches b
    where b.org_id = ${orgId} and ${scope}
    order by b.code
  `);
  return [...rows];
}

export async function branchById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<BranchRow | undefined> {
  const rows = await tx.execute<BranchRow>(sql`
    select id, code, name, kind::text as kind from org.branches where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export interface ReceiptHeaderRow extends Record<string, unknown> {
  readonly display_name: string;
  readonly legal_name: string;
  readonly brand: Record<string, unknown> | null;
  readonly branch_name: string;
  readonly branch_address: string | null;
  readonly branch_phone: string | null;
}

/**
 * What a receipt prints at the top (§24 per-org branding, D-034): the brand's
 * legal name and footer, and the branch's own address and phone. The branch's
 * phone is a shop line, not personal data.
 */
export async function receiptHeader(
  tx: Tx,
  orgId: string,
  branchId: string,
): Promise<ReceiptHeaderRow | undefined> {
  const rows = await tx.execute<ReceiptHeaderRow>(sql`
    select o.display_name, o.legal_name, o.brand, b.name as branch_name,
           b.address_line as branch_address, b.phone as branch_phone
    from org.organizations o
    join org.branches b on b.org_id = o.id and b.id = ${branchId}
    where o.id = ${orgId}
  `);
  return rows[0];
}

export interface BranchSummaryRow extends Record<string, unknown> {
  readonly sales_count: number;
  readonly held_count: number;
  readonly gross_poisha: string;
  readonly discount_poisha: string;
  readonly net_poisha: string;
  readonly cogs_poisha: string;
  readonly returns_count: number;
  readonly refunds_poisha: string;
  readonly return_cogs_poisha: string;
  readonly cash_poisha: string;
  readonly bkash_poisha: string;
  readonly card_poisha: string;
  readonly open_shifts: number;
  readonly open_reviews: number;
}

/**
 * One branch's till figures over a range of business dates.
 *
 * Sales and refunds count once posted **or** held — the money changed hands
 * either way, and a dashboard that hid held sales would show a branch trading less
 * than its drawer says. COGS is posted sales only, because a held sale has no
 * recorded cost yet; the service withholds it from roles without `read:cost`.
 */
export async function branchSummary(
  tx: Tx,
  orgId: string,
  branchId: string,
  range: { from: string; to: string },
): Promise<BranchSummaryRow> {
  const rows = await tx.execute<BranchSummaryRow>(sql`
    with s as (
      select * from pos.sales
      where org_id = ${orgId} and branch_id = ${branchId} and status <> 'voided'
        and business_date between ${range.from} and ${range.to}
    ), r as (
      select * from pos.returns
      where org_id = ${orgId} and branch_id = ${branchId} and status <> 'voided'
        and business_date between ${range.from} and ${range.to}
    )
    select
      (select count(*) from s)::int as sales_count,
      (select count(*) from s where status = 'held')::int as held_count,
      coalesce((select sum(gross_poisha) from s), 0)::text as gross_poisha,
      coalesce((select sum(discount_poisha) from s), 0)::text as discount_poisha,
      coalesce((select sum(net_poisha) from s), 0)::text as net_poisha,
      coalesce((select sum(cogs_poisha) from s where status = 'posted'), 0)::text as cogs_poisha,
      (select count(*) from r)::int as returns_count,
      coalesce((select sum(refund_poisha) from r), 0)::text as refunds_poisha,
      coalesce((select sum(cogs_poisha) from r where status = 'posted'), 0)::text as return_cogs_poisha,
      coalesce((select sum(t.amount_poisha) from pos.sale_tenders t join s on s.id = t.sale_id
                where t.org_id = ${orgId} and t.tender = 'cash'), 0)::text as cash_poisha,
      coalesce((select sum(t.amount_poisha) from pos.sale_tenders t join s on s.id = t.sale_id
                where t.org_id = ${orgId} and t.tender = 'bkash'), 0)::text as bkash_poisha,
      coalesce((select sum(t.amount_poisha) from pos.sale_tenders t join s on s.id = t.sale_id
                where t.org_id = ${orgId} and t.tender = 'card'), 0)::text as card_poisha,
      (select count(*) from pos.shifts where org_id = ${orgId} and branch_id = ${branchId}
         and status = 'open')::int as open_shifts,
      (select count(*) from pos.review_items where org_id = ${orgId} and branch_id = ${branchId}
         and status = 'open')::int as open_reviews
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('branch summary returned no row');
  return row;
}

export interface TopSkuRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly qty: number;
  readonly net_poisha: string;
}

export async function topSkus(
  tx: Tx,
  orgId: string,
  branchId: string,
  range: { from: string; to: string },
): Promise<TopSkuRow[]> {
  const rows = await tx.execute<TopSkuRow>(sql`
    select l.sku_id, sum(l.qty)::int as qty, sum(l.net_poisha)::text as net_poisha
    from pos.sale_lines l
    join pos.sales s on s.org_id = l.org_id and s.id = l.sale_id
    where l.org_id = ${orgId} and s.branch_id = ${branchId} and s.status <> 'voided'
      and s.business_date between ${range.from} and ${range.to}
    group by l.sku_id
    order by sum(l.qty) desc, l.sku_id
    limit 10
  `);
  return [...rows];
}

/** What stops a branch day from being closed: open tills and unresolved holds. */
export async function branchReadiness(
  tx: Tx,
  orgId: string,
  branchId: string,
  businessDate: string,
): Promise<{ open_shifts: number; open_reviews: number }> {
  const rows = await tx.execute<{ open_shifts: number; open_reviews: number }>(sql`
    select
      (select count(*) from pos.shifts where org_id = ${orgId} and branch_id = ${branchId}
         and status = 'open' and business_date <= ${businessDate})::int as open_shifts,
      (select count(*) from pos.review_items v
         left join pos.sales s on s.org_id = v.org_id and s.id = v.sale_id
         left join pos.returns r on r.org_id = v.org_id and r.id = v.return_id
         where v.org_id = ${orgId} and v.branch_id = ${branchId} and v.status = 'open'
           and coalesce(s.business_date, r.business_date) <= ${businessDate})::int as open_reviews
  `);
  return rows[0] ?? { open_shifts: 0, open_reviews: 0 };
}

export interface BranchClosingRow extends Record<string, unknown> {
  readonly id: string;
  readonly branch_id: string;
  readonly business_date: string;
  readonly closed_by: string;
  readonly sales_count: number;
  readonly net_sales_poisha: string;
  readonly refunds_poisha: string;
  readonly note: string | null;
  readonly created_at: string;
}

export async function branchClosing(
  tx: Tx,
  orgId: string,
  branchId: string,
  businessDate: string,
): Promise<BranchClosingRow | undefined> {
  const rows = await tx.execute<BranchClosingRow>(sql`
    select id, branch_id, business_date::text as business_date, closed_by, sales_count,
           net_sales_poisha::text as net_sales_poisha, refunds_poisha::text as refunds_poisha,
           note, ${iso(sql`created_at`)} as created_at
    from pos.branch_closings
    where org_id = ${orgId} and branch_id = ${branchId} and business_date = ${businessDate}
  `);
  return rows[0];
}

/** A branch closing by its own id, whatever branch or day it closed. */
export async function branchClosingById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<BranchClosingRow | undefined> {
  const rows = await tx.execute<BranchClosingRow>(sql`
    select id, branch_id, business_date::text as business_date, closed_by, sales_count,
           net_sales_poisha::text as net_sales_poisha, refunds_poisha::text as refunds_poisha,
           note, ${iso(sql`created_at`)} as created_at
    from pos.branch_closings
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function branchClosings(
  tx: Tx,
  orgId: string,
  branchId: string,
  range: { from: string; to: string },
): Promise<
  (BranchClosingRow & {
    wallets: { wallet_id: string; wallet_closing_id: string; counted_poisha: string }[];
  })[]
> {
  const rows = await tx.execute<
    BranchClosingRow & {
      wallets: { wallet_id: string; wallet_closing_id: string; counted_poisha: string }[];
    }
  >(sql`
    select c.id, c.branch_id, c.business_date::text as business_date, c.closed_by, c.sales_count,
           c.net_sales_poisha::text as net_sales_poisha, c.refunds_poisha::text as refunds_poisha,
           c.note, ${iso(sql`c.created_at`)} as created_at,
           coalesce((select json_agg(json_build_object(
                       'wallet_id', w.wallet_id, 'wallet_closing_id', w.wallet_closing_id,
                       'counted_poisha', w.counted_poisha::text) order by w.wallet_id)
                     from pos.branch_closing_wallets w
                     where w.org_id = c.org_id and w.branch_closing_id = c.id), '[]'::json) as wallets
    from pos.branch_closings c
    where c.org_id = ${orgId} and c.branch_id = ${branchId}
      and c.business_date between ${range.from} and ${range.to}
    order by c.business_date desc
  `);
  return [...rows];
}

export async function insertBranchClosing(
  tx: Tx,
  row: {
    orgId: string;
    id: string;
    branchId: string;
    businessDate: string;
    closedBy: string;
    salesCount: number;
    netSalesPoisha: bigint;
    refundsPoisha: bigint;
    note: string | null;
    wallets: readonly { walletId: string; walletClosingId: string; countedPoisha: bigint }[];
  },
): Promise<void> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into pos.branch_closings
      (id, org_id, branch_id, business_date, closed_by, sales_count, net_sales_poisha,
       refunds_poisha, note)
    values (${row.id}, ${row.orgId}, ${row.branchId}, ${row.businessDate}, ${row.closedBy},
            ${row.salesCount}, ${row.netSalesPoisha.toString()}::bigint, ${row.refundsPoisha.toString()}::bigint, ${row.note})
    on conflict (id) do nothing
    returning id
  `);
  if (inserted.length === 0) {
    // A replay is the same closing. Anything else under this id is a different one,
    // and recording nothing while the caller audits a close would hide that (W2).
    const existing = await branchClosingById(tx, row.orgId, row.id);
    if (existing?.branch_id !== row.branchId || existing.business_date !== row.businessDate) {
      throw new PosError('IDEMPOTENCY_CONFLICT', 'That closing id already closed another day.');
    }
    return;
  }
  for (const wallet of row.wallets) {
    await tx.execute(sql`
      insert into pos.branch_closing_wallets
        (org_id, branch_closing_id, wallet_id, wallet_closing_id, counted_poisha)
      values (${row.orgId}, ${row.id}, ${wallet.walletId}, ${wallet.walletClosingId},
              ${wallet.countedPoisha.toString()}::bigint)
    `);
  }
}
