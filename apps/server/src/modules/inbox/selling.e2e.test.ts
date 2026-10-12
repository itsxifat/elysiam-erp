import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withSystem } from '@elysium/db';
import { internalEan13 } from '@elysium/domain/barcode';
import { draftTotals, recommendSize, type SizeChartTable } from '@elysium/domain/inbox';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedStockLevel } from '../orders/orders.testing.js';

/**
 * M44b on real Postgres, through the real routes (D-770 to D-773): the picker finds a product
 * by a word of its name, its SKU, its parent SKU, its barcode, its website slug and by id, with
 * each size's selling price and the units in hand, and no cost anywhere; a size chart turns
 * "chest 42" into L; another brand and a role without the inbox see none of it; and the panel's
 * draft placed through the order desk's route comes out at the total the panel showed, pending,
 * with nothing reserved, and its advance recorded as a claim.
 */

let harness: HttpHarness;
let sales: RoleClient;
let accounts: RoleClient;
let adminB: RoleClient;
let productId = '';
let skuM = '';
let skuL = '';
let codeM = '';
let barcode = '';
let chartId = '';
let conversationId = '';

const UNIT_COST = 55_511n;

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

interface PickerItem {
  id: string;
  name: string;
  sizeChartId: string | null;
  matchedSkuId: string | null;
  variants: {
    skuId: string;
    size: string | null;
    colour: string | null;
    pricePoisha: string;
    available: number;
  }[];
}

