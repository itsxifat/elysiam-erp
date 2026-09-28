import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  ORG_A,
  ORG_B,
  expectRefused,
  startHttpHarness,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import {
  makeLocation,
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { ORDERS_API, type OrdersApi } from './orders.api.js';
import { OrdersModule } from './orders.module.js';
import { OrdersService } from './orders.service.js';
import {
  applyOrderMigrations,
  balancesBySubtype,
  ownRiderCourier,
  seedCustomer,
  stockAt,
  trialBalanceDifference,
} from './orders.testing.js';

/**
 * Orders against a real database (M10 acceptance checks 2, 4, 5 and 7).
 *
 * The four things this suite exists to prove, in the order they matter:
 *
 * 1. **Check 2 — concurrent confirms never oversell.** Five orders for the last three
 *    units, confirmed in five independent transactions against the real pool. The
 *    read-then-write version of a reservation passes every single-threaded test and fails
 *    this one, and that asymmetry is the whole reason the check is written this way. It
 *    also asserts what the losers' orders look like afterwards: still `pending`, because a
 *    confirm whose reservation failed must roll back the status too.
 * 2. **Check 4 — golden books.** Supply, three orders, ship all three, deliver two,
 *    return one, against hand-computed numbers written out in the test. Every figure is
 *    read back from `ledger.journal_lines` and `inventory.stock_levels`, not from what the
 *    service returned, and the trial balance is asserted at zero.
 * 3. **Check 5 — a partial delivery posts only the delivered lines**, and a collection
 *    that differs from the door price goes to Sales discounts with its reason (§7). Then
 *    the undelivered unit comes back and goods in transit returns to zero, which is the
 *    part a "revenue is 200000" assertion alone would not catch.
 * 4. **Check 7 — an exchange** puts the original units back at their dispatch cost,
 *    reverses the sale into a customer credit, and leaves the trial balance at zero once
 *    the replacement has been delivered.
 *
 * ## Why each scenario gets its own org
 *
 * The ledger assertions are Σ over `ledger.journal_lines` for an org, so two scenarios in
 * one org would each be asserting the other's postings as well. Five seeded orgs exist and
 * they are genuinely isolated (§5), so each scenario takes one — which also means every
 * one of these tests is, incidentally, a tenancy test: a figure that came out wrong
 * because another org's journal leaked in would fail here first.
 */

const ORG_GOLDEN = SEED_ORG_IDS.orvo ?? '';
const ORG_EXCHANGE = SEED_ORG_IDS['wear-x-clothing'] ?? '';
const ORG_PARTIAL = SEED_ORG_IDS.beownz ?? '';
// Its own brand: these balances are org-wide totals, and check 5 leaves a Sales discounts
// debit in `beownz` that would otherwise read as this test's own.
const ORG_PREPAID = SEED_ORG_IDS['oura-lifestyle'] ?? '';

const SYSTEM_USER = 'usr_orders_db_test';

let harness: HttpHarness;
let orders: OrdersService;
let inventory: InventoryApi;

beforeAll(async () => {
  harness = await startHttpHarness('orders-db', { extraModules: [OrdersModule] });
  await applyOrderMigrations();
  orders = harness.app.get(OrdersService);
  inventory = harness.app.get<InventoryApi>(INVENTORY_API);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- calling the service without an HTTP request ------------------------------

/**
 * A context and a request as the guard would have left them.
 *
 * `attachScope(..., { kind: 'all' })` is what an org-wide caller's request carries, and it
 * is what `scopeWhere` and `assertInScope` read. Faking it rather than driving HTTP is
 * right for this suite: what is under test is the money and the stock, and §6 is tested
 * through the real pipeline in `orders.e2e.test.ts`.
 */
function request(): AuditableRequest {
  const value = {} as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

function context(orgId: string, userId = SYSTEM_USER): ActiveContext {
  return {
    orgId,
    userId,
    isSuperAdmin: false,
    // Deliberately not `sales`: `orderScopeSql` widens a sales caller to the unassigned
    // queue, and a books test should not be reading rows for a reason it did not choose.
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: 'orders-db-test',
  };
}

interface Scene {
  readonly orgId: string;
  readonly location: string;
  readonly customerId: string;
  readonly courierId: string;
  readonly skus: readonly SeededSku[];
}

async function scene(orgId: string, slug: string, skuCount: number): Promise<Scene> {
  const { skus } = await seedProductWithSkus(orgId, slug, skuCount);
  return {
    orgId,
    location: await warehouseId(orgId),
    customerId: await seedCustomer(orgId, {
      phoneE164: '+8801712345678',
      name: 'Afsana Rahman',
    }),
    courierId: await ownRiderCourier(orgId),
    skus,
  };
}

/** A supply receipt through `INVENTORY_API`: the only way purchase cost enters (§8). */
async function receive(
  place: Scene,
  skuId: string,
  qty: number,
  unitCostPoisha: bigint,
): Promise<void> {
  const actor = { orgId: place.orgId, userId: SYSTEM_USER };
  await withOrg(actor, (tx) =>
    inventory.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: place.location,
      branchId: null,
      occurredAt: new Date(),
      lines: [{ skuId, qty, unitCostPoisha: poisha(unitCostPoisha) }],
    }),
  );
}

async function takeOrder(
  place: Scene,
  lines: readonly { skuId: string; qty: number; unitPricePoisha: string }[],
  deliveryChargePoisha = '6000',
): Promise<string> {
  const created = await orders.create(context(place.orgId), request(), {
    channel: 'phone',
    customerId: place.customerId,
    locationId: place.location,
    courierId: place.courierId,
    deliveryChargePoisha,
    lines: [...lines],
  });
  return created.id;
}

async function statusOf(orgId: string, orderId: string): Promise<string> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ status: string }>(sql`
        select status::text as status from sales.orders where org_id = ${orgId} and id = ${orderId}
      `),
    { orgId },
  );
  return rows[0]?.status ?? 'missing';
}

