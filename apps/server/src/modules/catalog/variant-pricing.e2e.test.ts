import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  createBranch,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { makeLocation, warehouseId } from '../inventory/inventory.testing.js';
import {
  insertTestSiteKey,
  signedGet,
  type TestSiteKey,
} from '../storefront/storefront.testing.js';

/**
 * M39b over HTTP on real PostgreSQL (M39 checks 3 to 7): prices by size and a bulk +10 %,
 * regular prices, a buying price per variant on every receipt and the weighted average it
 * makes, the standard buying price that prefills the next receipt and never leaves supply,
 * duplicating a product, adding sizes and colours later, archiving a size in every colour,
 * and what the website shows when a regular price or a live flash sale applies.
 */

let harness: HttpHarness;
let admin: RoleClient;
let accounts: RoleClient;
let sales: RoleClient;
let warehouse: RoleClient;
let marketing: RoleClient;
let adminB: RoleClient;

let mainWarehouse = '';
let supplier = '';
let otherSupplier = '';
let category = '';
const sizes: Record<string, string> = {};
const colours: Record<string, string> = {};
let sizeAttribute = '';
let colourAttribute = '';

const suffix = randomUUID().slice(0, 6).toLowerCase();

interface Sku {
  readonly id: string;
  readonly skuCode: string;
  readonly pricePoisha: string;
  readonly compareAtPoisha: string | null;
  readonly weightGrams: number | null;
  readonly status: string;
  readonly attributes: readonly { readonly valueId: string; readonly valueLabel: string }[];
}
interface Product {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly sequence: number;
  /** The parent SKU (D-661): the SKU codes without size and colour. */
  readonly parentSku: string | null;
  readonly status: string;
  readonly categoryId: string | null;
  readonly weightGrams: number | null;
  readonly skus: readonly Sku[];
  readonly web: { readonly webVisible: boolean; readonly sizeChartId: string | null };
}

async function call<T>(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
  return JSON.parse(response.body) as T;
}

async function status(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; code: string | undefined; body: string }> {
  const response = await who.client.request(
    method,
    url,
    payload === undefined ? {} : { body: payload },
  );
  const parsed =
    response.body === '' ? undefined : (JSON.parse(response.body) as { code?: string });
  return { statusCode: response.statusCode, code: parsed?.code, body: response.body };
}

/** One product a duplicate made (D-662, D-663). */
interface Copy {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly parentSku: string;
  readonly slug: string;
}

/** `ELY-SHT-0021` without its number: `ELY-SHT`. */
function withoutNumber(parentSku: string | null): string {
  return (parentSku ?? '').split('-').slice(0, -1).join('-');
}

/** The number at the end of a parent SKU: 21 for `ELY-SHT-0021`. */
function numberOf(parentSku: string | undefined): number {
  return Number((parentSku ?? '').split('-').at(-1));
}

function skuOf(product: Product, ...labels: string[]): Sku {
  const found = product.skus.find(
    (sku) =>
      sku.attributes.length === labels.length &&
      labels.every((label) => sku.attributes.some((pair) => pair.valueLabel === label)),
  );
  if (found === undefined) throw new Error(`no variant ${labels.join('/')}`);
  return found;
}

async function value(attributeId: string, code: string, position: number): Promise<string> {
  const created = await call<{ id: string }>(
    admin,
    'POST',
    `/v1/catalog/attributes/${attributeId}/values`,
    { code, label: code, position },
    201,
  );
  return created.id;
}

beforeAll(async () => {
  harness = await startHttpHarness('variant-pricing');
  admin = await harness.asRole('org_admin', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);
  mainWarehouse = await warehouseId(ORG_A);

  supplier = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/supply/suppliers',
      { code: 'SUP-VP', name: 'Variant Price Mills' },
      201,
    )
  ).id;
  otherSupplier = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/supply/suppliers',
      { code: 'SUP-VQ', name: 'Second Stitching' },
      201,
    )
  ).id;
  category = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/catalog/categories',
      { name: 'Shirts', slug: `shirts-${suffix}`, code: 'SHT' },
      201,
    )
  ).id;

  // Colour is created first and sorts first in the attribute list (`COLOUR` < `SIZE`), as on
  // a brand that set up its colours before its sizes: the code order must still read size
  // first (D-639).
  colourAttribute = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/catalog/attributes',
      { code: 'COLOUR', name: 'Colour', kind: 'colour', isVariant: true },
      201,
    )
  ).id;
  sizeAttribute = (
    await call<{ id: string }>(
      admin,
      'POST',
      '/v1/catalog/attributes',
      { code: 'SIZE', name: 'Size', kind: 'size', isVariant: true },
      201,
    )
  ).id;
  for (const [index, code] of ['S', 'M', 'L', 'XL', 'XXL'].entries()) {
    sizes[code] = await value(sizeAttribute, code, index);
  }
  for (const [index, code] of ['RED', 'NAVY', 'WHITE', 'BLUE'].entries()) {
    colours[code] = await value(colourAttribute, code, index);
  }
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

/** A 4-size × 3-colour shirt priced by size in one request, as the new-product grid sends it. */
async function shirtBySize(name: string, slug: string): Promise<Product> {
  const bySize: Record<string, string> = { S: '149000', M: '149000', L: '159000', XL: '169000' };
  return call<Product>(
    admin,
    'POST',
    '/v1/catalog/products',
    {
      name,
      slug,
      categoryId: category,
      status: 'active',
      pricePoisha: '149000',
      weightGrams: 350,
      axes: [
        { attributeId: sizeAttribute, valueIds: ['S', 'M', 'L', 'XL'].map((s) => sizes[s]) },
        {
          attributeId: colourAttribute,
          valueIds: ['RED', 'NAVY', 'WHITE'].map((c) => colours[c]),
        },
      ],
      variantPrices: ['S', 'M', 'L', 'XL'].flatMap((size) =>
        ['RED', 'NAVY', 'WHITE'].map((colour) => ({
          valueIds: [sizes[size], colours[colour]],
          pricePoisha: bySize[size],
          // A regular price on the red ones only.
          ...(colour === 'RED' ? { compareAtPoisha: '199000' } : {}),
        })),
      ),
    },
    201,
  );
}

