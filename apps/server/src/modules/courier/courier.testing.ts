import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem, type Tx } from '@elysium/db';
import {
  businessDate,
  dispatchValue,
  isAccountSubtype,
  orderDeliveredDraft,
  orderReturnDraft,
  poisha,
  subtypeInfo,
  transition,
  type AccountSubtype,
  type OrderStatus,
  type Poisha,
  type PostingAccount,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../platform/http/context.js';
import type { LedgerApi } from '../ledger/ledger.api.js';
import type { LedgerReadPort } from './ports/ledger-read.port.js';
import type {
  AppliedTrigger,
  CourierTriggerInput,
  CourierParty,
  OrderBookingSnapshot,
  OrderFacts,
  OrdersPort,
  ReturnableLine,
} from './ports/orders.port.js';
import type { WalletsPort } from './ports/wallets.port.js';

/**
 * Test-only setup for the courier suites.
 *
 * Two jobs, and both exist because of how this session is split rather than because of
 * anything about couriers:
 *
 * 1. **Seed the rows this module's foreign keys point at.** A consignment needs an order, an
 *    order needs a customer and a SKU, a settlement needs a wallet. Those are M06's, M08's
 *    and M10's create paths to test; these suites need the rows to exist, so they are written
 *    directly. A fixture, not a production path — which is why it is here and not in a
 *    service.
 * 2. **Stand in for the three ports.** `modules/orders` is being finished beside this one, so
 *    `ORDERS_PORT` has no real implementation yet. The double below is deliberately **not** a
 *    stub: it runs the real state machine from `@elysium/domain` and posts the real §7
 *    journals through the real `LedgerApi`, because the acceptance checks this milestone has
 *    to prove are about money. A double that recorded calls and posted nothing would make
 *    check 5 — "the courier receivable ends at exactly zero" — a test of nothing.
 *
 * `WalletsPort` and `LedgerReadPort` are implemented for real here, against `wallets.wallets`
 * and `ledger.*`. Those are the two queries the INTEGRATION notes ask the wallets and ledger
 * modules to expose; the implementations below are what should move there, near-verbatim.
 */

/**
 * Apply migration 0052, which `startTestDatabase()` does not.
 *
 * `packages/db/migrations/meta/_journal.json` is edited by several milestones at once, so 0052
 * is handed to the integrator as an INTEGRATION line rather than appended here — and until it
 * is appended, drizzle's migrator does not run it. Idempotent: the trigger it creates is
 * detected and the file is skipped, so a suite that calls this twice does nothing the second
 * time. The same arrangement `inventory.testing.ts` uses for M07's four files.
 */
export async function applyCourierMigrations(): Promise<void> {
  /*
   * Each file with the object whose presence proves it ran.
   *
   * 0052 is in the journal now and is detected and skipped. M15's three (0065–0067) are not
   * yet — they are handed to the integrator as INTEGRATION lines for the same reason 0052
   * was — so until they are registered this is what applies them. The marker for each is
   * the *last* object it creates, so a file that died half-way is re-run rather than
   * mistaken for done.
   */
  const files: readonly { readonly file: string; readonly marker: ReturnType<typeof sql> }[] = [
    {
      file: '0052_courier_settlement_binding.sql',
      marker: sql`select exists (select 1 from pg_trigger where tgname = 'courier_assert_collection_has_dispatch') as present`,
    },
    {
      file: '0065_courier_m15_schema.sql',
      marker: sql`select exists (select 1 from pg_constraint where conname = 'settlements_fingerprint_iff_api') as present`,
    },
    {
      file: '0066_courier_m15_policies.sql',
      marker: sql`select exists (select 1 from pg_policies where schemaname = 'courier' and policyname = 'settlement_fetch_runs_org_isolation') as present`,
    },
    {
      file: '0067_courier_m15_integrity.sql',
      marker: sql`select exists (select 1 from pg_trigger where tgname = 'courier_assert_collection_is_a_delivery') as present`,
    },
  ];

  for (const { file, marker } of files) {
    const already = await withSystem(async (tx) => {
      const rows = await tx.execute<{ present: boolean }>(marker);
      return rows[0]?.present === true;
    });
    if (already) continue;

    const contents = await readFile(
      path.resolve(import.meta.dirname, '../../../../../packages/db/migrations', file),
      'utf8',
    );
    // The same separator the real migrator splits on. Comment-only fragments are valid no-op
    // statements, so they need no filtering. One transaction for the file, as the migrator
    // gives it, so a failure leaves nothing half-applied for the marker to misread.
    await withSystem(async (tx) => {
      for (const statement of contents.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed === '') continue;
        await tx.execute(sql.raw(trimmed));
      }
    });
  }
}