async function lineOf(
  orgId: string,
  orderId: string,
  skuId: string,
): Promise<{ delivered: number; returned: number; dispatchCost: string | null }> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ delivered_qty: number; returned_qty: number; dispatch: string | null }>(sql`
        select delivered_qty, returned_qty, dispatch_unit_cost_poisha as dispatch
        from sales.order_lines
        where org_id = ${orgId} and order_id = ${orderId} and sku_id = ${skuId}
      `),
    { orgId },
  );
  const row = rows[0];
  return {
    delivered: row?.delivered_qty ?? -1,
    returned: row?.returned_qty ?? -1,
    dispatchCost: row?.dispatch ?? null,
  };
}

function balance(balances: Map<string, bigint>, subtype: string): bigint {
  return balances.get(subtype) ?? 0n;
}

// --- check 2: concurrency ------------------------------------------------------

describe('check 2: concurrent confirms on scarce stock', () => {
  it('reserves the last three units exactly three times, and leaves the losers pending', async () => {
    const place = await scene(ORG_A, 'ordersrace', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 3, 40_000n);

    const orderIds = await Promise.all(
      Array.from({ length: 5 }, () =>
        takeOrder(place, [{ skuId: target, qty: 1, unitPricePoisha: '150000' }]),
      ),
    );

    /*
     * Five independent transactions, started together.
     *
     * `orders.confirm` opens its own `withOrg`, so each takes a connection from the real
     * pool and the conditional UPDATE in `InventoryApi.reserve` genuinely contends for one
     * `stock_levels` row. A lost update would report five successes and hold three.
     */
    const outcomes = await Promise.all(
      orderIds.map((id) =>
        orders.confirm(context(place.orgId), request(), id, {}).then(
          () => 'confirmed' as const,
          () => 'refused' as const,
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'confirmed')).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(2);

    // Never oversold: three held out of three on hand, and not a unit more.
    expect(await stockAt(place.orgId, target, place.location)).toEqual({ onHand: 3, reserved: 3 });

    const statuses = await Promise.all(orderIds.map((id) => statusOf(place.orgId, id)));
    expect(statuses.filter((status) => status === 'confirmed')).toHaveLength(3);
    // The rollback is the assertion: a confirm that could not reserve must leave the order
    // exactly as it was, or the desk sees a confirmed order the warehouse cannot pick.
    expect(statuses.filter((status) => status === 'pending')).toHaveLength(2);

    const held = await withOrg({ orgId: place.orgId, userId: SYSTEM_USER }, async (tx) => {
      const rows = await tx.execute<{ total: string }>(sql`
        select count(*)::text as total from inventory.reservations
        where org_id = ${place.orgId} and sku_id = ${target} and status = 'active'
      `);
      return Number(rows[0]?.total ?? '0');
    });
    expect(held).toBe(3);
  }, 180_000);
});

// --- check 4: golden books -----------------------------------------------------

describe('check 4: supply → 3 orders → ship all → 2 delivered, 1 returned', () => {
  /*
   * The scenario, computed by hand in poisha:
   *
   *   supply        10 units @ 40,000     Dr Inventory 400,000 / Cr Supplier payable 400,000
   *   3 orders      2 units @ 150,000 each, delivery 6,000 → COD 306,000 each
   *   ship × 3      2 × 40,000 = 80,000 each  Dr Goods in transit / Cr Inventory
   *   deliver × 2   Dr Courier receivable 306,000
   *                   Cr Sales revenue 300,000, Cr Delivery income 6,000
   *                 Dr COGS 80,000 / Cr Goods in transit 80,000
   *   return × 1    Dr Inventory 80,000 / Cr Goods in transit 80,000
   *
   * Expected closing balances (debit − credit):
   *
   *   inventory              400,000 − 240,000 + 80,000 =  240,000
   *   supplier payable                              = −400,000
   *   goods in transit  240,000 − 160,000 − 80,000  =        0
   *   courier receivable          2 × 306,000       =  612,000
   *   sales revenue               2 × 300,000       = −600,000
   *   delivery income             2 ×   6,000       =  −12,000
   *   COGS                        2 ×  80,000       =  160,000
   *                                                   ────────
   *                                                          0
   *
   * Stock: 10 received − 6 dispatched + 2 returned = 6 on hand, nothing reserved, and
   * 6 × 40,000 = 240,000 — the same figure as the inventory account, which is the
   * cross-check that matters most: the shelf and the books are two independent records of
   * one fact, and §7 is only true if they agree to the poisha.
   */
  it('matches the hand-computed trial balance, stock and P&L', async () => {
    const place = await scene(ORG_GOLDEN, 'goldenbooks', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 10, 40_000n);

    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      ids.push(await takeOrder(place, [{ skuId: target, qty: 2, unitPricePoisha: '150000' }]));
    }

    for (const id of ids) {
      await orders.confirm(context(place.orgId), request(), id, {});
    }
    expect(await stockAt(place.orgId, target, place.location)).toEqual({ onHand: 10, reserved: 6 });

    for (const id of ids) {
      await orders.transition(context(place.orgId), request(), id, 'ship', {
        courierId: place.courierId,
      });
    }
    expect(await stockAt(place.orgId, target, place.location)).toEqual({ onHand: 4, reserved: 0 });
    // The dispatch cost is written on the line, and it is what both the delivery and the
    // return journal must use — see `TransitionsService.dispatch`.
    expect((await lineOf(place.orgId, ids[0] ?? '', target)).dispatchCost).toBe('40000');

    for (const id of ids.slice(0, 2)) {
      await orders.transition(context(place.orgId), request(), id, 'deliver');
    }

    const returned = ids[2] ?? '';
    await orders.transition(context(place.orgId), request(), returned, 'start_return', {
      reason: 'Buyer refused the parcel',
    });
    await orders.transition(context(place.orgId), request(), returned, 'receive_return', {
      reason: 'Came back sealed',
      ret: { reason: 'Came back sealed', locationId: place.location },
    });

    expect(await statusOf(place.orgId, ids[0] ?? '')).toBe('delivered');
    expect(await statusOf(place.orgId, returned)).toBe('returned');

    const balances = await balancesBySubtype(place.orgId);
    expect(balance(balances, 'inventory')).toBe(240_000n);
    expect(balance(balances, 'supplier_payable')).toBe(-400_000n);
    expect(balance(balances, 'goods_in_transit')).toBe(0n);
    expect(balance(balances, 'courier_receivable')).toBe(612_000n);
    expect(balance(balances, 'sales_revenue')).toBe(-600_000n);
    expect(balance(balances, 'delivery_charge_income')).toBe(-12_000n);
    expect(balance(balances, 'cogs')).toBe(160_000n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);

    const stock = await stockAt(place.orgId, target, place.location);
    expect(stock).toEqual({ onHand: 6, reserved: 0 });
    // The shelf, valued at the average, equals the inventory account.
    expect(BigInt(stock.onHand) * 40_000n).toBe(balance(balances, 'inventory'));

    // The P&L, from the same balances: revenue + delivery income − COGS.
    const revenue = -balance(balances, 'sales_revenue');
    const deliveryIncome = -balance(balances, 'delivery_charge_income');
    const cogs = balance(balances, 'cogs');
    expect(revenue).toBe(600_000n);
    expect(deliveryIncome).toBe(12_000n);
    expect(cogs).toBe(160_000n);
    expect(revenue + deliveryIncome - cogs).toBe(452_000n);
  }, 240_000);
});

