import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SEED_ORG_IDS, seedDeliveryZones, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { applyInventoryMigrations } from '../inventory/inventory.testing.js';

/**
 * Test-only setup for the order suites.
 *
 * `packages/db/migrations/meta/_journal.json` is edited by several milestones at once, so
 * M10's six files are handed to the integrator as INTEGRATION lines instead of appended
 * here — and until they are, `startTestDatabase()`'s `migrate()` does not run them. M06's
 * catalog and M07's inventory migrations come first, because every order line points at
 * `catalog.skus` and every reservation goes through `inventory.*`;
 * `applyInventoryMigrations` is M07's own helper and is idempotent.
 *
 * Nothing here seeds a chart of accounts. `startTestDatabase()` runs the real seed, which
 * gives every org D-084's 40 system accounts — `courier_receivable`, `sales_revenue`,
 * `delivery_charge_income`, `cogs`, `goods_in_transit`, `customer_advance` and
 * `sales_discounts` among them. A fixture that invented its own accounts would be testing
 * a chart production does not have.
 *
 * ## Two kinds of fixture, and why both exist
 *
 * `seedStockLevel` and `seedOrder` write rows **directly**, at a chosen status, with a
 * chosen cost. They are for suites whose question is not "does the flow work" — the
 * route-matrix suite needs an order in every one of eleven statuses and needs it cheaply,
 * and driving each one through confirm, pack, ship and deliver would make that suite an
 * order-flow test with a permission assertion at the end.
 *
 * The books tests do the opposite: they go through `INVENTORY_API` and the real
 * transitions, because their question *is* whether the flow leaves the ledger and the
 * shelf in agreement. A direct fixture there would prove only that the fixture balances.
 */

/** The DDL, applied only when the `sales` schema is not there yet. */
const SCHEMA_MIGRATIONS = [
  '0039_orders_schema.sql',
  '0040_orders_policies.sql',
  '0041_orders_integrity.sql',
  '0042_orders_delivery_zone_defaults.sql',
  '0043_orders_search.sql',
] as const;

/**
 * Applied every time, because both are idempotent and one of them may be missing from a
 * database whose journal was integrated before this milestone's last file existed.
 *
 * That is not hypothetical: the journal is edited by the integrator, so a test database can
 * legitimately have 0039-0043 applied by `migrate()` and not 0044 — and a `sales`-schema
 * check would then skip the grant that lets an order's lines be edited, failing one suite
 * with a permission error from PostgreSQL three layers down.
 */
const REPEATABLE_MIGRATIONS = ['0044_orders_line_edit.sql'] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the repository
  // root as cwd, but a suite run from `apps/server` must find the same files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

async function apply(directory: string, name: string): Promise<void> {
  const contents = await readFile(path.join(directory, name), 'utf8');
  // The same separator the real migrator splits on. Comment-only fragments are valid no-op
  // statements, so they need no filtering.
  for (const statement of contents.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed === '') continue;
    await withSystem(async (tx) => {
      await tx.execute(sql.raw(trimmed));
    });
  }
}

export async function applyOrderMigrations(): Promise<void> {
  await applyInventoryMigrations();

  const directory = migrationsDir();
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('sales') is not null as present`,
    );
    return rows[0]?.present === true;
  });

  if (!already) {
    for (const name of SCHEMA_MIGRATIONS) await apply(directory, name);
  }
  for (const name of REPEATABLE_MIGRATIONS) await apply(directory, name);

  /*
   * M11's two desk indexes (0064), guarded on the index itself: the file is plain
   * `CREATE INDEX`, which a second run would refuse, and until the integrator registers it
   * in the journal the test database's own migrator has not run it.
   */
  const deskIndexed = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regclass('sales.orders_org_phone_created_idx') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (!deskIndexed) await apply(directory, '0064_orders_desk_indexes.sql');

  /*
   * The zones and the own-rider courier, in case the seed that owns them predates them.
   *
   * `seedDeliveryZones` is idempotent and is what `seedOrganizations` calls, so this is a
   * no-op on a current database. It is here because migration 0042 writes nothing on a
   * fresh one — there are no organizations to loop over when migrations run — and a suite
   * that failed for that reason would look like a broken delivery journal rather than a
   * missing fixture.
   */
  await seedDeliveryZones(Object.values(SEED_ORG_IDS));
}

/**
 * Units on a shelf, with a weighted average, written directly.
 *
 * The `opening_balance` movement goes in beside the level on purpose: invariant 3 says a
 * level equals Σ its movements, M07's reconciliation job checks exactly that, and a
 * fixture that set a level without a movement would leave every later suite in the run
 * looking at injected drift.
 */
export async function seedStockLevel(
  orgId: string,
  input: {
    readonly skuId: string;
    readonly locationId: string;
    readonly qty: number;
    readonly unitCostPoisha: bigint;
  },
): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into inventory.stock_levels (org_id, sku_id, location_id, on_hand)
        values (${orgId}, ${input.skuId}, ${input.locationId}, ${input.qty})
        on conflict (org_id, sku_id, location_id)
          do update set on_hand = inventory.stock_levels.on_hand + ${input.qty},
                        updated_at = now()
      `);
      await tx.execute(sql`
        insert into inventory.sku_costs (org_id, sku_id, wac_poisha, qty_basis)
        values (${orgId}, ${input.skuId}, ${input.unitCostPoisha.toString()}::bigint, ${input.qty})
        on conflict (org_id, sku_id)
          do update set wac_poisha = ${input.unitCostPoisha.toString()}::bigint,
                        qty_basis = inventory.sku_costs.qty_basis + ${input.qty},
                        updated_at = now()
      `);
      await tx.execute(sql`
        insert into inventory.stock_movements
          (org_id, sku_id, location_id, kind, qty_delta, unit_cost_poisha, ref_type,
           business_date, created_by, created_txid)
        values (${orgId}, ${input.skuId}, ${input.locationId}, 'opening_balance', ${input.qty},
                ${input.unitCostPoisha.toString()}::bigint, 'fixture',
                (now() at time zone 'Asia/Dhaka')::date, 'usr_orders_fixture',
                pg_current_xact_id())
      `);
    },
    { orgId },
  );
}

