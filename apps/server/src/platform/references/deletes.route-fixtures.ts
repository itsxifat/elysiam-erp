import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { CatalogService } from '../../modules/catalog/catalog.service.js';
import type { ActiveContext } from '../http/context.js';

/**
 * How the route-matrix suite calls M39a's delete, archive, restore and usage routes
 * (D-621 to D-634), every module's in one file so the shared suite gains one import.
 *
 * The suite drives every route as every role and, for each mutation, asks that at least one
 * admitted role succeeded and left an audit row. A delete succeeds once per row, so every
 * mutation fixture makes a **fresh** row each time it is called (once per role): the admitted
 * role deletes its own, the refused roles never reach theirs. Rows are written directly or
 * through `CatalogService`, which takes no constructor dependencies, as the catalog's own
 * fixtures do. Every usage read names a row prepared once.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ACTOR = 'usr_route_matrix';

const seeder = {
  userId: ACTOR,
  orgId: ORG_A,
  roles: ['org_admin'],
  branchIds: [],
  branchIdsByRole: { org_admin: [] },
  isSuperAdmin: false,
  requestId: randomUUID(),
} as unknown as ActiveContext;

const catalog = new CatalogService();

function token(length = 6): string {
  return randomUUID().replace(/-/g, '').slice(0, length).toUpperCase();
}

const lower = (length = 8): string => token(length).toLowerCase();

async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<Record<string, unknown>>(query);
      const row = rows[0];
      if (row === undefined) throw new Error('a route-matrix seed returned no row');
      return row as T;
    },
    { orgId: ORG_A },
  );
}

// --- fresh rows ------------------------------------------------------------------------------

async function freshCategory(archived = false): Promise<string> {
  const { id } = await catalog.createCategory(seeder, {
    name: 'Matrix delete',
    slug: `rm-del-${lower()}`,
    code: `D${token(7)}`,
  });
  if (archived)
    await withSystem(
      (tx) => tx.execute(sql`update catalog.categories set is_active = false where id = ${id}`),
      { orgId: ORG_A },
    );
  return id;
}

async function freshAttribute(archived = false): Promise<{ id: string; values: string[] }> {
  const attribute = await catalog.createAttribute(seeder, {
    code: `RMD_${token(8)}`,
    name: 'Matrix list',
    kind: 'custom',
    isVariant: true,
  });
  const first = await catalog.createAttributeValue(seeder, attribute.id, {
    code: 'A',
    label: 'A',
    position: 0,
  });
  const second = await catalog.createAttributeValue(seeder, attribute.id, {
    code: 'B',
    label: 'B',
    position: 1,
  });
  if (archived) {
    await withSystem(
      (tx) =>
        tx.execute(sql`update catalog.attributes set is_active = false where id = ${attribute.id}`),
      { orgId: ORG_A },
    );
  }
  return { id: attribute.id, values: [first.id, second.id] };
}

async function freshValue(archived = false): Promise<{ attributeId: string; valueId: string }> {
  const attribute = await freshAttribute();
  const valueId = attribute.values[0] ?? '';
  if (archived) {
    await withSystem(
      (tx) =>
        tx.execute(
          sql`update catalog.attribute_values set is_active = false where id = ${valueId}`,
        ),
      { orgId: ORG_A },
    );
  }
  return { attributeId: attribute.id, valueId };
}

async function freshProduct(): Promise<{ id: string; skuId: string }> {
  const product = await catalog.createProduct(seeder, {
    name: `Matrix delete ${token()}`,
    slug: `rm-delete-${lower()}`,
    pricePoisha: '150000',
    status: 'draft',
    axes: [],
    generateSkus: true,
  });
  return { id: product.id, skuId: product.skus[0]?.id ?? '' };
}

async function freshLocation(active = true): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into org.locations (org_id, code, name, kind, is_active)
    values (${ORG_A}, ${`RMD-${token(8)}`}, 'Matrix delete', 'warehouse', ${active})
    returning id
  `);
  return row.id;
}

async function freshSupplier(): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into supply.suppliers (org_id, code, name)
    values (${ORG_A}, ${`RMD-${token(8)}`}, 'Matrix delete supplier')
    returning id
  `);
  return row.id;
}

async function freshCode(status = 'active'): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into promo.codes (org_id, code, kind, value_bps, status, created_by)
    values (${ORG_A}, ${`RMD${token(8)}`}, 'percent', 1000, ${status}, ${ACTOR})
    returning id
  `);
  return row.id;
}

async function freshSale(archived = false): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into promo.flash_sales (org_id, title, slug, created_by, archived_at)
    values (${ORG_A}, 'Matrix delete sale', ${`rm-delete-${lower(10)}`}, ${ACTOR},
            ${archived ? sql`now()` : sql`null`})
    returning id
  `);
  return row.id;
}

async function freshTemplate(): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into notify.templates (org_id, key, category, body_bn, body_en, updated_by)
    values (${ORG_A}, ${`matrix.delete_${lower(10)}`}, 'marketing', 'হ্যালো', 'Hello', ${ACTOR})
    returning id
  `);
  return row.id;
}

async function freshCampaign(): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into marketing.campaigns (org_id, name, platform, created_by)
    values (${ORG_A}, 'Matrix delete campaign', 'other', ${ACTOR})
    returning id
  `);
  return row.id;
}

async function freshChart(): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into storefront.size_charts (org_id, name, columns, rows)
    values (${ORG_A}, ${`Matrix delete ${lower()}`}, array['Size','Chest'], '[["M","40"]]'::jsonb)
    returning id
  `);
  return row.id;
}

async function freshNavItem(): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into storefront.nav_items (org_id, kind, label, position)
    values (${ORG_A}, 'dropdown', 'Matrix dropdown', 950)
    returning id
  `);
  return row.id;
}

async function freshBranch(): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into org.branches (org_id, code, name, kind)
    values (${ORG_A}, ${`RMD${token(5)}`}, 'Matrix branch', 'showroom')
    returning id
  `);
  return row.id;
}

async function freshHead(): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance)
    values (${ORG_A}, ${`RMD-${token(8)}`}, 'Matrix head', 'expense', 'operating_expense', 'debit')
    returning id
  `);
  return row.id;
}

// --- prepared once ---------------------------------------------------------------------------

interface Prepared {
  readonly categoryId: string;
  readonly attributeId: string;
  readonly valueId: string;
  readonly productId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly supplierId: string;
  readonly codeId: string;
  readonly saleId: string;
  readonly templateId: string;
  readonly campaignId: string;
  readonly branchId: string;
}

let prepared: Prepared | undefined;

/** Called once from the route-matrix suite's `beforeAll`, after the other modules' prepares. */
export async function prepareDeleteFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  const attribute = await freshAttribute();
  const product = await freshProduct();
  prepared = {
    categoryId: await freshCategory(),
    attributeId: attribute.id,
    valueId: attribute.values[0] ?? '',
    productId: product.id,
    skuId: product.skuId,
    locationId: await freshLocation(),
    supplierId: await freshSupplier(),
    codeId: await freshCode(),
    saleId: await freshSale(),
    templateId: await freshTemplate(),
    campaignId: await freshCampaign(),
    branchId: await freshBranch(),
  };
}