// --- check 5: partial delivery -------------------------------------------------

describe('check 5: a partial delivery', () => {
  /*
   * One order of three units at 100,000 with a 5,000 delivery charge. Two units arrive and
   * the rider collects 200,000 — 5,000 short, because they waived the delivery charge at
   * the door. Hand-computed:
   *
   *   supply         10 @ 40,000            Dr Inventory 400,000 / Cr Payable 400,000
   *   ship            3 × 40,000 = 120,000  Dr Goods in transit / Cr Inventory
   *   partial        Dr Courier receivable 200,000
   *                  Dr Sales discounts       5,000
   *                    Cr Sales revenue     200,000   ← the delivered two units only
   *                    Cr Delivery income     5,000   ← whole: the van went once
   *                  Dr COGS 80,000 / Cr Goods in transit 80,000
   *   return          the third unit back at 40,000  Dr Inventory / Cr Goods in transit
   *
   * Revenue is 200,000 and not 300,000, COGS is 80,000 and not 120,000, and goods in
   * transit ends at zero — which is what proves the undelivered unit was accounted for
   * rather than left somewhere.
   */
  it('posts only the delivered lines and sends the collection difference to Sales discounts', async () => {
    const place = await scene(ORG_PARTIAL, 'partialdelivery', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 10, 40_000n);

    const id = await takeOrder(
      place,
      [{ skuId: target, qty: 3, unitPricePoisha: '100000' }],
      '5000',
    );
    await orders.confirm(context(place.orgId), request(), id, {});
    await orders.transition(context(place.orgId), request(), id, 'ship', {
      courierId: place.courierId,
    });

    await orders.transition(context(place.orgId), request(), id, 'deliver_partially', {
      deliver: {
        lines: [{ skuId: target, deliveredQty: 2 }],
        collectedPoisha: '200000',
        differenceReason: 'Rider waived the delivery charge at the door',
      },
    });

    expect(await statusOf(place.orgId, id)).toBe('partially_delivered');
    expect(await lineOf(place.orgId, id, target)).toMatchObject({ delivered: 2 });

    const midway = await balancesBySubtype(place.orgId);
    expect(balance(midway, 'sales_revenue')).toBe(-200_000n);
    expect(balance(midway, 'delivery_charge_income')).toBe(-5_000n);
    expect(balance(midway, 'sales_discounts')).toBe(5_000n);
    expect(balance(midway, 'cogs')).toBe(80_000n);
    expect(balance(midway, 'courier_receivable')).toBe(200_000n);
    // One unit still with the courier, at its dispatch cost.
    expect(balance(midway, 'goods_in_transit')).toBe(40_000n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);

    // §7 asks for a reason on the difference, and this is where it survives.
    const memo = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ memo: string | null }>(sql`
          select l.memo from ledger.journal_lines l
          join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
          where l.org_id = ${place.orgId} and a.subtype = 'sales_discounts'
        `);
        return rows[0]?.memo ?? null;
      },
      { orgId: place.orgId },
    );
    expect(memo).toBe('Rider waived the delivery charge at the door');

    await orders.transition(context(place.orgId), request(), id, 'receive_return', {
      reason: 'The third piece came back',
      ret: { reason: 'The third piece came back', locationId: place.location },
    });

    const closing = await balancesBySubtype(place.orgId);
    expect(balance(closing, 'goods_in_transit')).toBe(0n);
    expect(balance(closing, 'inventory')).toBe(400_000n - 120_000n + 40_000n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
    expect(await stockAt(place.orgId, target, place.location)).toEqual({ onHand: 8, reserved: 0 });
    expect(await lineOf(place.orgId, id, target)).toMatchObject({ delivered: 2, returned: 1 });
  }, 240_000);
});