export interface SeedOrderLine {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly qty: number;
  readonly unitPricePoisha: bigint;
  readonly discountPoisha?: bigint;
  /** Set for an order already shipped: what the dispatch movement recorded. */
  readonly dispatchUnitCostPoisha?: bigint;
  readonly deliveredQty?: number;
  readonly returnedQty?: number;
}

export interface SeedOrderInput {
  readonly status: string;
  readonly customerId: string;
  readonly lines: readonly SeedOrderLine[];
  readonly createdBy?: string;
  readonly assignedTo?: string | null;
  readonly branchId?: string | null;
  readonly locationId?: string | null;
  readonly courierId?: string | null;
  readonly deliveryChargePoisha?: bigint;
  readonly advancePaidPoisha?: bigint;
  readonly discountPoisha?: bigint;
  /** Hold the units, as a `confirmed` order really would (§9). */
  readonly reserve?: boolean;
}

let sequence = 40_000;

/**
 * One order, at any status, with its lines.
 *
 * The status is written on the INSERT rather than reached by transitions: 0041's trigger
 * guards `UPDATE OF status`, so an insert at `shipped` is legal and an update into it from
 * the wrong status is not — which is exactly the asymmetry a fixture wants and a
 * production path must not have.
 *
 * `reserve` also bumps `stock_levels.reserved` and writes the reservation row, because a
 * `confirmed` order that holds nothing would let the ship transition drive `reserved`
 * negative and be refused by a CHECK, three layers from the fixture that caused it.
 */
