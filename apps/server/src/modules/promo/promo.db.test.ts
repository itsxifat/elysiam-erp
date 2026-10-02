import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActiveContext } from '../../platform/http/context.js';
import {
  createBranch,
  ORG_A,
  startHttpHarness,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, type SeededSku } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { PROMO_API, type PromoApi } from './promo.api.js';
import { PromoService } from './promo.service.js';

/**
 * Promo codes against real Postgres (M16; architecture §10).
 *
 * The domain's table-driven tests (`packages/domain/src/promo`) are acceptance check 3:
 * what a code is worth for a basket, and every reason it is not. These are the parts
 * only a database can prove, and the plan's risks name them:
 *
 * - **The last use of a code, claimed twice at once.** The guard is a conditional UPDATE
 *   on `used_count`, not a read; the race below runs two real transactions against it.
 * - **A retried order applies a code once.** The unique index per (code, order) decides,
 *   and the use claimed by the retry is given back.
 * - **A cancel returns the use once.** Delivered twice, it must not return two.
 * - **The check never spends anything.** It is a read.
 * - **A category-scoped code reads the category through `CatalogApi`**, which is the
 *   change this milestone made to keep invariant 12.
 */

const ACTOR = 'usr_promo_db';
const PRICE = 150_000n;

let harness: HttpHarness;
let promo: PromoService;
let api: PromoApi;
let customerId = '';
let saree: SeededSku;
let panjabi: SeededSku;
let sareeCategory = '';

function context(): ActiveContext {
  return {
    userId: ACTOR,
    orgId: ORG_A,
    roles: ['org_admin'],
    branchIds: [],
    isSuperAdmin: false,
    requestId: randomUUID(),
  } as unknown as ActiveContext;
}

beforeAll(async () => {
  harness = await startHttpHarness('promo-db');
  promo = harness.app.get(PromoService);
  api = harness.app.get<PromoApi>(PROMO_API, { strict: false });

  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000999', name: 'Promo Buyer' });
  // Two products in two categories, so a category-scoped code has something to exclude.
  [saree] = (await seedProductWithSkus(ORG_A, 'promosar', 1)).skus as [SeededSku];
  [panjabi] = (await seedProductWithSkus(ORG_A, 'promopan', 1)).skus as [SeededSku];
  sareeCategory = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ category_id: string }>(sql`
          select p.category_id from catalog.skus s
          join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
          where s.org_id = ${ORG_A} and s.id = ${saree.id}
        `)
      )[0]?.category_id ?? '',
    { orgId: ORG_A },
  );
}, 600_000);

afterAll(async () => {
  await harness?.close();
}, 120_000);

