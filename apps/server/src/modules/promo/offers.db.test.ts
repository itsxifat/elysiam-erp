import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { bestFlashOffer, planFlashLines } from '@elysium/domain/promo';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { OrdersService } from '../orders/orders.service.js';
import { ownRiderCourier, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { PROMO_API, type PromoApi } from './promo.api.js';

/**
 * Offers against real Postgres (M35a; D-541, D-542).
 *
 * Acceptance check 1 is the first block: a flash sale with five units, twenty orders
 * claiming one each at the same instant, exactly five sold; and a cancel that gives its unit
 * back exactly once, through the order's real cancel transition. Around it, what only a
 * database can prove: the savepoint that makes a claim all-or-nothing even for a caller who
 * catches the refusal, the price and window conditions inside the claim's UPDATE, a return
 * after a partial delivery through the real transitions, two lines of one SKU priced by two
 * sales, the editor over HTTP, and the website's discount quote and redemptions.
 */

const ACTOR = 'usr_offers_db';
const SHELF = 150_000n;
const HOUR = 3_600_000;

let harness: HttpHarness;
let api: PromoApi;
let marketing: RoleClient;
let customerId = '';
let skus: SeededSku[] = [];

beforeAll(async () => {
  harness = await startHttpHarness('offers-db');
  api = harness.app.get<PromoApi>(PROMO_API, { strict: false });
  marketing = await harness.asRole('marketing', ORG_A);
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000351', name: 'Offer Buyer' });
  skus = (await seedProductWithSkus(ORG_A, 'offers', 4)).skus;
}, 600_000);

afterAll(async () => {
  await harness?.close();
}, 120_000);

function sku(index: number): SeededSku {
  const found = skus[index];
  if (found === undefined) throw new Error(`no seeded SKU ${String(index)}`);
  return found;
}

interface SeededOrder {
  readonly id: string;
  /** The order's lines, in the order given. */
  readonly lineIds: readonly string[];
}

/**
 * An order with lines of these SKUs (one unit of SKU 0 when none are given), each charged
 * `price` per unit (the shelf price when absent). A flash claim names a line charged the sale
 * price, so a test claiming at a sale price takes an order priced at it.
 */
async function order(
  lines: readonly { skuIndex: number; qty: number; price?: bigint }[] = [{ skuIndex: 0, qty: 1 }],
  buyer = customerId,
  status: 'pending' | 'cancelled' = 'pending',
): Promise<SeededOrder> {
  const seeded = await seedOrder(ORG_A, {
    status,
    customerId: buyer,
    lines: lines.map((line) => ({
      skuId: sku(line.skuIndex).id,
      skuCode: sku(line.skuIndex).code,
      productName: 'Offer product',
      qty: line.qty,
      unitPricePoisha: line.price ?? SHELF,
    })),
  });
  return { id: seeded.id, lineIds: await linesOf(seeded.id) };
}

async function linesOf(orderId: string): Promise<string[]> {
  return withSystem(
    async (tx) =>
      [
        ...(await tx.execute<{ id: string }>(sql`
          select id from sales.order_lines where org_id = ${ORG_A} and order_id = ${orderId}
          order by position, created_at, id
        `)),
      ].map((row) => row.id),
    { orgId: ORG_A },
  );
}

/** A sale written directly: the fixture for the claim tests, which do not test the editor. */
async function sale(input: {
  readonly items: readonly { skuId: string; price: bigint; limit: number | null }[];
  readonly enabled?: boolean;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly priority?: number;
}): Promise<{ saleId: string; itemIds: string[] }> {
  const startsAt = input.startsAt === undefined ? new Date(Date.now() - HOUR) : input.startsAt;
  const endsAt = input.endsAt === undefined ? new Date(Date.now() + HOUR) : input.endsAt;
  return withSystem(
    async (tx) => {
      const slug = `t-${randomUUID().slice(0, 8)}`;
      const [row] = await tx.execute<{ id: string }>(sql`
        insert into promo.flash_sales (
          org_id, title, slug, enabled, priority, starts_at, ends_at, created_by)
        values (${ORG_A}, 'Test sale', ${slug}, ${input.enabled ?? true}, ${input.priority ?? 0},
                ${startsAt?.toISOString() ?? null}::timestamptz,
                ${endsAt?.toISOString() ?? null}::timestamptz, ${ACTOR})
        returning id
      `);
      const saleId = row?.id ?? '';
      const itemIds: string[] = [];
      for (const item of input.items) {
        const [itemRow] = await tx.execute<{ id: string }>(sql`
          insert into promo.flash_sale_items (
            org_id, flash_sale_id, sku_id, sale_price_poisha, unit_limit)
          values (${ORG_A}, ${saleId}, ${item.skuId}, ${item.price.toString()}, ${item.limit})
          returning id
        `);
        itemIds.push(itemRow?.id ?? '');
      }
      return { saleId, itemIds };
    },
    { orgId: ORG_A },
  );
}

async function itemState(itemId: string) {
  return withSystem(
    async (tx) => {
      const [item] = await tx.execute<{ units_sold: number }>(sql`
        select units_sold from promo.flash_sale_items where org_id = ${ORG_A} and id = ${itemId}
      `);
      const claims = await tx.execute<{ status: string; qty: number; released_qty: number }>(sql`
        select status, qty, released_qty from promo.flash_claims
        where org_id = ${ORG_A} and flash_sale_item_id = ${itemId}
        order by created_at, id
      `);
      return { sold: item?.units_sold ?? -1, claims: [...claims] };
    },
    { orgId: ORG_A },
  );
}

/** Claim the order's first line (or `line`) from one offer. */
function claim(
  target: SeededOrder,
  itemId: string,
  qty = 1,
  price = 100_000n,
  skuIndex = 0,
  line = 0,
) {
  return withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    api.claimFlashUnits(tx, ORG_A, {
      orderId: target.id,
      lines: [
        {
          orderLineId: target.lineIds[line] ?? '',
          skuId: sku(skuIndex).id,
          qty,
          flashSaleItemId: itemId,
          salePricePoisha: price,
        },
      ],
    }),
  );
}