// --- seeding ------------------------------------------------------------------

export interface SeededOrder {
  readonly orderId: string;
  readonly orderNo: string;
  readonly customerId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly branchId: string;
  readonly codAmountPoisha: bigint;
  readonly itemsPoisha: bigint;
  readonly deliveryChargePoisha: bigint;
  readonly qty: number;
  readonly unitPricePoisha: bigint;
  readonly dispatchUnitCostPoisha: bigint;
}

let orderSequence = 0;

/**
 * Statuses that imply the parcel has been handed to a courier (§9).
 *
 * `handed_over_at` is set by the `ship` transition, and migration 0052 treats it as the
 * database's evidence that a delivery journal is possible at all — so a fixture that seeds a
 * shipped order has to set it, exactly as the real transition does.
 */
const SHIPPED_OR_LATER: readonly OrderStatus[] = [
  'shipped',
  'delivered',
  'partially_delivered',
  'return_in_transit',
  'returned',
];

export async function hqBranch(orgId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.branches where org_id = ${orgId} and code = 'HQ'
      `);
      return rows[0]?.id ?? '';
    },
    { orgId },
  );
}

export async function warehouse(orgId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.locations where org_id = ${orgId} and code = 'WH-01'
      `);
      return rows[0]?.id ?? '';
    },
    { orgId },
  );
}

/** A second location, for the `damaged` shelf §7 sends damaged returns to. */
export async function makeLocation(
  orgId: string,
  input: { code: string; name: string; kind: string },
): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into org.locations (org_id, code, name, kind)
        values (${orgId}, ${input.code}, ${input.name}, ${input.kind}::org.location_kind)
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId },
  );
}

/** M10's courier party row, which `courier.courier_accounts` hangs off (D-171). */
export async function makeCourier(orgId: string, code: string, name: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into sales.couriers (org_id, code, name)
        values (${orgId}, ${code}, ${name})
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId },
  );
}