// --- a prepaid parcel that arrives in part (ledger audit, 2026-09-26) ---------

describe('a partial delivery of a mostly-prepaid order', () => {
  /*
   * The advance applied is capped at what the delivery earned.
   *
   * Applying the whole prepayment was wrong in both directions. Two units at 50,000 with a
   * 6,000 charge is 106,000 payable; pay it all in advance and have one unit delivered,
   * and the delivery earns 50,000 + 6,000 = 56,000. The old code applied all 106,000, so
   * `orderDeliveredDraft` saw 50,000 more money than the delivery was worth and **credited
   * Sales discounts** with the difference — extinguishing a liability the brand still owed
   * and booking the buyer's own money as income. Debits equalled credits, the trial balance
   * stayed at zero, and no report could show it.
   *
   * The other branch was no better: leaving `collectedPoisha` out made the default
   * collection negative and the transition was refused outright — so a mostly-prepaid
   * parcel that arrived in part could not be recorded correctly by any route.
   *
   * Hand-computed, after the fix:
   *
   *   advance        Dr Wallet 106,000 / Cr Customer advance 106,000
   *   ship           2 × 40,000 = 80,000   Dr Goods in transit / Cr Inventory
   *   partial        Dr Customer advance 56,000
   *                    Cr Sales revenue    50,000   ← the one delivered unit
   *                    Cr Delivery income   6,000
   *                  Dr COGS 40,000 / Cr Goods in transit 40,000
   *
   * Customer advance ends at 50,000 credit: the store credit the buyer is still owed,
   * on the balance sheet where it belongs rather than in income.
   */
  it('applies only the delivered share of the advance and leaves the rest owed', async () => {
    const place = await scene(ORG_PREPAID, 'prepaidpartial', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 10, 40_000n);

    const id = await takeOrder(
      place,
      [{ skuId: target, qty: 2, unitPricePoisha: '50000' }],
      '6000',
    );

    const wallet = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          select id from ledger.accounts
          where org_id = ${place.orgId} and subtype = 'wallet_bkash' and is_active
          order by code limit 1
        `);
        return rows[0]?.id ?? '';
      },
      { orgId: place.orgId },
    );
    await orders.recordAdvance(context(place.orgId), request(), id, {
      walletAccountId: wallet,
      amountPoisha: '106000',
    });

    await orders.confirm(context(place.orgId), request(), id, {});
    await orders.transition(context(place.orgId), request(), id, 'ship', {
      courierId: place.courierId,
    });
    await orders.transition(context(place.orgId), request(), id, 'deliver_partially', {
      deliver: { lines: [{ skuId: target, deliveredQty: 1 }], collectedPoisha: '0' },
    });

    const after = await balancesBySubtype(place.orgId);
    // The one thing the bug did: revenue inflated by a credit to contra-revenue.
    expect(balance(after, 'sales_discounts')).toBe(0n);
    expect(balance(after, 'sales_revenue')).toBe(-50_000n);
    expect(balance(after, 'delivery_charge_income')).toBe(-6_000n);
    // Still owed to the buyer, as a liability rather than as income.
    expect(balance(after, 'customer_advance')).toBe(-50_000n);
    expect(balance(after, 'cogs')).toBe(40_000n);
    // Nothing collected at the door, so the courier owes nothing for this one.
    expect(balance(after, 'courier_receivable')).toBe(0n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
    expect(await lineOf(place.orgId, id, target)).toMatchObject({ delivered: 1 });
  }, 240_000);
});

// --- check 7: exchange ---------------------------------------------------------

describe('check 7: exchanging a delivered order for a different SKU', () => {
  /*
   * Hand-computed, in poisha:
   *
   *   supply A       10 @ 40,000   Dr Inventory 400,000 / Cr Payable 400,000
   *   supply B       10 @ 60,000   Dr Inventory 600,000 / Cr Payable 600,000
   *   order          1 × A @ 200,000, delivery 6,000 → COD 206,000
   *   ship           Dr Goods in transit 40,000 / Cr Inventory 40,000
   *   deliver        Dr Courier receivable 206,000
   *                    Cr Sales revenue 200,000, Cr Delivery income 6,000
   *                  Dr COGS 40,000 / Cr Goods in transit 40,000
   *   exchange       Dr Sales revenue 200,000 / Cr Customer advance 200,000
   *                  Dr Inventory      40,000 / Cr COGS              40,000
   *   replacement    1 × B @ 250,000, delivery 0, credit 200,000 applied
   *                    → COD 50,000, which *is* the price difference
   *   ship B         Dr Goods in transit 60,000 / Cr Inventory 60,000
   *   deliver B      Dr Courier receivable 50,000, Dr Customer advance 200,000
   *                    Cr Sales revenue 250,000
   *                  Dr COGS 60,000 / Cr Goods in transit 60,000
   *
   * Closing: inventory 940,000 (A 10 × 40,000 + B 9 × 60,000), goods in transit 0,
   * customer advance 0, courier receivable 256,000, revenue −250,000, delivery income
   * −6,000, COGS 60,000, payable −1,000,000 — and the trial balance at zero.
   */
  it('returns the units at dispatch cost, credits the buyer, and balances', async () => {
    const place = await scene(ORG_EXCHANGE, 'exchangebooks', 2);
    const first = place.skus[0]?.id ?? '';
    const second = place.skus[1]?.id ?? '';
    await receive(place, first, 10, 40_000n);
    await receive(place, second, 10, 60_000n);

    const id = await takeOrder(place, [{ skuId: first, qty: 1, unitPricePoisha: '200000' }]);
    await orders.confirm(context(place.orgId), request(), id, {});
    await orders.transition(context(place.orgId), request(), id, 'ship', {
      courierId: place.courierId,
    });
    await orders.transition(context(place.orgId), request(), id, 'deliver');

    const exchanged = await orders.exchange(context(place.orgId), request(), id, {
      reason: 'Wrong size delivered',
      returnLines: [{ skuId: first, qty: 1 }],
      lines: [{ skuId: second, qty: 1, unitPricePoisha: '250000' }],
      deliveryChargePoisha: '0',
      locationId: place.location,
    });

    expect(await statusOf(place.orgId, id)).toBe('exchange');
    // The credit is what was paid for the returned units, and the replacement's COD is the
    // price difference — not a journal, just the formula (§9).
    expect(exchanged.creditPoisha).toBe('200000');
    expect(exchanged.replacement.advancePaidPoisha).toBe('200000');
    expect(exchanged.replacement.codAmountPoisha).toBe('50000');
    // The delivered unit came back, so the line can no longer claim it was delivered.
    expect(await lineOf(place.orgId, id, first)).toMatchObject({ delivered: 0, returned: 1 });
    expect(await stockAt(place.orgId, first, place.location)).toEqual({ onHand: 10, reserved: 0 });

    const replacementId = exchanged.replacement.id;
    await orders.confirm(context(place.orgId), request(), replacementId, {});
    await orders.transition(context(place.orgId), request(), replacementId, 'ship', {
      courierId: place.courierId,
    });
    await orders.transition(context(place.orgId), request(), replacementId, 'deliver');

    const balances = await balancesBySubtype(place.orgId);
    expect(balance(balances, 'inventory')).toBe(940_000n);
    expect(balance(balances, 'supplier_payable')).toBe(-1_000_000n);
    expect(balance(balances, 'goods_in_transit')).toBe(0n);
    // The credit was given and then entirely spent, so the liability is gone.
    expect(balance(balances, 'customer_advance')).toBe(0n);
    expect(balance(balances, 'courier_receivable')).toBe(256_000n);
    expect(balance(balances, 'sales_revenue')).toBe(-250_000n);
    expect(balance(balances, 'delivery_charge_income')).toBe(-6_000n);
    expect(balance(balances, 'cogs')).toBe(60_000n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);

    expect(await stockAt(place.orgId, second, place.location)).toEqual({ onHand: 9, reserved: 0 });
    expect(BigInt(10 * 40_000 + 9 * 60_000)).toBe(balance(balances, 'inventory'));
  }, 240_000);
});

// --- the refusals the database itself owns ------------------------------------

describe('what nothing can do to an order, whatever it is', () => {
  it('refuses a status change §9 does not list, even as the table owner (0041)', async () => {
    const place = await scene(ORG_A, 'triggerguard', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 2, 40_000n);
    const id = await takeOrder(place, [{ skuId: target, qty: 1, unitPricePoisha: '100000' }]);

    /*
     * `pending → delivered` is not in §9's table, and this is the *trigger* refusing it —
     * `withSystem` runs as `erp_owner`, which owns the table and bypasses no trigger.
     * That is the half of invariant 7 the domain cannot enforce: a data repair, an import
     * or a future worker that sets a status directly.
     */
    await expectRefused(
      withSystem(
        async (tx) => {
          await tx.execute(sql`
            update sales.orders set status = 'delivered'
            where org_id = ${place.orgId} and id = ${id}
          `);
        },
        { orgId: place.orgId },
      ),
      /ORDER_TRANSITION_INVALID/,
      '23514',
    );
    expect(await statusOf(place.orgId, id)).toBe('pending');
  }, 120_000);

  it('refuses an advance larger than the order will collect (§9’s negative COD)', async () => {
    const place = await scene(ORG_A, 'advanceguard', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 2, 40_000n);
    const id = await takeOrder(place, [{ skuId: target, qty: 1, unitPricePoisha: '100000' }]);

    const wallet = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          select id from ledger.accounts
          where org_id = ${place.orgId} and subtype = 'wallet_bkash' and is_active
          order by code limit 1
        `);
        return rows[0]?.id ?? '';
      },
      { orgId: place.orgId },
    );

    // The order collects 106,000. An advance of 200,000 would make the COD negative, which
    // §9 rejects rather than clamping — the excess is a store credit, not money handed
    // back at the door.
    await expect(
      orders.recordAdvance(context(place.orgId), request(), id, {
        walletAccountId: wallet,
        amountPoisha: '200000',
      }),
    ).rejects.toThrow();

    const row = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ advance: string; cod: string }>(sql`
          select advance_paid_poisha as advance, cod_amount_poisha as cod
          from sales.orders where org_id = ${place.orgId} and id = ${id}
        `);
        return rows[0];
      },
      { orgId: place.orgId },
    );
    expect(row).toMatchObject({ advance: '0', cod: '106000' });
  }, 120_000);

  it('keeps one buyer one row, however their number was typed (check 6)', async () => {
    const place = await scene(ORG_A, 'phoneidentity', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 4, 40_000n);

    const spellings = ['01912345678', '+8801912345678', '০১৯১২৩৪৫৬৭৮', '01912-345678'];
    const thanaId = await someThanaIn(place.orgId, 47);
    const ids: string[] = [];
    for (const phone of spellings) {
      const created = await orders.create(context(place.orgId), request(), {
        channel: 'phone',
        customer: {
          phone,
          name: 'Nusrat Jahan',
          address: { districtId: 47, thanaId, addressLine: 'House 9, Road 3, Dhaka' },
        },
        locationId: place.location,
        lines: [{ skuId: target, qty: 1, unitPricePoisha: '100000' }],
      });
      ids.push(created.id);
    }

    const distinct = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ total: string }>(sql`
          select count(distinct customer_id)::text as total from sales.orders
          where org_id = ${place.orgId}
            and id in (${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
        `);
        return Number(rows[0]?.total ?? '0');
      },
      { orgId: place.orgId },
    );
    // Four spellings, four orders, one buyer. A second row here is a buyer whose fraud
    // signal and order history are split in half (§10).
    expect(distinct).toBe(1);
  }, 120_000);

  it('keeps one org’s orders out of another’s (invariant 4)', async () => {
    const place = await scene(ORG_A, 'tenancyorders', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 2, 40_000n);
    const id = await takeOrder(place, [{ skuId: target, qty: 1, unitPricePoisha: '100000' }]);

    const visible = await withOrg({ orgId: ORG_B, userId: SYSTEM_USER }, async (tx) => {
      const rows = await tx.execute<{ total: string }>(sql`
        select count(*)::text as total from sales.orders where id = ${id}
      `);
      return Number(rows[0]?.total ?? '0');
    });
    expect(visible).toBe(0);
  }, 120_000);
});