/** Every message down an error's `cause` chain: a trigger's refusal sits under the query's. */
async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const messages: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
    }
    return messages.join(' | ');
  }
  return 'no failure';
}

/** Hold every caller until `parties` of them have arrived, so the race is a real one. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release = (): void => undefined;
  const all = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await all;
  };
}

describe('a flash sale’s units under concurrent checkouts (M35a check 1)', () => {
  let itemId = '';
  let winners: SeededOrder[] = [];

  it('sells exactly five of five units to twenty orders claiming at once', async () => {
    ({
      itemIds: [itemId = ''],
    } = await sale({ items: [{ skuId: sku(0).id, price: 100_000n, limit: 5 }] }));
    // Every order's line is charged the sale price, so the five sold are sold at it.
    const orders = await Promise.all(
      Array.from({ length: 20 }, () => order([{ skuIndex: 0, qty: 1, price: 100_000n }])),
    );

    /*
     * Twenty transactions started together. `withOrg` borrows from the real pool, so ten
     * hold a connection at any instant; the barrier makes those ten each open and waiting
     * before any of them claims, so ten copies of the conditional UPDATE contend for one row
     * at once, and the ten queued behind them then find the units gone (the shape of M07's
     * reservation race, `inventory.db.test.ts`).
     */
    const ready = barrier(10);
    const results = await Promise.allSettled(
      orders.map((target) =>
        withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
          // Every transaction is open and has done work before any claims.
          await tx.execute(sql`select 1`);
          await ready();
          await api.claimFlashUnits(tx, ORG_A, {
            orderId: target.id,
            lines: [
              {
                orderLineId: target.lineIds[0] ?? '',
                skuId: sku(0).id,
                qty: 1,
                flashSaleItemId: itemId,
                salePricePoisha: 100_000n,
              },
            ],
          });
          return target;
        }),
      ),
    );

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(5);
    expect(lost).toHaveLength(15);
    for (const refusal of lost) {
      expect(refusal.reason).toMatchObject({
        response: { code: 'FLASH_SALE_UNAVAILABLE', skuIds: [sku(0).id] },
      });
    }
    const state = await itemState(itemId);
    expect(state.sold).toBe(5);
    expect(state.claims).toHaveLength(5);
    winners = won.map((result) => result.value);
  });

  it('gives a cancelled order’s unit back exactly once, through the real cancel', async () => {
    const [cancelled] = winners;
    if (cancelled === undefined) throw new Error('no winning order');
    const response = await adminCancel(cancelled.id);
    expect(response.statusCode, response.body).toBeLessThan(300);

    let state = await itemState(itemId);
    expect(state.sold).toBe(4);
    expect(state.claims.filter((row) => row.status === 'released')).toEqual([
      { status: 'released', qty: 1, released_qty: 1 },
    ]);

    // Told again, by a second cancel and by a direct release: nothing more goes back.
    const again = await adminCancel(cancelled.id);
    expect(again.statusCode).toBe(409);
    const released = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, cancelled.id),
    );
    expect(released).toBe(0);
    state = await itemState(itemId);
    expect(state.sold).toBe(4);

    // And the unit is there to be sold again.
    await claim(await order([{ skuIndex: 0, qty: 1, price: 100_000n }]), itemId);
    expect((await itemState(itemId)).sold).toBe(5);
  });

  async function adminCancel(orderId: string) {
    const admin = await harness.asRole('org_admin', ORG_A);
    return admin.client.request('POST', `/v1/orders/${orderId}/cancel`, {
      body: { reason: 'Buyer changed their mind' },
    });
  }
});