function state(): Prepared {
  if (prepared === undefined) {
    throw new Error('call prepareDeleteFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

export const DELETE_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  // The catalog (D-623 to D-626).
  'GET /v1/catalog/categories/:id/usage': () => ({
    url: `/v1/catalog/categories/${state().categoryId}/usage`,
  }),
  'DELETE /v1/catalog/categories/:id': async () => ({
    url: `/v1/catalog/categories/${await freshCategory()}`,
  }),
  'POST /v1/catalog/categories/:id/empty-and-delete': async () => ({
    url: `/v1/catalog/categories/${await freshCategory()}/empty-and-delete`,
    body: { targetCategoryId: null },
  }),
  'POST /v1/catalog/categories/:id/archive': async () => ({
    url: `/v1/catalog/categories/${await freshCategory()}/archive`,
  }),
  'POST /v1/catalog/categories/:id/restore': async () => ({
    url: `/v1/catalog/categories/${await freshCategory(true)}/restore`,
  }),
  'GET /v1/catalog/attributes/:id/usage': () => ({
    url: `/v1/catalog/attributes/${state().attributeId}/usage`,
  }),
  'DELETE /v1/catalog/attributes/:id': async () => ({
    url: `/v1/catalog/attributes/${(await freshAttribute()).id}`,
  }),
  'POST /v1/catalog/attributes/:id/archive': async () => ({
    url: `/v1/catalog/attributes/${(await freshAttribute()).id}/archive`,
  }),
  'POST /v1/catalog/attributes/:id/restore': async () => ({
    url: `/v1/catalog/attributes/${(await freshAttribute(true)).id}/restore`,
  }),
  'PUT /v1/catalog/attributes/:id/values/order': async () => {
    const attribute = await freshAttribute();
    return {
      url: `/v1/catalog/attributes/${attribute.id}/values/order`,
      body: { valueIds: [...attribute.values].reverse() },
    };
  },
  'GET /v1/catalog/attributes/:id/values/:valueId/usage': () => ({
    url: `/v1/catalog/attributes/${state().attributeId}/values/${state().valueId}/usage`,
  }),
  'DELETE /v1/catalog/attributes/:id/values/:valueId': async () => {
    const value = await freshValue();
    return { url: `/v1/catalog/attributes/${value.attributeId}/values/${value.valueId}` };
  },
  'POST /v1/catalog/attributes/:id/values/:valueId/archive': async () => {
    const value = await freshValue();
    return {
      url: `/v1/catalog/attributes/${value.attributeId}/values/${value.valueId}/archive`,
      body: { archiveVariants: true },
    };
  },
  'POST /v1/catalog/attributes/:id/values/:valueId/restore': async () => {
    const value = await freshValue(true);
    return { url: `/v1/catalog/attributes/${value.attributeId}/values/${value.valueId}/restore` };
  },
  'GET /v1/catalog/products/:id/usage': () => ({
    url: `/v1/catalog/products/${state().productId}/usage`,
  }),
  'DELETE /v1/catalog/products/:id': async () => ({
    url: `/v1/catalog/products/${(await freshProduct()).id}`,
  }),
  'GET /v1/catalog/skus/:id/usage': () => ({ url: `/v1/catalog/skus/${state().skuId}/usage` }),
  'DELETE /v1/catalog/skus/:id': async () => ({
    url: `/v1/catalog/skus/${(await freshProduct()).skuId}`,
  }),

  // Stock locations (D-629).
  'GET /v1/inventory/locations/:id/usage': () => ({
    url: `/v1/inventory/locations/${state().locationId}/usage`,
  }),
  'DELETE /v1/inventory/locations/:id': async () => ({
    url: `/v1/inventory/locations/${await freshLocation()}`,
  }),
  'POST /v1/inventory/locations/:id/archive': async () => ({
    url: `/v1/inventory/locations/${await freshLocation()}/archive`,
  }),
  'POST /v1/inventory/locations/:id/restore': async () => ({
    url: `/v1/inventory/locations/${await freshLocation(false)}/restore`,
  }),

  // Suppliers (D-630).
  'GET /v1/supply/suppliers/:id/usage': () => ({
    url: `/v1/supply/suppliers/${state().supplierId}/usage`,
  }),
  'DELETE /v1/supply/suppliers/:id': async () => ({
    url: `/v1/supply/suppliers/${await freshSupplier()}`,
  }),

  // Discounts and flash sales (D-631).
  'GET /v1/promo/codes/:id/usage': () => ({ url: `/v1/promo/codes/${state().codeId}/usage` }),
  'DELETE /v1/promo/codes/:id': async () => ({ url: `/v1/promo/codes/${await freshCode()}` }),
  'POST /v1/promo/codes/:id/restore': async () => ({
    url: `/v1/promo/codes/${await freshCode('archived')}/restore`,
  }),
  'GET /v1/promo/flash-sales/:id/usage': () => ({
    url: `/v1/promo/flash-sales/${state().saleId}/usage`,
  }),
  'DELETE /v1/promo/flash-sales/:id': async () => ({
    url: `/v1/promo/flash-sales/${await freshSale()}`,
  }),
  'POST /v1/promo/flash-sales/:id/archive': async () => ({
    url: `/v1/promo/flash-sales/${await freshSale()}/archive`,
  }),
  'POST /v1/promo/flash-sales/:id/restore': async () => ({
    url: `/v1/promo/flash-sales/${await freshSale(true)}/restore`,
  }),

  // SMS templates and ad campaigns (D-632).
  'GET /v1/notify/templates/:id/usage': () => ({
    url: `/v1/notify/templates/${state().templateId}/usage`,
  }),
  'DELETE /v1/notify/templates/:id': async () => ({
    url: `/v1/notify/templates/${await freshTemplate()}`,
  }),
  'GET /v1/marketing/campaigns/:id/usage': () => ({
    url: `/v1/marketing/campaigns/${state().campaignId}/usage`,
  }),
  'DELETE /v1/marketing/campaigns/:id': async () => ({
    url: `/v1/marketing/campaigns/${await freshCampaign()}`,
  }),

  // The website (D-628).
  'GET /v1/storefront/size-charts/:id/usage': async () => ({
    url: `/v1/storefront/size-charts/${await freshChart()}/usage`,
  }),
  'POST /v1/storefront/size-charts/:id/empty-and-delete': async () => ({
    url: `/v1/storefront/size-charts/${await freshChart()}/empty-and-delete`,
    body: { replacementId: null },
  }),
  'GET /v1/storefront/nav-items/:id/usage': async () => ({
    url: `/v1/storefront/nav-items/${await freshNavItem()}/usage`,
  }),

  // Branches (D-633): a fresh branch renamed, never the brand's own head office.
  'GET /v1/pos/branches/:id/holds': () => ({ url: `/v1/pos/branches/${state().branchId}/holds` }),
  'PATCH /v1/pos/branches/:id': async () => ({
    url: `/v1/pos/branches/${await freshBranch()}`,
    body: { name: 'Matrix branch renamed' },
  }),

  // Expense and income heads (D-634).
  'GET /v1/accounts/heads': () => ({ url: '/v1/accounts/heads' }),
  'POST /v1/accounts/heads': () => ({
    url: '/v1/accounts/heads',
    body: { name: `Matrix head ${token()}`, kind: 'expense' },
  }),
  'PATCH /v1/accounts/heads/:id': async () => ({
    url: `/v1/accounts/heads/${await freshHead()}`,
    body: { name: 'Matrix head renamed' },
  }),
};

export const DELETE_ROUTE_KEYS: readonly string[] = Object.keys(DELETE_ROUTE_FIXTURES);