export async function seedOrder(
  orgId: string,
  input: SeedOrderInput,
): Promise<{ id: string; orderNo: string }> {
  sequence += 1;
  const orderNo = `TST-2609-${String(sequence).padStart(5, '0')}`;
  const items = input.lines.reduce(
    (total, line) => total + line.unitPricePoisha * BigInt(line.qty),
    0n,
  );
  const lineDiscounts = input.lines.reduce(
    (total, line) => total + (line.discountPoisha ?? 0n),
    0n,
  );
  const discount = lineDiscounts + (input.discountPoisha ?? 0n);
  const delivery = input.deliveryChargePoisha ?? 6000n;
  const advance = input.advancePaidPoisha ?? 0n;
  const cod = items - discount + delivery - advance;

  return withSystem(
    async (tx) => {
      const area = await tx.execute<{ district_id: number; thana_id: number }>(sql`
        select t.district_id, t.id as thana_id from ref.thanas t order by t.id limit 1
      `);
      const districtId = area[0]?.district_id ?? 1;
      const thanaId = area[0]?.thana_id ?? 1;

      const rows = await tx.execute<{ id: string }>(sql`
        insert into sales.orders (
          org_id, branch_id, order_no, channel, customer_id,
          ship_name, ship_phone_e164, ship_district_id, ship_thana_id, ship_address_line,
          courier_id, location_id,
          items_poisha, discount_poisha, delivery_charge_poisha, advance_paid_poisha,
          cod_amount_poisha, status, assigned_to, created_by
        ) values (
          ${orgId}, ${input.branchId ?? null}::uuid, ${orderNo}, 'phone', ${input.customerId},
          'Fixture Buyer', '+8801711000000', ${districtId}, ${thanaId}, 'House 1, Road 1, Dhaka',
          ${input.courierId ?? null}::uuid, ${input.locationId ?? null}::uuid,
          ${items.toString()}::bigint, ${discount.toString()}::bigint,
          ${delivery.toString()}::bigint, ${advance.toString()}::bigint,
          ${cod.toString()}::bigint, ${input.status}::sales.order_status,
          ${input.assignedTo ?? null}, ${input.createdBy ?? 'usr_orders_fixture'}
        )
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('seeding an order returned no id');

      for (const [index, line] of input.lines.entries()) {
        await tx.execute(sql`
          insert into sales.order_lines
            (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
             discount_poisha, delivered_qty, returned_qty, dispatch_unit_cost_poisha, position)
          values (${orgId}, ${id}, ${line.skuId}, ${line.skuCode}, ${line.productName},
                  ${line.qty}, ${line.unitPricePoisha.toString()}::bigint,
                  ${(line.discountPoisha ?? 0n).toString()}::bigint,
                  ${line.deliveredQty ?? 0}, ${line.returnedQty ?? 0},
                  ${line.dispatchUnitCostPoisha === undefined ? null : line.dispatchUnitCostPoisha.toString()}::bigint,
                  ${index})
        `);
      }

      if (input.reserve === true && input.locationId != null) {
        for (const line of input.lines) {
          await tx.execute(sql`
            update inventory.stock_levels set reserved = reserved + ${line.qty}, updated_at = now()
            where org_id = ${orgId} and sku_id = ${line.skuId} and location_id = ${input.locationId}
          `);
          await tx.execute(sql`
            insert into inventory.reservations
              (org_id, sku_id, location_id, qty, ref_type, ref_id, created_by)
            values (${orgId}, ${line.skuId}, ${input.locationId}, ${line.qty}, 'order', ${id},
                    'usr_orders_fixture')
          `);
        }
      }

      return { id, orderNo };
    },
    { orgId },
  );
}

/** A buyer with a default address, written directly. */
export async function seedCustomer(
  orgId: string,
  input: { readonly phoneE164: string; readonly name: string },
): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into sales.customers (org_id, phone_e164, name)
        values (${orgId}, ${input.phoneE164}, ${input.name})
        on conflict (org_id, phone_e164) do update set name = excluded.name
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('seeding a customer returned no id');

      const area = await tx.execute<{ district_id: number; thana_id: number }>(sql`
        select t.district_id, t.id as thana_id from ref.thanas t order by t.id limit 1
      `);
      await tx.execute(sql`
        insert into sales.customer_addresses
          (org_id, customer_id, district_id, thana_id, address_line, is_default)
        values (${orgId}, ${id}, ${area[0]?.district_id ?? 1}, ${area[0]?.thana_id ?? 1},
                'House 1, Road 1, Dhaka', true)
        on conflict do nothing
      `);
      return id;
    },
    { orgId },
  );
}

/** The org's own-rider courier, seeded by migration 0042. */
export async function ownRiderCourier(orgId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from sales.couriers where org_id = ${orgId} and code = 'own_rider'
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('migration 0042 seeded no own_rider courier');
      return id;
    },
    { orgId },
  );
}

/** The org's `wallet_bkash` ledger account, for an advance. */
export async function walletAccount(orgId: string, subtype = 'wallet_bkash'): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from ledger.accounts
        where org_id = ${orgId} and subtype = ${subtype}::ledger.account_subtype and is_active
        order by code limit 1
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error(`the seeded chart has no ${subtype} account`);
      return id;
    },
    { orgId },
  );
}

/** Balances per account subtype, for the golden-books assertions. */
export async function balancesBySubtype(orgId: string): Promise<Map<string, bigint>> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ subtype: string; debit: string; credit: string }>(sql`
        select a.subtype::text as subtype,
               coalesce(sum(l.debit_poisha), 0)::text as debit,
               coalesce(sum(l.credit_poisha), 0)::text as credit
        from ledger.journal_lines l
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${orgId}
        group by a.subtype
      `),
    { orgId },
  );
  const balances = new Map<string, bigint>();
  for (const row of rows) {
    // Debit minus credit, so an asset or an expense is positive and a liability, equity or
    // income is negative. One sign convention across every assertion beats remembering
    // which way each account leans.
    balances.set(row.subtype, BigInt(row.debit) - BigInt(row.credit));
  }
  return balances;
}

/** Σ debits − Σ credits across every journal line: zero, or the books are broken. */
export async function trialBalanceDifference(orgId: string): Promise<bigint> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ debit: string; credit: string }>(sql`
        select coalesce(sum(debit_poisha), 0)::text as debit,
               coalesce(sum(credit_poisha), 0)::text as credit
        from ledger.journal_lines where org_id = ${orgId}
      `),
    { orgId },
  );
  const row = rows[0];
  return row === undefined ? 0n : BigInt(row.debit) - BigInt(row.credit);
}

/** On hand and reserved for one SKU at one location. */
export async function stockAt(
  orgId: string,
  skuId: string,
  locationId: string,
): Promise<{ onHand: number; reserved: number }> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ on_hand: number; reserved: number }>(sql`
        select on_hand, reserved from inventory.stock_levels
        where org_id = ${orgId} and sku_id = ${skuId} and location_id = ${locationId}
      `),
    { orgId },
  );
  const row = rows[0];
  return { onHand: row?.on_hand ?? 0, reserved: row?.reserved ?? 0 };
}