/** A bank wallet for a settlement's net to land in (§7's "Dr W"). */
export async function makeBankWallet(orgId: string, code = '1110'): Promise<string> {
  return withSystem(
    async (tx) => {
      const accountRows = await tx.execute<{ id: string }>(sql`
        insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance)
        values (${orgId}, ${code}, 'Settlement bank', 'asset', 'wallet_bank', 'debit')
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      const accountId = accountRows[0]?.id ?? '';
      const walletRows = await tx.execute<{ id: string }>(sql`
        insert into wallets.wallets (org_id, ledger_account_id, requires_daily_closing)
        values (${orgId}, ${accountId}, false)
        on conflict do nothing
        returning id
      `);
      if (walletRows[0]?.id !== undefined) return walletRows[0].id;
      const existing = await tx.execute<{ id: string }>(sql`
        select id from wallets.wallets where org_id = ${orgId} and ledger_account_id = ${accountId}
      `);
      return existing[0]?.id ?? '';
    },
    { orgId },
  );
}

/**
 * One order, shipped, with one line and a dispatch cost on it.
 *
 * `status` defaults to `shipped`, because that is where every courier status this module
 * applies starts from (§9's transition table). The dispatch cost is written on the line
 * because §7 and §8 both require the return and the delivery to credit goods in transit with
 * exactly what the dispatch movement recorded — the port's double reads it from here.
 */
export async function seedShippedOrder(
  orgId: string,
  options: {
    qty?: number;
    unitPricePoisha?: bigint;
    deliveryChargePoisha?: bigint;
    dispatchUnitCostPoisha?: bigint;
    status?: OrderStatus;
    orgCode?: string;
  } = {},
): Promise<SeededOrder> {
  const qty = options.qty ?? 2;
  const unitPricePoisha = options.unitPricePoisha ?? 120_000n;
  const deliveryChargePoisha = options.deliveryChargePoisha ?? 8_000n;
  const dispatchUnitCostPoisha = options.dispatchUnitCostPoisha ?? 60_000n;
  const itemsPoisha = unitPricePoisha * BigInt(qty);
  const codAmountPoisha = itemsPoisha + deliveryChargePoisha;
  const status = options.status ?? 'shipped';

  orderSequence += 1;
  const branchId = await hqBranch(orgId);
  const locationId = await warehouse(orgId);

  return withSystem(
    async (tx) => {
      /*
       * The product number comes from the table, not from a counter in this module.
       *
       * `catalog.products` has a unique `(org_id, sequence)`, and this fixture is not the
       * only thing that writes to it: in the route-matrix suite M06's fixtures seed the same
       * org first, so a process-local counter starting at 1 collided with a product that was
       * already there. Reading the maximum makes each seeded order independent of whatever
       * else has used the table, which is what a fixture shared by two suites has to be.
       */
      const seq = await tx.execute<{ next: number }>(sql`
        select coalesce(max(sequence), 0) + 1 as next
        from catalog.products where org_id = ${orgId}
      `);
      const sequence = seq[0]?.next ?? orderSequence;

      // A SKU, through the catalog's tables directly: M06 owns its create path.
      await tx.execute(sql`
        insert into catalog.sku_settings (org_id, org_code, last_sequence)
        values (${orgId}, ${options.orgCode ?? 'CUR'}, 0)
        on conflict (org_id) do nothing
      `);
      const category = await tx.execute<{ id: string }>(sql`
        insert into catalog.categories (org_id, name, slug, code, path, depth)
        values (${orgId}, 'Courier test', 'courier-test', 'CUR', '/courier-test', 0)
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      const product = await tx.execute<{ id: string }>(sql`
        insert into catalog.products (org_id, category_id, sequence, name, slug, status)
        values (${orgId}, ${category[0]?.id ?? null}::uuid, ${sequence},
                ${`Courier product ${String(sequence)}`},
                ${`courier-product-${String(sequence)}`}, 'active')
        returning id
      `);
      const sku = await tx.execute<{ id: string }>(sql`
        insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha, status)
        values (${orgId}, ${product[0]?.id ?? null}::uuid,
                ${`CUR-${String(sequence).padStart(5, '0')}`}, ${`v${String(sequence)}`},
                ${unitPricePoisha.toString()}, 'active')
        returning id
      `);
      const skuId = sku[0]?.id ?? '';

      const district = await tx.execute<{ id: number }>(
        sql`select id from ref.districts order by id limit 1`,
      );
      const thana = await tx.execute<{ id: number }>(sql`
        select id from ref.thanas where district_id = ${district[0]?.id ?? 1} order by id limit 1
      `);

      const customer = await tx.execute<{ id: string }>(sql`
        insert into sales.customers (org_id, name, phone_e164)
        values (${orgId}, 'Rahim Uddin', ${`+88017${String(10_000_000 + sequence)}`})
        returning id
      `);
      const customerId = customer[0]?.id ?? '';
      // M48: the buyer's number, as every buyer has one.
      await tx.execute(sql`
        insert into sales.customer_phones (org_id, customer_id, phone_e164, rank, source)
        values (${orgId}, ${customerId}, ${`+88017${String(10_000_000 + sequence)}`}, 1, 'import')
      `);

      const orderNo = `CUR-2609-${String(sequence).padStart(5, '0')}`;
      const order = await tx.execute<{ id: string }>(sql`
        insert into sales.orders
          (org_id, branch_id, order_no, channel, customer_id, ship_name, ship_phone_e164,
           ship_district_id, ship_thana_id, ship_area, ship_address_line, location_id,
           items_poisha, delivery_charge_poisha, cod_amount_poisha, status, handed_over_at,
           created_by)
        values (
          ${orgId}, ${branchId}, ${orderNo}, 'phone', ${customerId}, 'Rahim Uddin',
          ${`+88017${String(10_000_000 + sequence)}`}, ${district[0]?.id ?? 1},
          ${thana[0]?.id ?? 1}, 'Niketan', 'House 12, Road 3', ${locationId},
          ${itemsPoisha.toString()}, ${deliveryChargePoisha.toString()},
          ${codAmountPoisha.toString()}, ${status}::sales.order_status,
          -- Set by §9's ship transition. Migration 0052 refuses a recorded collection
          -- without it: it is the database's evidence that the units left.
          ${SHIPPED_OR_LATER.includes(status) ? sql`now()` : sql`null`},
          'usr_courier_test'
        )
        returning id
      `);
      const orderId = order[0]?.id ?? '';

      await tx.execute(sql`
        insert into sales.order_lines
          (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
           dispatch_unit_cost_poisha)
        values (
          ${orgId}, ${orderId}, ${skuId}, ${`CUR-${String(sequence).padStart(5, '0')}`},
          ${`Courier product ${String(sequence)}`}, ${qty}, ${unitPricePoisha.toString()},
          ${dispatchUnitCostPoisha.toString()}
        )
      `);

      return {
        orderId,
        orderNo,
        customerId,
        skuId,
        locationId,
        branchId,
        codAmountPoisha,
        itemsPoisha,
        deliveryChargePoisha,
        qty,
        unitPricePoisha,
        dispatchUnitCostPoisha,
      };
    },
    { orgId },
  );
}

/** Close a month, so D-037's closed-period path can be driven (check 4). */
export async function closeMonth(orgId: string, month: string, closedBy = 'usr_courier_test') {
  const start = `${month}-01`;
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into ledger.periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
        values (
          ${orgId}, ${start}::date,
          (${start}::date + interval '1 month' - interval '1 day')::date,
          'closed', now(), ${closedBy}
        )
        on conflict (org_id, starts_on) do update set status = 'closed', closed_at = now()
      `);
    },
    { orgId },
  );
}

// --- the ports ----------------------------------------------------------------

/**
 * `LedgerReadPort`, implemented for real.
 *
 * These two queries are what the INTEGRATION notes ask `ledger.api.ts` to expose. They live
 * here rather than being faked because the second one is the COD reconciliation report's
 * outstanding column and check 5's assertion — a fake would make both meaningless.
 */
export class TestLedgerReadPort implements LedgerReadPort {
  async accountBySubtype(
    tx: Tx,
    orgId: string,
    subtype: AccountSubtype,
  ): Promise<PostingAccount | null> {
    const rows = await tx.execute<{ id: string; subtype: string; branch_id: string | null }>(sql`
      select id, subtype::text as subtype, branch_id from ledger.accounts
      where org_id = ${orgId} and subtype = ${subtype}::ledger.account_subtype and is_active
      order by code
      limit 1
    `);
    const row = rows[0];
    if (row === undefined || !isAccountSubtype(row.subtype)) return null;
    return { accountId: row.id, subtype: row.subtype, branchId: row.branch_id };
  }

  async courierReceivables(
    tx: Tx,
    orgId: string,
    asOf: string,
  ): Promise<ReadonlyMap<string, bigint>> {
    const rows = await tx.execute<{ party_id: string; debit: string; credit: string }>(sql`
      select l.party_id,
             coalesce(sum(l.debit_poisha), 0)::text as debit,
             coalesce(sum(l.credit_poisha), 0)::text as credit
      from ledger.journal_lines l
      join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
      join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${orgId}
        and a.subtype = 'courier_receivable'
        and l.party_type = 'courier'
        and j.business_date <= ${asOf}::date
      group by l.party_id
    `);
    return new Map(
      [...rows]
        .filter((row) => row.party_id !== null)
        .map((row) => [row.party_id, BigInt(row.debit) - BigInt(row.credit)]),
    );
  }
}

/** `WalletsPort`, implemented for real. This is what `wallets.api.ts` should carry. */
export class TestWalletsPort implements WalletsPort {
  async walletAccount(tx: Tx, orgId: string, walletId: string): Promise<PostingAccount | null> {
    const rows = await tx.execute<{ id: string; subtype: string; branch_id: string | null }>(sql`
      select a.id, a.subtype::text as subtype, a.branch_id
      from wallets.wallets w
      join ledger.accounts a on a.org_id = w.org_id and a.id = w.ledger_account_id
      where w.org_id = ${orgId} and w.id = ${walletId} and w.is_active and a.is_active
    `);
    const row = rows[0];
    if (row === undefined || !isAccountSubtype(row.subtype)) return null;
    if (!subtypeInfo(row.subtype).wallet) return null;
    return { accountId: row.id, subtype: row.subtype, branchId: row.branch_id };
  }
}

/**
 * `OrdersPort`, running the real state machine and posting the real journals.
 *
 * Not a stub, and the distinction is the whole reason this class is as long as it is. The
 * acceptance checks M12 has to prove are about money — a receivable that reaches exactly
 * zero, a P&L that shows the courier's charges, a duplicate webhook that does not
 * double-post — and every one of them would pass vacuously against a double that recorded a
 * call. So:
 *
 * - `applyTrigger` calls `transition()` from `@elysium/domain`, the same function
 *   `TransitionsService` calls, so an illegal move is refused the same way;
 * - a delivery posts `orderDeliveredDraft` through the real `LedgerApi`, with the real
 *   idempotency key, so the ledger's own idempotency is what stops a double post;
 * - a return posts `orderReturnDraft` the same way;
 * - the order's status column moves with a conditional UPDATE, so a second transition from a
 *   stale read loses.
 *
 * What it does **not** do is touch `inventory.*`: reserving and dispatching are M07's and the
 * courier suites never ship an order, they receive one that is already shipped. The
 * `returnReceipt` inspection is recorded on the call log instead, so the suite can assert
 * that the split reached the port — which is the contract the real adapter has to honour.
 */
export class TestOrdersPort implements OrdersPort {
  readonly calls: CourierTriggerInput[] = [];

  constructor(
    private readonly ledger: LedgerApi,
    private readonly accounts: TestLedgerReadPort,
  ) {}

  /** What the real port does: M10's table read by M10's side of the boundary. */
  async courierParties(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
  ): Promise<readonly CourierParty[]> {
    if (ids.length === 0) return [];
    const rows = await tx.execute<{ id: string; code: string; name: string }>(sql`
      select id, code, name from sales.couriers
      where org_id = ${orgId} and id = any (${sql.param([...new Set(ids)])}::uuid[])
    `);
    return [...rows];
  }

  /** What the real port does (D-913), M10's table written by the same statement. */
  async ensureCourierParty(
    tx: Tx,
    orgId: string,
    party: { readonly code: string; readonly name: string },
  ): Promise<CourierParty & { readonly created: boolean }> {
    const rows = await tx.execute<{ id: string; code: string; name: string; created: boolean }>(sql`
      insert into sales.couriers (org_id, code, name)
      values (${orgId}, ${party.code}, ${party.name})
      on conflict (org_id, code) do update set is_active = true, updated_at = now()
      returning id, code, name, (xmax = 0) as created
    `);
    const row = rows[0];
    if (row === undefined) throw new Error('sales.couriers upsert returned no row');
    return row;
  }

  async defaultCourierId(tx: Tx, orgId: string): Promise<string | null> {
    return (await this.defaultCourierState(tx, orgId)).courierId;
  }

  async defaultCourierState(
    tx: Tx,
    orgId: string,
  ): Promise<{ courierId: string | null; mixed: boolean; activeZones: number }> {
    const rows = await tx.execute<{ default_courier_id: string | null }>(sql`
      select default_courier_id from sales.delivery_zones where org_id = ${orgId} and is_active
    `);
    const named = new Set([...rows].map((row) => row.default_courier_id));
    return {
      courierId: rows.length === 0 || named.size !== 1 ? null : ([...named][0] ?? null),
      mixed: named.size > 1,
      activeZones: rows.length,
    };
  }

  async setDefaultCourier(
    tx: Tx,
    orgId: string,
    courierId: string,
  ): Promise<{
    readonly before: readonly {
      readonly zoneCode: string;
      readonly courierId: string | null;
      readonly isActive: boolean;
    }[];
  }> {
    // The zones locked, then read and written, as the real port does.
    const before = await tx.execute<{
      code: string;
      default_courier_id: string | null;
      is_active: boolean;
    }>(sql`
      select code, default_courier_id, is_active from sales.delivery_zones
      where org_id = ${orgId} order by code for update
    `);
    await tx.execute(sql`
      update sales.delivery_zones set default_courier_id = ${courierId}::uuid, updated_at = now()
      where org_id = ${orgId}
    `);
    return {
      before: [...before].map((row) => ({
        zoneCode: row.code,
        courierId: row.default_courier_id,
        isActive: row.is_active,
      })),
    };
  }

  async bookingSnapshot(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<OrderBookingSnapshot | null> {
    const rows = await tx.execute<{
      id: string;
      order_no: string;
      status: string;
      branch_id: string | null;
      location_id: string | null;
      courier_id: string | null;
      cod_amount_poisha: string;
      delivery_charge_poisha: string;
      ship_name: string;
      ship_phone_e164: string;
      ship_area: string | null;
      ship_address_line: string;
      district: string;
      thana: string;
      notes: string | null;
    }>(sql`
      select o.id, o.order_no, o.status::text as status, o.branch_id, o.location_id,
             o.courier_id, o.cod_amount_poisha::text, o.delivery_charge_poisha::text,
             o.ship_name, o.ship_phone_e164, o.ship_area, o.ship_address_line,
             d.name_en as district, t.name_en as thana, o.notes
      from sales.orders o
      join ref.districts d on d.id = o.ship_district_id
      join ref.thanas t on t.id = o.ship_thana_id
      where o.org_id = ${orgId} and o.id = ${orderId}
    `);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      orderId: row.id,
      orderNo: row.order_no,
      status: row.status as OrderStatus,
      branchId: row.branch_id,
      locationId: row.location_id,
      courierId: row.courier_id,
      codAmountPoisha: poisha(BigInt(row.cod_amount_poisha)),
      deliveryChargePoisha: poisha(BigInt(row.delivery_charge_poisha)),
      recipientName: row.ship_name,
      recipientPhoneE164: row.ship_phone_e164,
      district: row.district,
      thana: row.thana,
      area: row.ship_area,
      addressLine: row.ship_address_line,
      itemSummary: null,
      notes: row.notes,
      weightGrams: null,
    };
  }

  async summary(tx: Tx, orgId: string, orderId: string): Promise<OrderFacts | undefined> {
    const rows = await tx.execute<{
      order_no: string;
      status: string;
      branch_id: string | null;
      courier_id: string | null;
      delivery_zone_id: string | null;
      phone_e164: string;
      cod_amount_poisha: string;
    }>(sql`
      select o.order_no, o.status::text as status, o.branch_id, o.courier_id, o.delivery_zone_id,
             c.phone_e164, o.cod_amount_poisha::text
      from sales.orders o
      join sales.customers c on c.org_id = o.org_id and c.id = o.customer_id
      where o.org_id = ${orgId} and o.id = ${orderId}
    `);
    const row = rows[0];
    if (row === undefined) return undefined;
    return {
      orderNo: row.order_no,
      status: row.status as OrderStatus,
      branchId: row.branch_id,
      courierId: row.courier_id,
      deliveryZoneId: row.delivery_zone_id,
      customerPhoneE164: row.phone_e164,
      codAmountPoisha: row.cod_amount_poisha,
    };
  }

  async statusOf(tx: Tx, orgId: string, orderId: string) {
    const rows = await tx.execute<{
      status: string;
      branch_id: string | null;
      location_id: string | null;
      courier_id: string | null;
    }>(sql`
      select status::text as status, branch_id, location_id, courier_id
      from sales.orders where org_id = ${orgId} and id = ${orderId}
    `);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      status: row.status as OrderStatus,
      branchId: row.branch_id,
      locationId: row.location_id,
      courierId: row.courier_id,
    };
  }

  async returnableLines(
    tx: Tx,
    orgId: string,
    orderId: string,
  ): Promise<readonly ReturnableLine[]> {
    const rows = await tx.execute<{
      sku_id: string;
      sku_code: string;
      qty: number;
      delivered_qty: number;
      returned_qty: number;
      dispatch_unit_cost_poisha: string | null;
    }>(sql`
      select sku_id, sku_code, qty, delivered_qty, returned_qty,
             dispatch_unit_cost_poisha::text
      from sales.order_lines
      where org_id = ${orgId} and order_id = ${orderId}
      order by sku_code
    `);
    return [...rows].map((row) => ({
      skuId: row.sku_id,
      skuCode: row.sku_code,
      outstandingQty: row.qty - row.delivered_qty - row.returned_qty,
      dispatchUnitCostPoisha: poisha(BigInt(row.dispatch_unit_cost_poisha ?? '0')),
    }));
  }

  async applyTrigger(
    tx: Tx,
    context: ActiveContext,
    _request: AuditableRequest | undefined,
    input: CourierTriggerInput,
  ): Promise<AppliedTrigger | null> {
    this.calls.push(input);

    const current = await this.statusOf(tx, context.orgId, input.orderId);
    if (current === null) return null;

    // The real machine. An illegal move throws `ORDER_TRANSITION_INVALID`, exactly as it
    // would in `TransitionsService`.
    const result = transition({
      from: current.status,
      trigger: input.trigger,
      at: input.occurredAt,
      reason: input.reason ?? null,
      returnReason: input.returnReason ?? null,
      bookingPolicy: 'manual',
      parcelBooked: true,
    });

    const lines = await this.returnableLines(tx, context.orgId, input.orderId);
    const order = await this.bookingSnapshot(tx, context.orgId, input.orderId);
    if (order === null) return null;

    let journalId: string | null = null;

    if (
      result.effects.includes('post_revenue') ||
      result.effects.includes('post_partial_revenue')
    ) {
      const delivered = input.deliveredLines;
      const priced = await this.pricedLines(tx, context.orgId, input.orderId);
      const perLine = priced.map((line) => ({
        qty:
          delivered === undefined
            ? line.outstandingQty
            : (delivered.find((entry) => entry.skuId === line.skuId)?.deliveredQty ?? 0),
        unitCostPoisha: line.dispatchUnitCostPoisha,
      }));
      /*
       * Σ delivered qty × unit price. §7's "net item value of the delivered units", which for
       * a full delivery is the order's items total and for a partial one is the part that
       * arrived. Computed from the lines rather than apportioned from the COD, because
       * apportioning a total is where a rounding error would hide.
       */
      const netItems = priced.reduce(
        (total, line, index) => total + line.unitPricePoisha * BigInt(perLine[index]?.qty ?? 0),
        0n,
      );

      const collected = input.collectedPoisha ?? poisha(netItems + order.deliveryChargePoisha);
      const [receivable, revenue, deliveryIncome, cogs, git, discounts] = await Promise.all([
        this.require(tx, context.orgId, 'courier_receivable'),
        this.require(tx, context.orgId, 'sales_revenue'),
        this.require(tx, context.orgId, 'delivery_charge_income'),
        this.require(tx, context.orgId, 'cogs'),
        this.require(tx, context.orgId, 'goods_in_transit'),
        this.require(tx, context.orgId, 'sales_discounts'),
      ]);

      const posted = await this.ledger.post(
        tx,
        { orgId: context.orgId, userId: context.userId },
        orderDeliveredDraft({
          orderId: input.orderId,
          occurredAt: input.occurredAt,
          partial: result.to === 'partially_delivered',
          courierReceivable: receivable,
          courierId: current.courierId ?? randomUUID(),
          salesRevenue: revenue,
          deliveryIncome,
          cogs,
          goodsInTransit: git,
          salesDiscounts: discounts,
          netItemsPoisha: poisha(netItems),
          deliveryChargePoisha: order.deliveryChargePoisha,
          advanceAppliedPoisha: poisha(0),
          collectedPoisha: collected,
          costPoisha: dispatchValue(perLine),
          differenceReason: 'Courier reported a different collection.',
          branchId: order.branchId,
          memo: null,
        }),
      );
      journalId = posted.journalId;

      await tx.execute(sql`
        update sales.order_lines set delivered_qty = qty
        where org_id = ${context.orgId} and order_id = ${input.orderId}
      `);
    }

    if (result.effects.includes('post_return')) {
      const receipt = input.returnReceipt;
      const value = lines.reduce((total, line) => {
        const back =
          receipt === undefined
            ? line.outstandingQty
            : (receipt.lines.find((entry) => entry.skuId === line.skuId)?.sellableQty ?? 0) +
              (receipt.lines.find((entry) => entry.skuId === line.skuId)?.damagedQty ?? 0);
        return total + line.dispatchUnitCostPoisha * BigInt(back);
      }, 0n);

      if (value > 0n) {
        const [inventory, git] = await Promise.all([
          this.require(tx, context.orgId, 'inventory'),
          this.require(tx, context.orgId, 'goods_in_transit'),
        ]);
        const posted = await this.ledger.post(
          tx,
          { orgId: context.orgId, userId: context.userId },
          orderReturnDraft({
            orderId: input.orderId,
            occurredAt: input.occurredAt,
            inventory,
            goodsInTransit: git,
            valuePoisha: poisha(value),
            branchId: order.branchId,
            memo: null,
          }),
        );
        journalId = posted.journalId;
      }

      await tx.execute(sql`
        update sales.order_lines set returned_qty = qty - delivered_qty
        where org_id = ${context.orgId} and order_id = ${input.orderId}
      `);
    }

    const moved = await tx.execute<{ id: string }>(sql`
      update sales.orders set status = ${result.to}::sales.order_status, updated_at = now()
      where org_id = ${context.orgId} and id = ${input.orderId}
        and status = ${current.status}::sales.order_status
      returning id
    `);
    if (moved.length === 0) return null;

    // M17 (D-234): a return records its reason, as `TransitionsService` does. Migration 0088's
    // deferred trigger refuses the commit without it, so the double has to keep up.
    if (result.returnReason !== null) {
      await tx.execute(sql`
        insert into sales.order_returns
          (org_id, order_id, kind, reason_code, note, business_date, recorded_by)
        values (${context.orgId}, ${input.orderId}, 'return', ${result.returnReason},
                ${result.reason}, ${result.businessDate}::date, ${context.userId})
      `);
    }

    return {
      from: current.status,
      to: result.to,
      businessDate: businessDate(input.occurredAt),
      journalId,
    };
  }

  /** Lines with their selling price, for the delivery journal's revenue side. */
  private async pricedLines(tx: Tx, orgId: string, orderId: string) {
    const rows = await tx.execute<{
      sku_id: string;
      qty: number;
      delivered_qty: number;
      returned_qty: number;
      unit_price_poisha: string;
      dispatch_unit_cost_poisha: string | null;
    }>(sql`
      select sku_id, qty, delivered_qty, returned_qty, unit_price_poisha::text,
             dispatch_unit_cost_poisha::text
      from sales.order_lines
      where org_id = ${orgId} and order_id = ${orderId}
      order by sku_code
    `);
    return [...rows].map((row) => ({
      skuId: row.sku_id,
      outstandingQty: row.qty - row.delivered_qty - row.returned_qty,
      unitPricePoisha: BigInt(row.unit_price_poisha),
      dispatchUnitCostPoisha: poisha(BigInt(row.dispatch_unit_cost_poisha ?? '0')),
    }));
  }

  private async require(tx: Tx, orgId: string, subtype: AccountSubtype): Promise<PostingAccount> {
    const account = await this.accounts.accountBySubtype(tx, orgId, subtype);
    if (account === null) throw new Error(`the seeded chart has no ${subtype} account`);
    return account;
  }
}

/** A statement, as the CSV `parseCsvStatement` reads (§9's settlement import). */
export function statementCsv(
  rows: readonly {
    consignmentNo: string;
    invoice?: string;
    cod: string;
    delivery?: string;
    ret?: string;
    other?: string;
    net?: string;
  }[],
): Buffer {
  const header =
    'consignment_id,invoice,cod_amount,delivery_charge,return_charge,other_charge,net_amount';
  const body = rows.map((row) =>
    [
      row.consignmentNo,
      row.invoice ?? '',
      row.cod,
      row.delivery ?? '0',
      row.ret ?? '0',
      row.other ?? '0',
      row.net ?? '',
    ].join(','),
  );
  return Buffer.from([header, ...body].join('\n'), 'utf8');
}

/** Taka, as a statement column. Poisha in, a two-decimal string out. */
export function taka(amount: bigint | Poisha): string {
  const raw: bigint = amount;
  const negative = raw < 0n;
  const magnitude = negative ? -raw : raw;
  return `${negative ? '-' : ''}${(magnitude / 100n).toString()}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}