/** A thana in one district, so an address can be written without hard-coding an id. */
async function someThanaIn(orgId: string, districtId: number): Promise<number> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ id: number }>(sql`
        select id from ref.thanas where district_id = ${districtId} order by id limit 1
      `),
    { orgId },
  );
  return rows[0]?.id ?? 1;
}

// --- the refusals the auditor's critical finding turned into tests --------------

describe('what an exchange will not do', () => {
  it('refuses a SKU named twice beyond what was delivered, and moves nothing', async () => {
    const place = await scene(ORG_A, 'exchangedupe', 2);
    const first = place.skus[0]?.id ?? '';
    const second = place.skus[1]?.id ?? '';
    await receive(place, first, 4, 40_000n);
    await receive(place, second, 4, 60_000n);

    const id = await takeOrder(place, [{ skuId: first, qty: 2, unitPricePoisha: '200000' }]);
    await orders.confirm(context(place.orgId), request(), id, {});
    await orders.transition(context(place.orgId), request(), id, 'ship', {
      courierId: place.courierId,
    });
    await orders.transition(context(place.orgId), request(), id, 'deliver');

    const before = await balancesBySubtype(place.orgId);
    const stockBefore = await stockAt(place.orgId, first, place.location);

    /*
     * Two units delivered, and a body asking for two twice.
     *
     * Each entry on its own is legal, so the per-entry check this used to do passed both:
     * the journal credited COGS with four units of cost and the buyer with two line-values,
     * while inventory's dedupe key wrote one movement of two units. Balanced, trial balance
     * still zero, and the replacement order came out free.
     */
    await expect(
      orders.exchange(context(place.orgId), request(), id, {
        reason: 'Wrong size delivered',
        returnLines: [
          { skuId: first, qty: 2 },
          { skuId: first, qty: 2 },
        ],
        lines: [{ skuId: second, qty: 1, unitPricePoisha: '250000' }],
        locationId: place.location,
      }),
    ).rejects.toThrow();

    // Nothing moved and nothing posted: the refusal happens before the first movement.
    expect(await statusOf(place.orgId, id)).toBe('delivered');
    expect(await stockAt(place.orgId, first, place.location)).toEqual(stockBefore);
    const after = await balancesBySubtype(place.orgId);
    expect(balance(after, 'cogs')).toBe(balance(before, 'cogs'));
    expect(balance(after, 'inventory')).toBe(balance(before, 'inventory'));
    expect(balance(after, 'customer_advance')).toBe(balance(before, 'customer_advance'));
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
  }, 180_000);

  it('aggregates a SKU split across two entries into one return', async () => {
    const place = await scene(ORG_A, 'exchangesplit', 2);
    const first = place.skus[0]?.id ?? '';
    const second = place.skus[1]?.id ?? '';
    await receive(place, first, 4, 40_000n);
    await receive(place, second, 4, 60_000n);

    const id = await takeOrder(place, [{ skuId: first, qty: 2, unitPricePoisha: '200000' }]);
    await orders.confirm(context(place.orgId), request(), id, {});
    await orders.transition(context(place.orgId), request(), id, 'ship', {
      courierId: place.courierId,
    });
    await orders.transition(context(place.orgId), request(), id, 'deliver');

    const exchanged = await orders.exchange(context(place.orgId), request(), id, {
      reason: 'Both pieces were the wrong size',
      // One and one: the same two units the aggregate refusal above would have doubled.
      returnLines: [
        { skuId: first, qty: 1 },
        { skuId: first, qty: 1 },
      ],
      lines: [{ skuId: second, qty: 1, unitPricePoisha: '500000' }],
      deliveryChargePoisha: '0',
      locationId: place.location,
    });

    // 2 × 200,000 sold, both back: the credit is the line's whole net value, once.
    expect(exchanged.creditPoisha).toBe('400000');
    expect(await lineOf(place.orgId, id, first)).toMatchObject({ delivered: 0, returned: 2 });
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
  }, 180_000);
});