describe('what a claim checks inside its own UPDATE (D-542)', () => {
  it('refuses a price the sale no longer has, a sale not live, and one switched off', async () => {
    const live = await sale({ items: [{ skuId: sku(1).id, price: 90_000n, limit: 10 }] });
    const later = await sale({
      items: [{ skuId: sku(1).id, price: 90_000n, limit: 10 }],
      startsAt: new Date(Date.now() + HOUR),
      endsAt: null,
    });
    const over = await sale({
      items: [{ skuId: sku(1).id, price: 90_000n, limit: 10 }],
      startsAt: null,
      endsAt: new Date(Date.now() - HOUR),
    });
    const off = await sale({
      items: [{ skuId: sku(1).id, price: 90_000n, limit: 10 }],
      enabled: false,
    });

    const refused = { response: { code: 'FLASH_SALE_UNAVAILABLE' } };
    const stale = await order([{ skuIndex: 1, qty: 1, price: 90_000n }]);
    await expect(claim(stale, live.itemIds[0] ?? '', 1, 95_000n, 1)).rejects.toMatchObject(refused);
    for (const offer of [later, over, off]) {
      await expect(
        claim(
          await order([{ skuIndex: 1, qty: 1, price: 90_000n }]),
          offer.itemIds[0] ?? '',
          1,
          90_000n,
          1,
        ),
      ).rejects.toMatchObject(refused);
    }
    await claim(stale, live.itemIds[0] ?? '', 1, 90_000n, 1);
    expect((await itemState(live.itemIds[0] ?? '')).sold).toBe(1);
  });

  it('refuses a claim naming one SKU for another SKU’s offer', async () => {
    const offer = await sale({ items: [{ skuId: sku(1).id, price: 90_000n, limit: 10 }] });
    // The order's line is SKU 0; the claim says SKU 0 but names SKU 1's offer.
    await expect(claim(await order(), offer.itemIds[0] ?? '', 1, 90_000n, 0)).rejects.toMatchObject(
      { response: { code: 'FLASH_SALE_UNAVAILABLE' } },
    );
  });

  it('takes nothing when one line is refused, even if the caller catches it and commits', async () => {
    const plenty = await sale({ items: [{ skuId: sku(2).id, price: 80_000n, limit: 10 }] });
    const scarce = await sale({ items: [{ skuId: sku(3).id, price: 80_000n, limit: 1 }] });
    await claim(
      await order([{ skuIndex: 3, qty: 1, price: 80_000n }]),
      scarce.itemIds[0] ?? '',
      1,
      80_000n,
      3,
    );

    const target = await order([
      { skuIndex: 2, qty: 3, price: 80_000n },
      { skuIndex: 3, qty: 1, price: 80_000n },
    ]);
    const caught = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      try {
        await api.claimFlashUnits(tx, ORG_A, {
          orderId: target.id,
          lines: [
            {
              orderLineId: target.lineIds[0] ?? '',
              skuId: sku(2).id,
              qty: 3,
              flashSaleItemId: plenty.itemIds[0] ?? '',
              salePricePoisha: 80_000n,
            },
            {
              orderLineId: target.lineIds[1] ?? '',
              skuId: sku(3).id,
              qty: 1,
              flashSaleItemId: scarce.itemIds[0] ?? '',
              salePricePoisha: 80_000n,
            },
          ],
        });
        return 'claimed';
      } catch (error) {
        // A checkout that falls back to the shelf price carries on in the same transaction.
        return (error as { response?: { skuIds?: string[] } }).response?.skuIds ?? [];
      }
    });

    expect(caught).toEqual([sku(3).id]);
    expect((await itemState(plenty.itemIds[0] ?? '')).sold).toBe(0);
    expect((await itemState(plenty.itemIds[0] ?? '')).claims).toEqual([]);
  });

  it('sells as many as asked of an all-stock offer, and a retried claim takes nothing more', async () => {
    const all = await sale({ items: [{ skuId: sku(2).id, price: 70_000n, limit: null }] });
    const target = await order([{ skuIndex: 2, qty: 40, price: 70_000n }]);
    await claim(target, all.itemIds[0] ?? '', 40, 70_000n, 2);
    await claim(target, all.itemIds[0] ?? '', 40, 70_000n, 2);
    expect((await itemState(all.itemIds[0] ?? '')).sold).toBe(40);
  });

  it('gives back each line’s own units: one line delivered, the other returned', async () => {
    const x = await sale({ items: [{ skuId: sku(1).id, price: 60_000n, limit: 10 }] });
    const y = await sale({ items: [{ skuId: sku(2).id, price: 65_000n, limit: 10 }] });
    const target = await order([
      { skuIndex: 1, qty: 2, price: 60_000n },
      { skuIndex: 2, qty: 3, price: 65_000n },
    ]);
    await claim(target, x.itemIds[0] ?? '', 2, 60_000n, 1, 0);
    await claim(target, y.itemIds[0] ?? '', 3, 65_000n, 2, 1);

    // Line one was delivered whole; line two came back whole. Only Y gets units back, and
    // X's claim stays held: those two units sold at the sale price.
    const returned = [
      { orderLineId: target.lineIds[0] ?? '', qty: 0 },
      { orderLineId: target.lineIds[1] ?? '', qty: 3 },
    ];
    const first = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, target.id, returned),
    );
    const second = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, target.id, returned),
    );

    expect([first, second]).toEqual([3, 0]);
    expect(await itemState(x.itemIds[0] ?? '')).toEqual({
      sold: 2,
      claims: [{ status: 'claimed', qty: 2, released_qty: 0 }],
    });
    expect(await itemState(y.itemIds[0] ?? '')).toEqual({
      sold: 0,
      claims: [{ status: 'released', qty: 3, released_qty: 3 }],
    });
  });

  it('refuses a claim for another order’s line, part of a line, or a line at the shelf price', async () => {
    const offer = await sale({ items: [{ skuId: sku(1).id, price: 90_000n, limit: 10 }] });
    const mine = await order([{ skuIndex: 1, qty: 2, price: 90_000n }]);
    const theirs = await order([{ skuIndex: 1, qty: 2, price: 90_000n }]);
    const invalid = { response: { code: 'FLASH_SALE_INVALID' } };

    // Another order's line.
    await expect(
      withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
        api.claimFlashUnits(tx, ORG_A, {
          orderId: mine.id,
          lines: [
            {
              orderLineId: theirs.lineIds[0] ?? '',
              skuId: sku(1).id,
              qty: 2,
              flashSaleItemId: offer.itemIds[0] ?? '',
              salePricePoisha: 90_000n,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject(invalid);
    // One unit of a line of two.
    await expect(claim(mine, offer.itemIds[0] ?? '', 1, 90_000n, 1)).rejects.toMatchObject(invalid);
    // A whole line, but charged the shelf price: units sold at the sale price are units a
    // line charges the sale price for.
    const shelf = await order([{ skuIndex: 1, qty: 2 }]);
    await expect(claim(shelf, offer.itemIds[0] ?? '', 2, 90_000n, 1)).rejects.toMatchObject(
      invalid,
    );
    // Nothing was taken by either.
    expect((await itemState(offer.itemIds[0] ?? '')).sold).toBe(0);
  });

  it('refuses to edit the lines of an order that holds flash units (re-audit W1)', async () => {
    const offer = await sale({ items: [{ skuId: sku(1).id, price: 90_000n, limit: 10 }] });
    const target = await order([{ skuIndex: 1, qty: 1, price: 90_000n }]);
    await claim(target, offer.itemIds[0] ?? '', 1, 90_000n, 1);
    const admin = await harness.asRole('org_admin', ORG_A);

    const edit = await admin.client.request('PATCH', `/v1/orders/${target.id}`, {
      body: { lines: [{ skuId: sku(1).id, qty: 2, unitPricePoisha: SHELF.toString() }] },
    });
    expect(edit.statusCode, edit.body).toBe(409);
    expect(JSON.parse(edit.body)).toMatchObject({ code: 'ORDER_IMMUTABLE' });

    const note = await admin.client.request('PATCH', `/v1/orders/${target.id}`, {
      body: { notes: 'Call before delivery' },
    });
    expect(note.statusCode, note.body).toBe(200);
    expect((await itemState(offer.itemIds[0] ?? '')).sold).toBe(1);
  });

  it('refuses to change or remove a claim once it is released', async () => {
    const offer = await sale({ items: [{ skuId: sku(1).id, price: 60_000n, limit: 10 }] });
    const target = await order([{ skuIndex: 1, qty: 1, price: 60_000n }]);
    await claim(target, offer.itemIds[0] ?? '', 1, 60_000n, 1);
    await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, target.id),
    );

    const change = await failure(
      withSystem(
        (tx) =>
          tx.execute(
            sql`update promo.flash_claims set released_qty = 0 where order_id = ${target.id}`,
          ),
        { orgId: ORG_A },
      ),
    );
    const remove = await failure(
      withSystem(
        (tx) => tx.execute(sql`delete from promo.flash_claims where order_id = ${target.id}`),
        { orgId: ORG_A },
      ),
    );
    expect(change).toMatch(/FLASH_CLAIM_IMMUTABLE: a released flash claim is final/);
    expect(remove).toMatch(/FLASH_CLAIM_IMMUTABLE: a flash claim is released, never removed/);
  });

  it('offers the cheapest live price, then the sale ending soonest, and plans whole lines', async () => {
    const soon = await sale({
      items: [{ skuId: sku(3).id, price: 50_000n, limit: 2 }],
      endsAt: new Date(Date.now() + HOUR),
    });
    await sale({
      items: [{ skuId: sku(3).id, price: 50_000n, limit: 9 }],
      endsAt: new Date(Date.now() + 5 * HOUR),
    });
    const now = new Date();
    const offers = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.liveFlashOffers(tx, ORG_A, [sku(3).id], now),
    );

    expect(bestFlashOffer(poisha(SHELF), offers, now)?.flashSaleItemId).toBe(soon.itemIds[0]);
    const plan = planFlashLines(
      [
        { skuId: sku(3).id, qty: 2, shelfPricePoisha: poisha(SHELF) },
        { skuId: sku(3).id, qty: 3, shelfPricePoisha: poisha(SHELF) },
      ],
      offers,
      now,
    );
    expect(plan[0]?.offer?.flashSaleItemId).toBe(soon.itemIds[0]);
    expect(plan[1]?.offer?.flashSaleItemId).not.toBe(soon.itemIds[0]);
    expect(plan[1]?.unitPricePoisha).toBe(50_000n);
  });
});

