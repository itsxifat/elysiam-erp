import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isStillReferenced } from '../../platform/references/references.js';
import {
  ORG_A,
  ORG_B,
  auditRowsFor,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { makeLocation, warehouseId } from '../inventory/inventory.testing.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import {
  insertTestSiteKey,
  signedGet,
  type TestSiteKey,
} from '../storefront/storefront.testing.js';
import { seedWallet } from '../wallets/wallets.testing.js';
import { toCatalogHttpError } from './catalog.errors.js';
import { CatalogReferences } from './ports/catalog-references.port.js';
import { makeBankWallet, makeCourier, seedShippedOrder } from '../courier/courier.testing.js';
import { LocationReferences } from '../inventory/ports/location-references.port.js';

/**
 * Deleting and archiving the catalog (M39a, D-621 to D-626; M39 checks 1 and 2), over HTTP
 * on a real PostgreSQL, through the guard, the interceptors and `serializeFor()`.
 *
 * Every row that nothing uses is deleted, with its audit row holding what it was; every row
 * that a stock movement, an order line, a till line, a supply line, a flash sale, a live
 * discount or a lead names is refused with `CATALOG_IN_USE` and the counts, and stays. A
 * reference and a delete at the same moment never leave a reference to nothing.
 */

let harness: HttpHarness;
let admin: RoleClient;
let marketing: RoleClient;
let warehouse: RoleClient;
let sales: RoleClient;
let otherAdmin: RoleClient;
let inventory: InventoryApi;
let mainWarehouse = '';
let siteKey: TestSiteKey;

interface Called<T> {
  readonly status: number;
  readonly body: T;
  readonly raw: string;
}

async function call<T = Record<string, unknown>>(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<Called<T>> {
  const response = await who.client.request(
    method,
    url,
    payload === undefined ? {} : { body: payload },
  );
  return {
    status: response.statusCode,
    body: (response.body === '' ? {} : JSON.parse(response.body)) as T,
    raw: response.body,
  };
}

async function ok<T = Record<string, unknown>>(
  who: RoleClient,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<T> {
  const result = await call<T>(who, method, url, payload);
  expect(result.status, `${method} ${url}: ${result.raw}`).toBeLessThan(300);
  return result.body;
}

const token = (length = 6) => randomUUID().replace(/-/g, '').slice(0, length).toUpperCase();

async function category(name: string, parentId?: string): Promise<{ id: string; slug: string }> {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${token(4).toLowerCase()}`;
  const created = await ok<{ id: string }>(admin, 'POST', '/v1/catalog/categories', {
    name,
    slug,
    code: `C${token(6)}`,
    ...(parentId === undefined ? {} : { parentId }),
  });
  return { id: created.id, slug };
}

async function list(
  name: string,
  labels: readonly string[],
): Promise<{ id: string; values: string[] }> {
  const created = await ok<{ id: string }>(admin, 'POST', '/v1/catalog/attributes', {
    code: `L_${token(8)}`,
    name,
    kind: 'size',
    isVariant: true,
  });
  const values: string[] = [];
  for (const [index, label] of labels.entries()) {
    const value = await ok<{ id: string }>(
      admin,
      'POST',
      `/v1/catalog/attributes/${created.id}/values`,
      { code: `${label.replace(/[^A-Z0-9]/g, '')}${index}`.slice(0, 8), label, position: index },
    );
    values.push(value.id);
  }
  return { id: created.id, values };
}

interface Product {
  readonly id: string;
  readonly slug: string;
  /** The parent SKU (D-661); a new product's slug is it in lower case. */
  readonly parentSku: string | null;
  readonly skus: readonly { readonly id: string; readonly skuCode: string }[];
}

async function product(name: string, extra: Record<string, unknown> = {}): Promise<Product> {
  return ok<Product>(admin, 'POST', '/v1/catalog/products', {
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${token(4).toLowerCase()}`,
    pricePoisha: '150000',
    status: 'active',
    ...extra,
  });
}

function skuOf(item: Product): string {
  const id = item.skus[0]?.id;
  if (id === undefined) throw new Error('the product has no SKU');
  return id;
}

async function receive(skuId: string, qty = 3): Promise<void> {
  const actor = { orgId: ORG_A, userId: 'usr_deletes_e2e' };
  await withOrg(actor, (tx) =>
    inventory.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: mainWarehouse,
      branchId: null,
      occurredAt: new Date(),
      lines: [{ skuId, qty, unitCostPoisha: poisha(90_000) }],
    }),
  );
}

async function exists(table: 'skus' | 'products' | 'categories', id: string): Promise<boolean> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ found: boolean }>(
        sql`select exists (select 1 from ${sql.raw(`catalog.${table}`)} where id = ${id}) as found`,
      );
      return rows[0]?.found === true;
    },
    { orgId: ORG_A },
  );
}

async function scalar(query: ReturnType<typeof sql>): Promise<number> {
  return withSystem(async (tx) => Number((await tx.execute<{ n: string }>(query))[0]?.n ?? 0), {
    orgId: ORG_A,
  });
}

interface Usage {
  readonly canDelete: boolean;
  readonly canEmptyAndDelete: boolean;
  readonly canArchive: boolean;
  readonly archived: boolean;
  readonly activeVariants?: number;
  readonly uses: readonly {
    readonly reason: string;
    readonly count: number;
    readonly movable: boolean;
    readonly examples: readonly { readonly id: string; readonly label: string }[];
  }[];
}

const reasons = (usage: Usage) =>
  Object.fromEntries(usage.uses.map((use) => [use.reason, use.count]));

