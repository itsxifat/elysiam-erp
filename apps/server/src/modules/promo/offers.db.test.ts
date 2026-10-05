import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { bestFlashOffer, planFlashLines } from '@elysium/domain/promo';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, type SeededSku } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { PROMO_API, type PromoApi } from './promo.api.js';

/**
 * Offers against real Postgres (M35a; D-541, D-542).
 *
 * Acceptance check 1 is the first block: a flash sale with five units, twenty orders
 * claiming one each at the same instant, exactly five sold; and a cancel that gives its unit
 * back exactly once, through the order's real cancel transition. Around it, what only a
 * database can prove: the savepoint that makes a claim all-or-nothing even for a caller who
 * catches the refusal, the price and window conditions inside the claim's UPDATE, a partial
 * return, the editor over HTTP, and the website's discount quote and redemptions.
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

async function order(buyer = customerId, status: 'pending' | 'cancelled' = 'pending') {
  const seeded = await seedOrder(ORG_A, {
    status,
    customerId: buyer,
    lines: [
      {
        skuId: sku(0).id,
        skuCode: sku(0).code,
        productName: 'Offer product',
        qty: 1,
        unitPricePoisha: SHELF,
      },
    ],
  });
  return seeded.id;
}

/** A sale written directly: the fixture for the claim tests, which do not test the editor. */
async function sale(input: {
  readonly items: readonly { skuId: string; price: bigint; limit: number | null }[];
  readonly enabled?: boolean;
  readonly startsAt?: Date | null;
  readonly endsAt?: Date | null;
  readonly priority?: number;
}): Promise<{ saleId: string; itemIds: string[] }> {
  return withSystem(
    async (tx) => {
      const slug = `t-${randomUUID().slice(0, 8)}`;
      const [row] = await tx.execute<{ id: string }>(sql`
        insert into promo.flash_sales (
          org_id, title, slug, enabled, priority, starts_at, ends_at, created_by)
        values (${ORG_A}, 'Test sale', ${slug}, ${input.enabled ?? true}, ${input.priority ?? 0},
                ${input.startsAt === undefined ? new Date(Date.now() - HOUR).toISOString() : (input.startsAt?.toISOString() ?? null)}::timestamptz,
                ${input.endsAt === undefined ? new Date(Date.now() + HOUR).toISOString() : (input.endsAt?.toISOString() ?? null)}::timestamptz,
                ${ACTOR})
        returning id
      `);
      const saleId = row?.id ?? '';
      const itemIds: string[] = [];
      for (const item of input.items) {
        const [itemRow] = await tx.execute<{ id: string }>(sql`
          insert into promo.flash_sale_items (org_id, flash_sale_id, sku_id, sale_price_poisha, unit_limit)
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

function claim(orderId: string, itemId: string, qty = 1, price = 100_000n, skuIndex = 0) {
  return withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    api.claimFlashUnits(tx, ORG_A, {
      orderId,
      lines: [{ skuId: sku(skuIndex).id, qty, flashSaleItemId: itemId, salePricePoisha: price }],
      now: new Date(),
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
  let winners: string[] = [];

  it('sells exactly five of five units to twenty orders claiming at once', async () => {
    ({
      itemIds: [itemId = ''],
    } = await sale({ items: [{ skuId: sku(0).id, price: 100_000n, limit: 5 }] }));
    const orders = await Promise.all(Array.from({ length: 20 }, () => order()));

    /*
     * Twenty transactions started together. `withOrg` borrows from the real pool, so ten
     * hold a connection at any instant; the barrier makes those ten each open and waiting
     * before any of them claims, so ten copies of the conditional UPDATE contend for one row
     * at once, and the ten queued behind them then find the units gone (the shape of M07's
     * reservation race, `inventory.db.test.ts`).
     */
    const ready = barrier(10);
    const results = await Promise.allSettled(
      orders.map((orderId) =>
        withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
          // Every transaction is open and has done work before any claims.
          await tx.execute(sql`select 1`);
          await ready();
          await api.claimFlashUnits(tx, ORG_A, {
            orderId,
            lines: [
              {
                skuId: sku(0).id,
                qty: 1,
                flashSaleItemId: itemId,
                salePricePoisha: 100_000n,
              },
            ],
            now: new Date(),
          });
          return orderId;
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
    const [cancelled = ''] = winners;
    const response = await marketingAdminCancel(cancelled);
    expect(response.statusCode, response.body).toBeLessThan(300);

    let state = await itemState(itemId);
    expect(state.sold).toBe(4);
    expect(state.claims.filter((row) => row.status === 'released')).toEqual([
      { status: 'released', qty: 1, released_qty: 1 },
    ]);

    // Told again, by a second cancel and by a direct release: nothing more goes back.
    const again = await marketingAdminCancel(cancelled);
    expect(again.statusCode).toBe(409);
    const released = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, cancelled),
    );
    expect(released).toBe(0);
    state = await itemState(itemId);
    expect(state.sold).toBe(4);

    // And the unit is there to be sold again.
    await claim(await order(), itemId);
    expect((await itemState(itemId)).sold).toBe(5);
  });

  async function marketingAdminCancel(orderId: string) {
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
    const stale = await order();
    await expect(claim(stale, live.itemIds[0] ?? '', 1, 95_000n, 1)).rejects.toMatchObject(refused);
    for (const offer of [later, over, off]) {
      await expect(
        claim(await order(), offer.itemIds[0] ?? '', 1, 90_000n, 1),
      ).rejects.toMatchObject(refused);
    }
    await claim(stale, live.itemIds[0] ?? '', 1, 90_000n, 1);
    expect((await itemState(live.itemIds[0] ?? '')).sold).toBe(1);
  });

  it('takes nothing when one line is refused, even if the caller catches it and commits', async () => {
    const plenty = await sale({ items: [{ skuId: sku(2).id, price: 80_000n, limit: 10 }] });
    const scarce = await sale({ items: [{ skuId: sku(3).id, price: 80_000n, limit: 1 }] });
    await claim(await order(), scarce.itemIds[0] ?? '', 1, 80_000n, 3);

    const orderId = await order();
    const caught = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      try {
        await api.claimFlashUnits(tx, ORG_A, {
          orderId,
          lines: [
            {
              skuId: sku(2).id,
              qty: 3,
              flashSaleItemId: plenty.itemIds[0] ?? '',
              salePricePoisha: 80_000n,
            },
            {
              skuId: sku(3).id,
              qty: 1,
              flashSaleItemId: scarce.itemIds[0] ?? '',
              salePricePoisha: 80_000n,
            },
          ],
          now: new Date(),
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
    const orderId = await order();
    await claim(orderId, all.itemIds[0] ?? '', 40, 70_000n, 2);
    await claim(orderId, all.itemIds[0] ?? '', 40, 70_000n, 2);
    expect((await itemState(all.itemIds[0] ?? '')).sold).toBe(40);
  });

  it('gives back only the returned units after a partial delivery, once', async () => {
    const offer = await sale({ items: [{ skuId: sku(1).id, price: 60_000n, limit: 10 }] });
    const orderId = await order();
    await claim(orderId, offer.itemIds[0] ?? '', 3, 60_000n, 1);

    const returned = [{ skuId: sku(1).id, qty: 1 }];
    const first = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, orderId, returned),
    );
    const second = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, orderId, returned),
    );

    expect([first, second]).toEqual([1, 0]);
    expect(await itemState(offer.itemIds[0] ?? '')).toEqual({
      sold: 2,
      claims: [{ status: 'released', qty: 3, released_qty: 1 }],
    });
  });

  it('refuses to change or remove a claim once it is released', async () => {
    const offer = await sale({ items: [{ skuId: sku(1).id, price: 60_000n, limit: 10 }] });
    const orderId = await order();
    await claim(orderId, offer.itemIds[0] ?? '', 1, 60_000n, 1);
    await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseFlashUnits(tx, ORG_A, orderId),
    );

    const change = await failure(
      withSystem(
        (tx) =>
          tx.execute(
            sql`update promo.flash_claims set released_qty = 0 where order_id = ${orderId}`,
          ),
        { orgId: ORG_A },
      ),
    );
    const remove = await failure(
      withSystem(
        (tx) => tx.execute(sql`delete from promo.flash_claims where order_id = ${orderId}`),
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
    await claim(await order(), firstItem, 2, 120_000n, 0);
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
    expect(answer.refused).toEqual([{ code: 'NOPE123', reason: 'not_found' }]);

    // The desk does not see automatic discounts (D-544).
    expect((await quote({ lines: [{ skuIndex: 0, qty: 3 }], automatic: false })).applied).toEqual(
      [],
    );

    const orderId = await order();
    const { redemptionIds } = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.redeem(tx, ORG_A, { orderId, customerId, applied: answer.applied }),
    );
    expect(redemptionIds).toHaveLength(2);
    const released = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseForOrder(tx, ORG_A, orderId),
    );
    expect(released).toBe(true);
    const statuses = await withSystem(
      (tx) =>
        tx.execute<{ status: string }>(sql`
          select status from promo.redemptions where org_id = ${ORG_A} and order_id = ${orderId}
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
    await order(cancelledOnly, 'cancelled');

    for (const buyer of [fresh, cancelledOnly, null]) {
      const answer = await quote({ lines: [{ skuIndex: 0, qty: 1 }], codes: [word], buyer });
      expect(answer.applied.map((entry) => entry.discountId)).toEqual([id]);
    }
    // `customerId` has ordered before (the suites above took orders for them).
    const returning = await quote({ lines: [{ skuIndex: 0, qty: 1 }], codes: [word] });
    expect(returning.refused).toEqual([{ code: word, reason: 'first_order_only' }]);
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