describe('a return after a partial delivery, through the real transitions (ledger audit W10)', () => {
  function request(): AuditableRequest {
    const value = {} as AuditableRequest;
    attachScope(value, 'update', 'Order', { kind: 'all' });
    return value;
  }

  function agent(): ActiveContext {
    return {
      orgId: ORG_A,
      userId: ACTOR,
      isSuperAdmin: false,
      roles: ['org_admin'],
      branchIds: [],
      branchIdsByRole: {},
      requestId: 'offers-db-test',
    };
  }

  it('gives back the undelivered units of a flash-priced line, and keeps the delivered ones', async () => {
    const orders = harness.app.get(OrdersService);
    const inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });
    const [item] = (await seedProductWithSkus(ORG_A, 'offersret', 1)).skus;
    if (item === undefined) throw new Error('no SKU seeded');
    const location = await warehouseId(ORG_A);
    const courierId = await ownRiderCourier(ORG_A);
    await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      inventory.receiveSupply(
        tx,
        { orgId: ORG_A, userId: ACTOR },
        {
          supplyId: randomUUID(),
          supplierId: randomUUID(),
          locationId: location,
          branchId: null,
          occurredAt: new Date(),
          lines: [{ skuId: item.id, qty: 10, unitCostPoisha: poisha(40_000n) }],
        },
      ),
    );
    const offer = await sale({ items: [{ skuId: item.id, price: 100_000n, limit: 5 }] });
    const itemId = offer.itemIds[0] ?? '';

    const created = await orders.create(agent(), request(), {
      channel: 'website',
      customerId,
      locationId: location,
      courierId,
      deliveryChargePoisha: '6000',
      lines: [{ skuId: item.id, qty: 3, unitPricePoisha: '100000' }],
    });
    const lineIds = await linesOf(created.id);
    await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.claimFlashUnits(tx, ORG_A, {
        orderId: created.id,
        lines: [
          {
            orderLineId: lineIds[0] ?? '',
            skuId: item.id,
            qty: 3,
            flashSaleItemId: itemId,
            salePricePoisha: 100_000n,
          },
        ],
      }),
    );
    expect((await itemState(itemId)).sold).toBe(3);

    const move = (trigger: Parameters<OrdersService['transition']>[3], options = {}) =>
      orders.transition(agent(), request(), created.id, trigger, options);
    await move('confirm');
    await move('ship', { courierId });
    await move('deliver_partially', {
      deliver: { lines: [{ skuId: item.id, deliveredQty: 2 }], collectedPoisha: '206000' },
    });
    expect((await itemState(itemId)).sold).toBe(3);
    await move('receive_return', {
      reason: 'One came back',
      returnReason: 'size_issue',
      ret: { reason: 'One came back', locationId: location },
    });

    expect(await itemState(itemId)).toEqual({
      sold: 2,
      claims: [{ status: 'released', qty: 3, released_qty: 1 }],
    });
  }, 240_000);

  it('keeps every sale’s sold count equal to what its claims hold', async () => {
    const drift = await withSystem(
      async (tx) =>
        tx.execute<{ id: string }>(sql`
          select i.id from promo.flash_sale_items i
          left join promo.flash_claims c on c.org_id = i.org_id and c.flash_sale_item_id = i.id
          where i.org_id = ${ORG_A}
          group by i.id, i.units_sold
          having i.units_sold <> coalesce(sum(c.qty - c.released_qty), 0)
        `),
      { orgId: ORG_A },
    );
    expect([...drift]).toEqual([]);
  });
});

