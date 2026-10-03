import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  auditRowsFor,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { warehouseId } from '../inventory/inventory.testing.js';

/**
 * The catalog-and-stock pass (plan `catalog-stock-ux`, D-420 to D-431), over HTTP
 * against a real PostgreSQL: every new route, through the guard, the interceptors and
 * `serializeFor()`, as the roles §6 gives and refuses them to.
 *
 * Stock enters only the way the console's product page sends it: a supply entry with
 * a cost (invariant 3 and 5), and leaves the warehouse only through a transfer.
 */

let harness: HttpHarness;
let admin: RoleClient;
let warehouse: RoleClient;
let sales: RoleClient;
let otherAdmin: RoleClient;

let mainWarehouse = '';
let secondWarehouse = '';
let supplier = '';
let category = '';
let childCategory = '';
let size = { id: '', values: {} as Record<string, string> };
let colour = { id: '', values: {} as Record<string, string> };

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function call<T>(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
  expected?: number,
): Promise<T> {
  const response = await who.client.request(
    method,
    url,
    payload === undefined ? {} : { body: payload },
  );
  if (expected !== undefined) expect(response.statusCode, response.body).toBe(expected);
  return body<T>(response);
}

async function attribute(
  code: string,
  kind: 'size' | 'colour',
  values: readonly [string, string][],
): Promise<{ id: string; values: Record<string, string> }> {
  const created = await call<{ id: string }>(
    admin,
    'POST',
    '/v1/catalog/attributes',
    { code, name: kind === 'size' ? 'Size' : 'Colour', kind, isVariant: true },
    201,
  );
  const ids: Record<string, string> = {};
  for (const [index, [valueCode, label]] of values.entries()) {
    const value = await call<{ id: string }>(
      admin,
      'POST',
      `/v1/catalog/attributes/${created.id}/values`,
      { code: valueCode, label, position: index },
      201,
    );
    ids[valueCode] = value.id;
  }
  return { id: created.id, values: ids };
}

interface Product {
  readonly id: string;
  readonly name: string;
  readonly skus: readonly {
    readonly id: string;
    readonly skuCode: string;
    readonly pricePoisha: string;
    readonly status: string;
    readonly attributes: readonly { readonly valueId: string; readonly valueLabel: string }[];
  }[];
}

beforeAll(async () => {
  harness = await startHttpHarness('catalog-stock-ux');
  admin = await harness.asRole('org_admin', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  otherAdmin = await harness.asRole('org_admin', ORG_B);

  mainWarehouse = await warehouseId(ORG_A);
  secondWarehouse = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/inventory/locations',
      { code: 'WH-UX', name: 'Second warehouse', kind: 'warehouse' },
      201,
    )
  ).id;
  supplier = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/supply/suppliers',
      { code: 'SUP-UX', name: 'Demo Stitching House' },
      201,
    )
  ).id;

  category = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/catalog/categories',
      { name: 'Men', slug: 'men-ux', code: 'MEN' },
      201,
    )
  ).id;
  childCategory = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/catalog/categories',
      { name: 'Panjabi', slug: 'panjabi-ux', code: 'PNJ', parentId: category },
      201,
    )
  ).id;

  size = await attribute('SIZE_UX', 'size', [
    ['M', 'M'],
    ['L', 'L'],
    ['XL', 'XL'],
  ]);
  colour = await attribute('COLOUR_UX', 'colour', [
    ['WHT', 'White'],
    ['CRM', 'Cram'],
  ]);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