beforeAll(async () => {
  harness = await startHttpHarness('m44b-selling');
  await applyOrderMigrations();
  sales = await harness.asRole('sales', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);

  const seeded = await seedProductWithSkus(ORG_A, 'm44bpanjabi', 2);
  productId = seeded.productId;
  skuM = seeded.skus[0]?.id ?? '';
  skuL = seeded.skus[1]?.id ?? '';
  codeM = seeded.skus[0]?.code ?? '';
  barcode = internalEan13(987_654_321);

  const ids = await withSystem(
    async (tx) => {
      // A size list and a colour list, as the catalog's settings keep them.
      const size = (
        await tx.execute<{ id: string }>(sql`
          insert into catalog.attributes (org_id, code, name, kind)
          values (${ORG_A}, 'M44BSIZE', 'Size', 'size') returning id
        `)
      )[0]?.id;
      const colour = (
        await tx.execute<{ id: string }>(sql`
          insert into catalog.attributes (org_id, code, name, kind)
          values (${ORG_A}, 'M44BCOLOUR', 'Colour', 'colour') returning id
        `)
      )[0]?.id;
      const value = async (attribute: string | undefined, code: string, label: string) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into catalog.attribute_values (org_id, attribute_id, code, label)
            values (${ORG_A}, ${attribute}, ${code}, ${label}) returning id
          `)
        )[0]?.id;
      const m = await value(size, 'M', 'M');
      const l = await value(size, 'L', 'L');
      const black = await value(colour, 'BLK', 'Black');
      for (const [sku, sizeValue] of [
        [skuM, m],
        [skuL, l],
      ] as const) {
        await tx.execute(sql`
          insert into catalog.sku_values (org_id, sku_id, attribute_id, value_id)
          values (${ORG_A}, ${sku}, ${size}, ${sizeValue}), (${ORG_A}, ${sku}, ${colour}, ${black})
        `);
      }
      await tx.execute(sql`update catalog.skus set barcode = ${barcode} where id = ${skuM}`);
      await tx.execute(sql`update catalog.skus set price_poisha = 160000 where id = ${skuL}`);
      const chart = (
        await tx.execute<{ id: string }>(sql`
          insert into storefront.size_charts (org_id, name, columns, rows)
          values (${ORG_A}, 'Panjabi', array['Size', 'Chest (inch)', 'Length'],
                  '[["M", "40", "40"], ["L", "42", "42"], ["XL", "44", "43"]]'::jsonb)
          returning id
        `)
      )[0]?.id;
      await tx.execute(
        sql`update catalog.products set size_chart_id = ${chart}::uuid where id = ${productId}`,
      );

      // A Messenger conversation the customer opened an hour ago.
      const channel = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.channels (org_id, kind, external_id, enabled, updated_by)
          values (${ORG_A}, 'messenger', '900000000044201', true, 'usr_m44b')
          on conflict (org_id, kind) do update set enabled = true
          returning id
        `)
      )[0]?.id;
      const contact = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.contacts (org_id, display_name) values (${ORG_A}, 'Rahim')
          returning id
        `)
      )[0]?.id;
      const identity = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.identities (org_id, contact_id, channel_id, external_user_id)
          values (${ORG_A}, ${contact}, ${channel}, ${`psid-${randomUUID()}`}) returning id
        `)
      )[0]?.id;
      const conversation = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.conversations
            (org_id, channel_id, contact_id, identity_id, last_inbound_at, last_message_at,
             last_preview, last_direction, unread_count)
          values (${ORG_A}, ${channel}, ${contact}, ${identity}, now() - interval '1 hour',
                  now() - interval '1 hour', 'বুকের মাপ ৪২', 'inbound', 1)
          returning id
        `)
      )[0]?.id;
      return { chart, conversation };
    },
    { orgId: ORG_A },
  );
  chartId = ids.chart ?? '';
  conversationId = ids.conversation ?? '';

  await seedStockLevel(ORG_A, {
    skuId: skuM,
    locationId: await warehouseId(ORG_A),
    qty: 5,
    unitCostPoisha: UNIT_COST,
  });
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

async function pick(query: string): Promise<PickerItem[]> {
  const response = await sales.client.request('GET', `/v1/inbox/products?${query}`);
  expect(response.statusCode, response.body).toBe(200);
  expect(findCostFields(JSON.parse(response.body))).toEqual([]);
  expect(response.body).not.toContain(UNIT_COST.toString());
  return json<{ items: PickerItem[] }>(response).items;
}

describe('the product picker (M44b, D-772)', () => {
  it('finds a product by a word of its name, with each size, price and stock, and no cost', async () => {
    const items = await pick('q=m44bpanjabi');
    const product = items.find((item) => item.id === productId);
    expect(product).toMatchObject({ sizeChartId: chartId, matchedSkuId: null });
    expect(product?.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skuId: skuM,
          size: 'M',
          colour: 'Black',
          pricePoisha: '150000',
          available: 5,
        }),
        expect.objectContaining({ skuId: skuL, size: 'L', pricePoisha: '160000', available: 0 }),
      ]),
    );
  });

  it('finds it by SKU, parent SKU, barcode, website slug and id', async () => {
    expect((await pick(`q=${codeM}`))[0]).toMatchObject({ id: productId, matchedSkuId: skuM });
    expect((await pick(`q=${codeM.toLowerCase()}`))[0]).toMatchObject({ matchedSkuId: skuM });
    expect((await pick('q=TEST-M44BPANJABI')).map((item) => item.id)).toContain(productId);
    expect((await pick(`q=${barcode}`))[0]).toMatchObject({ id: productId, matchedSkuId: skuM });
    expect((await pick('q=product-m44bpanjabi'))[0]?.id).toBe(productId);
    expect((await pick(`ids=${productId}`)).map((item) => item.id)).toEqual([productId]);
    expect(await pick('q=nothing-like-this-anywhere')).toEqual([]);
  });

  it('is the inbox’s: another brand finds nothing, a role without the inbox is refused', async () => {
    const other = await adminB.client.request('GET', `/v1/inbox/products?ids=${productId}`);
    expect(other.statusCode).toBe(200);
    expect(json<{ items: unknown[] }>(other).items).toEqual([]);
    const refused = await accounts.client.request('GET', '/v1/inbox/products?q=panjabi');
    expect(refused.statusCode).toBe(403);
    const bad = await sales.client.request('GET', '/v1/inbox/products');
    expect(bad.statusCode).toBe(400);
  });
});

describe('size from the size chart (M44b, D-771)', () => {
  it('reads the chart, and "chest 42" is L', async () => {
    const response = await sales.client.request('GET', `/v1/inbox/size-charts/${chartId}`);
    expect(response.statusCode, response.body).toBe(200);
    const chart = json<SizeChartTable & { name: string }>(response);
    expect(chart.name).toBe('Panjabi');
    expect(recommendSize(chart, [{ part: 'chest', inches: 42, kg: null }])).toMatchObject({
      size: 'L',
      decidedBy: 'chest',
    });
    const other = await adminB.client.request('GET', `/v1/inbox/size-charts/${chartId}`);
    expect(other.statusCode).toBe(404);
  });

  it('gives the detector the brand’s colours', async () => {
    const response = await sales.client.request('GET', '/v1/inbox/selling-context');
    expect(response.statusCode, response.body).toBe(200);
    const context = json<{ colours: string[]; siteHosts: string[] }>(response);
    expect(context.colours).toContain('Black');
    expect(Array.isArray(context.siteHosts)).toBe(true);
  });
});

describe('placing the panel’s draft (M44b check 5, D-773)', () => {
  it('comes out at the total the panel showed, pending, nothing reserved, the advance a claim', async () => {
    const area = await withSystem(async (tx) => {
      const rows = await tx.execute<{ district_id: number; thana_id: number }>(
        sql`select district_id, id as thana_id from ref.thanas order by id limit 1`,
      );
      return rows[0];
    });
    const lines = [
      { skuId: skuL, qty: 2, unitPricePoisha: '160000' },
      { skuId: skuM, qty: 1, unitPricePoisha: '150000' },
    ];
    const preview = draftTotals({
      lines: lines.map((line) => ({
        unitPricePoisha: poisha(line.unitPricePoisha),
        qty: line.qty,
      })),
      discountPoisha: poisha(5_000),
      deliveryPoisha: poisha(6_000),
      advancePoisha: poisha(50_000),
    });

    const placed = await sales.client.request('POST', '/v1/orders', {
      body: {
        channel: 'facebook',
        source: { inboxConversationId: conversationId },
        customer: { phone: '01712000442', name: 'Rahim' },
        shipTo: {
          name: 'Rahim',
          districtId: area?.district_id ?? 1,
          thanaId: area?.thana_id ?? 1,
          addressLine: 'House 4, Road 4',
        },
        lines: lines.map((line) => ({ skuId: line.skuId, qty: line.qty })),
        discountPoisha: '5000',
        deliveryChargePoisha: '6000',
        assignedTo: sales.userId,
      },
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const order = json<{ id: string; orderNo: string; status: string; codAmountPoisha: string }>(
      placed,
    );
    expect(order.status).toBe('pending');
    expect(order.codAmountPoisha).toBe(preview.totalPoisha.toString());

    const reserved = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ reserved: number }>(sql`
            select coalesce(sum(reserved), 0)::int as reserved from inventory.stock_levels
            where org_id = ${ORG_A} and sku_id = ${skuM}
          `)
        )[0]?.reserved,
      { orgId: ORG_A },
    );
    expect(reserved).toBe(0);

    const advance = await sales.client.request('POST', `/v1/orders/${order.id}/advances`, {
      body: { method: 'bkash', transactionRef: 'M44B-TX-1', amountPoisha: '50000' },
    });
    expect(advance.statusCode, advance.body).toBe(201);
    expect(json<{ status: string }>(advance).status).toBe('pending');
    // Until accounts verifies it, the order still collects its whole total.
    const after = await sales.client.request('GET', `/v1/orders/${order.id}`);
    expect(
      json<{
        amounts: {
          itemsPoisha: string;
          discountPoisha: string;
          deliveryChargePoisha: string;
          codAmountPoisha: string;
        };
      }>(after).amounts,
    ).toMatchObject({
      itemsPoisha: preview.itemsPoisha.toString(),
      discountPoisha: preview.discountPoisha.toString(),
      deliveryChargePoisha: preview.deliveryPoisha.toString(),
      codAmountPoisha: preview.totalPoisha.toString(),
    });
    expect(preview.toCollectPoisha).toBe(preview.totalPoisha - 50_000n);
  });
});