describe('what the storefront reads (D-548)', () => {
  it('lists switched-on sales that have not ended, in listing order, and finds one by slug', async () => {
    const now = new Date();
    const first = await sale({
      items: [{ skuId: sku(3).id, price: 55_000n, limit: 4 }],
      priority: 90,
      endsAt: new Date(now.getTime() + 2 * HOUR),
    });
    const upcoming = await sale({
      items: [{ skuId: sku(3).id, price: 56_000n, limit: null }],
      priority: 90,
      startsAt: new Date(now.getTime() + HOUR),
      endsAt: new Date(now.getTime() + 3 * HOUR),
    });
    const draft = await sale({ items: [], enabled: false, priority: 90 });
    const over = await sale({
      items: [],
      priority: 90,
      startsAt: null,
      endsAt: new Date(now.getTime() - HOUR),
    });

    const listed = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.storefrontFlashSales(tx, ORG_A, { now, homeOnly: false }),
    );
    const ids = listed.map((entry) => entry.id);
    expect(ids.indexOf(first.saleId)).toBeLessThan(ids.indexOf(upcoming.saleId));
    expect(ids).not.toContain(draft.saleId);
    expect(ids).not.toContain(over.saleId);
    expect(listed.find((entry) => entry.id === first.saleId)).toMatchObject({
      status: 'live',
      items: [{ skuId: sku(3).id, salePricePoisha: 55_000n, unitsLeft: 4 }],
    });
    expect(listed.find((entry) => entry.id === upcoming.saleId)).toMatchObject({
      status: 'scheduled',
      items: [{ unitsLeft: null }],
    });

    const slugOf = async (saleId: string) =>
      withSystem(
        async (tx) =>
          (
            await tx.execute<{ slug: string }>(sql`
              select slug from promo.flash_sales where org_id = ${ORG_A} and id = ${saleId}
            `)
          )[0]?.slug ?? '',
        { orgId: ORG_A },
      );
    const found = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => ({
      ended: await api.storefrontFlashSale(tx, ORG_A, await slugOf(over.saleId), now),
      draft: await api.storefrontFlashSale(tx, ORG_A, await slugOf(draft.saleId), now),
    }));
    expect(found.ended).toMatchObject({ id: over.saleId, status: 'ended' });
    expect(found.draft).toBeUndefined();
  });
});