beforeAll(async () => {
  harness = await startHttpHarness('catalog-deletes');
  admin = await harness.asRole('org_admin', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  otherAdmin = await harness.asRole('org_admin', ORG_B);
  inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });
  mainWarehouse = await warehouseId(ORG_A);
  siteKey = await insertTestSiteKey(ORG_A);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('every module that points at catalog rows answers (D-621)', () => {
  it('has every expected checker registered', () => {
    const registry = harness.app.get(CatalogReferences, { strict: false });
    expect(registry.modules()).toEqual([
      'courier',
      // M42: a customer's interest in a product or a size keeps it.
      'inbox',
      'inventory',
      'marketing',
      // M35b, joined at integration: an ncom.bd hold keeps the SKUs it held.
      'marketplace',
      'orders',
      // M38b: a packing scan keeps the SKU it named.
      'packing',
      'pos',
      'promo',
      'storefront',
      'supply',
    ]);
  });

  /*
   * The critic's first finding: `courier.return_receipt_lines.sku_id` has its key only in
   * 0048's SQL. So the list of what points at a SKU, a product, a category or a value is read
   * from the database, not from the Drizzle schema, and every foreign key is either counted
   * by a checker (named here with the module that counts it) or cascades with its parent.
   */
  it('counts or cascades every foreign key into the catalog, read from the database', async () => {
    const keys = await withSystem(async (tx) =>
      tx.execute<{ child: string; parent: string; action: string }>(sql`
        select cn.nspname || '.' || c.relname as child,
               pn.nspname || '.' || p.relname as parent,
               con.confdeltype::text as action
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace cn on cn.oid = c.relnamespace
        join pg_class p on p.oid = con.confrelid
        join pg_namespace pn on pn.oid = p.relnamespace
        where con.contype = 'f'
          and pn.nspname = 'catalog'
          and p.relname in ('skus', 'products', 'categories', 'attribute_values', 'attributes')
          and cn.nspname <> 'catalog'
        order by 1, 2
      `),
    );
    const counted: Readonly<Record<string, string>> = {
      'courier.return_receipt_lines->catalog.skus': 'courier',
      // M42: the inbox's product interests (D-741).
      'inbox.interests->catalog.products': 'inbox',
      'inbox.interests->catalog.skus': 'inbox',
      'inventory.adjustment_lines->catalog.skus': 'inventory',
      'inventory.count_lines->catalog.skus': 'inventory',
      'inventory.count_scans->catalog.skus': 'inventory',
      'inventory.reservations->catalog.skus': 'inventory',
      'inventory.sku_costs->catalog.skus': 'inventory',
      'inventory.stock_in_hand_lines->catalog.skus': 'inventory',
      'inventory.stock_movements->catalog.skus': 'inventory',
      'inventory.stock_transfer_lines->catalog.skus': 'inventory',
      'marketing.leads->catalog.skus': 'marketing',
      // M38b: a packing scan keeps the SKU it named.
      'packing.scans->catalog.skus': 'packing',
      'pos.return_lines->catalog.skus': 'pos',
      'pos.sale_lines->catalog.skus': 'pos',
      'promo.flash_sale_items->catalog.skus': 'promo',
      'sales.order_lines->catalog.skus': 'orders',
      // M35b, joined at integration: a campaign link opening a category (D-551).
      'storefront.custom_links->catalog.categories': 'storefront',
      'storefront.nav_items->catalog.categories': 'storefront',
      'supply.return_lines->catalog.skus': 'supply',
      'supply.supply_lines->catalog.skus': 'supply',
    };
    const uncovered = keys
      .filter((key) => key.action !== 'c')
      .map((key) => `${key.child}->${key.parent}`)
      .filter((name) => counted[name] === undefined);
    expect(uncovered, 'a new foreign key into the catalog needs a checker').toEqual([]);
    // Cascades are only the ones 0118 made, guarded by 0119, and M39b's standard buying
    // price (D-638): a setting kept for a SKU, not evidence, so it leaves with its SKU.
    expect(
      keys.filter((key) => key.action === 'c').map((key) => `${key.child}->${key.parent}`),
    ).toEqual(['inventory.stock_levels->catalog.skus', 'supply.sku_purchase_prices->catalog.skus']);
  });

  it('counts or cascades every foreign key into a stock location, read from the database', async () => {
    const registry = harness.app.get(LocationReferences, { strict: false });
    expect(registry.modules()).toEqual([
      'courier',
      'marketplace',
      'orders',
      'pos',
      'storefront',
      'supply',
    ]);
    const keys = await withSystem(async (tx) =>
      tx.execute<{ child: string; action: string }>(sql`
        select distinct cn.nspname || '.' || c.relname as child, con.confdeltype::text as action
        from pg_constraint con
        join pg_class c on c.oid = con.conrelid
        join pg_namespace cn on cn.oid = c.relnamespace
        join pg_class p on p.oid = con.confrelid
        join pg_namespace pn on pn.oid = p.relnamespace
        where con.contype = 'f' and pn.nspname = 'org' and p.relname = 'locations'
        order by 1
      `),
    );
    // Inventory owns locations and counts its own tables; the rest are its checkers'.
    const counted: Readonly<Record<string, string>> = {
      'courier.return_receipts': 'courier',
      'inventory.adjustments': 'inventory',
      'inventory.count_sessions': 'inventory',
      'inventory.reservations': 'inventory',
      'inventory.stock_in_hand_entries': 'inventory',
      'inventory.stock_movements': 'inventory',
      'inventory.stock_transfers': 'inventory',
      // M35b, joined at integration: an ncom.bd hold keeps the place it held stock at.
      'marketplace.ncom_holds': 'marketplace',
      'pos.registers': 'pos',
      'pos.returns': 'pos',
      'pos.sales': 'pos',
      'sales.orders': 'orders',
      'storefront.web_locations': 'storefront',
      'supply.returns': 'supply',
      'supply.supplies': 'supply',
    };
    const uncovered = keys
      .filter((key) => key.action !== 'c')
      .map((key) => key.child)
      .filter((name) => counted[name] === undefined);
    expect(uncovered, 'a new foreign key into org.locations needs a checker').toEqual([]);
    expect(keys.filter((key) => key.action === 'c').map((key) => key.child)).toEqual([
      'inventory.stock_levels',
    ]);
  });
});

describe('categories (D-623)', () => {
  it('deletes an unused category, with the deleted row in the audit log, for org_admin only', async () => {
    const unused = await category('Unused');
    const usage = await ok<Usage>(admin, 'GET', `/v1/catalog/categories/${unused.id}/usage`);
    expect(usage).toMatchObject({ canDelete: true, uses: [] });

    for (const who of [marketing, warehouse, sales]) {
      expect((await call(who, 'DELETE', `/v1/catalog/categories/${unused.id}`)).status).toBe(403);
    }
    expect((await call(otherAdmin, 'DELETE', `/v1/catalog/categories/${unused.id}`)).status).toBe(
      404,
    );
    expect(
      (await call(otherAdmin, 'GET', `/v1/catalog/categories/${unused.id}/usage`)).status,
    ).toBe(404);

    await ok(admin, 'DELETE', `/v1/catalog/categories/${unused.id}`);
    expect(await exists('categories', unused.id)).toBe(false);
    const audit = await auditRowsFor(ORG_A, unused.id);
    const row = audit.find((entry) => entry.action === 'catalog.category.deleted');
    expect(row?.operation).toBe('delete');
    expect(row?.before).toMatchObject({ id: unused.id, slug: unused.slug, name: 'Unused' });
  });

  it('refuses a plain delete of a category in use, naming what uses it', async () => {
    const used = await category('Used');
    await product('In used category', { categoryId: used.id });
    const refused = await call<{ code: string; detail: string }>(
      admin,
      'DELETE',
      `/v1/catalog/categories/${used.id}`,
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CATALOG_IN_USE');
    expect(refused.body.detail).toContain('1 product');
    expect(await exists('categories', used.id)).toBe(true);
  });

  it('empties a category with products, subcategories and a menu entry into another, and deletes it in one transaction (check 2)', async () => {
    const shirts = await category('Shirts');
    const formal = await category('Formal', shirts.id);
    // A top-level category already uses the slug the subcategory will want at the top.
    const clash = await ok<{ id: string }>(admin, 'POST', '/v1/catalog/categories', {
      name: 'Formal wear',
      slug: formal.slug,
      code: `C${token(6)}`,
    });
    const tops = await category('Tops');
    const first = await product('Oxford shirt', { categoryId: shirts.id });
    const second = await product('Linen shirt', { categoryId: shirts.id });
    for (const item of [first, second]) {
      await ok(admin, 'PUT', `/v1/storefront/products/${item.id}`, { webVisible: true });
    }
    const menu = await ok<{ id: string }>(admin, 'POST', '/v1/storefront/nav-items', {
      kind: 'category',
      categoryId: shirts.id,
      label: null,
      href: null,
      parentId: null,
      highlighted: false,
      isActive: true,
    });

    const usage = await ok<Usage>(admin, 'GET', `/v1/catalog/categories/${shirts.id}/usage`);
    expect(reasons(usage)).toEqual({ products: 2, subcategories: 1, menu_entries: 1 });
    expect(usage).toMatchObject({ canDelete: false, canEmptyAndDelete: true });

    // Not into itself or below it.
    expect(
      (
        await call(admin, 'POST', `/v1/catalog/categories/${shirts.id}/empty-and-delete`, {
          targetCategoryId: formal.id,
        })
      ).status,
    ).toBe(400);

    const done = await ok<{
      movedProducts: number;
      movedSubcategories: number;
      menuEntries: number;
    }>(admin, 'POST', `/v1/catalog/categories/${shirts.id}/empty-and-delete`, {
      targetCategoryId: tops.id,
    });
    expect(done).toMatchObject({ movedProducts: 2, movedSubcategories: 1, menuEntries: 1 });
    expect(await exists('categories', shirts.id)).toBe(false);

    const moved = await withSystem(
      async (tx) =>
        tx.execute<{ id: string; category_id: string }>(sql`
          select id, category_id from catalog.products where id in (${first.id}, ${second.id})
        `),
      { orgId: ORG_A },
    );
    expect(moved.every((row) => row.category_id === tops.id)).toBe(true);
    const child = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ parent_id: string | null; slug: string; path: string }>(sql`
            select parent_id, slug, path from catalog.categories where id = ${formal.id}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(child?.parent_id).toBeNull();
    expect(child?.slug).toBe(`${formal.slug}-2`);
    expect(child?.path).toBe(`/${formal.slug}-2`);
    expect(clash.id).not.toBe(formal.id);
    const entry = await scalar(sql`
      select count(*)::text as n from storefront.nav_items
      where id = ${menu.id} and category_id = ${tops.id}
    `);
    expect(entry).toBe(1);

    const audit = await auditRowsFor(ORG_A, shirts.id);
    expect(
      audit.find((row) => row.action === 'catalog.category.emptied_and_deleted')?.before,
    ).toMatchObject({
      slug: shirts.slug,
    });
    // Each moved product's own history shows the move (D-622).
    for (const item of [first, second]) {
      const moved = (await auditRowsFor(ORG_A, item.id)).find(
        (row) => row.action === 'catalog.product.category_moved',
      );
      expect(moved).toMatchObject({
        before: { categoryId: shirts.id },
        after: { categoryId: tops.id },
      });
    }

    // The website shows the products under the new category.
    const shop = await signedGet(
      harness.server,
      siteKey,
      `/storefront/v1/catalog/products?category=${tops.id}`,
    );
    expect(shop.statusCode, shop.body).toBe(200);
    const slugs = (JSON.parse(shop.body) as { items: { slug: string }[] }).items.map(
      (item) => item.slug,
    );
    expect(slugs).toEqual(expect.arrayContaining([first.slug, second.slug]));
  });

  it('removes the menu entries when the products go to no category', async () => {
    const bags = await category('Bags');
    await product('Tote', { categoryId: bags.id });
    const menu = await ok<{ id: string }>(admin, 'POST', '/v1/storefront/nav-items', {
      kind: 'category',
      categoryId: bags.id,
      label: null,
      href: null,
      parentId: null,
      highlighted: false,
      isActive: true,
    });
    await ok(admin, 'POST', `/v1/catalog/categories/${bags.id}/empty-and-delete`, {
      targetCategoryId: null,
    });
    expect(
      await scalar(sql`select count(*)::text as n from storefront.nav_items where id = ${menu.id}`),
    ).toBe(0);
    const removed = await auditRowsFor(ORG_A, menu.id);
    expect(
      removed.find((row) => row.action === 'storefront.nav_item.deleted')?.before,
    ).toMatchObject({
      kind: 'category',
    });
  });

  it('refuses while a live discount names the category, and never rewrites the discount (D-541)', async () => {
    const sale = await category('Sale rack');
    await product('Sale item', { categoryId: sale.id });
    const code = await ok<{ id: string }>(admin, 'POST', '/v1/promo/codes', {
      code: `CAT${token(6)}`,
      kind: 'percent',
      valueBps: 1000,
      categoryIds: [sale.id],
    });
    const usage = await ok<Usage>(admin, 'GET', `/v1/catalog/categories/${sale.id}/usage`);
    expect(usage.canEmptyAndDelete).toBe(false);
    expect(usage.uses.find((use) => use.reason === 'discounts')).toMatchObject({
      count: 1,
      movable: false,
    });
    const refused = await call<{ code: string }>(
      admin,
      'POST',
      `/v1/catalog/categories/${sale.id}/empty-and-delete`,
      { targetCategoryId: null },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CATALOG_IN_USE');

    await ok(admin, 'PATCH', `/v1/promo/codes/${code.id}`, { status: 'archived' });
    await ok(admin, 'POST', `/v1/catalog/categories/${sale.id}/empty-and-delete`, {
      targetCategoryId: null,
    });
    const scope = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ ids: string[] }>(sql`
          select category_ids as ids from promo.codes where id = ${code.id}
        `)
        )[0]?.ids,
      { orgId: ORG_A },
    );
    expect(scope).toEqual([sale.id]);
  });

  it('archives a category: new products refuse it, and its products leave the website until restored', async () => {
    const winter = await category('Winter');
    const coat = await product('Wool coat', { categoryId: winter.id });
    await ok(admin, 'PUT', `/v1/storefront/products/${coat.id}`, { webVisible: true });
    const shown = async () => {
      const shop = await signedGet(
        harness.server,
        siteKey,
        `/storefront/v1/catalog/products?search=${encodeURIComponent('Wool coat')}`,
      );
      expect(shop.statusCode, shop.body).toBe(200);
      return (JSON.parse(shop.body) as { items: { slug: string }[] }).items.some(
        (item) => item.slug === coat.slug,
      );
    };
    expect(await shown()).toBe(true);

    expect(
      (await call(marketing, 'POST', `/v1/catalog/categories/${winter.id}/archive`)).status,
    ).toBe(403);
    await ok(admin, 'POST', `/v1/catalog/categories/${winter.id}/archive`);
    expect(await shown()).toBe(false);
    const refused = await call<{ code: string }>(admin, 'POST', '/v1/catalog/products', {
      name: 'New coat',
      slug: `new-coat-${token(4).toLowerCase()}`,
      pricePoisha: '100000',
      categoryId: winter.id,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('CATALOG_CATEGORY_INVALID');
    // A category under the archived one is refused too: the website would not show it.
    const below = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into catalog.categories (org_id, parent_id, name, slug, code)
            values (${ORG_A}, ${winter.id}, 'Parkas', ${`parkas-${token(6).toLowerCase()}`},
                    ${`P${token(5)}`})
            returning id
          `)
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );
    const underneath = await call<{ code: string }>(admin, 'POST', '/v1/catalog/products', {
      name: 'New parka',
      slug: `new-parka-${token(4).toLowerCase()}`,
      pricePoisha: '100000',
      categoryId: below,
    });
    expect(underneath.status).toBe(400);
    expect(underneath.body.code).toBe('CATALOG_CATEGORY_INVALID');
    expect(underneath.raw).toContain('Winter');
    // Nor may a category's products be emptied into it: they would leave the website unasked.
    const leaving = await category('Leaving');
    await product('Leaving product', { categoryId: leaving.id });
    const intoArchived = await call<{ code: string }>(
      admin,
      'POST',
      `/v1/catalog/categories/${leaving.id}/empty-and-delete`,
      { targetCategoryId: below },
    );
    expect(intoArchived.status).toBe(400);
    expect(intoArchived.body.code).toBe('CATALOG_CATEGORY_INVALID');
    expect(intoArchived.raw).toContain('Winter');
    expect(await exists('categories', leaving.id)).toBe(true);

    await ok(admin, 'POST', `/v1/catalog/categories/${winter.id}/restore`);
    expect(await shown()).toBe(true);
  });
});