describe('§7’s posting window and §8’s location kinds', () => {
  it('refuses an order event dated before yesterday', async () => {
    const place = await scene(ORG_A, 'backdating', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 4, 40_000n);
    const id = await takeOrder(place, [{ skuId: target, qty: 1, unitPricePoisha: '100000' }]);
    await orders.confirm(context(place.orgId), request(), id, {});
    await orders.transition(context(place.orgId), request(), id, 'ship', {
      courierId: place.courierId,
    });

    const lastMonth = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    await expect(
      orders.transition(context(place.orgId), request(), id, 'deliver', {
        occurredAt: lastMonth,
      }),
    ).rejects.toThrow();

    const nextYear = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    await expect(
      orders.transition(context(place.orgId), request(), id, 'deliver', {
        occurredAt: nextYear,
      }),
    ).rejects.toThrow();

    // Still shipped, and no revenue anywhere near either date.
    expect(await statusOf(place.orgId, id)).toBe('shipped');
  }, 180_000);

  it('refuses an order that would ship from the damaged shelf', async () => {
    const place = await scene(ORG_A, 'damagedship', 1);
    const target = place.skus[0]?.id ?? '';
    const damaged = await makeLocation(place.orgId, {
      code: 'DAMAGED-ORD',
      name: 'Damaged stock',
      kind: 'damaged',
    });

    /*
     * §8 keeps written-off stock on its own shelf and the write-off behind an approval. An
     * order allowed to dispatch from it would sell damaged goods with no approval anywhere —
     * `defaultFulfilmentLocation` filters by kind, and an id named in the body bypassed it.
     */
    await expect(
      orders.create(context(place.orgId), request(), {
        channel: 'phone',
        customerId: place.customerId,
        locationId: damaged,
        deliveryChargePoisha: '6000',
        lines: [{ skuId: target, qty: 1, unitPricePoisha: '100000' }],
      }),
    ).rejects.toThrow();
  }, 120_000);
});

