import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActiveContext } from '../../platform/http/context.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
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
  readonly categoryIds?: readonly string[];
  readonly valueBps?: number;
}): Promise<{ id: string; word: string }> {
  const word = `T${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const id = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into promo.codes (org_id, code, kind, value_bps, total_limit, category_ids, created_by)
          values (${ORG_A}, ${word}, 'percent', ${fields.valueBps ?? 1000},
                  ${fields.totalLimit ?? null},
                  ${JSON.stringify(fields.categoryIds ?? [])}::jsonb, ${ACTOR})
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

function apply(word: string, orderId: string) {
  return withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
    api.applyToOrder(tx, context(), {
      code: word,
      orderId,
      customerId,
      channel: 'desk',
      lines: [{ skuId: saree.id, netPoisha: PRICE.toString() }],
      deliveryChargePoisha: '6000',
    }),
  );
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
    expect(String((lost[0] as PromiseRejectedResult).reason)).toMatch(/as many times as it allows/);

    // The count and the ledger agree, and neither went past the limit.
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
        channel: 'desk',
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
      channel: 'desk',
      customerId,
    });

    // 20% of the ৳1,000 saree line only; the ৳3,000 panjabi is in another category.
    expect(answer).toMatchObject({ ok: true, discountPoisha: '20000' });
  });
});