describe('the flash-sale editor over HTTP (D-542)', () => {
  it('creates, edits, switches on, duplicates, and keeps what sold', async () => {
    const created = await marketing.client.request('POST', '/v1/promo/flash-sales', {
      body: {
        title: 'Eid Flash',
        enabled: true,
        items: [
          { skuId: sku(0).id, salePricePoisha: '120000', unitLimit: 5 },
          { skuId: sku(1).id, salePricePoisha: '110000', unitLimit: null },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const view = JSON.parse(created.body) as {
      id: string;
      slug: string;
      status: string;
      items: {
        id: string;
        skuId: string;
        skuCode: string;
        shelfPricePoisha: string;
        unitsSold: number;
      }[];
    };
    expect(view).toMatchObject({ slug: 'eid-flash', status: 'live' });
    expect(view.items.map((item) => item.shelfPricePoisha)).toEqual(['150000', '150000']);
    expect(created.body).not.toMatch(/cost|wac/i);

    // Sell two units, then edit: the price changes, sku(1) leaves, sold stays.
    const firstItem = view.items.find((item) => item.skuId === sku(0).id)?.id ?? '';
    await claim(await order([{ skuIndex: 0, qty: 2, price: 120_000n }]), firstItem, 2, 120_000n, 0);
    const edited = await marketing.client.request('PUT', `/v1/promo/flash-sales/${view.id}`, {
      body: {
        title: 'Eid Flash',
        slug: view.slug,
        enabled: true,
        items: [{ skuId: sku(0).id, salePricePoisha: '115000', unitLimit: 4 }],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    // Switched-on SKUs first, then the ones taken off the sale.
    expect(JSON.parse(edited.body)).toMatchObject({
      status: 'live',
      items: [
        { skuId: sku(0).id, salePricePoisha: '115000', unitLimit: 4, unitsSold: 2, enabled: true },
        { skuId: sku(1).id, enabled: false },
      ],
    });

    // The audit row names every SKU's price before and after.
    const audit = await withSystem(
      (tx) =>
        tx.execute<{ before: unknown; after: unknown }>(sql`
          select before, after from audit.audit_log
          where org_id = ${ORG_A} and action = 'promo.flash_sale.updated' and entity_id = ${view.id}
          order by created_at desc limit 1
        `),
      { orgId: ORG_A },
    );
    expect(JSON.stringify(audit[0])).toContain('"salePricePoisha":"120000"');
    expect(JSON.stringify(audit[0])).toContain('"salePricePoisha":"115000"');

    // A limit below what sold, and a sale price at the shelf price, are refused.
    for (const item of [
      { skuId: sku(0).id, salePricePoisha: '115000', unitLimit: 1 },
      { skuId: sku(0).id, salePricePoisha: '150000', unitLimit: 4 },
    ]) {
      const refused = await marketing.client.request('PUT', `/v1/promo/flash-sales/${view.id}`, {
        body: { title: 'Eid Flash', items: [item] },
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'FLASH_SALE_INVALID' });
    }

    const off = await marketing.client.request('PATCH', `/v1/promo/flash-sales/${view.id}`, {
      body: { enabled: false },
    });
    expect(JSON.parse(off.body)).toMatchObject({ enabled: false, status: 'draft' });

    const copy = await marketing.client.request(
      'POST',
      `/v1/promo/flash-sales/${view.id}/duplicate`,
    );
    expect(copy.statusCode, copy.body).toBe(201);
    expect(JSON.parse(copy.body)).toMatchObject({
      slug: 'eid-flash-2',
      enabled: false,
      items: [{ skuId: sku(0).id, unitsSold: 0, salePricePoisha: '115000' }],
    });

    const taken = await marketing.client.request('POST', '/v1/promo/flash-sales', {
      body: { title: 'Another', slug: 'eid-flash' },
    });
    expect(taken.statusCode).toBe(409);

    const list = await marketing.client.request('GET', '/v1/promo/flash-sales');
    const listed = (JSON.parse(list.body) as { items: { id: string; unitsSold: number }[] }).items;
    expect(listed.find((row) => row.id === view.id)).toMatchObject({ unitsSold: 2 });
  });

  it('takes a public campaign image as the banner, and nothing else (ledger audit W6)', async () => {
    async function file(purpose: string, visibility: 'public' | 'private'): Promise<string> {
      const fileId = randomUUID();
      await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
        tx.execute(sql`
          insert into files.objects
            (id, org_id, storage_key, driver, visibility, status, purpose, mime, size_bytes,
             sha256)
          values (
            ${fileId}, ${ORG_A}, ${`${visibility}/${ORG_A}/${fileId}.webp`}, 'local',
            ${visibility}::files.file_visibility, 'stored', ${purpose}, 'image/webp', 1024,
            ${'a'.repeat(64)})
        `),
      );
      return fileId;
    }
    const banner = await file('campaign-asset', 'public');
    for (const bannerFileId of [
      await file('payslip', 'private'),
      await file('campaign-asset', 'private'),
      randomUUID(),
    ]) {
      const refused = await marketing.client.request('POST', '/v1/promo/flash-sales', {
        body: { title: 'Banner test', bannerFileId },
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(JSON.parse(refused.body)).toMatchObject({ code: 'FLASH_SALE_INVALID' });
    }
    const accepted = await marketing.client.request('POST', '/v1/promo/flash-sales', {
      body: { title: 'Banner test', bannerFileId: banner },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
  });

  it('is not the warehouse’s to see', async () => {
    const warehouse = await harness.asRole('warehouse', ORG_A);
    const response = await warehouse.client.request('GET', '/v1/promo/flash-sales');
    expect(response.statusCode).toBe(403);
  });
});

describe('the website’s discounts, through the one engine (D-540, D-541)', () => {
  async function createDiscount(body: Record<string, unknown>): Promise<string> {
    const response = await marketing.client.request('POST', '/v1/promo/codes', { body });
    expect(response.statusCode, response.body).toBe(201);
    return (JSON.parse(response.body) as { id: string }).id;
  }

  function quote(input: {
    readonly lines: readonly { skuIndex: number; qty: number }[];
    readonly codes?: readonly string[];
    readonly buyer?: string | null;
    readonly automatic?: boolean;
  }) {
    return withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.quoteDiscounts(tx, ORG_A, {
        lines: input.lines.map((line) => ({
          skuId: sku(line.skuIndex).id,
          qty: line.qty,
          netPoisha: SHELF * BigInt(line.qty),
        })),
        customerId: input.buyer === undefined ? customerId : input.buyer,
        channel: 'website',
        codes: input.codes ?? [],
        deliveryChargePoisha: 6_000n,
        now: new Date(),
        ...(input.automatic === undefined ? {} : { automatic: input.automatic }),
      }),
    );
  }

  it('stacks an automatic tiered discount with a typed buy-X-get-Y code, and redeems both', async () => {
    const word = `BXG${randomUUID().slice(0, 6).toUpperCase()}`;
    const tiered = await createDiscount({
      method: 'automatic',
      title: 'Spend more',
      kind: 'tiered',
      allowStacking: true,
      tiers: [
        { minSubtotalPoisha: '300000', kind: 'percent', valueBps: 500 },
        { minSubtotalPoisha: '1000000', kind: 'flat', valuePoisha: '200000' },
      ],
    });
    const bxgy = await createDiscount({
      code: word,
      kind: 'buy_x_get_y',
      buyQuantity: 2,
      getQuantity: 1,
      allowStacking: true,
      totalLimit: 5,
    });

    const answer = await quote({ lines: [{ skuIndex: 0, qty: 3 }], codes: [word, 'NOPE123'] });
    // ৳4,500: 5% (৳225) and one of three free (৳1,500), together ৳1,725.
    expect(answer.discountPoisha).toBe(172_500n);
    expect(answer.applied.map((entry) => entry.discountId).sort()).toEqual([bxgy, tiered].sort());
    expect(answer.applied.find((entry) => entry.discountId === bxgy)?.title).toBe(word);
    expect(answer.refused).toEqual([{ code: 'NOPE123', reason: 'not_found' }]);

    // The desk does not see automatic discounts (D-544).
    expect((await quote({ lines: [{ skuIndex: 0, qty: 3 }], automatic: false })).applied).toEqual(
      [],
    );

    const target = await order();
    const { redemptionIds } = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.redeem(tx, ORG_A, { orderId: target.id, customerId, applied: answer.applied }),
    );
    expect(redemptionIds).toHaveLength(2);
    const released = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseForOrder(tx, ORG_A, target.id),
    );
    expect(released).toBe(true);
    const statuses = await withSystem(
      (tx) =>
        tx.execute<{ status: string }>(sql`
          select status from promo.redemptions
          where org_id = ${ORG_A} and order_id = ${target.id}
        `),
      { orgId: ORG_A },
    );
    expect([...statuses].map((row) => row.status)).toEqual(['released', 'released']);

    // Paused, so the next suites price without it.
    for (const id of [tiered, bxgy]) {
      await marketing.client.request('PATCH', `/v1/promo/codes/${id}`, {
        body: { status: 'paused' },
      });
    }
  });

  it('takes no use at all when one of a stack’s discounts is refused and the caller carries on', async () => {
    const open = await createDiscount({
      method: 'automatic',
      title: `Open ${randomUUID().slice(0, 6)}`,
      kind: 'flat',
      valuePoisha: '1000',
      allowStacking: true,
    });
    const spent = await createDiscount({
      method: 'automatic',
      title: `Spent ${randomUUID().slice(0, 6)}`,
      kind: 'flat',
      valuePoisha: '1000',
      allowStacking: true,
      totalLimit: 1,
    });
    const answer = await quote({ lines: [{ skuIndex: 0, qty: 1 }] });
    const stack = answer.applied.filter((entry) => [open, spent].includes(entry.discountId));
    expect(stack).toHaveLength(2);
    // The limited one's last use goes to another order first.
    await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) =>
      api.redeem(tx, ORG_A, {
        orderId: (await order()).id,
        customerId,
        applied: stack.filter((entry) => entry.discountId === spent),
      }),
    );

    const target = await order();
    const outcome = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      try {
        await api.redeem(tx, ORG_A, { orderId: target.id, customerId, applied: stack });
        return 'redeemed';
      } catch {
        // A checkout that drops the discounts and carries on in the same transaction.
        return 'refused';
      }
    });
    expect(outcome).toBe('refused');
    const used = await withSystem(
      (tx) =>
        tx.execute<{ id: string; used_count: number }>(sql`
          select id, used_count from promo.codes where org_id = ${ORG_A}
            and id = any (${sql.param([open, spent])}::uuid[])
        `),
      { orgId: ORG_A },
    );
    expect(Object.fromEntries([...used].map((row) => [row.id, row.used_count]))).toEqual({
      [open]: 0,
      [spent]: 1,
    });
    for (const id of [open, spent]) {
      await marketing.client.request('PATCH', `/v1/promo/codes/${id}`, {
        body: { status: 'paused' },
      });
    }
  });

  it('gives a first-order discount to a new buyer and to one whose only order was cancelled', async () => {
    const word = `NEW${randomUUID().slice(0, 6).toUpperCase()}`;
    const id = await createDiscount({
      code: word,
      kind: 'flat',
      valuePoisha: '20000',
      firstOrderOnly: true,
    });
    const fresh = await seedCustomer(ORG_A, { phoneE164: '+8801711000352', name: 'New Buyer' });
    const cancelledOnly = await seedCustomer(ORG_A, {
      phoneE164: '+8801711000353',
      name: 'Cancelled Buyer',
    });
    await order(undefined, cancelledOnly, 'cancelled');

    for (const buyer of [fresh, cancelledOnly, null]) {
      const answer = await quote({ lines: [{ skuIndex: 0, qty: 1 }], codes: [word], buyer });
      expect(answer.applied.map((entry) => entry.discountId)).toEqual([id]);
    }
    // `customerId` has ordered before (the suites above took orders for them).
    const returning = await quote({ lines: [{ skuIndex: 0, qty: 1 }], codes: [word] });
    expect(returning.refused).toEqual([{ code: word, reason: 'first_order_only' }]);
  });

  it('gives a new buyer’s first-order discount to one of two orders placed at once (W3)', async () => {
    const word = `ONE${randomUUID().slice(0, 6).toUpperCase()}`;
    await createDiscount({ code: word, kind: 'flat', valuePoisha: '20000', firstOrderOnly: true });
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801711000354', name: 'Twice Buyer' });
    const answer = await quote({ lines: [{ skuIndex: 0, qty: 1 }], codes: [word], buyer });
    expect(answer.refused).toEqual([]);
    expect(answer.applied).toHaveLength(1);

    // Both orders exist (each in its own transaction, as checkout writes it), both quoted
    // before either redeemed; only the code's row lock stands between them.
    const ready = barrier(2);
    const attempts = await Promise.allSettled(
      [0, 1].map(() =>
        withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
          const placed = await tx.execute<{ id: string }>(sql`
            insert into sales.orders (
              org_id, order_no, channel, customer_id, ship_name, ship_phone_e164,
              ship_district_id, ship_thana_id, ship_address_line, items_poisha,
              discount_poisha, delivery_charge_poisha, advance_paid_poisha, cod_amount_poisha,
              status, created_by)
            select ${ORG_A}, ${`TST-2609-9${String(Math.floor(Math.random() * 90_000) + 10_000)}`},
                   'website', ${buyer},
                   'Twice Buyer', '+8801711000354', t.district_id, t.id, 'House 2', 150000,
                   20000, 6000, 0, 136000, 'pending', ${ACTOR}
            from ref.thanas t order by t.id limit 1
            returning id
          `);
          await ready();
          return api.redeem(tx, ORG_A, {
            orderId: placed[0]?.id ?? '',
            customerId: buyer,
            applied: answer.applied,
          });
        }),
      ),
    );
    const refused = attempts.filter((attempt) => attempt.status === 'rejected');
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.status === 'rejected' ? refused[0].reason : null).toMatchObject({
      response: { reason: 'first_order_only' },
    });
  });

  it('reaches a sub-category’s products from a discount on the parent category', async () => {
    const { parent, child } = await withSystem(
      async (tx) => {
        const [up] = await tx.execute<{ id: string; path: string }>(sql`
          insert into catalog.categories (org_id, name, slug, code, path, depth)
          values (${ORG_A}, 'Sarees', 'sarees-m35a', 'SAREEM35', '/sarees-m35a', 0)
          returning id, path
        `);
        const [down] = await tx.execute<{ id: string }>(sql`
          insert into catalog.categories (org_id, parent_id, name, slug, code, path, depth)
          values (${ORG_A}, ${up?.id ?? ''}, 'Silk', 'silk-m35a', 'SILKM35',
                  ${`${up?.path ?? ''}/silk-m35a`}, 1)
          returning id
        `);
        const product = await tx.execute<{ product_id: string }>(sql`
          select product_id from catalog.skus where org_id = ${ORG_A} and id = ${sku(2).id}
        `);
        await tx.execute(sql`
          update catalog.products set category_id = ${down?.id ?? ''}
          where org_id = ${ORG_A} and id = ${product[0]?.product_id ?? ''}
        `);
        return { parent: up?.id ?? '', child: down?.id ?? '' };
      },
      { orgId: ORG_A },
    );
    expect(child).not.toBe(parent);
    const word = `CAT${randomUUID().slice(0, 6).toUpperCase()}`;
    await createDiscount({ code: word, kind: 'percent', valueBps: 1_000, categoryIds: [parent] });

    const answer = await quote({ lines: [{ skuIndex: 2, qty: 1 }], codes: [word] });
    expect(answer.discountPoisha).toBe(15_000n);
  });

  it('prices a buy-X-get-Y code at the desk from the units on the order', async () => {
    const word = `DSK${randomUUID().slice(0, 6).toUpperCase()}`;
    await createDiscount({ code: word, kind: 'buy_x_get_y', buyQuantity: 2, getQuantity: 1 });
    const admin = await harness.asRole('org_admin', ORG_A);

    const response = await admin.client.request('POST', '/v1/orders', {
      body: {
        channel: 'phone',
        customerId,
        deliveryChargePoisha: '6000',
        promoCode: word,
        lines: [{ skuId: sku(0).id, qty: 3, unitPricePoisha: SHELF.toString() }],
      },
    });

    expect(response.statusCode, response.body).toBe(201);
    // ৳4,500 for three, one of them free (৳1,500), plus ৳60 delivery.
    expect(JSON.parse(response.body)).toMatchObject({ codAmountPoisha: '306000' });
  });

  it('titles a code made before M35a with its own word (the 0111 backfill, ledger audit W2)', async () => {
    // A code as M16 left it: no title. Then 0111's own statement, run as the migration runs
    // it: as the owner, with no org context of its own.
    const word = `OLD${randomUUID().slice(0, 6).toUpperCase()}`;
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into promo.codes (org_id, code, kind, value_bps, created_by)
          values (${ORG_A}, ${word}, 'percent', 500, ${ACTOR})
        `),
      { orgId: ORG_A },
    );
    const { readFileSync } = await import('node:fs');
    const migration = readFileSync(
      new URL(
        '../../../../../packages/db/migrations/0111_m35a_offers_integrity.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const backfill = migration.slice(migration.indexOf('DO $$'), migration.indexOf('$$;') + 3);
    const title = await withSystem(
      async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', '', true)`);
        await tx.execute(sql.raw(backfill));
        await tx.execute(sql`select set_config('app.org_id', ${ORG_A}, true)`);
        const rows = await tx.execute<{ title: string }>(sql`
          select title from promo.codes where org_id = ${ORG_A} and code = ${word}
        `);
        return rows[0]?.title;
      },
      { orgId: ORG_A },
    );
    expect(title).toBe(word);
  });

  it('refuses an automatic discount with a code, and a code without one', async () => {
    for (const body of [
      { method: 'automatic', code: 'AUTOWORD', title: 'x', kind: 'percent', valueBps: 100 },
      { method: 'automatic', kind: 'percent', valueBps: 100 },
      { kind: 'buy_x_get_y', code: 'BXGYBAD', buyQuantity: 1 },
      { kind: 'tiered', code: 'TIERBAD' },
    ]) {
      const response = await marketing.client.request('POST', '/v1/promo/codes', { body });
      expect(response.statusCode, response.body).toBe(400);
    }
  });
});