describe('prices by size and a bulk change (M39 check 3, D-635, D-636, D-640)', () => {
  let shirt: Product;

  beforeAll(async () => {
    shirt = await shirtBySize(`Oxford ${suffix}`, `oxford-${suffix}`);
  }, 60_000);

  it('makes 12 variants priced by size, size before colour in every code', () => {
    expect(shirt.skus).toHaveLength(12);
    expect(skuOf(shirt, 'S', 'RED').pricePoisha).toBe('149000');
    expect(skuOf(shirt, 'L', 'NAVY').pricePoisha).toBe('159000');
    expect(skuOf(shirt, 'XL', 'WHITE').pricePoisha).toBe('169000');
    expect(skuOf(shirt, 'XL', 'RED').compareAtPoisha).toBe('199000');
    expect(skuOf(shirt, 'XL', 'NAVY').compareAtPoisha).toBeNull();
    expect(skuOf(shirt, 'M', 'RED').skuCode).toMatch(/-M-RED$/);
    expect(shirt.weightGrams).toBe(350);
  });

  it('refuses a regular price at or below the price, naming why, and creates nothing', async () => {
    const refused = await status(admin, 'POST', '/v1/catalog/products', {
      name: `Bad regular ${suffix}`,
      slug: `bad-regular-${suffix}`,
      pricePoisha: '150000',
      compareAtPoisha: '150000',
      axes: [{ attributeId: sizeAttribute, valueIds: [sizes.M] }],
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.code).toBe('CATALOG_VARIANT_INVALID');
    const listed = await call<{ items: { name: string }[] }>(
      admin,
      'GET',
      '/v1/catalog/products?q=bad%20regular',
      undefined,
      200,
    );
    expect(listed.items).toEqual([]);
  });

  it('raises all 12 by 10 % in one request, with a history row for every change', async () => {
    const prices = shirt.skus.map((sku) => {
      const current = BigInt(sku.pricePoisha);
      // The console's preview: +10 %, rounded once to the poisha (D-636).
      const next = current + (current * 1000n + 5000n) / 10_000n;
      return { skuId: sku.id, pricePoisha: next.toString() };
    });
    const result = await call<{ repriced: number }>(
      admin,
      'PUT',
      '/v1/catalog/prices',
      { prices, reason: 'Eid +10%' },
      200,
    );
    expect(result.repriced).toBe(12);

    const after = await call<Product>(
      admin,
      'GET',
      `/v1/catalog/products/${shirt.id}`,
      undefined,
      200,
    );
    expect(skuOf(after, 'S', 'NAVY').pricePoisha).toBe('163900');
    expect(skuOf(after, 'XL', 'WHITE').pricePoisha).toBe('185900');

    const history = await call<{
      items: {
        skuId: string;
        variantLabel: string;
        fromPricePoisha: string | null;
        toPricePoisha: string;
        reason: string | null;
      }[];
    }>(admin, 'GET', `/v1/catalog/products/${shirt.id}/price-history`, undefined, 200);
    const raised = history.items.filter((row) => row.reason === 'Eid +10%');
    expect(raised).toHaveLength(12);
    expect(new Set(raised.map((row) => row.skuId)).size).toBe(12);
    expect(raised.find((row) => row.variantLabel === 'S / NAVY')).toMatchObject({
      fromPricePoisha: '149000',
      toPricePoisha: '163900',
    });
    // The 12 first prices are there too: one history for every variant (D-636).
    expect(history.items.filter((row) => row.fromPricePoisha === null)).toHaveLength(12);
  });

  it('a regular price change is history too, and one the price would overtake is refused', async () => {
    const red = skuOf(shirt, 'S', 'RED');
    await call(
      admin,
      'PUT',
      '/v1/catalog/prices',
      { prices: [{ skuId: red.id, compareAtPoisha: '209000' }], reason: 'New regular' },
      200,
    );
    const history = await call<{
      items: {
        skuId: string;
        compareAtFromPoisha: string | null;
        compareAtToPoisha: string | null;
        reason: string | null;
      }[];
    }>(admin, 'GET', `/v1/catalog/products/${shirt.id}/price-history`, undefined, 200);
    expect(history.items.find((row) => row.reason === 'New regular')).toMatchObject({
      skuId: red.id,
      compareAtFromPoisha: '199000',
      compareAtToPoisha: '209000',
    });

    const refused = await status(admin, 'PUT', '/v1/catalog/prices', {
      prices: [{ skuId: red.id, pricePoisha: '209000' }],
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.code).toBe('CATALOG_PRICE_INVALID');
    expect(refused.body).toContain(red.skuCode);

    // Clearing the regular price is a change of its own.
    await call(
      admin,
      'PUT',
      '/v1/catalog/prices',
      { prices: [{ skuId: red.id, compareAtPoisha: null }] },
      200,
    );
    const cleared = await call<Product>(
      admin,
      'GET',
      `/v1/catalog/products/${shirt.id}`,
      undefined,
      200,
    );
    expect(skuOf(cleared, 'S', 'RED').compareAtPoisha).toBeNull();
  });

  it('only org_admin reprices', async () => {
    const sku = shirt.skus[0];
    for (const who of [sales, accounts, warehouse, marketing]) {
      const refused = await status(who, 'PUT', '/v1/catalog/prices', {
        prices: [{ skuId: sku?.id, pricePoisha: '170000' }],
      });
      expect(refused.statusCode).toBe(403);
    }
  });
});

describe('a buying price per variant on every receipt (M39 checks 4 and 5, D-637, D-638)', () => {
  let shirt: Product;

  beforeAll(async () => {
    shirt = await shirtBySize(`Cost shirt ${suffix}`, `cost-shirt-${suffix}`);
  }, 60_000);

  it('posts each variant at its own cost, and the average per variant comes out right', async () => {
    const sRed = skuOf(shirt, 'S', 'RED');
    const xlRed = skuOf(shirt, 'XL', 'RED');
    await call(
      admin,
      'POST',
      '/v1/supply/entries',
      {
        supplyId: randomUUID(),
        supplierId: supplier,
        locationId: mainWarehouse,
        lines: [
          { skuId: sRed.id, qty: 10, unitCostPoisha: '70000' },
          { skuId: xlRed.id, qty: 4, unitCostPoisha: '90000' },
        ],
      },
      201,
    );
    // A second delivery of S/Red at a higher cost: (10 × 700 + 10 × 800) / 20 = 750.
    await call(
      accounts,
      'POST',
      '/v1/supply/entries',
      {
        supplyId: randomUUID(),
        supplierId: otherSupplier,
        locationId: mainWarehouse,
        lines: [{ skuId: sRed.id, qty: 10, unitCostPoisha: '80000' }],
      },
      201,
    );

    const costs = await call<{
      items: {
        skuId: string;
        wacPoisha: string | null;
        lastUnitCostPoisha: string | null;
        lastSupplierName: string | null;
        prefillUnitCostPoisha: string | null;
        prefillSource: string | null;
      }[];
    }>(accounts, 'GET', `/v1/supply/sku-costs?skuIds=${sRed.id},${xlRed.id}`, undefined, 200);
    const s = costs.items.find((item) => item.skuId === sRed.id);
    const xl = costs.items.find((item) => item.skuId === xlRed.id);
    expect(s).toMatchObject({
      wacPoisha: '75000',
      lastUnitCostPoisha: '80000',
      lastSupplierName: 'Second Stitching',
      prefillUnitCostPoisha: '80000',
      prefillSource: 'last',
    });
    expect(xl).toMatchObject({ wacPoisha: '90000', lastUnitCostPoisha: '90000' });

    // The stock page agrees: the average is per variant, never one figure for all of them.
    const stock = await call<{ items: { skuId: string; wacPoisha?: string }[] }>(
      admin,
      'GET',
      `/v1/inventory/stock?productId=${shirt.id}`,
      undefined,
      200,
    );
    expect(stock.items.find((row) => row.skuId === sRed.id)?.wacPoisha).toBe('75000');
    expect(stock.items.find((row) => row.skuId === xlRed.id)?.wacPoisha).toBe('90000');
  });

  it("a standard buying price prefills the next receipt, the supplier's own first", async () => {
    const mNavy = skuOf(shirt, 'M', 'NAVY');
    const set = await call<{ set: number; removed: number }>(
      accounts,
      'PUT',
      '/v1/supply/sku-costs',
      {
        entries: [
          { skuId: mNavy.id, supplierId: null, standardUnitCostPoisha: '72000' },
          { skuId: mNavy.id, supplierId: supplier, standardUnitCostPoisha: '71000' },
        ],
      },
      200,
    );
    expect(set).toEqual({ set: 2, removed: 0 });

    const forSupplier = await call<{
      items: { prefillUnitCostPoisha: string | null; prefillSource: string | null }[];
    }>(
      accounts,
      'GET',
      `/v1/supply/sku-costs?skuIds=${mNavy.id}&supplierId=${supplier}`,
      undefined,
      200,
    );
    expect(forSupplier.items[0]).toMatchObject({
      prefillUnitCostPoisha: '71000',
      prefillSource: 'supplier-standard',
    });
    const other = await call<{
      items: {
        standardUnitCostPoisha: string | null;
        standards: { supplierId: string | null }[];
        prefillUnitCostPoisha: string | null;
        prefillSource: string | null;
      }[];
    }>(
      accounts,
      'GET',
      `/v1/supply/sku-costs?skuIds=${mNavy.id}&supplierId=${otherSupplier}`,
      undefined,
      200,
    );
    expect(other.items[0]).toMatchObject({
      standardUnitCostPoisha: '72000',
      prefillUnitCostPoisha: '72000',
      prefillSource: 'standard',
    });
    expect(other.items[0]?.standards).toHaveLength(2);

    // Removing the supplier's own falls back to the any-supplier standard.
    await call(
      accounts,
      'PUT',
      '/v1/supply/sku-costs',
      { entries: [{ skuId: mNavy.id, supplierId: supplier, standardUnitCostPoisha: null }] },
      200,
    );
    const after = await call<{ items: { prefillSource: string | null }[] }>(
      accounts,
      'GET',
      `/v1/supply/sku-costs?skuIds=${mNavy.id}&supplierId=${supplier}`,
      undefined,
      200,
    );
    expect(after.items[0]?.prefillSource).toBe('standard');
  });

  it('cost never reaches a role without read:cost, and never through the catalog', async () => {
    const mNavy = skuOf(shirt, 'M', 'NAVY');
    for (const who of [sales, warehouse, marketing]) {
      const refused = await status(who, 'GET', `/v1/supply/sku-costs?skuIds=${mNavy.id}`);
      expect(refused.statusCode).toBe(403);
      const write = await status(who, 'PUT', '/v1/supply/sku-costs', {
        entries: [{ skuId: mNavy.id, supplierId: null, standardUnitCostPoisha: '1' }],
      });
      expect(write.statusCode).toBe(403);
    }
    // The product as every role reads it, cost roles included: no cost field, no standard
    // price, anywhere (invariant 5: the standard price lives only in supply).
    for (const who of [admin, accounts, sales, warehouse, marketing]) {
      const response = await who.client.request('GET', `/v1/catalog/products/${shirt.id}`);
      expect(response.statusCode).toBe(200);
      const payload = JSON.parse(response.body) as unknown;
      expect(findCostFields(payload)).toEqual([]);
      expect(response.body).not.toMatch(/standard|lastUnitCost|wac|margin/i);
    }
    // And the stock rows strip the average for a role without cost.
    const stock = await call<{ items: Record<string, unknown>[] }>(
      sales,
      'GET',
      `/v1/inventory/stock?productId=${shirt.id}`,
      undefined,
      200,
    );
    expect(findCostFields(stock)).toEqual([]);
  });

  it('the standard price spreadsheet exports, checks and imports in supply only', async () => {
    const exported = await call<{ csv: string; filename: string }>(
      accounts,
      'GET',
      `/v1/supply/sku-costs/export?productId=${shirt.id}`,
      undefined,
      200,
    );
    const lines = exported.csv.trim().split('\n');
    expect(lines[0]).toBe('sku,product,variant,supplier,standard_cost_taka');
    expect(lines).toHaveLength(13);
    const lNavy = skuOf(shirt, 'L', 'NAVY');
    const csv = `sku,supplier,standard_cost_taka\n${lNavy.skuCode},SUP-VQ,815.50\n${lNavy.skuCode},,\nNOPE-1,,10\n`;
    const dry = await call<{ willSet: number; problems: { line: number }[]; canCommit: boolean }>(
      accounts,
      'POST',
      '/v1/supply/sku-costs/import/dry-run',
      { csv },
      201,
    );
    expect(dry.willSet).toBe(1);
    expect(dry.problems.map((problem) => problem.line)).toEqual([4]);
    expect(dry.canCommit).toBe(false);
    const refused = await status(accounts, 'POST', '/v1/supply/sku-costs/import', { csv });
    expect(refused.statusCode).toBe(422);

    const good = `sku,supplier,standard_cost_taka\n${lNavy.skuCode},SUP-VQ,815.50\n`;
    const imported = await call<{ set: number }>(
      accounts,
      'POST',
      '/v1/supply/sku-costs/import',
      { csv: good },
      201,
    );
    expect(imported.set).toBe(1);
    const costs = await call<{ items: { prefillUnitCostPoisha: string | null }[] }>(
      accounts,
      'GET',
      `/v1/supply/sku-costs?skuIds=${lNavy.id}&supplierId=${otherSupplier}`,
      undefined,
      200,
    );
    expect(costs.items[0]?.prefillUnitCostPoisha).toBe('81550');
    // The catalog's own price importer still refuses a cost column (D-638).
    const catalogImport = await status(admin, 'POST', '/v1/catalog/imports/prices/dry-run', {
      csv: `sku,price_taka,standard_cost_taka\n${lNavy.skuCode},1600,800\n`,
    });
    expect(catalogImport.body).toMatch(/not a column this importer writes/);
  });

  it('another brand reads none of it', async () => {
    const mNavy = skuOf(shirt, 'M', 'NAVY');
    const other = await call<{ items: unknown[] }>(
      adminB,
      'GET',
      `/v1/supply/sku-costs?skuIds=${mNavy.id}`,
      undefined,
      200,
    );
    expect(other.items).toEqual([]);
    const write = await status(adminB, 'PUT', '/v1/supply/sku-costs', {
      entries: [{ skuId: mNavy.id, supplierId: null, standardUnitCostPoisha: '1' }],
    });
    expect(write.statusCode).toBe(404);
  });
});

describe('duplicate a product (M39 check 6, D-641)', () => {
  it('copies the variants and prices under a new name and address, with no stock', async () => {
    const source = await shirtBySize(`Linen ${suffix}`, `linen-${suffix}`);
    // Stock on the source, so "no stock" on the copy means something.
    await call(
      admin,
      'POST',
      '/v1/supply/entries',
      {
        supplyId: randomUUID(),
        supplierId: supplier,
        locationId: mainWarehouse,
        lines: [{ skuId: skuOf(source, 'M', 'RED').id, qty: 3, unitCostPoisha: '60000' }],
      },
      201,
    );
    // An archived variant stays behind.
    await call(
      admin,
      'PATCH',
      `/v1/catalog/skus/${skuOf(source, 'S', 'WHITE').id}`,
      {
        status: 'archived',
      },
      200,
    );

    const copy = await call<Product>(
      admin,
      'POST',
      `/v1/catalog/products/${source.id}/duplicate`,
      { name: `Linen ${suffix} (sand)` },
      201,
    );
    expect(copy.id).not.toBe(source.id);
    expect(copy.status).toBe('draft');
    // Its own parent SKU, the source's with the copy's number, and its address is that in lower
    // case (D-661).
    expect(copy.parentSku).toBe(
      `${withoutNumber(source.parentSku)}-${String(copy.sequence).padStart(4, '0')}`,
    );
    expect(copy.slug).toBe(copy.parentSku?.toLowerCase());
    expect(copy.categoryId).toBe(source.categoryId);
    expect(copy.weightGrams).toBe(350);
    expect(copy.web.webVisible).toBe(false);
    expect(copy.skus).toHaveLength(11);
    for (const sku of copy.skus) {
      const labels = sku.attributes.map((pair) => pair.valueLabel);
      const original = skuOf(source, ...labels);
      expect(sku.pricePoisha).toBe(original.pricePoisha);
      expect(sku.compareAtPoisha).toBe(original.compareAtPoisha);
      expect(sku.id).not.toBe(original.id);
      expect(sku.skuCode).not.toBe(original.skuCode);
      // Same segment order, the copy's own sequence.
      expect(sku.skuCode.split('-').slice(-2)).toEqual(original.skuCode.split('-').slice(-2));
      expect(sku.skuCode).toContain(String(copy.sequence).padStart(4, '0'));
      expect(sku.skuCode.startsWith(`${copy.parentSku ?? '?'}-`)).toBe(true);
    }
    const stock = await call<{ items: { onHand: number }[] }>(
      admin,
      'GET',
      `/v1/inventory/stock?productId=${copy.id}`,
      undefined,
      200,
    );
    expect(stock.items.reduce((sum, row) => sum + row.onHand, 0)).toBe(0);

    // A second copy with the same name is a product of its own: the next number, its own
    // address (names may repeat, D-653, D-661).
    const again = await call<Product>(
      admin,
      'POST',
      `/v1/catalog/products/${source.id}/duplicate`,
      { name: `Linen ${suffix} (sand)` },
      201,
    );
    expect(again.name).toBe(copy.name);
    expect(again.sequence).toBe(copy.sequence + 1);
    expect(again.slug).toBe(again.parentSku?.toLowerCase());
    expect(again.slug).not.toBe(copy.slug);

    // Only a role that may create products; another brand's product is not found.
    expect(
      (await status(sales, 'POST', `/v1/catalog/products/${source.id}/duplicate`, { name: 'X' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await status(adminB, 'POST', `/v1/catalog/products/${source.id}/duplicate`, { name: 'X' }))
        .statusCode,
    ).toBe(404);
  });

  it('makes three copies numbered one after another, and copies many from the list in order (D-662, D-663)', async () => {
    const source = await shirtBySize(`Hawaii ${suffix}`, `hawaii-${suffix}`);
    // A new product's address is its parent SKU in lower case, whatever was sent (D-661).
    expect(source.slug).toBe(source.parentSku?.toLowerCase());
    expect(source.slug).not.toBe(`hawaii-${suffix}`);
    const prefix = withoutNumber(source.parentSku);

    const made = await call<Product & { copies: readonly Copy[] }>(
      admin,
      'POST',
      `/v1/catalog/products/${source.id}/duplicate`,
      { copies: 3 },
      201,
    );
    expect(made.copies).toHaveLength(3);
    // The first copy answers as the product page reads it.
    expect(made.id).toBe(made.copies[0]?.id);
    const first = numberOf(made.copies[0]?.parentSku);
    expect(first).toBeGreaterThan(source.sequence);
    for (const [index, copy] of made.copies.entries()) {
      // ELY-SHT-0021, ELY-SHT-0022, ELY-SHT-0023: only the number changes.
      expect(copy.parentSku).toBe(`${prefix}-${String(first + index).padStart(4, '0')}`);
      expect(copy.slug).toBe(copy.parentSku.toLowerCase());
      expect(copy.sourceId).toBe(source.id);
      // The same name unless one is given.
      expect(copy.name).toBe(source.name);
      const product = await call<Product>(
        admin,
        'GET',
        `/v1/catalog/products/${copy.id}`,
        undefined,
        200,
      );
      expect(product.parentSku).toBe(copy.parentSku);
      expect(product.status).toBe('draft');
      expect(product.skus).toHaveLength(source.skus.length);
      for (const sku of product.skus) {
        const original = skuOf(source, ...sku.attributes.map((pair) => pair.valueLabel));
        // The variants follow: the source's code with the copy's parent SKU in front.
        expect(sku.skuCode).toBe(
          `${copy.parentSku}${original.skuCode.slice((source.parentSku ?? '').length)}`,
        );
        expect(sku.pricePoisha).toBe(original.pricePoisha);
      }
    }

    // From the list: two copies of each, in the order the products were given.
    const other = await shirtBySize(`Kurta ${suffix}`, `kurta-${suffix}`);
    const bulk = await call<{ products: readonly Copy[] }>(
      admin,
      'POST',
      '/v1/catalog/products/duplicate',
      { productIds: [other.id, source.id], copies: 2 },
      201,
    );
    expect(bulk.products.map((copy) => copy.sourceId)).toEqual([
      other.id,
      other.id,
      source.id,
      source.id,
    ]);
    expect(bulk.products.map((copy) => numberOf(copy.parentSku))).toEqual([
      other.sequence + 1,
      other.sequence + 2,
      other.sequence + 3,
      other.sequence + 4,
    ]);
    expect(bulk.products.map((copy) => copy.name)).toEqual([
      other.name,
      other.name,
      source.name,
      source.name,
    ]);

    // All or nothing: one archived product among them and no copy is made.
    const count = async () =>
      (
        await call<{ items: unknown[] }>(
          admin,
          'GET',
          `/v1/catalog/products?q=${encodeURIComponent(`hawaii ${suffix}`)}&limit=100`,
          undefined,
          200,
        )
      ).items.length;
    const before = await count();
    await call(
      admin,
      'PATCH',
      '/v1/catalog/products',
      { productIds: [other.id], status: 'archived' },
      200,
    );
    const refused = await status(admin, 'POST', '/v1/catalog/products/duplicate', {
      productIds: [source.id, other.id],
      copies: 1,
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.code).toBe('CATALOG_VARIANT_INVALID');
    expect(await count()).toBe(before);

    // Only a role that may create products; another brand's product is not found; the limits.
    expect(
      (await status(sales, 'POST', '/v1/catalog/products/duplicate', { productIds: [source.id] }))
        .statusCode,
    ).toBe(403);
    expect(
      (await status(adminB, 'POST', '/v1/catalog/products/duplicate', { productIds: [source.id] }))
        .statusCode,
    ).toBe(404);
    expect(
      (await status(admin, 'POST', `/v1/catalog/products/${source.id}/duplicate`, { copies: 51 }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await status(admin, 'POST', '/v1/catalog/products/duplicate', {
          productIds: [source.id],
          copies: 0,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('leaves out a variant with an archived colour, and refuses an archived category (M39a)', async () => {
    // A colour of its own, so archiving it touches no other test's products.
    const sand = await value(colourAttribute, `SAND${suffix.slice(0, 3).toUpperCase()}`, 9);
    const source = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Sand tee ${suffix}`,
        slug: `sand-tee-${suffix}`,
        categoryId: category,
        status: 'active',
        pricePoisha: '99000',
        axes: [
          { attributeId: sizeAttribute, valueIds: [sizes.S, sizes.M] },
          { attributeId: colourAttribute, valueIds: [colours.NAVY, sand] },
        ],
      },
      201,
    );
    const allSand = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `All sand ${suffix}`,
        slug: `all-sand-${suffix}`,
        status: 'active',
        pricePoisha: '99000',
        axes: [{ attributeId: colourAttribute, valueIds: [sand] }],
      },
      201,
    );
    // Archived for new work only: the source's sand variants stay active (D-624).
    await call(
      admin,
      'POST',
      `/v1/catalog/attributes/${colourAttribute}/values/${sand}/archive`,
      { archiveVariants: false },
      200,
    );
    const copy = await call<Product>(
      admin,
      'POST',
      `/v1/catalog/products/${source.id}/duplicate`,
      { name: `Sand tee ${suffix} copy` },
      201,
    );
    expect(copy.skus.map((sku) => sku.attributes.map((pair) => pair.valueId))).toEqual(
      expect.not.arrayContaining([expect.arrayContaining([sand])]),
    );
    expect(copy.skus).toHaveLength(2);

    // A product whose every variant carries it cannot be copied until it is restored.
    const refused = await status(admin, 'POST', `/v1/catalog/products/${allSand.id}/duplicate`, {
      name: `All sand ${suffix} copy`,
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.code).toBe('CATALOG_VARIANT_INVALID');
    await call(
      admin,
      'POST',
      `/v1/catalog/attributes/${colourAttribute}/values/${sand}/restore`,
      undefined,
      200,
    );

    // An archived category: no copy goes into it, and no product is moved into it in bulk.
    const coats = await call<{ id: string }>(
      admin,
      'POST',
      '/v1/catalog/categories',
      { name: `Coats ${suffix}`, slug: `coats-${suffix}`, code: 'COT' },
      201,
    );
    const coat = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Coat ${suffix}`,
        slug: `coat-${suffix}`,
        categoryId: coats.id,
        status: 'active',
        pricePoisha: '299000',
      },
      201,
    );
    await call(admin, 'POST', `/v1/catalog/categories/${coats.id}/archive`, undefined, 200);
    const copied = await status(admin, 'POST', `/v1/catalog/products/${coat.id}/duplicate`, {
      name: `Coat ${suffix} copy`,
    });
    expect(copied.statusCode, copied.body).toBe(400);
    expect(copied.code).toBe('CATALOG_CATEGORY_INVALID');
    const moved = await status(admin, 'PATCH', '/v1/catalog/products', {
      productIds: [source.id],
      categoryId: coats.id,
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.code).toBe('CATALOG_CATEGORY_INVALID');
  });
});

describe('sizes and colours added later (D-639)', () => {
  it('prices a new colour like the same size, a new size at the main price, codes size first', async () => {
    const tee = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Tee ${suffix}`,
        slug: `tee-${suffix}`,
        categoryId: category,
        status: 'active',
        pricePoisha: '99000',
        axes: [
          { attributeId: sizeAttribute, valueIds: [sizes.S, sizes.M, sizes.XL] },
          { attributeId: colourAttribute, valueIds: [colours.RED] },
        ],
        variantPrices: [
          { valueIds: [sizes.XL, colours.RED], pricePoisha: '119000' },
          { valueIds: [sizes.M, colours.RED], pricePoisha: '109000' },
        ],
      },
      201,
    );
    // The cheapest variant is archived: its price must never be the default.
    await call(
      admin,
      'PATCH',
      `/v1/catalog/skus/${skuOf(tee, 'S', 'RED').id}`,
      {
        status: 'archived',
      },
      200,
    );

    // The request lists colour first, as the attribute list does; the codes still read size
    // first, as on creation.
    const extended = await call<{
      created: string[];
      orphanedSkus: unknown[];
      product: Product;
    }>(
      admin,
      'POST',
      `/v1/catalog/products/${tee.id}/variants`,
      {
        axes: [
          { attributeId: colourAttribute, valueIds: [colours.RED, colours.BLUE] },
          { attributeId: sizeAttribute, valueIds: [sizes.S, sizes.M, sizes.XL, sizes.XXL] },
        ],
        variantPrices: [{ valueIds: [sizes.XXL, colours.BLUE], pricePoisha: '129000' }],
      },
      201,
    );
    expect(extended.orphanedSkus).toEqual([]);
    const product = extended.product;
    expect(skuOf(product, 'XXL', 'RED').skuCode).toMatch(/-XXL-RED$/);
    expect(skuOf(product, 'M', 'BLUE').skuCode).toMatch(/-M-BLUE$/);
    // Same size, other colour.
    expect(skuOf(product, 'XL', 'BLUE').pricePoisha).toBe('119000');
    expect(skuOf(product, 'M', 'BLUE').pricePoisha).toBe('109000');
    // A new size: the price most active variants carry (109000 and 119000 tie: the higher),
    // never the archived S at 99000.
    expect(skuOf(product, 'XXL', 'RED').pricePoisha).toBe('119000');
    expect(skuOf(product, 'S', 'BLUE').pricePoisha).not.toBe('99000');
    // The typed price wins.
    expect(skuOf(product, 'XXL', 'BLUE').pricePoisha).toBe('129000');

    const refused = await status(admin, 'POST', `/v1/catalog/products/${tee.id}/variants`, {
      axes: [
        { attributeId: sizeAttribute, valueIds: [sizes.M] },
        { attributeId: colourAttribute, valueIds: [colours.RED] },
      ],
      variantPrices: [{ valueIds: [sizes.M, colours.RED], pricePoisha: '1000' }],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.code).toBe('CATALOG_VARIANT_INVALID');
  });

  it('a colour added to a size-only product reports the old variants to archive, together', async () => {
    const plain = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Plain ${suffix}`,
        slug: `plain-${suffix}`,
        status: 'active',
        pricePoisha: '89000',
        axes: [{ attributeId: sizeAttribute, valueIds: [sizes.M, sizes.L] }],
      },
      201,
    );
    const extended = await call<{
      created: string[];
      orphanedSkus: { id: string; skuCode: string }[];
    }>(
      admin,
      'POST',
      `/v1/catalog/products/${plain.id}/variants`,
      {
        axes: [
          { attributeId: sizeAttribute, valueIds: [sizes.M, sizes.L] },
          { attributeId: colourAttribute, valueIds: [colours.RED] },
        ],
      },
      201,
    );
    expect(extended.created).toHaveLength(2);
    expect(extended.created.every((code) => code.endsWith('-RED'))).toBe(true);
    expect(extended.orphanedSkus.map((sku) => sku.id).sort()).toEqual(
      plain.skus.map((sku) => sku.id).sort(),
    );

    const archived = await call<{ changed: { id: string }[]; unchanged: number }>(
      admin,
      'PATCH',
      '/v1/catalog/skus',
      { skuIds: extended.orphanedSkus.map((sku) => sku.id), status: 'archived' },
      200,
    );
    expect(archived.changed).toHaveLength(2);
    const after = await call<Product>(
      admin,
      'GET',
      `/v1/catalog/products/${plain.id}`,
      undefined,
      200,
    );
    expect(after.skus.filter((sku) => sku.status === 'archived')).toHaveLength(2);
  });

  it('stop selling XS in every colour: refused while orders hold pieces', async () => {
    const shirt = await shirtBySize(`Held ${suffix}`, `held-${suffix}`);
    const sRed = skuOf(shirt, 'S', 'RED');
    const sNavy = skuOf(shirt, 'S', 'NAVY');
    await call(
      admin,
      'POST',
      '/v1/supply/entries',
      {
        supplyId: randomUUID(),
        supplierId: supplier,
        locationId: mainWarehouse,
        lines: [{ skuId: sNavy.id, qty: 2, unitCostPoisha: '60000' }],
      },
      201,
    );
    const inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });
    await withOrg({ orgId: ORG_A, userId: admin.userId }, async (tx) => {
      await inventory.reserve(
        tx,
        { orgId: ORG_A, userId: admin.userId },
        {
          refType: 'order',
          refId: randomUUID(),
          lines: [{ skuId: sNavy.id, locationId: mainWarehouse, qty: 1 }],
        },
      );
    });
    const sizeS = shirt.skus.filter((sku) =>
      sku.attributes.some((pair) => pair.valueLabel === 'S'),
    );
    const refused = await status(admin, 'PATCH', '/v1/catalog/skus', {
      skuIds: sizeS.map((sku) => sku.id),
      status: 'archived',
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.code).toBe('CATALOG_SKU_HELD');
    expect(refused.body).toContain(sNavy.skuCode);
    const unchanged = await call<Product>(
      admin,
      'GET',
      `/v1/catalog/products/${shirt.id}`,
      undefined,
      200,
    );
    expect(unchanged.skus.every((sku) => sku.status === 'active')).toBe(true);

    // Without the held one it goes through; on-hand stock alone does not stop it.
    const others = sizeS.filter((sku) => sku.id !== sNavy.id);
    const done = await call<{ changed: { id: string }[] }>(
      admin,
      'PATCH',
      '/v1/catalog/skus',
      { skuIds: others.map((sku) => sku.id), status: 'archived' },
      200,
    );
    expect(done.changed.map((sku) => sku.id)).toContain(sRed.id);
    expect(
      (await status(sales, 'PATCH', '/v1/catalog/skus', { skuIds: [sRed.id], status: 'active' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await status(adminB, 'PATCH', '/v1/catalog/skus', { skuIds: [sRed.id], status: 'active' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('weights, photo colours, the category default chart, bulk changes (D-642 to D-646)', () => {
  it('a variant weight overrides the product, and a photo takes colours only', async () => {
    const shirt = await shirtBySize(`Weighed ${suffix}`, `weighed-${suffix}`);
    const xl = skuOf(shirt, 'XL', 'NAVY');
    await call(admin, 'PUT', `/v1/catalog/skus/${xl.id}/weight`, { weightGrams: 420 }, 200);
    const after = await call<Product>(
      admin,
      'GET',
      `/v1/catalog/products/${shirt.id}`,
      undefined,
      200,
    );
    expect(skuOf(after, 'XL', 'NAVY').weightGrams).toBe(420);
    expect(after.weightGrams).toBe(350);
    await call(admin, 'PATCH', `/v1/catalog/products/${shirt.id}`, { weightGrams: null }, 200);

    const notColour = await status(
      admin,
      'PUT',
      `/v1/catalog/products/${shirt.id}/images/${randomUUID()}/colour`,
      { colourValueId: sizes.M },
    );
    expect(notColour.statusCode).toBe(400);
    const missing = await status(
      admin,
      'PUT',
      `/v1/catalog/products/${shirt.id}/images/${randomUUID()}/colour`,
      { colourValueId: colours.RED },
    );
    expect(missing.statusCode).toBe(404);
  });

  it('a new product filed under a category starts with its default size chart', async () => {
    const chart = await call<{ id: string }>(
      marketing,
      'POST',
      '/v1/storefront/size-charts',
      { name: `Shirts chart ${suffix}`, columns: ['Size', 'Chest'], rows: [['M', '40']] },
      201,
    );
    await call(
      marketing,
      'PUT',
      `/v1/storefront/categories/${category}`,
      { defaultSizeChartId: chart.id },
      200,
    );
    const product = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Charted ${suffix}`,
        slug: `charted-${suffix}`,
        categoryId: category,
        pricePoisha: '100000',
      },
      201,
    );
    expect(product.web.sizeChartId).toBe(chart.id);

    // Emptied into another chart (M39a's empty-and-delete): the category's new products start
    // on the replacement, not on none (re-audit N3).
    const replacement = await call<{ id: string }>(
      marketing,
      'POST',
      '/v1/storefront/size-charts',
      { name: `Shirts chart two ${suffix}`, columns: ['Size', 'Chest'], rows: [['M', '41']] },
      201,
    );
    await call(
      marketing,
      'POST',
      `/v1/storefront/size-charts/${chart.id}/empty-and-delete`,
      { replacementId: replacement.id },
      200,
    );
    const categories = await call<{
      items: { id: string; web: { defaultSizeChartId: string | null } }[];
    }>(admin, 'GET', '/v1/catalog/categories', undefined, 200);
    expect(categories.items.find((entry) => entry.id === category)?.web.defaultSizeChartId).toBe(
      replacement.id,
    );
    await call(
      marketing,
      'PUT',
      `/v1/storefront/categories/${category}`,
      { defaultSizeChartId: null },
      200,
    );
  });

  it('archives, re-files and puts on the website many products at once', async () => {
    const one = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      { name: `Bulk one ${suffix}`, slug: `bulk-one-${suffix}`, pricePoisha: '100000' },
      201,
    );
    const two = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      { name: `Bulk two ${suffix}`, slug: `bulk-two-${suffix}`, pricePoisha: '100000' },
      201,
    );
    await call(
      admin,
      'PATCH',
      '/v1/catalog/products',
      { productIds: [one.id, two.id], categoryId: category, status: 'active' },
      200,
    );
    await call(
      marketing,
      'PUT',
      '/v1/storefront/products',
      { productIds: [one.id, two.id], webVisible: true },
      200,
    );
    const listed = await call<{ items: { id: string; webVisible: boolean; categoryId: string }[] }>(
      admin,
      'GET',
      `/v1/catalog/products?q=bulk`,
      undefined,
      200,
    );
    const ours = listed.items.filter((item) => item.id === one.id || item.id === two.id);
    expect(ours).toHaveLength(2);
    expect(ours.every((item) => item.webVisible && item.categoryId === category)).toBe(true);
    const missing = await status(admin, 'PATCH', '/v1/catalog/products', {
      productIds: [one.id, randomUUID()],
      status: 'archived',
    });
    expect(missing.statusCode).toBe(404);
    expect(
      (
        await status(sales, 'PATCH', '/v1/catalog/products', {
          productIds: [one.id],
          status: 'archived',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await status(sales, 'PUT', '/v1/storefront/products', {
          productIds: [one.id],
          webVisible: false,
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('the website: regular prices and live flash prices (M39 check 7, D-640)', () => {
  let key: TestSiteKey;
  let regular: Product;
  let flash: Product;
  let plain: Product;

  async function signed<T>(
    pathAndQuery: string,
  ): Promise<{ status: number; body: T; raw: string }> {
    const response = await signedGet(harness.server, key, pathAndQuery);
    return {
      status: response.statusCode,
      body: JSON.parse(response.body) as T,
      raw: response.body,
    };
  }

  async function onWebsite(name: string, slug: string, compareAt?: string): Promise<Product> {
    const product = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name,
        slug,
        status: 'active',
        pricePoisha: '149000',
        ...(compareAt === undefined ? {} : { compareAtPoisha: compareAt }),
        axes: [{ attributeId: sizeAttribute, valueIds: [sizes.M, sizes.L] }],
      },
      201,
    );
    await call(
      marketing,
      'PUT',
      `/v1/storefront/products/${product.id}`,
      { webVisible: true },
      200,
    );
    return product;
  }

  beforeAll(async () => {
    key = await insertTestSiteKey(ORG_A);
    regular = await onWebsite(`Regular ${suffix}`, `regular-${suffix}`, '189000');
    flash = await onWebsite(`Flash ${suffix}`, `flash-${suffix}`);
    plain = await onWebsite(`Plainweb ${suffix}`, `plainweb-${suffix}`);
    const m = skuOf(flash, 'M');
    const created = await marketing.client.request('POST', '/v1/promo/flash-sales', {
      body: {
        title: `Flash ${suffix}`,
        enabled: true,
        items: [{ skuId: m.id, salePricePoisha: '119000', unitLimit: 5 }],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
  }, 60_000);

  it('the product page strikes through the regular price, and the flash price under it', async () => {
    const page = await signed<{
      product: {
        variants: {
          skuId: string;
          price: { poisha: string };
          compareAt: { poisha: string } | null;
        }[];
        galleries: unknown[];
      };
    }>(`/storefront/v1/catalog/products/regular-${suffix}`);
    expect(page.status, page.raw).toBe(200);
    expect(page.body.product.variants.every((v) => v.price.poisha === '149000')).toBe(true);
    expect(page.body.product.variants.every((v) => v.compareAt?.poisha === '189000')).toBe(true);
    expect(page.body.product.galleries).toEqual([]);

    const sale = await signed<{
      product: {
        variants: {
          skuId: string;
          price: { poisha: string };
          compareAt: { poisha: string } | null;
        }[];
        compareAt: { poisha: string } | null;
        onSale: boolean;
        price: { min: { poisha: string } };
      };
    }>(`/storefront/v1/catalog/products/flash-${suffix}`);
    expect(sale.status, sale.raw).toBe(200);
    const m = sale.body.product.variants.find((v) => v.skuId === skuOf(flash, 'M').id);
    const l = sale.body.product.variants.find((v) => v.skuId === skuOf(flash, 'L').id);
    expect(m).toMatchObject({ price: { poisha: '119000' }, compareAt: { poisha: '149000' } });
    expect(l).toMatchObject({ price: { poisha: '149000' }, compareAt: null });
    expect(sale.body.product.onSale).toBe(true);
    expect(sale.body.product.price.min.poisha).toBe('119000');
    expect(sale.body.product.compareAt?.poisha).toBe('149000');
  });

  it('a card never shows one size’s regular price beside another size’s price (W4)', async () => {
    const mixed = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Mixed ${suffix}`,
        slug: `mixed-${suffix}`,
        status: 'active',
        pricePoisha: '99000',
        axes: [{ attributeId: sizeAttribute, valueIds: [sizes.S, sizes.XL] }],
        variantPrices: [{ valueIds: [sizes.XL], pricePoisha: '149000', compareAtPoisha: '189000' }],
      },
      201,
    );
    await call(marketing, 'PUT', `/v1/storefront/products/${mixed.id}`, { webVisible: true }, 200);
    const page = await signed<{
      items: {
        id: string;
        onSale: boolean;
        compareAt: { poisha: string } | null;
        price: { min: { poisha: string } };
      }[];
    }>(`/storefront/v1/catalog/products?onSale=true&limit=60`);
    const card = page.body.items.find((item) => item.id === mixed.id);
    expect(card).toMatchObject({
      onSale: true,
      compareAt: null,
      price: { min: { poisha: '99000' } },
    });
  });

  it('the cards say so too, and "on sale" lists exactly those', async () => {
    const all = await signed<{
      items: { id: string; onSale: boolean; compareAt: { poisha: string } | null }[];
    }>('/storefront/v1/catalog/products?limit=60');
    expect(all.status, all.raw).toBe(200);
    const card = (id: string) => all.body.items.find((item) => item.id === id);
    expect(card(regular.id)).toMatchObject({ onSale: true, compareAt: { poisha: '189000' } });
    expect(card(flash.id)).toMatchObject({ onSale: true, compareAt: { poisha: '149000' } });
    expect(card(plain.id)).toMatchObject({ onSale: false, compareAt: null });

    const onSale = await signed<{ items: { id: string }[] }>(
      '/storefront/v1/catalog/products?onSale=true&limit=60',
    );
    expect(onSale.status, onSale.raw).toBe(200);
    const ids = onSale.body.items.map((item) => item.id);
    expect(ids).toContain(regular.id);
    expect(ids).toContain(flash.id);
    expect(ids).not.toContain(plain.id);
    // Nothing a margin could be read from reaches the website.
    expect(findCostFields(onSale.body)).toEqual([]);
  });
});

describe('ledger audit follow-ups (W1, W4, W5, N4, N10)', () => {
  it('a standard buying price never moves the average: the receipt’s own cost does', async () => {
    const tee = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Standard tee ${suffix}`,
        slug: `standard-tee-${suffix}`,
        status: 'active',
        pricePoisha: '120000',
        axes: [{ attributeId: sizeAttribute, valueIds: [sizes.M] }],
      },
      201,
    );
    const m = skuOf(tee, 'M');
    await call(
      accounts,
      'PUT',
      '/v1/supply/sku-costs',
      { entries: [{ skuId: m.id, supplierId: null, standardUnitCostPoisha: '50000' }] },
      200,
    );
    await call(
      admin,
      'POST',
      '/v1/supply/entries',
      {
        supplyId: randomUUID(),
        supplierId: supplier,
        locationId: mainWarehouse,
        lines: [{ skuId: m.id, qty: 4, unitCostPoisha: '70000' }],
      },
      201,
    );
    const costs = await call<{
      items: { wacPoisha: string | null; standardUnitCostPoisha: string | null }[];
    }>(accounts, 'GET', `/v1/supply/sku-costs?skuIds=${m.id}`, undefined, 200);
    expect(costs.items[0]).toMatchObject({ wacPoisha: '70000', standardUnitCostPoisha: '50000' });
  });

  it('the spreadsheet import is a cost role’s, and the audit log keeps counts, never figures', async () => {
    const lines = ['sku,standard_cost_taka', `NOPE-${suffix.toUpperCase()},1`, ''].join('\n');
    for (const who of [sales, warehouse, marketing]) {
      expect(
        (await status(who, 'POST', '/v1/supply/sku-costs/import', { csv: lines })).statusCode,
      ).toBe(403);
      expect(
        (await status(who, 'POST', '/v1/supply/sku-costs/import/dry-run', { csv: lines }))
          .statusCode,
      ).toBe(403);
      expect((await status(who, 'GET', '/v1/supply/sku-costs/export')).statusCode).toBe(403);
    }
    const product = await shirtBySize(`Audited ${suffix}`, `audited-${suffix}`);
    const sku = skuOf(product, 'M', 'NAVY');
    const csv = ['sku,standard_cost_taka', `${sku.skuCode},987.65`, ''].join('\n');
    await call(accounts, 'POST', '/v1/supply/sku-costs/import/dry-run', { csv }, 201);
    await call(accounts, 'POST', '/v1/supply/sku-costs/import', { csv }, 201);
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ action: string; after: unknown }>(sql`
          select action, after from audit.audit_log
          where org_id = ${ORG_A} and action like 'supply.standard_costs.%'
        `),
      { orgId: ORG_A },
    );
    expect(rows.map((row) => row.action)).toEqual(
      expect.arrayContaining(['supply.standard_costs.checked', 'supply.standard_costs.imported']),
    );
    // The service's own rows hold counts and nothing else: no file, no column name, no figure.
    for (const row of rows) {
      const after = row.after as Record<string, unknown>;
      expect(Object.values(after).every((value) => typeof value === 'number')).toBe(true);
      const body = JSON.stringify(after);
      for (const leak of ['csv', 'standard_cost_taka', '987.65', sku.skuCode]) {
        expect(body).not.toContain(leak);
      }
    }
    // The interceptor's net stood down for these routes: no `http:` row keeps the request body.
    const netted = await withSystem(
      async (tx) =>
        tx.execute<{ action: string }>(sql`
          select action from audit.audit_log
          where org_id = ${ORG_A} and action like 'http:% /v1/supply/sku-costs%'
        `),
      { orgId: ORG_A },
    );
    expect(netted.map((row) => row.action)).toEqual([]);
    // And the figure is nowhere in the brand's log. (The catalog price spreadsheet's own text is
    // kept by the net, which is a selling price, not a cost: a recorded follow-up.)
    const everything = await withSystem(
      async (tx) =>
        tx.execute<{ body: string }>(sql`
          select coalesce(after::text, '') || coalesce(before::text, '') as body
          from audit.audit_log where org_id = ${ORG_A}
        `),
      { orgId: ORG_A },
    );
    expect(everything.some((row) => row.body.includes('987.65'))).toBe(false);
  });

  it('the catalog price spreadsheet names a price that would reach its regular price (N11)', async () => {
    const product = await shirtBySize(`Imported ${suffix}`, `imported-${suffix}`);
    const red = skuOf(product, 'S', 'RED');
    const csv = ['sku,price_taka', `${red.skuCode},1990`, ''].join('\n');
    const dry = await call<{ canCommit: boolean; problems: { line: number; column: string }[] }>(
      admin,
      'POST',
      '/v1/catalog/imports/prices/dry-run',
      { csv },
      201,
    );
    expect(dry.canCommit).toBe(false);
    expect(dry.problems).toEqual([expect.objectContaining({ line: 2, column: 'price_taka' })]);
    const refused = await status(admin, 'POST', '/v1/catalog/imports/prices', { csv });
    expect(refused.statusCode).toBe(422);
  });

  it('a reprice made against an old price is refused rather than overwriting a newer one', async () => {
    const product = await shirtBySize(`Raced ${suffix}`, `raced-${suffix}`);
    const sku = skuOf(product, 'S', 'NAVY');
    await call(
      admin,
      'PUT',
      '/v1/catalog/prices',
      { prices: [{ skuId: sku.id, pricePoisha: '155000' }] },
      200,
    );
    const stale = await status(admin, 'PUT', '/v1/catalog/prices', {
      prices: [{ skuId: sku.id, pricePoisha: '160000', expectedPricePoisha: sku.pricePoisha }],
    });
    expect(stale.statusCode, stale.body).toBe(400);
    expect(stale.code).toBe('CATALOG_PRICE_INVALID');
    const fresh = await status(admin, 'PUT', '/v1/catalog/prices', {
      prices: [{ skuId: sku.id, pricePoisha: '160000', expectedPricePoisha: '155000' }],
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
  });

  it('the product list’s stock: the stock page’s scope, and none of another brand’s', async () => {
    const branch = await createBranch(ORG_A, `BR-VP${suffix.toUpperCase().slice(0, 4)}`);
    const showroom = await makeLocation(ORG_A, {
      code: `SR-VP${suffix.toUpperCase().slice(0, 4)}`,
      name: 'Variant price showroom',
      kind: 'showroom',
      branchId: branch,
    });
    const tee = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Counted tee ${suffix}`,
        slug: `counted-tee-${suffix}`,
        status: 'active',
        pricePoisha: '90000',
      },
      201,
    );
    const only = tee.skus[0]?.id ?? '';
    for (const [locationId, qty] of [
      [mainWarehouse, 3],
      [showroom, 2],
    ] as const) {
      await call(
        admin,
        'POST',
        '/v1/supply/entries',
        {
          supplyId: randomUUID(),
          supplierId: supplier,
          locationId,
          lines: [{ skuId: only, qty, unitCostPoisha: '40000' }],
        },
        201,
      );
    }
    const url = `/v1/inventory/stock/products?productIds=${tee.id}`;
    const all = await call<{ items: { productId: string; onHand: number; available: number }[] }>(
      admin,
      'GET',
      url,
      undefined,
      200,
    );
    expect(all.items).toEqual([{ productId: tee.id, onHand: 5, available: 5 }]);
    const manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branch] });
    // §6 gives a branch manager the whole brand's stock (a showroom offers a transfer from
    // another branch), so the route's scope is the stock page's: the same five pieces.
    const mine = await call<{ items: { onHand: number }[] }>(manager, 'GET', url, undefined, 200);
    expect(mine.items).toEqual([{ productId: tee.id, onHand: 5, available: 5 }]);
    const other = await call<{ items: unknown[] }>(adminB, 'GET', url, undefined, 200);
    expect(other.items).toEqual([]);
    expect(JSON.stringify(all)).not.toMatch(/cost|wac/i);
  });
});

describe('standard buying prices and M39a’s deletes (re-audit W1, W2)', () => {
  async function priceRows(where: { skuId?: string; supplierId?: string; orgId?: string }) {
    return withSystem(
      async (tx) =>
        tx.execute<{ sku_id: string; supplier_id: string | null }>(sql`
          select sku_id, supplier_id from supply.sku_purchase_prices
          where org_id = ${where.orgId ?? ORG_A}
            and (${where.skuId ?? null}::uuid is null or sku_id = ${where.skuId ?? null}::uuid)
            and (${where.supplierId ?? null}::uuid is null
                 or supplier_id = ${where.supplierId ?? null}::uuid)
        `),
      { orgId: where.orgId ?? ORG_A },
    );
  }

  async function standard(skuId: string, supplierId: string | null, poisha: string) {
    await call(
      accounts,
      'PUT',
      '/v1/supply/sku-costs',
      { entries: [{ skuId, supplierId, standardUnitCostPoisha: poisha }] },
      200,
    );
  }

  it('a variant or product nothing used is deleted with its standard prices, and the log counts them', async () => {
    const otherBrandBefore = (await priceRows({ orgId: ORG_B })).length;
    const tee = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Mistake tee ${suffix}`,
        slug: `mistake-tee-${suffix}`,
        status: 'active',
        pricePoisha: '90000',
        axes: [{ attributeId: sizeAttribute, valueIds: [sizes.S, sizes.M] }],
      },
      201,
    );
    const s = skuOf(tee, 'S');
    const m = skuOf(tee, 'M');
    await standard(s.id, null, '40000');
    await standard(s.id, supplier, '41000');
    await standard(m.id, null, '42000');

    const deleted = await status(admin, 'DELETE', `/v1/catalog/skus/${s.id}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await priceRows({ skuId: s.id })).toEqual([]);
    expect(await priceRows({ skuId: m.id })).toHaveLength(1);
    const logged = await withSystem(
      async (tx) =>
        tx.execute<{ actor_user_id: string | null; entity_id: string; before: unknown }>(sql`
          select actor_user_id, entity_id, before from audit.audit_log
          where org_id = ${ORG_A} and action = 'supply.standard_costs.removed'
            and entity_id = ${s.id}
        `),
      { orgId: ORG_A },
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]?.actor_user_id).toBe(admin.userId);
    // Counts only: the figures stay out of the append-only log (invariant 5).
    expect(logged[0]?.before).toEqual({ standardBuyingPrices: 2, variants: 1 });
    expect(JSON.stringify(logged[0]?.before)).not.toMatch(/4[01]000/);

    const gone = await status(admin, 'DELETE', `/v1/catalog/products/${tee.id}`);
    expect(gone.statusCode, gone.body).toBe(200);
    expect(await priceRows({ skuId: m.id })).toEqual([]);
    expect((await priceRows({ orgId: ORG_B })).length).toBe(otherBrandBefore);
  });

  it('a variant with a receipt is kept, and so is its standard price', async () => {
    const tee = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Kept tee ${suffix}`,
        slug: `kept-tee-${suffix}`,
        status: 'active',
        pricePoisha: '90000',
      },
      201,
    );
    const only = tee.skus[0]?.id ?? '';
    await standard(only, null, '43000');
    await call(
      admin,
      'POST',
      '/v1/supply/entries',
      {
        supplyId: randomUUID(),
        supplierId: supplier,
        locationId: mainWarehouse,
        lines: [{ skuId: only, qty: 1, unitCostPoisha: '43000' }],
      },
      201,
    );
    const refused = await status(admin, 'DELETE', `/v1/catalog/skus/${only}`);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.code).toBe('CATALOG_IN_USE');
    expect(await priceRows({ skuId: only })).toHaveLength(1);
  });

  it('a supplier nothing used takes only its own standard prices with it', async () => {
    const spare = await call<{ id: string }>(
      admin,
      'POST',
      '/v1/supply/suppliers',
      { code: `SUP-DX${suffix.slice(0, 3).toUpperCase()}`, name: 'Duplicate Mills' },
      201,
    );
    const tee = await call<Product>(
      admin,
      'POST',
      '/v1/catalog/products',
      {
        name: `Supplied tee ${suffix}`,
        slug: `supplied-tee-${suffix}`,
        status: 'active',
        pricePoisha: '90000',
      },
      201,
    );
    const only = tee.skus[0]?.id ?? '';
    await standard(only, null, '44000');
    await standard(only, spare.id, '45000');
    await standard(only, otherSupplier, '46000');

    const deleted = await status(admin, 'DELETE', `/v1/supply/suppliers/${spare.id}`);
    expect(deleted.statusCode, deleted.body).toBe(200);
    const left = await priceRows({ skuId: only });
    expect(left.map((row) => row.supplier_id).sort()).toEqual([null, otherSupplier].sort());
    const logged = await withSystem(
      async (tx) =>
        tx.execute<{ before: { standardBuyingPrices?: number } }>(sql`
          select before from audit.audit_log
          where org_id = ${ORG_A} and entity_id = ${spare.id} and operation = 'delete'
        `),
      { orgId: ORG_A },
    );
    expect(logged.map((row) => row.before.standardBuyingPrices)).toEqual([1]);
  });

  it('every foreign key into a supplier is restrict but the standard price, read from the database', async () => {
    const keys = await withSystem(async (tx) =>
      tx.execute<{ child: string; action: string }>(sql`
        select cn.nspname || '.' || c.relname as child, con.confdeltype::text as action
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace cn on cn.oid = c.relnamespace
        join pg_class p on p.oid = con.confrelid
        join pg_namespace pn on pn.oid = p.relnamespace
        where con.contype = 'f' and pn.nspname = 'supply' and p.relname = 'suppliers'
        order by 1
      `),
    );
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.filter((key) => key.action === 'c').map((key) => key.child)).toEqual([
      'supply.sku_purchase_prices',
    ]);
  });
});

describe('the price-history trigger and the standard price table, in the database', () => {
  it('keeps the standard price under RLS: another brand sees no row', async () => {
    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from supply.sku_purchase_prices where org_id = ${ORG_A}
      `),
    );
    expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
    const fromB = await withOrg({ orgId: ORG_B }, async (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from supply.sku_purchase_prices where org_id = ${ORG_A}
      `),
    );
    expect(fromB[0]?.n).toBe(0);
  });
});