async function code(fields: {
  readonly totalLimit?: number;
  readonly perCustomerLimit?: number;
  readonly categoryIds?: readonly string[];
  readonly valueBps?: number;
  readonly channels?: readonly string[];
}): Promise<{ id: string; word: string }> {
  const word = `T${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const id = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into promo.codes (
            org_id, code, kind, value_bps, total_limit, per_customer_limit, category_ids,
            channels, created_by)
          values (${ORG_A}, ${word}, 'percent', ${fields.valueBps ?? 1000},
                  ${fields.totalLimit ?? null}, ${fields.perCustomerLimit ?? null},
                  ${JSON.stringify(fields.categoryIds ?? [])}::jsonb,
                  ${JSON.stringify(fields.channels ?? [])}::jsonb, ${ACTOR})
          returning id
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
  return { id, word };
}

async function order(): Promise<string> {
  const seeded = await seedOrder(ORG_A, {
    status: 'pending',
    customerId,
    lines: [
      {
        skuId: saree.id,
        skuCode: saree.code,
        productName: 'Saree',
        qty: 1,
        unitPricePoisha: PRICE,
      },
    ],
  });
  return seeded.id;
}

async function state(codeId: string) {
  return withSystem(
    async (tx) => {
      const [row] = await tx.execute<{ used_count: number }>(
        sql`select used_count from promo.codes where org_id = ${ORG_A} and id = ${codeId}`,
      );
      const redemptions = await tx.execute<{ status: string }>(
        sql`select status from promo.redemptions where org_id = ${ORG_A} and code_id = ${codeId}`,
      );
      return { used: row?.used_count ?? -1, redemptions: [...redemptions].map((r) => r.status) };
    },
    { orgId: ORG_A },
  );
}

/**
 * Both phases in one transaction, as the order desk does it: price, then redeem against
 * the order. The race is between two of these transactions, and only the redeem phase's
 * conditional UPDATE stands between them.
 */
function apply(word: string, orderId: string) {
  return withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
    const priced = await api.priceForOrder(tx, context(), {
      code: word,
      customerId,
      channel: 'phone',
      lines: [{ skuId: saree.id, netPoisha: PRICE.toString() }],
      deliveryChargePoisha: '6000',
    });
    const { redemptionId } = await api.redeemForOrder(tx, context(), priced, orderId);
    return { redemptionId, discountPoisha: priced.discountPoisha };
  });
}

describe('a promo code against real Postgres', () => {
  it('gives the last use to exactly one of two orders claiming it at once', async () => {
    const { id, word } = await code({ totalLimit: 1 });
    const [first, second] = [await order(), await order()];

    // Two transactions, started together. A read-then-write guard lets both through;
    // the conditional UPDATE lets the row lock decide.
    const results = await Promise.allSettled([apply(word, first), apply(word, second)]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(String(lost[0]?.reason)).toMatch(/as many times as it allows/);

    // The count and the ledger agree, and neither went past the limit.
    expect(await state(id)).toEqual({ used: 1, redemptions: ['applied'] });
  });

  it('refuses a buyer’s second use when another order took it between the check and the claim', async () => {
    const { id, word } = await code({ perCustomerLimit: 1 });
    const [first, second] = [await order(), await order()];

    // Deterministic, not a hopeful race: the first transaction prices the code (and sees
    // no use by this buyer), then waits; the second applies and commits; then the first
    // redeems. Only a re-count under the claim's lock can see the second's use.
    let priced!: () => void;
    const pricedSignal = new Promise<void>((resolve) => {
      priced = resolve;
    });
    let resume!: () => void;
    const resumeSignal = new Promise<void>((resolve) => {
      resume = resolve;
    });

    const late = withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const quote = await api.priceForOrder(tx, context(), {
        code: word,
        customerId,
        channel: 'phone',
        lines: [{ skuId: saree.id, netPoisha: PRICE.toString() }],
        deliveryChargePoisha: '6000',
      });
      priced();
      await resumeSignal;
      return api.redeemForOrder(tx, context(), quote, first);
    });

    await pricedSignal;
    await apply(word, second);
    resume();

    await expect(late).rejects.toMatchObject({ response: { reason: 'customer_limit_reached' } });
    expect(await state(id)).toEqual({ used: 1, redemptions: ['applied'] });
  });

  it('applies a code once to an order however many times the order is retried', async () => {
    const { id, word } = await code({});
    const orderId = await order();

    const once = await apply(word, orderId);
    const again = await apply(word, orderId);

    expect(again.redemptionId).toBe(once.redemptionId);
    // ৳1,500 at 10%, from the server's own pricing — never a number the caller sent.
    expect(once.discountPoisha).toBe(15_000n);
    // The retry claimed a use and gave it straight back: one use, one redemption.
    expect(await state(id)).toEqual({ used: 1, redemptions: ['applied'] });
  });

  it('gives the use back once when the order is cancelled, however often it is told', async () => {
    const { id, word } = await code({ totalLimit: 5 });
    const orderId = await order();
    await apply(word, orderId);

    const released = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseForOrder(tx, ORG_A, orderId),
    );
    const twice = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      api.releaseForOrder(tx, ORG_A, orderId),
    );

    expect(released).toBe(true);
    expect(twice).toBe(false);
    expect(await state(id)).toEqual({ used: 0, redemptions: ['released'] });
  });

  it('spends nothing when the desk only asks what a code is worth', async () => {
    const { id, word } = await code({ totalLimit: 1 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await promo.check(context(), {
        code: word,
        lines: [{ skuId: saree.id, netPoisha: PRICE.toString() }],
        deliveryChargePoisha: '6000',
        channel: 'phone',
        customerId,
      });
      expect(answer).toMatchObject({ ok: true, discountPoisha: '15000' });
    }

    // Asked three times of a one-use code, and the use is still there to be spent.
    expect(await state(id)).toEqual({ used: 0, redemptions: [] });
  });

  it('discounts only the lines in a scoped category, read through the catalog module', async () => {
    const { word } = await code({ categoryIds: [sareeCategory], valueBps: 2000 });

    const answer = await promo.check(context(), {
      code: word,
      lines: [
        { skuId: saree.id, netPoisha: '100000' },
        { skuId: panjabi.id, netPoisha: '300000' },
      ],
      deliveryChargePoisha: '6000',
      channel: 'phone',
      customerId,
    });

    // 20% of the ৳1,000 saree line only; the ৳3,000 panjabi is in another category.
    expect(answer).toMatchObject({ ok: true, discountPoisha: '20000' });
  });
});

/**
 * The order desk, end to end on the server (M16 check 5's server half).
 *
 * Through `POST /v1/orders`, so the controller, the order's own transaction and the promo
 * port are all the real ones. The desk sends a code word and nothing else about the
 * discount: these prove the order carries what the server worked out, that a cancel gives
 * the use back, and that an order the code cannot pay for is never written at all.
 */
describe('a promo code on an order taken at the desk', () => {
  async function takeOrder(word: string, channel = 'phone') {
    const admin = await harness.asRole('org_admin', ORG_A);
    return admin.client.request('POST', '/v1/orders', {
      body: {
        channel,
        customerId,
        deliveryChargePoisha: '6000',
        promoCode: word,
        lines: [{ skuId: saree.id, qty: 1, unitPricePoisha: PRICE.toString() }],
      },
    });
  }

  async function ordersWith(codeId: string): Promise<number> {
    return withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from sales.orders
            where org_id = ${ORG_A} and promo_code_id = ${codeId}
          `)
        )[0]?.n ?? 0,
      { orgId: ORG_A },
    );
  }

  it('writes the discount the server worked out, and records the redemption', async () => {
    const { id, word } = await code({});

    const response = await takeOrder(word);

    expect(response.statusCode, response.body).toBe(201);
    // ৳1,500 less 10% (৳150) plus ৳60 delivery: the desk sent the word, not ৳150.
    expect(JSON.parse(response.body)).toMatchObject({ codAmountPoisha: '141000' });
    expect(await state(id)).toEqual({ used: 1, redemptions: ['applied'] });
    expect(await ordersWith(id)).toBe(1);
  });

  it('gives the use back when that order is cancelled before it ships', async () => {
    const { id, word } = await code({ totalLimit: 3 });
    const created = JSON.parse((await takeOrder(word)).body) as { id: string };

    const admin = await harness.asRole('org_admin', ORG_A);
    const cancelled = await admin.client.request('POST', `/v1/orders/${created.id}/cancel`, {
      body: { reason: 'Buyer changed their mind' },
    });

    expect(cancelled.statusCode, cancelled.body).toBeLessThan(300);
    expect(await state(id)).toEqual({ used: 0, redemptions: ['released'] });
  });

  it('refuses a code for another channel, and writes no order', async () => {
    // The vocabulary the desk really sends. M16's first cut compared against `web` and
    // `desk`, which no order carries, so a channel-scoped code could never match.
    const { id, word } = await code({ channels: ['facebook'] });

    const response = await takeOrder(word, 'phone');

    expect(response.statusCode, response.body).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'PROMO_NOT_APPLICABLE',
      reason: 'wrong_channel',
    });
    expect(await ordersWith(id)).toBe(0);
    expect(await state(id)).toEqual({ used: 0, redemptions: [] });
  });

  it('accepts the same code on the channel it is for', async () => {
    const { id, word } = await code({ channels: ['facebook'] });

    const response = await takeOrder(word, 'facebook');

    expect(response.statusCode, response.body).toBe(201);
    expect(await state(id)).toEqual({ used: 1, redemptions: ['applied'] });
  });

  it('rolls the whole order back when the code has run out, rather than keep a discount', async () => {
    const { id, word } = await code({ totalLimit: 1 });
    expect((await takeOrder(word)).statusCode).toBe(201);

    const second = await takeOrder(word);

    expect(second.statusCode, second.body).toBe(409);
    // One order, one use: the second order does not exist, with or without the discount.
    expect(await ordersWith(id)).toBe(1);
    expect(await state(id)).toEqual({ used: 1, redemptions: ['applied'] });
  });
});

describe('a branch manager reads codes without the scope backstop firing (W6)', () => {
  it('lists codes and checks one with a branch-scoped grant', async () => {
    const branch = await createBranch(ORG_A, 'PRM-BR');
    const manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branch] });

    // Before the routes declared that a code has no branch, each of these was a 500 from
    // `ScopeNotAppliedError`; the route matrix missed it because its branch manager is
    // org-wide.
    const list = await manager.client.request('GET', '/v1/promo/codes');
    expect(list.statusCode, list.body).toBe(200);
  });
});
