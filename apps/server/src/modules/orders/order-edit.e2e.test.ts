import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { OrdersModule } from './orders.module.js';
import {
  applyOrderMigrations,
  ownRiderCourier,
  seedCustomer,
  seedOrder,
  seedStockLevel,
} from './orders.testing.js';

/**
 * The order editor (M50, D-921 to D-924), over HTTP against real PostgreSQL.
 *
 * - An edit names its offers: the order's discounts are given back and the chosen ones taken
 *   again, the same code included (0164's index counts applied redemptions only), and an offer
 *   the basket no longer qualifies for is listed with its reason and refused on save.
 * - A packed order is replaced, not edited: cancelled, and a confirmed replacement created in
 *   the same transaction, each naming the other.
 * - A return re-prices what the buyer kept with the offers chosen and the charge typed.
 */

let harness: HttpHarness;
let admin: RoleClient;
let location = '';
let customerId = '';
let courierId = '';
let skus: SeededSku[] = [];

beforeAll(async () => {
  harness = await startHttpHarness('order-edit-e2e', { extraModules: [OrdersModule] });
  await applyOrderMigrations();
  location = await warehouseId(ORG_A);
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711998877', name: 'Nusrat Jahan' });
  courierId = await ownRiderCourier(ORG_A);
  // Three SKUs at Tk 1,500 each.
  ({ skus } = await seedProductWithSkus(ORG_A, 'orderedit', 3));
  for (const sku of skus) {
    await seedStockLevel(ORG_A, {
      skuId: sku.id,
      locationId: location,
      qty: 50,
      unitCostPoisha: 60_000n,
    });
  }
  admin = await harness.asRole('org_admin', ORG_A);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

function sku(index: number): SeededSku {
  const found = skus[index];
  if (found === undefined) throw new Error(`no fixture SKU ${String(index)}`);
  return found;
}

async function call<T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown) {
  const response = await admin.client.request(method, url, body === undefined ? {} : { body });
  return { status: response.statusCode, body: json<T>(response) };
}

async function ok<T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
  const response = await call<T>(method, url, body);
  if (response.status >= 300) {
    throw new Error(
      `${method} ${url} answered ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

interface OrderBody {
  readonly id: string;
  readonly orderNo: string;
  readonly status: string;
  readonly amounts: {
    readonly discountPoisha: string;
    readonly codAmountPoisha: string;
    readonly deliveryChargePoisha: string;
  };
  readonly appliedOffers: readonly { readonly discountId: string }[];
  readonly replaces: { readonly id: string } | null;
  readonly replacedBy: { readonly id: string } | null;
}

interface OffersBody {
  readonly offers: readonly {
    readonly discountId: string;
    readonly qualifies: boolean;
    readonly reason: string | null;
    readonly discountPoisha: string;
  }[];
  readonly applied: readonly { readonly discountId: string }[];
  readonly totals?: { readonly codAmountPoisha: string };
  readonly collectPoisha?: string;
  readonly expectedPoisha?: string;
}

async function usedCount(codeId: string): Promise<number> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ used_count: number }>(
        sql`select used_count from promo.codes where id = ${codeId}`,
      );
      return rows[0]?.used_count ?? -1;
    },
    { orgId: ORG_A },
  );
}

describe('editing an order with offers (D-921)', () => {
  it('gives the order’s discounts back, takes the chosen ones, and lists what no longer applies', async () => {
    const tenOff = await ok<{ id: string }>('POST', '/v1/promo/codes', {
      code: 'EDITTEN',
      kind: 'percent',
      valueBps: 1000,
      minOrderPoisha: '250000',
    });
    const flat = await ok<{ id: string }>('POST', '/v1/promo/codes', {
      code: 'EDITFLAT',
      kind: 'flat',
      valuePoisha: '5000',
    });

    const created = await ok<{ id: string }>('POST', '/v1/orders', {
      channel: 'phone',
      customerId,
      promoCode: 'EDITTEN',
      deliveryChargePoisha: '6000',
      lines: [
        { skuId: sku(0).id, qty: 1 },
        { skuId: sku(1).id, qty: 1 },
      ],
    });
    expect(await usedCount(tenOff.id)).toBe(1);

    // One piece is taken off: Tk 1,500 is below the code's Tk 2,500.
    const quote = await ok<OffersBody>('POST', `/v1/orders/${created.id}/offers`, {
      mode: 'edit',
      lines: [{ skuId: sku(0).id, qty: 1 }],
      deliveryChargePoisha: '6000',
      discountIds: [flat.id],
    });
    expect(quote.offers.find((offer) => offer.discountId === tenOff.id)).toMatchObject({
      qualifies: false,
      reason: 'min_order_not_met',
    });
    expect(quote.offers.find((offer) => offer.discountId === flat.id)).toMatchObject({
      qualifies: true,
      discountPoisha: '5000',
    });
    expect(quote.totals?.codAmountPoisha).toBe('151000');

    const refused = await call('PATCH', `/v1/orders/${created.id}`, {
      lines: [{ skuId: sku(0).id, qty: 1 }],
      deliveryChargePoisha: '6000',
      discountIds: [tenOff.id],
    });
    expect(refused.status).toBe(409);

    await ok('PATCH', `/v1/orders/${created.id}`, {
      lines: [{ skuId: sku(0).id, qty: 1 }],
      deliveryChargePoisha: '6000',
      discountIds: [flat.id],
    });
    const edited = await ok<OrderBody>('GET', `/v1/orders/${created.id}`);
    expect(edited.amounts.discountPoisha).toBe('5000');
    expect(edited.amounts.codAmountPoisha).toBe('151000');
    expect(edited.appliedOffers.map((offer) => offer.discountId)).toEqual([flat.id]);
    expect(await usedCount(tenOff.id)).toBe(0);
    expect(await usedCount(flat.id)).toBe(1);

    // Both pieces back, and the first code again: a released use does not block a new one.
    await ok('PATCH', `/v1/orders/${created.id}`, {
      lines: [
        { skuId: sku(0).id, qty: 1 },
        { skuId: sku(1).id, qty: 1 },
      ],
      deliveryChargePoisha: '6000',
      discountIds: [tenOff.id],
    });
    const again = await ok<OrderBody>('GET', `/v1/orders/${created.id}`);
    expect(again.amounts.discountPoisha).toBe('30000');
    expect(again.appliedOffers.map((offer) => offer.discountId)).toEqual([tenOff.id]);
    expect(await usedCount(tenOff.id)).toBe(1);
    expect(await usedCount(flat.id)).toBe(0);
  });
});

describe('replacing a packed order (D-922)', () => {
  it('cancels it and creates a confirmed replacement in one transaction', async () => {
    const packed = await seedOrder(ORG_A, {
      status: 'packed',
      customerId,
      locationId: location,
      courierId,
      reserve: true,
      lines: [
        {
          skuId: sku(0).id,
          skuCode: sku(0).code,
          productName: 'Order edit fixture',
          qty: 1,
          unitPricePoisha: 150_000n,
        },
      ],
    });

    const notPacked = await seedOrder(ORG_A, {
      status: 'confirmed',
      customerId,
      locationId: location,
      reserve: true,
      lines: [
        {
          skuId: sku(0).id,
          skuCode: sku(0).code,
          productName: 'Order edit fixture',
          qty: 1,
          unitPricePoisha: 150_000n,
        },
      ],
    });
    const wrong = await call('POST', `/v1/orders/${notPacked.id}/replace`, {
      reason: 'Size change',
      lines: [{ skuId: sku(1).id, qty: 1 }],
    });
    expect(wrong.status).toBe(409);

    const replaced = await ok<{ id: string; orderNo: string }>(
      'POST',
      `/v1/orders/${packed.id}/replace`,
      { reason: 'The buyer wants another size', lines: [{ skuId: sku(2).id, qty: 2 }] },
    );
    const original = await ok<OrderBody>('GET', `/v1/orders/${packed.id}`);
    expect(original.status).toBe('cancelled');
    expect(original.replacedBy?.id).toBe(replaced.id);
    const replacement = await ok<OrderBody>('GET', `/v1/orders/${replaced.id}`);
    expect(replacement.status).toBe('confirmed');
    expect(replacement.replaces?.id).toBe(packed.id);
    expect(replacement.amounts.codAmountPoisha).toBe('306000');
  });
});

describe('re-pricing a return (D-924)', () => {
  it('collects what was kept, with the offer chosen and the charge typed', async () => {
    const shipped = await seedOrder(ORG_A, {
      status: 'shipped',
      customerId,
      locationId: location,
      courierId,
      discountPoisha: 30_000n,
      lines: [0, 1].map((index) => ({
        skuId: sku(index).id,
        skuCode: sku(index).code,
        productName: 'Order edit fixture',
        qty: 1,
        unitPricePoisha: 150_000n,
        dispatchUnitCostPoisha: 60_000n,
      })),
    });
    const flat = await ok<{ id: string }>('POST', '/v1/promo/codes', {
      code: 'RETFLAT',
      kind: 'flat',
      valuePoisha: '10000',
    });

    const whole = await ok<OffersBody & { wholeReturn: boolean }>(
      'POST',
      `/v1/orders/${shipped.id}/offers`,
      {
        mode: 'return',
        keep: [
          { skuId: sku(0).id, qty: 0 },
          { skuId: sku(1).id, qty: 0 },
        ],
        deliveryChargePoisha: '6000',
        discountIds: [],
      },
    );
    expect(whole.wholeReturn).toBe(true);

    const part = await ok<OffersBody>('POST', `/v1/orders/${shipped.id}/offers`, {
      mode: 'return',
      keep: [
        { skuId: sku(0).id, qty: 1 },
        { skuId: sku(1).id, qty: 0 },
      ],
      deliveryChargePoisha: '5000',
      discountIds: [flat.id],
    });
    // §7 expects half the order's Tk 300 off on the kept piece, with the Tk 60 charge.
    expect(part.expectedPoisha).toBe(String(150_000 - 15_000 + 6_000));
    // Kept Tk 1,500 with its Tk 150 share of the typed discount, Tk 100 off, Tk 50 charge.
    expect(part.collectPoisha).toBe(String(150_000 - 15_000 - 10_000 + 5_000));
    expect(part.applied.map((entry) => entry.discountId)).toEqual([flat.id]);

    // Nothing chosen and the charge unchanged: the order's own terms, no difference to book.
    const plain = await ok<OffersBody>('POST', `/v1/orders/${shipped.id}/offers`, {
      mode: 'return',
      keep: [
        { skuId: sku(0).id, qty: 1 },
        { skuId: sku(1).id, qty: 0 },
      ],
      deliveryChargePoisha: '6000',
      discountIds: [],
    });
    expect(plain.collectPoisha).toBe(plain.expectedPoisha);
  });
});

describe('who may apply offers (D-921, ledger audit C2)', () => {
  it('refuses a role without the apply-codes grant, and shows resellers no offers', async () => {
    const warehouse = await harness.asRole('warehouse', ORG_A);
    const reseller = await harness.asRole('reseller', ORG_A);
    const code = await ok<{ id: string }>('POST', '/v1/promo/codes', {
      code: 'ROLEFLAT',
      kind: 'flat',
      valuePoisha: '5000',
    });
    const pending = await seedOrder(ORG_A, {
      status: 'pending',
      customerId,
      locationId: location,
      lines: [
        {
          skuId: sku(0).id,
          skuCode: sku(0).code,
          productName: 'Order edit fixture',
          qty: 1,
          unitPricePoisha: 150_000n,
        },
      ],
    });
    const refused = await warehouse.client.request('PATCH', `/v1/orders/${pending.id}`, {
      body: {
        lines: [{ skuId: sku(0).id, qty: 1 }],
        deliveryChargePoisha: '6000',
        discountIds: [code.id],
      },
    });
    expect(refused.statusCode).toBe(403);

    const harvest = await reseller.client.request('POST', `/v1/orders/${pending.id}/offers`, {
      body: {
        mode: 'edit',
        lines: [{ skuId: sku(0).id, qty: 1 }],
        deliveryChargePoisha: '6000',
        discountIds: [],
      },
    });
    expect(harvest.statusCode).toBe(403);

    // Accounts reads orders but may not apply codes: the offers come without their words.
    const accounts = await harness.asRole('accounts', ORG_A);
    const quote = await accounts.client.request('POST', `/v1/orders/${pending.id}/offers`, {
      body: {
        mode: 'edit',
        lines: [{ skuId: sku(0).id, qty: 1 }],
        deliveryChargePoisha: '6000',
        discountIds: [],
      },
    });
    expect(quote.statusCode).toBe(200);
    const listed = json<OffersBody & { offers: readonly { code: string | null }[] }>(quote);
    expect(listed.offers.length).toBeGreaterThan(0);
    expect(listed.offers.every((offer) => offer.code === null)).toBe(true);
  });
});