// --- the courier port (M12) ----------------------------------------------------

/**
 * `applyTrigger`, as a courier's webhook reaches it.
 *
 * M12 acceptance check 3 — "a duplicate webhook or poll never double-transitions or
 * double-posts" — rests on this method answering **null** for a move the machine has
 * nothing to do for. It is asserted here rather than only through the courier module
 * because it is this module's promise: a throw would travel back to `sync.runWebhook`,
 * dead-letter a delivery notification for an order that is in fact delivered, and leave
 * a courier retrying until its budget ran out.
 */
describe('the courier port’s applyTrigger', () => {
  it('answers null for a duplicate and still refuses an illegal move', async () => {
    const place = await scene(ORG_A, 'courierduplicate', 1);
    const target = place.skus[0]?.id ?? '';
    await receive(place, target, 4, 40_000n);

    const id = await takeOrder(place, [{ skuId: target, qty: 2, unitPricePoisha: '150000' }]);
    await orders.confirm(context(place.orgId), request(), id, {});
    await orders.transition(context(place.orgId), request(), id, 'ship', {
      courierId: place.courierId,
    });

    const port = harness.app.get<OrdersApi>(ORDERS_API);
    const actor = { orgId: place.orgId, userId: SYSTEM_USER };

    // `undefined` for the request, which is what a job passes: the port must not need one.
    const deliver = () =>
      withOrg(actor, (tx) =>
        port.applyTrigger(tx, context(place.orgId), undefined, {
          orderId: id,
          trigger: 'deliver',
          occurredAt: new Date(),
          collectedPoisha: poisha(306_000n),
        }),
      );

    const journalsForOrder = async (): Promise<number> => {
      const rows = await withSystem(
        async (tx) =>
          tx.execute<{ count: string }>(sql`
            select count(*) as count from ledger.journals
            where org_id = ${place.orgId} and source_type = 'order' and source_id = ${id}
          `),
        { orgId: place.orgId },
      );
      return Number(rows[0]?.count ?? 0);
    };

    const first = await deliver();
    expect(first?.from).toBe('shipped');
    expect(first?.to).toBe('delivered');
    expect(first?.journalId).not.toBeNull();
    // §7's handover journal from the ship, and the delivery journal from this call.
    const posted = await journalsForOrder();
    expect(posted).toBe(2);

    // The same webhook again.
    await expect(deliver()).resolves.toBeNull();

    // Nothing was posted by the second call, so the null was a refusal to act rather than a
    // second posting that the ledger's idempotency key happened to absorb.
    expect(await journalsForOrder()).toBe(posted);

    // A move that is genuinely not in §9's table is still refused, with the domain's own
    // message: "already applied" and "impossible" must not answer the same way.
    await expect(
      withOrg(actor, (tx) =>
        port.applyTrigger(tx, context(place.orgId), undefined, {
          orderId: id,
          trigger: 'ship',
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toThrow(/cannot be handed to a courier/);
  }, 120_000);
});