async function productCount(name: string): Promise<number> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from catalog.products where org_id = ${ORG_A} and name = ${name}
      `);
      return Number(rows[0]?.n ?? '0');
    },
    { orgId: ORG_A },
  );
}

describe('a product with sizes, colours and its own price per variant (D-422)', () => {
  let product: Product;

  it('creates the whole matrix in one call, with the typed variant price', async () => {
    product = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: 'Linen Panjabi',
        slug: 'linen-panjabi-ux',
        categoryId: childCategory,
        status: 'active',
        pricePoisha: '245000',
        axes: [
          { attributeId: size.id, valueIds: [size.values.M, size.values.L, size.values.XL] },
          { attributeId: colour.id, valueIds: [colour.values.WHT, colour.values.CRM] },
        ],
        variantPrices: [
          // Colour first, size second: the set of values is the combination.
          { valueIds: [colour.values.CRM, size.values.XL], pricePoisha: '255000' },
        ],
      },
      201,
    );
    expect(product.skus).toHaveLength(6);
    const xlCream = product.skus.find(
      (sku) =>
        sku.attributes.some((a) => a.valueId === size.values.XL) &&
        sku.attributes.some((a) => a.valueId === colour.values.CRM),
    );
    expect(xlCream?.pricePoisha).toBe('255000');
    expect(product.skus.filter((sku) => sku.pricePoisha === '245000')).toHaveLength(5);
    expect(xlCream?.skuCode).toMatch(/-PNJ-\d{4}-XL-CRM$/);
  });

  it('refuses a price for a combination the matrix does not make, and creates nothing', async () => {
    const response = await admin.client.request('POST', '/v1/catalog/products', {
      body: {
        name: 'Refused Panjabi',
        slug: 'refused-panjabi-ux',
        pricePoisha: '100000',
        axes: [{ attributeId: size.id, valueIds: [size.values.M] }],
        variantPrices: [{ valueIds: [size.values.XL], pricePoisha: '120000' }],
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(body<{ code: string }>(response).code).toBe('CATALOG_VARIANT_INVALID');
    expect(await productCount('Refused Panjabi')).toBe(0);
  });

  it('archives one SKU and brings it back; its code and stock stay put (D-423)', async () => {
    const sku = product.skus[0];
    if (sku === undefined) throw new Error('no SKU');

    for (const who of [sales, warehouse]) {
      const refused = await who.client.request('PATCH', `/v1/catalog/skus/${sku.id}`, {
        body: { status: 'archived' },
      });
      expect(refused.statusCode).toBe(403);
    }
    const otherBrand = await otherAdmin.client.request('PATCH', `/v1/catalog/skus/${sku.id}`, {
      body: { status: 'archived' },
    });
    expect(otherBrand.statusCode).toBe(404);

    const archived = await call<{ status: string; skuCode: string }>(
      admin,
      'PATCH',
      `/v1/catalog/skus/${sku.id}`,
      { status: 'archived' },
      200,
    );
    expect(archived).toMatchObject({ status: 'archived', skuCode: sku.skuCode });

    const list = await call<{ items: { id: string; skuCount: number }[] }>(
      admin,
      'GET',
      '/v1/catalog/products?q=Linen',
      undefined,
      200,
    );
    expect(list.items.find((row) => row.id === product.id)?.skuCount).toBe(5);

    await call(admin, 'PATCH', `/v1/catalog/skus/${sku.id}`, { status: 'active' }, 200);
    const again = await call<Product>(
      admin,
      'GET',
      `/v1/catalog/products/${product.id}`,
      undefined,
      200,
    );
    expect(again.skus.every((row) => row.status === 'active')).toBe(true);
  });

  it('fixes a value label without touching any code (D-424)', async () => {
    const renamed = await call<{ code: string; label: string }>(
      admin,
      'PATCH',
      `/v1/catalog/attributes/${colour.id}/values/${colour.values.CRM}`,
      { label: 'Cream' },
      200,
    );
    expect(renamed).toMatchObject({ code: 'CRM', label: 'Cream' });
    await call(admin, 'PATCH', `/v1/catalog/attributes/${colour.id}`, { name: 'Colours' }, 200);

    const refused = await sales.client.request(
      'PATCH',
      `/v1/catalog/attributes/${colour.id}/values/${colour.values.CRM}`,
      { body: { label: 'Nope' } },
    );
    expect(refused.statusCode).toBe(403);
    const codeChange = await admin.client.request(
      'PATCH',
      `/v1/catalog/attributes/${colour.id}/values/${colour.values.CRM}`,
      { body: { code: 'CRX' } },
    );
    expect(codeChange.statusCode).toBe(400);

    const after = await call<Product>(
      admin,
      'GET',
      `/v1/catalog/products/${product.id}`,
      undefined,
      200,
    );
    expect(after.skus.map((sku) => sku.skuCode).sort()).toEqual(
      product.skus.map((sku) => sku.skuCode).sort(),
    );
    expect(after.skus.some((sku) => sku.attributes.some((a) => a.valueLabel === 'Cream'))).toBe(
      true,
    );
  });

  it('receives a first delivery, then shows stock and history by product (D-427)', async () => {
    const lines = product.skus.slice(0, 3).map((sku, index) => ({
      skuId: sku.id,
      qty: 10 + index,
      unitCostPoisha: '150000',
    }));
    await call(
      admin,
      'POST',
      '/v1/supply/entries',
      { supplyId: randomUUID(), supplierId: supplier, locationId: mainWarehouse, lines },
      201,
    );

    interface Row {
      skuId: string;
      productId: string;
      variantLabel: string;
      onHand: number;
      wacPoisha?: string;
    }
    const stock = await call<{ items: Row[] }>(
      admin,
      'GET',
      `/v1/inventory/stock?productId=${product.id}`,
      undefined,
      200,
    );
    expect(stock.items).toHaveLength(3);
    expect(stock.items.every((row) => row.productId === product.id)).toBe(true);
    expect(stock.items.map((row) => row.variantLabel).sort()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^(M|L|XL) \/ (White|Cream)$/)]),
    );
    expect(stock.items[0]?.wacPoisha).toBe('150000');

    // The parent category finds the product in its child (the materialised path).
    const byCategory = await call<{ items: Row[] }>(
      admin,
      'GET',
      `/v1/inventory/stock?categoryId=${category}`,
      undefined,
      200,
    );
    expect(byCategory.items.map((row) => row.skuId).sort()).toEqual(
      stock.items.map((row) => row.skuId).sort(),
    );

    // The warehouse sees the same units and no cost (invariant 5, serializeFor).
    const asWarehouse = await call<{ items: Row[] }>(
      warehouse,
      'GET',
      `/v1/inventory/stock?productId=${product.id}`,
      undefined,
      200,
    );
    expect(asWarehouse.items).toHaveLength(3);
    expect(findCostFields(asWarehouse)).toEqual([]);

    const history = await call<{
      items: { skuId: string; kind: string; qtyDelta: number; locationCode: string }[];
    }>(warehouse, 'GET', `/v1/inventory/movements?productId=${product.id}`, undefined, 200);
    expect(history.items).toHaveLength(3);
    expect(history.items.every((row) => row.kind === 'supply_receipt')).toBe(true);
    expect(history.items.every((row) => row.locationCode === 'WH-01')).toBe(true);
    expect(findCostFields(history)).toEqual([]);

    // Another brand's product id finds nothing here.
    const otherBrand = await call<{ items: Row[] }>(
      otherAdmin,
      'GET',
      `/v1/inventory/stock?productId=${product.id}`,
      undefined,
      200,
    );
    expect(otherBrand.items).toEqual([]);
  });

  it('the first transfer creates the in-transit location, once (D-428)', async () => {
    const transitCount = () =>
      withSystem(
        async (tx) => {
          const rows = await tx.execute<{ n: string }>(sql`
            select count(*)::text as n from org.locations
            where org_id = ${ORG_A} and kind = 'in_transit'
          `);
          return Number(rows[0]?.n ?? '0');
        },
        { orgId: ORG_A },
      );
    expect(await transitCount()).toBe(0);

    const sku = product.skus[0];
    if (sku === undefined) throw new Error('no SKU');
    const first = await call<{ id: string; status: string }>(
      warehouse,
      'POST',
      '/v1/inventory/transfers',
      {
        fromLocationId: mainWarehouse,
        toLocationId: secondWarehouse,
        lines: [{ skuId: sku.id, qty: 2 }],
      },
      201,
    );
    expect(first.status).toBe('dispatched');
    await call(
      warehouse,
      'POST',
      '/v1/inventory/transfers',
      {
        fromLocationId: mainWarehouse,
        toLocationId: secondWarehouse,
        lines: [{ skuId: sku.id, qty: 1 }],
      },
      201,
    );
    expect(await transitCount()).toBe(1);

    await call(warehouse, 'POST', `/v1/inventory/transfers/${first.id}/receive`, undefined, 201);
    const there = await call<{ items: { locationId: string; onHand: number }[] }>(
      warehouse,
      'GET',
      `/v1/inventory/stock?productId=${product.id}&locationId=${secondWarehouse}`,
      undefined,
      200,
    );
    expect(there.items).toEqual([expect.objectContaining({ onHand: 2 })]);

    // More than is there is refused, and nothing moves (invariant 3).
    const tooMany = await warehouse.client.request('POST', '/v1/inventory/transfers', {
      body: {
        fromLocationId: secondWarehouse,
        toLocationId: mainWarehouse,
        lines: [{ skuId: sku.id, qty: 3 }],
      },
    });
    expect(tooMany.statusCode).toBeGreaterThanOrEqual(400);
    const unchanged = await call<{ items: { onHand: number }[] }>(
      warehouse,
      'GET',
      `/v1/inventory/stock?productId=${product.id}&locationId=${secondWarehouse}`,
      undefined,
      200,
    );
    expect(unchanged.items[0]?.onHand).toBe(2);
  });
});

describe('the new-products spreadsheet (D-425)', () => {
  const good = [
    'name,category,price_taka,sizes,colours,status',
    'Cotton Kurta,PNJ,1890,M|L,White|Cream,active',
    'Plain Scarf,,350.50,,,draft',
  ].join('\n');

  it('reports every problem with its line, for anyone who may read the catalog', async () => {
    const bad = [
      'name,category,price_taka,sizes,colours',
      'Linen Panjabi,,100,,', // already in the catalog
      'Odd Tee,NOPE,100,,',
      'Odd Tee Two,,100,XXXL,',
      'Odd Tee Three,,abc,,',
    ].join('\n');
    const report = await call<{
      canCommit: boolean;
      problems: { line: number; column: string }[];
    }>(sales, 'POST', '/v1/catalog/imports/products/dry-run', { csv: bad }, 201);
    expect(report.canCommit).toBe(false);
    expect(report.problems.map((p) => `${String(p.line)}:${p.column}`)).toEqual([
      '2:name',
      '3:category',
      '4:sizes',
      '5:price_taka',
    ]);

    const refused = await admin.client.request('POST', '/v1/catalog/imports/products', {
      body: { csv: bad },
    });
    expect(refused.statusCode).toBe(422);
    expect(await productCount('Odd Tee')).toBe(0);
  });

  it('previews a good file, then creates every product in it with generated codes', async () => {
    const preview = await call<{
      canCommit: boolean;
      willCreate: number;
      skuCount: number;
      preview: { name: string; sizes: string[]; colours: string[] }[];
    }>(admin, 'POST', '/v1/catalog/imports/products/dry-run', { csv: good }, 201);
    expect(preview).toMatchObject({ canCommit: true, willCreate: 2, skuCount: 5 });
    expect(preview.preview[0]).toMatchObject({
      name: 'Cotton Kurta',
      sizes: ['M', 'L'],
      colours: ['White', 'Cream'],
    });

    for (const who of [sales, warehouse]) {
      const refused = await who.client.request('POST', '/v1/catalog/imports/products', {
        body: { csv: good },
      });
      expect(refused.statusCode).toBe(403);
    }

    const result = await call<{ created: number; skuCount: number; products: { id: string }[] }>(
      admin,
      'POST',
      '/v1/catalog/imports/products',
      { csv: good },
      201,
    );
    expect(result).toMatchObject({ created: 2, skuCount: 5 });

    const kurta = await call<Product & { status: string; categoryId: string }>(
      admin,
      'GET',
      `/v1/catalog/products/${result.products[0]?.id ?? ''}`,
      undefined,
      200,
    );
    expect(kurta.status).toBe('active');
    expect(kurta.categoryId).toBe(childCategory);
    expect(kurta.skus).toHaveLength(4);
    expect(kurta.skus.every((sku) => sku.pricePoisha === '189000')).toBe(true);
    expect(kurta.skus.every((sku) => /-PNJ-\d{4}-(M|L)-(WHT|CRM)$/.test(sku.skuCode))).toBe(true);

    // The same file again is refused whole: both names now exist.
    const again = await admin.client.request('POST', '/v1/catalog/imports/products', {
      body: { csv: good },
    });
    expect(again.statusCode).toBe(422);
    expect(await productCount('Cotton Kurta')).toBe(1);
  });
});

describe('the first transfer in a brand with no in-transit location (D-428)', () => {
  let from = '';
  let to = '';
  let skuId = '';
  let transitId = '';
  const transferIds: string[] = [];

  async function transitLocations(): Promise<{ id: string; is_active: boolean }[]> {
    return withSystem(
      async (tx) => [
        ...(await tx.execute<{ id: string; is_active: boolean }>(sql`
          select id, is_active from org.locations
          where org_id = ${ORG_B} and kind = 'in_transit'
        `)),
      ],
      { orgId: ORG_B },
    );
  }

  beforeAll(async () => {
    from = await warehouseId(ORG_B);
    to = (
      await call<{ id: string }>(
        otherAdmin,
        'POST',
        '/v1/inventory/locations',
        { code: 'WH-UXB', name: 'Second warehouse B', kind: 'warehouse' },
        201,
      )
    ).id;
    const supplierB = await call<{ id: string }>(
      otherAdmin,
      'POST',
      '/v1/supply/suppliers',
      { code: 'SUP-UXB', name: 'Brand B supplier' },
      201,
    );
    const product = await call<Product>(
      otherAdmin,
      'POST',
      '/v1/catalog/products',
      { name: 'Plain Scarf B', slug: 'plain-scarf-b-ux', pricePoisha: '50000', status: 'active' },
      201,
    );
    skuId = product.skus[0]?.id ?? '';
    await call(
      otherAdmin,
      'POST',
      '/v1/supply/entries',
      {
        supplyId: randomUUID(),
        supplierId: supplierB.id,
        locationId: from,
        lines: [{ skuId, qty: 10, unitCostPoisha: '20000' }],
      },
      201,
    );
  });

  it('two first transfers at once make one location, audited once', async () => {
    expect(await transitLocations()).toEqual([]);
    const responses = await Promise.all(
      [1, 2].map(() =>
        otherAdmin.client.request('POST', '/v1/inventory/transfers', {
          body: { fromLocationId: from, toLocationId: to, lines: [{ skuId, qty: 1 }] },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([201, 201]);
    transferIds.push(...responses.map((response) => body<{ id: string }>(response).id));

    const transit = await transitLocations();
    expect(transit).toHaveLength(1);
    transitId = transit[0]?.id ?? '';
    const audit = await auditRowsFor(ORG_B, transitId);
    expect(audit.filter((row) => row.action === 'inventory.location.created')).toHaveLength(1);
  });

  it('a location still holding stock or a transfer cannot be switched off', async () => {
    // Two transfers are on their way through in-transit, and the source holds stock.
    for (const id of [transitId, from]) {
      const refused = await otherAdmin.client.request('PATCH', `/v1/inventory/locations/${id}`, {
        body: { isActive: false },
      });
      expect(refused.statusCode, refused.body).toBe(400);
      expect(body<{ code: string }>(refused).code).toBe('STOCK_LOCATION_INVALID');
    }
  });

  it('a switched-off in-transit location is pointed at, not replaced by a second', async () => {
    for (const id of transferIds) {
      await call(otherAdmin, 'POST', `/v1/inventory/transfers/${id}/receive`, undefined, 201);
    }
    // Empty now, so it may be switched off.
    await call(
      otherAdmin,
      'PATCH',
      `/v1/inventory/locations/${transitId}`,
      { isActive: false },
      200,
    );

    const refused = await otherAdmin.client.request('POST', '/v1/inventory/transfers', {
      body: { fromLocationId: from, toLocationId: to, lines: [{ skuId, qty: 1 }] },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(body<{ code: string }>(refused).code).toBe('STOCK_LOCATION_INVALID');
    expect(refused.body).toMatch(/switched off/);
    expect(await transitLocations()).toEqual([{ id: transitId, is_active: false }]);

    await call(
      otherAdmin,
      'PATCH',
      `/v1/inventory/locations/${transitId}`,
      { isActive: true },
      200,
    );
    await call(
      otherAdmin,
      'POST',
      '/v1/inventory/transfers',
      { fromLocationId: from, toLocationId: to, lines: [{ skuId, qty: 1 }] },
      201,
    );
  });
});