describe('lists and values (D-624)', () => {
  it('deletes an unused value and an unused list, and refuses a used one', async () => {
    const sizes = await list('Sizes', ['S', 'M', 'L']);
    const [small, medium] = sizes.values;
    await product('Plain tee', {
      axes: [{ attributeId: sizes.id, valueIds: [small] }],
    });

    const smallUsage = await ok<Usage>(
      admin,
      'GET',
      `/v1/catalog/attributes/${sizes.id}/values/${small}/usage`,
    );
    expect(reasons(smallUsage)).toEqual({ variants: 1 });
    expect(smallUsage.activeVariants).toBe(1);
    expect(
      (await call(admin, 'DELETE', `/v1/catalog/attributes/${sizes.id}/values/${small}`)).status,
    ).toBe(409);
    await ok(admin, 'DELETE', `/v1/catalog/attributes/${sizes.id}/values/${medium}`);
    expect((await call(admin, 'DELETE', `/v1/catalog/attributes/${sizes.id}`)).status).toBe(409);

    const spare = await list('Spare list', ['A', 'B']);
    await ok(admin, 'DELETE', `/v1/catalog/attributes/${spare.id}`);
    const audit = await auditRowsFor(ORG_A, spare.id);
    expect(audit.find((row) => row.action === 'catalog.attribute.deleted')?.before).toMatchObject({
      name: 'Spare list',
      values: [expect.objectContaining({ label: 'A' }), expect.objectContaining({ label: 'B' })],
    });
  });

  it('archives a size with its variants in one call; a new variant refuses it until it is restored', async () => {
    const sizes = await list('Shirt sizes', ['S', 'XXL']);
    const [small, huge] = sizes.values;
    const shirt = await product('Archive shirt', {
      axes: [{ attributeId: sizes.id, valueIds: [small, huge] }],
    });
    const archived = await ok<{ archivedVariants: number }>(
      admin,
      'POST',
      `/v1/catalog/attributes/${sizes.id}/values/${huge}/archive`,
      { archiveVariants: true },
    );
    expect(archived.archivedVariants).toBe(1);
    const listed = await ok<{
      items: { id: string; isActive: boolean; values: { id: string; isActive: boolean }[] }[];
    }>(admin, 'GET', '/v1/catalog/attributes');
    const value = listed.items
      .find((item) => item.id === sizes.id)
      ?.values.find((entry) => entry.id === huge);
    expect(value?.isActive).toBe(false);
    const statuses = await withSystem(
      async (tx) =>
        tx.execute<{ status: string }>(sql`
          select s.status::text as status from catalog.skus s
          join catalog.sku_values v on v.org_id = s.org_id and v.sku_id = s.id
          where s.product_id = ${shirt.id} and v.value_id = ${huge}
        `),
      { orgId: ORG_A },
    );
    expect(statuses.map((row) => row.status)).toEqual(['archived']);

    const refused = await call<{ code: string }>(admin, 'POST', '/v1/catalog/products', {
      name: 'Needs XXL',
      slug: `needs-xxl-${token(4).toLowerCase()}`,
      pricePoisha: '100000',
      axes: [{ attributeId: sizes.id, valueIds: [huge] }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('CATALOG_VARIANT_INVALID');

    await ok(admin, 'POST', `/v1/catalog/attributes/${sizes.id}/values/${huge}/restore`);
    await ok(admin, 'POST', '/v1/catalog/products', {
      name: 'Has XXL',
      slug: `has-xxl-${token(4).toLowerCase()}`,
      pricePoisha: '100000',
      axes: [{ attributeId: sizes.id, valueIds: [huge] }],
    });

    // An archived list refuses a new variant on any of its values, live ones included.
    await ok(admin, 'POST', `/v1/catalog/attributes/${sizes.id}/archive`);
    const listArchived = await call<{ code: string }>(admin, 'POST', '/v1/catalog/products', {
      name: 'Needs S',
      slug: `needs-s-${token(4).toLowerCase()}`,
      pricePoisha: '100000',
      axes: [{ attributeId: sizes.id, valueIds: [small] }],
    });
    expect(listArchived.status).toBe(400);
    expect(listArchived.body.code).toBe('CATALOG_VARIANT_INVALID');
    await ok(admin, 'POST', `/v1/catalog/attributes/${sizes.id}/restore`);
  });

  it('never lets another brand ask about, delete or archive a list or a value', async () => {
    const sizes = await list('Private sizes', ['S']);
    const [small] = sizes.values;
    const calls: readonly (readonly ['GET' | 'DELETE' | 'POST', string])[] = [
      ['GET', `/v1/catalog/attributes/${sizes.id}/usage`],
      ['DELETE', `/v1/catalog/attributes/${sizes.id}`],
      ['POST', `/v1/catalog/attributes/${sizes.id}/archive`],
      ['GET', `/v1/catalog/attributes/${sizes.id}/values/${small}/usage`],
      ['DELETE', `/v1/catalog/attributes/${sizes.id}/values/${small}`],
      ['POST', `/v1/catalog/attributes/${sizes.id}/values/${small}/archive`],
    ];
    for (const [method, url] of calls) {
      const answer = await call(otherAdmin, method, url, method === 'POST' ? {} : undefined);
      expect(answer.status, `${method} ${url}`).toBe(404);
    }
    expect(
      await scalar(
        sql`select count(*)::text as n from catalog.attribute_values where id = ${small} and is_active`,
      ),
    ).toBe(1);
  });

  it('reorders a list, every value once', async () => {
    const sizes = await list('Ordered', ['S', 'M', 'L']);
    const [s, m, l] = sizes.values;
    expect(
      (
        await call(admin, 'PUT', `/v1/catalog/attributes/${sizes.id}/values/order`, {
          valueIds: [l, s],
        })
      ).status,
    ).toBe(400);
    await ok(admin, 'PUT', `/v1/catalog/attributes/${sizes.id}/values/order`, {
      valueIds: [l, m, s],
    });
    const listed = await ok<{ items: { id: string; values: { id: string }[] }[] }>(
      admin,
      'GET',
      '/v1/catalog/attributes',
    );
    expect(
      listed.items.find((item) => item.id === sizes.id)?.values.map((value) => value.id),
    ).toEqual([l, m, s]);
  });
});

describe('products and variants (D-625, D-626)', () => {
  it('deletes a product nothing references, with its SKUs, values, price history and empty stock rows', async () => {
    const sizes = await list('Delete sizes', ['S', 'M']);
    const doomed = await product('Mistake product', {
      axes: [{ attributeId: sizes.id, valueIds: sizes.values }],
    });
    // A reorder level set on a SKU that never moved: an empty stock row.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into inventory.stock_levels (org_id, sku_id, location_id, reorder_level)
          values (${ORG_A}, ${skuOf(doomed)}, ${mainWarehouse}, 5)
        `),
      { orgId: ORG_A },
    );
    const usage = await ok<Usage>(admin, 'GET', `/v1/catalog/products/${doomed.id}/usage`);
    expect(usage).toMatchObject({ canDelete: true, uses: [] });

    const deleted = await ok<{ deletedVariants: number }>(
      admin,
      'DELETE',
      `/v1/catalog/products/${doomed.id}`,
    );
    expect(deleted.deletedVariants).toBe(2);
    expect(await exists('products', doomed.id)).toBe(false);
    for (const sku of doomed.skus) {
      expect(
        await scalar(
          sql`select count(*)::text as n from catalog.sku_price_history where sku_id = ${sku.id}`,
        ),
      ).toBe(0);
      expect(
        await scalar(
          sql`select count(*)::text as n from inventory.stock_levels where sku_id = ${sku.id}`,
        ),
      ).toBe(0);
    }
    const audit = await auditRowsFor(ORG_A, doomed.id);
    const before = audit.find((row) => row.action === 'catalog.product.deleted')?.before as
      { name: string; skus: { code: string }[] } | undefined;
    expect(before?.name).toBe('Mistake product');
    expect(before?.skus.map((sku) => sku.code).sort()).toEqual(
      doomed.skus.map((sku) => sku.skuCode).sort(),
    );
  });

  it('keeps a product whose SKU moved stock, and names it (check 1)', async () => {
    const stocked = await product('Stocked product');
    await receive(skuOf(stocked));
    const usage = await ok<Usage>(admin, 'GET', `/v1/catalog/products/${stocked.id}/usage`);
    expect(reasons(usage)).toMatchObject({ stock_movements: 1, stock_on_hand: 1 });
    for (const url of [
      `/v1/catalog/products/${stocked.id}`,
      `/v1/catalog/skus/${skuOf(stocked)}`,
    ]) {
      const refused = await call<{ code: string }>(admin, 'DELETE', url);
      expect(refused.status, url).toBe(409);
      expect(refused.body.code).toBe('CATALOG_IN_USE');
    }
    expect(await exists('skus', skuOf(stocked))).toBe(true);
  });

  it('keeps a SKU on an order line, a supply line, a flash sale, a live discount or a lead', async () => {
    const customer = await seedCustomer(ORG_A, {
      phoneE164: '+8801711000123',
      name: 'Delete test buyer',
    });
    const onOrder = await product('On an order');
    await seedOrder(ORG_A, {
      customerId: customer,
      status: 'pending',
      lines: [
        {
          skuId: skuOf(onOrder),
          skuCode: onOrder.skus[0]?.skuCode ?? '',
          productName: 'On an order',
          qty: 1,
          unitPricePoisha: 150_000n,
        },
      ],
    });

    const onSupply = await product('On a supply draft');
    const supplier = await ok<{ id: string }>(admin, 'POST', '/v1/supply/suppliers', {
      code: `SUP${token(5)}`,
      name: 'Draft supplier',
    });
    await ok(admin, 'POST', '/v1/supply/drafts', {
      draftId: randomUUID(),
      supplierId: supplier.id,
      locationId: mainWarehouse,
      lines: [{ skuId: skuOf(onSupply), qty: 2 }],
    });

    const onFlash = await product('On a flash sale');
    await ok(admin, 'POST', '/v1/promo/flash-sales', {
      title: 'Delete test sale',
      slug: `delete-test-${token(6).toLowerCase()}`,
      items: [{ skuId: skuOf(onFlash), salePricePoisha: '100000', unitLimit: 5 }],
    });

    const onDiscount = await product('On a discount');
    const discount = await ok<{ id: string }>(admin, 'POST', '/v1/promo/codes', {
      code: `SKU${token(6)}`,
      kind: 'percent',
      valueBps: 500,
      skuIds: [skuOf(onDiscount)],
    });

    const onLead = await product('On a lead');
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into marketing.leads (org_id, phone_e164, channel, sku_id, created_by)
          values (${ORG_A}, '+8801700000555', 'facebook', ${skuOf(onLead)}, 'usr_deletes_e2e')
        `),
      { orgId: ORG_A },
    );

    const expected: [Product, string][] = [
      [onOrder, 'order_lines'],
      [onSupply, 'supply_lines'],
      [onFlash, 'flash_sale_items'],
      [onDiscount, 'discounts'],
      [onLead, 'leads'],
    ];
    for (const [item, reason] of expected) {
      const usage = await ok<Usage>(admin, 'GET', `/v1/catalog/skus/${skuOf(item)}/usage`);
      expect(reasons(usage), reason).toMatchObject({ [reason]: 1 });
      const refused = await call(admin, 'DELETE', `/v1/catalog/skus/${skuOf(item)}`);
      expect(refused.status, reason).toBe(409);
      expect(await exists('skus', skuOf(item)), reason).toBe(true);
    }

    // An archived discount's scope is history; it keeps nothing (and is never rewritten).
    await ok(admin, 'PATCH', `/v1/promo/codes/${discount.id}`, { status: 'archived' });
    await ok(admin, 'DELETE', `/v1/catalog/products/${onDiscount.id}`);
  });

  it('keeps a SKU a courier return names, and a product a live campaign or a product-wide discount names', async () => {
    // A received courier return (0048's foreign key, counted by the couriers' checker).
    const courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
    const walletId = await makeBankWallet(ORG_A, '1116');
    const shipped = await seedShippedOrder(ORG_A, { orgCode: 'DEL' });
    await withSystem(
      async (tx) => {
        // The fixture numbers its product past the catalog's counter; move the counter on so
        // the products made through the API after it take fresh numbers.
        await tx.execute(sql`
          update catalog.sku_settings
          set last_sequence = greatest(last_sequence, (
            select max(sequence) from catalog.products where org_id = ${ORG_A}
          ))
          where org_id = ${ORG_A}
        `);
        const account = await tx.execute<{ id: string }>(sql`
          insert into courier.courier_accounts
            (org_id, courier_id, provider_code, label, supports_webhook, settlement_wallet_id,
             verified, is_active)
          values (${ORG_A}, ${courierId}, 'fake', 'Delete test courier', true, ${walletId},
                  true, true)
          on conflict (org_id, courier_id) do update set label = excluded.label
          returning id
        `);
        const consignment = await tx.execute<{ id: string }>(sql`
          insert into courier.consignments
            (org_id, order_id, courier_account_id, courier_id, branch_id, consignment_no,
             reference, booking_state, status, cod_amount_poisha, collected_poisha, booked_at,
             delivered_at, created_by)
          values (${ORG_A}, ${shipped.orderId}, ${account[0]?.id ?? ''}, ${courierId},
                  ${shipped.branchId}, ${`DEL-${token(8)}`}, ${shipped.orderNo}, 'booked',
                  'delivered', ${shipped.codAmountPoisha.toString()},
                  ${shipped.codAmountPoisha.toString()}, now(), now(), 'usr_deletes_e2e')
          returning id
        `);
        const receipt = await tx.execute<{ id: string }>(sql`
          insert into courier.return_receipts
            (org_id, consignment_id, order_id, branch_id, location_id, received_at,
             business_date, received_by, reason)
          values (${ORG_A}, ${consignment[0]?.id ?? ''}, ${shipped.orderId}, ${shipped.branchId},
                  ${shipped.locationId}, now(), (now() at time zone 'Asia/Dhaka')::date,
                  'usr_deletes_e2e', 'refused')
          returning id
        `);
        await tx.execute(sql`
          insert into courier.return_receipt_lines (org_id, receipt_id, sku_id, sellable_qty)
          values (${ORG_A}, ${receipt[0]?.id ?? ''}, ${shipped.skuId}, 1)
        `);
      },
      { orgId: ORG_A },
    );
    const returned = await ok<Usage>(admin, 'GET', `/v1/catalog/skus/${shipped.skuId}/usage`);
    expect(reasons(returned)).toMatchObject({ courier_returns: 1, order_lines: 1 });
    expect((await call(admin, 'DELETE', `/v1/catalog/skus/${shipped.skuId}`)).status).toBe(409);

    // A live ad campaign promoting the product.
    const promoted = await product('Promoted product');
    const campaign = await ok<{ id: string }>(marketing, 'POST', '/v1/marketing/campaigns', {
      name: 'Promotes a product',
      platform: 'other',
      productIds: [promoted.id],
    });
    expect(
      reasons(await ok<Usage>(admin, 'GET', `/v1/catalog/products/${promoted.id}/usage`)),
    ).toMatchObject({ campaigns: 1 });
    const keptByCampaign = await call<{ code: string }>(
      admin,
      'DELETE',
      `/v1/catalog/products/${promoted.id}`,
    );
    expect(keptByCampaign.status).toBe(409);
    expect(keptByCampaign.body.code).toBe('CATALOG_IN_USE');

    // A live discount on the whole product.
    const discounted = await product('Discounted product');
    await ok(admin, 'POST', '/v1/promo/codes', {
      code: `PRD${token(6)}`,
      kind: 'percent',
      valueBps: 500,
      productIds: [discounted.id],
    });
    expect(
      reasons(await ok<Usage>(admin, 'GET', `/v1/catalog/products/${discounted.id}/usage`)),
    ).toMatchObject({ discounts: 1 });
    expect((await call(admin, 'DELETE', `/v1/catalog/products/${discounted.id}`)).status).toBe(409);
    for (const id of [promoted.id, discounted.id]) expect(await exists('products', id)).toBe(true);
    expect(campaign.id).not.toBe('');
  });

  it("forgets the old website's ids of a deleted product and its variants", async () => {
    const old = await product('Old site product');
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into storefront.legacy_ids (org_id, kind, legacy_id, erp_id)
          values (${ORG_A}, 'product', ${`p${token(12)}`}, ${old.id}),
                 (${ORG_A}, 'variant', ${`v${token(12)}`}, ${skuOf(old)})
        `),
      { orgId: ORG_A },
    );
    await ok(admin, 'DELETE', `/v1/catalog/products/${old.id}`);
    expect(
      await scalar(
        sql`select count(*)::text as n from storefront.legacy_ids where erp_id in (${old.id}, ${skuOf(old)})`,
      ),
    ).toBe(0);
  });

  it('keeps a SKU a till sold, and refuses an offline sale of a deleted SKU as a bad payload (D-625)', async () => {
    const branch = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(
            sql`select id from org.branches where org_id = ${ORG_A} and code = 'HQ'`,
          )
        )[0]?.id ?? '',
      { orgId: ORG_A },
    );
    const showroom = await makeLocation(ORG_A, {
      code: 'DEL-SHR',
      name: 'Delete test showroom',
      kind: 'showroom',
      branchId: branch,
    });
    const handCash = await seedWallet(ORG_A, '1010-HQ', { provider: 'Till' });
    const bank = await seedWallet(ORG_A, '1100', { provider: 'Bank' });
    const manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branch] });
    const register = await ok<{ id: string }>(manager, 'POST', '/v1/pos/registers', {
      branchId: branch,
      locationId: showroom,
      code: 'DEL1',
      name: 'Delete till',
      cashWalletId: handCash.id,
      cardWalletId: bank.id,
    });
    const shiftId = randomUUID();
    await ok(manager, 'POST', '/v1/pos/shifts', {
      shiftId,
      registerId: register.id,
      openingFloatPoisha: '100000',
    });
    let receipt = 0;
    const sale = (skuId: string) => {
      receipt += 1;
      return {
        kind: 'sale',
        id: randomUUID(),
        registerId: register.id,
        shiftId,
        receiptNo: `DEL1-1-${String(receipt).padStart(4, '0')}`,
        occurredAt: new Date().toISOString(),
        lines: [{ lineNo: 1, skuId, qty: 1, unitPricePoisha: '150000', discountPoisha: '0' }],
        tenders: [{ tender: 'cash', amountPoisha: '150000' }],
        totals: { grossPoisha: '150000', discountPoisha: '0', netPoisha: '150000' },
      };
    };

    // No stock anywhere, so the sale is held for review: recorded, with its line.
    const sold = await product('Sold at the till');
    const held = await ok<{ results: { outcome: string }[] }>(manager, 'POST', '/v1/pos/sync', {
      documents: [sale(skuOf(sold))],
    });
    expect(held.results[0]?.outcome).toBe('held');
    const usage = await ok<Usage>(admin, 'GET', `/v1/catalog/skus/${skuOf(sold)}/usage`);
    expect(reasons(usage)).toMatchObject({ pos_lines: 1 });
    expect((await call(admin, 'DELETE', `/v1/catalog/skus/${skuOf(sold)}`)).status).toBe(409);

    // A SKU deleted while a till still had it on its price list: the offline sale names
    // nothing, and is refused whole rather than failing the sync.
    const gone = await product('Deleted before sync');
    await ok(admin, 'DELETE', `/v1/catalog/products/${gone.id}`);
    const rejected = await ok<{ results: { outcome: string; error: { code: string } | null }[] }>(
      manager,
      'POST',
      '/v1/pos/sync',
      { documents: [sale(skuOf(gone))] },
    );
    expect(rejected.results[0]?.outcome).toBe('rejected');
    expect(rejected.results[0]?.error?.code).toBe('POS_SALE_INVALID');
  });

  it('deletes one variant nothing uses and keeps the product', async () => {
    const sizes = await list('Variant sizes', ['S', 'M']);
    const two = await product('Two variants', {
      axes: [{ attributeId: sizes.id, valueIds: sizes.values }],
    });
    const [first, second] = two.skus;
    await receive(first?.id ?? '');
    expect((await call(admin, 'DELETE', `/v1/catalog/skus/${first?.id ?? ''}`)).status).toBe(409);
    await ok(admin, 'DELETE', `/v1/catalog/skus/${second?.id ?? ''}`);
    expect(await exists('skus', second?.id ?? '')).toBe(false);
    expect(await exists('products', two.id)).toBe(true);
    const audit = await auditRowsFor(ORG_A, second?.id ?? '');
    expect(audit.find((row) => row.action === 'catalog.sku.deleted')?.before).toMatchObject({
      code: second?.skuCode,
    });
  });

  it('gives every new product its parent SKU as its address, so names may repeat (D-653, D-661)', async () => {
    const old = await product('Black Panjabi');
    expect(old.slug).toBe(old.parentSku?.toLowerCase());
    await ok(admin, 'PATCH', `/v1/catalog/products/${old.id}`, { status: 'archived' });
    // The address the request names is not used: a new product's is its own parent SKU.
    const again = await ok<Product>(admin, 'POST', '/v1/catalog/products', {
      name: 'Black Panjabi',
      slug: old.slug,
      pricePoisha: '150000',
    });
    expect(again.slug).toBe(again.parentSku?.toLowerCase());
    expect(again.slug).not.toBe(old.slug);
    // The same name beside a live one is normal (one cut, many designs): its own number.
    const sameName = await ok<Product>(admin, 'POST', '/v1/catalog/products', {
      name: 'Black Panjabi',
      pricePoisha: '150000',
    });
    expect(sameName.slug).toBe(sameName.parentSku?.toLowerCase());
    expect(sameName.slug).not.toBe(again.slug);

    // An address another product was given by hand that equals the next parent SKU still gives
    // way: the new product takes its own number after it (`freeProductSlug`, the guard).
    const squatter = await product('Squatter');
    const parts = (squatter.parentSku ?? '').split('-');
    const taken = String(Number(parts.at(-1)) + 1).padStart(4, '0');
    const squatted = [...parts.slice(0, -1), taken].join('-').toLowerCase();
    await ok(admin, 'PATCH', `/v1/catalog/products/${squatter.id}`, { slug: squatted });
    const guarded = await product('Black Panjabi');
    expect(guarded.parentSku?.toLowerCase()).toBe(squatted);
    expect(guarded.slug).toBe(`${squatted}-${taken}`);
  });

  it('keeps the code prefix a product already has when it gains a variant after moving category (D-623)', async () => {
    const shirts = await category('Prefix shirts');
    const tops = await category('Prefix tops');
    const sizes = await list('Prefix sizes', ['S', 'M']);
    const [small, medium] = sizes.values;
    const item = await product('Prefix shirt', {
      categoryId: shirts.id,
      axes: [{ attributeId: sizes.id, valueIds: [small] }],
    });
    const prefix = (item.skus[0]?.skuCode ?? '').split('-').slice(0, 3).join('-');
    await ok(admin, 'PATCH', `/v1/catalog/products/${item.id}`, { categoryId: tops.id });
    const extended = await ok<{ created: string[] }>(
      admin,
      'POST',
      `/v1/catalog/products/${item.id}/variants`,
      {
        axes: [{ attributeId: sizes.id, valueIds: [small, medium] }],
      },
    );
    expect(extended.created).toHaveLength(1);
    expect(extended.created[0]?.startsWith(`${prefix}-`)).toBe(true);
  });

  it('answers a foreign-key refusal the counts missed with CATALOG_IN_USE, never a 500 (backstop)', async () => {
    const stocked = await product('Backstop product');
    await receive(skuOf(stocked));
    // Straight at the table, past every checker: PostgreSQL's own refusal, mapped.
    const error: unknown = await withOrg({ orgId: ORG_A, userId: 'usr_deletes_e2e' }, (tx) =>
      tx.execute(sql`delete from catalog.skus where id = ${skuOf(stocked)}`),
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isStillReferenced(error)).toBe(true);
    const mapped = toCatalogHttpError(error) as {
      getStatus(): number;
      getResponse(): { code: string };
    };
    expect(mapped.getStatus()).toBe(409);
    expect(mapped.getResponse().code).toBe('CATALOG_IN_USE');
  });
});

describe('a delete and a new reference at the same moment (lock ordering)', () => {
  it('waits for a reference committing first, then refuses; nothing ever points at a deleted SKU', async () => {
    const customer = await seedCustomer(ORG_A, { phoneE164: '+8801711000124', name: 'Race buyer' });
    const raced = await product('Raced product');
    const sku = skuOf(raced);

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted: () => void = () => undefined;
    const insertedOnce = new Promise<void>((resolve) => {
      inserted = resolve;
    });

    // A transaction that has written an order line for the SKU (its foreign key holds the
    // SKU row `for key share`) and has not committed yet.
    const holder = withOrg({ orgId: ORG_A, userId: 'usr_race' }, async (tx) => {
      const order = await tx.execute<{ id: string }>(sql`
        insert into sales.orders (org_id, order_no, channel, customer_id, ship_name, ship_phone_e164,
          ship_district_id, ship_thana_id, ship_address_line, items_poisha, discount_poisha,
          delivery_charge_poisha, advance_paid_poisha, cod_amount_poisha, status, created_by)
        select ${ORG_A}, ${`RACE-2610-${String(Math.floor(Math.random() * 90_000) + 10_000)}`}, 'phone', ${customer}, 'Race', '+8801711000124',
               t.district_id, t.id, 'Road 1', 150000, 0, 6000, 0, 156000, 'pending', 'usr_race'
        from ref.thanas t order by t.id limit 1
        returning id
      `);
      await tx.execute(sql`
        insert into sales.order_lines (org_id, order_id, sku_id, sku_code, product_name, qty,
          unit_price_poisha, discount_poisha, delivered_qty, returned_qty, position)
        values (${ORG_A}, ${order[0]?.id ?? ''}, ${sku}, 'RACE', 'Raced product', 1, 150000, 0, 0, 0, 0)
      `);
      inserted();
      await gate;
    });
    await insertedOnce;

    // The delete locks the SKU `for update`: it waits for the holder.
    const deletion = call<{ code: string }>(admin, 'DELETE', `/v1/catalog/skus/${sku}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await holder;
    const refused = await deletion;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CATALOG_IN_USE');
    expect(await exists('skus', sku)).toBe(true);
  });

  it('never leaves a dangling reference when deletes and references race, many times', async () => {
    const customer = await seedCustomer(ORG_A, {
      phoneE164: '+8801711000125',
      name: 'Race buyer two',
    });
    let deletedCount = 0;
    let referencedCount = 0;
    for (let round = 0; round < 12; round += 1) {
      const item = await product(`Race ${String(round)}`);
      const sku = skuOf(item);
      const [deletion, reference] = await Promise.allSettled([
        call(admin, 'DELETE', `/v1/catalog/skus/${sku}`),
        seedOrder(ORG_A, {
          customerId: customer,
          status: 'pending',
          lines: [
            { skuId: sku, skuCode: 'RACE', productName: 'Race', qty: 1, unitPricePoisha: 150_000n },
          ],
        }),
      ]);
      const skuThere = await exists('skus', sku);
      const lines = await scalar(
        sql`select count(*)::text as n from sales.order_lines where sku_id = ${sku}`,
      );
      if (skuThere) {
        // The order line won: the delete was refused, or it ran first only on paper.
        expect(lines).toBe(reference.status === 'fulfilled' ? 1 : 0);
        if (reference.status === 'fulfilled') {
          expect(deletion.status === 'fulfilled' ? deletion.value.status : 0).toBe(409);
          referencedCount += 1;
        }
      } else {
        // The delete won: the order line was refused by its foreign key.
        expect(lines).toBe(0);
        expect(reference.status).toBe('rejected');
        deletedCount += 1;
      }
    }
    expect(deletedCount + referencedCount).toBe(12);
  });
});

describe('who may delete, archive and ask (permissions, D-621)', () => {
  it('gives usage, archive and restore to update Catalog and delete to delete Catalog, org_admin only', async () => {
    const target = await category('Permission check');
    for (const who of [marketing, warehouse, sales]) {
      expect((await call(who, 'GET', `/v1/catalog/categories/${target.id}/usage`)).status).toBe(
        403,
      );
      expect((await call(who, 'POST', `/v1/catalog/categories/${target.id}/archive`)).status).toBe(
        403,
      );
      expect(
        (
          await call(who, 'POST', `/v1/catalog/categories/${target.id}/empty-and-delete`, {
            targetCategoryId: null,
          })
        ).status,
      ).toBe(403);
    }
    const anItem = await product('Permission product');
    expect((await call(otherAdmin, 'DELETE', `/v1/catalog/products/${anItem.id}`)).status).toBe(
      404,
    );
    expect((await call(otherAdmin, 'GET', `/v1/catalog/skus/${skuOf(anItem)}/usage`)).status).toBe(
      404,
    );
    expect(await exists('products', anItem.id)).toBe(true);
  });
});

describe('what only a cascade may delete (0118, 0119; D-627)', () => {
  const attempt = (query: ReturnType<typeof sql>): Promise<unknown> =>
    withSystem((tx) => tx.execute(query), { orgId: ORG_A }).then(
      () => null,
      (caught: unknown) => caught,
    );

  it('refuses, for erp_owner too, a price history row or a stock level while its SKU is there', async () => {
    const guarded = await product('Guarded product');
    await receive(skuOf(guarded));
    expect(
      isStillReferenced(
        await attempt(sql`delete from catalog.sku_price_history where sku_id = ${skuOf(guarded)}`),
      ),
    ).toBe(true);
    expect(
      isStillReferenced(
        await attempt(sql`delete from inventory.stock_levels where sku_id = ${skuOf(guarded)}`),
      ),
    ).toBe(true);
  });

  it('gives the application role no DELETE on them', async () => {
    const privileges = await withSystem(async (tx) =>
      tx.execute<{ table_name: string; can_delete: boolean }>(sql`
        select t as table_name, has_table_privilege('erp_app', t, 'DELETE') as can_delete
        from unnest(array['catalog.sku_price_history', 'inventory.stock_levels',
                          'promo.discount_tiers', 'promo.flash_sale_items']) as t
      `),
    );
    expect(privileges.filter((row) => row.can_delete).map((row) => row.table_name)).toEqual([]);
  });
});
