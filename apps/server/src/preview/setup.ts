import { randomBytes } from 'node:crypto';

import { deterministicUuid, ensureBranchWallets, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { itemsOf, type Context, type Sku } from './context.js';

/**
 * The brand's set-up and its stock (D-383): what a brand configures before its first
 * order — a showroom, wallets, products, suppliers, a courier — then stock bought in.
 *
 * Everything with a route goes through it. Two things have none in this system: a branch
 * (the seed is the only writer of `org.branches`) and a courier row (`sales.couriers`,
 * written by the seed and by `seedDemoSetUp` for the training brand). Those two are
 * written here as set-up data, the same way, and nothing else is.
 */

const SHOWROOM = { code: 'DHN', name: 'Dhanmondi Showroom' } as const;
const DEMO_COURIER = { code: 'demo_courier', name: 'Demo Courier (fake)' } as const;

/** A fashion brand's first range: price and cost in poisha, sizes. */
export const PRODUCTS = [
  {
    slug: 'classic-cotton-tee',
    name: 'Classic Cotton Tee',
    category: 'TSH',
    price: 65_000n,
    cost: 28_000n,
    sizes: ['S', 'M', 'L', 'XL'],
  },
  {
    slug: 'premium-polo-shirt',
    name: 'Premium Polo Shirt',
    category: 'POL',
    price: 125_000n,
    cost: 56_000n,
    sizes: ['M', 'L', 'XL'],
  },
  {
    slug: 'festive-cotton-panjabi',
    name: 'Festive Cotton Panjabi',
    category: 'PNJ',
    price: 245_000n,
    cost: 115_000n,
    sizes: ['M', 'L', 'XL'],
  },
  {
    slug: 'linen-casual-shirt',
    name: 'Linen Casual Shirt',
    category: 'SHT',
    price: 145_000n,
    cost: 64_000n,
    sizes: ['M', 'L', 'XL'],
  },
  {
    slug: 'slim-fit-denim',
    name: 'Slim Fit Denim',
    category: 'DNM',
    price: 185_000n,
    cost: 90_000n,
    sizes: ['M', 'L', 'XL'],
  },
  {
    slug: 'hooded-sweatshirt',
    name: 'Hooded Sweatshirt',
    category: 'WIN',
    price: 165_000n,
    cost: 78_000n,
    sizes: ['M', 'L', 'XL'],
  },
] as const;

const CATEGORIES: Readonly<Record<string, string>> = {
  TSH: 'T-Shirts',
  POL: 'Polo Shirts',
  PNJ: 'Panjabi',
  SHT: 'Shirts',
  DNM: 'Denim',
  WIN: 'Winter Wear',
};

const SIZES = ['S', 'M', 'L', 'XL'] as const;

/** The showroom branch and its hand-cash account. Set-up data: no route makes a branch. */
async function ensureShowroomBranch(ctx: Context): Promise<void> {
  const orgId = ctx.orgId;
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into org.branches (id, org_id, code, name, kind)
        values (${deterministicUuid('elysium-erp/preview-branch', `${orgId}:${SHOWROOM.code}`)},
                ${orgId}, ${SHOWROOM.code}, ${SHOWROOM.name}, 'showroom'::org.branch_kind)
        on conflict (org_id, code) do nothing
      `);
      // The branch's own hand-cash account (1010-DHN), as the seed gives every branch one.
      await ensureBranchWallets(tx, orgId);
      await tx.execute(sql`
        insert into sales.couriers (org_id, code, name)
        values (${orgId}, ${DEMO_COURIER.code}, ${DEMO_COURIER.name})
        on conflict (org_id, code) do nothing
      `);
      const branches = await tx.execute<{ id: string; code: string }>(
        sql`select id, code from org.branches where org_id = ${orgId}`,
      );
      ctx.ids.hqBranchId = branches.find((row) => row.code === 'HQ')?.id ?? '';
      ctx.ids.showroomBranchId = branches.find((row) => row.code === SHOWROOM.code)?.id ?? '';
      const couriers = await tx.execute<{ id: string; code: string }>(
        sql`select id, code from sales.couriers where org_id = ${orgId}`,
      );
      ctx.ids.demoCourierId = couriers.find((row) => row.code === DEMO_COURIER.code)?.id ?? '';
      ctx.ids.ownRiderId = couriers.find((row) => row.code === 'own_rider')?.id ?? '';
    },
    { orgId },
  );
}

/** Branch ids the logins are scoped to: the branch manager runs the showroom. */
export async function prepareBranches(ctx: Context): Promise<Record<string, string>> {
  await ensureShowroomBranch(ctx);
  return { branch: ctx.ids.showroomBranchId };
}

interface Location {
  id: string;
  code: string;
  kind: string;
}

export async function ensureLocations(ctx: Context): Promise<void> {
  const admin = await ctx.people.robot('admin');
  const existing = async () => itemsOf<Location>(await admin.client.get('/v1/inventory/locations'));
  let locations = await existing();
  const wanted = [
    {
      code: 'SR-01',
      name: SHOWROOM.name,
      kind: 'showroom',
      branchId: ctx.ids.showroomBranchId,
    },
    { code: 'TRANSIT', name: 'In transit', kind: 'in_transit' },
    { code: 'DAMAGED', name: 'Damaged goods', kind: 'damaged' },
  ];
  for (const location of wanted) {
    if (locations.some((row) => row.code === location.code)) continue;
    await admin.client.post('/v1/inventory/locations', location);
  }
  locations = await existing();
  const byCode = (code: string) => locations.find((row) => row.code === code)?.id ?? '';
  ctx.ids.warehouseId = byCode('WH-01');
  ctx.ids.showroomId = byCode('SR-01');
  ctx.ids.transitId = byCode('TRANSIT');
}

export async function loadAccounts(ctx: Context): Promise<void> {
  const accounts = await ctx.people.robot('accounts');
  const rows = itemsOf<{ id: string; code: string }>(
    await accounts.client.get('/v1/ledger/accounts'),
  );
  for (const row of rows) ctx.ids.accounts[row.code] = row.id;
}

export function account(ctx: Context, code: string): string {
  const id = ctx.ids.accounts[code];
  if (id === undefined) throw new Error(`preview: no ledger account ${code}.`);
  return id;
}

export async function ensureWallets(ctx: Context): Promise<void> {
  const accounts = await ctx.people.robot('accounts');
  const list = async () =>
    itemsOf<{ id: string; code: string }>(
      await accounts.client.get('/v1/accounts/wallets?includeInactive=true'),
    );
  let wallets = await list();
  const wanted = [
    { code: '1010-HQ', body: { branchId: ctx.ids.hqBranchId, provider: 'Office cash' } },
    { code: '1010-DHN', body: { branchId: ctx.ids.showroomBranchId, provider: 'Till cash' } },
    { code: '1100', body: { provider: 'Demo Bank', accountRefLast4: '0000' } },
    { code: '1110', body: { provider: 'bKash' } },
  ];
  for (const wallet of wanted) {
    if (wallets.some((row) => row.code === wallet.code)) continue;
    await accounts.client.post('/v1/accounts/wallets', {
      account: { existingAccountId: account(ctx, wallet.code) },
      ...wallet.body,
    });
  }
  wallets = await list();
  for (const row of wallets) ctx.ids.wallets[row.code] = row.id;
}

interface CatalogAttribute {
  id: string;
  code: string;
  values: { id: string; code: string }[];
}

interface ProductView {
  id: string;
  slug?: string;
  skus: {
    id: string;
    skuCode: string;
    pricePoisha: string;
    barcode?: string | null;
    attributes?: { valueCode: string }[];
  }[];
}

export async function ensureCatalog(ctx: Context): Promise<void> {
  const admin = (await ctx.people.robot('admin')).client;

  const categories = itemsOf<{ id: string; code?: string; slug?: string }>(
    await admin.get('/v1/catalog/categories'),
  );
  const categoryIds: Record<string, string> = {};
  for (const [code, name] of Object.entries(CATEGORIES)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const found = categories.find((row) => row.code === code || row.slug === slug);
    categoryIds[code] =
      found?.id ??
      (await admin.post<{ id: string }>('/v1/catalog/categories', { name, slug, code })).id;
  }

  const attributes = async () =>
    itemsOf<CatalogAttribute>(await admin.get('/v1/catalog/attributes'));
  let size = (await attributes()).find((row) => row.code === 'SIZE');
  if (size === undefined) {
    await admin.post('/v1/catalog/attributes', { code: 'SIZE', name: 'Size', kind: 'size' });
    size = (await attributes()).find((row) => row.code === 'SIZE');
  }
  if (size === undefined) throw new Error('preview: the size attribute did not appear.');
  for (const [position, code] of SIZES.entries()) {
    if (size.values.some((value) => value.code === code)) continue;
    await admin.post(`/v1/catalog/attributes/${size.id}/values`, { code, label: code, position });
  }
  const sizes = (await attributes()).find((row) => row.code === 'SIZE') ?? size;
  const valueId = (code: string) => sizes.values.find((value) => value.code === code)?.id ?? '';

  const listed = itemsOf<{ id: string; name: string }>(
    await admin.get('/v1/catalog/products?limit=100'),
  );
  const skus: Sku[] = [];
  const barcodes: { skuId: string; barcode: string }[] = [];
  for (const [productIndex, product] of PRODUCTS.entries()) {
    // Found again by name: a product's web address is its parent SKU (D-661), so `slug` here
    // is only the preview's own key for the product.
    const known = listed.find((row) => row.name === product.name);
    const view =
      known === undefined
        ? await admin.post<ProductView>('/v1/catalog/products', {
            name: product.name,
            slug: product.slug,
            categoryId: categoryIds[product.category],
            status: 'active',
            pricePoisha: String(product.price),
            axes: [{ attributeId: sizes.id, valueIds: product.sizes.map(valueId) }],
          })
        : await admin.get<ProductView>(`/v1/catalog/products/${known.id}`);
    for (const sku of view.skus) {
      const sizeCode =
        sku.attributes?.[0]?.valueCode ?? sku.skuCode.slice(sku.skuCode.lastIndexOf('-') + 1);
      skus.push({
        id: sku.id,
        skuCode: sku.skuCode,
        pricePoisha: sku.pricePoisha,
        productSlug: product.slug,
        size: sizeCode,
      });
      if (sku.barcode == null) {
        barcodes.push({ skuId: sku.id, barcode: previewBarcode(productIndex, sizeCode) });
      }
    }
    if (known === undefined) ctx.count('products');
  }
  ctx.ids.skus = skus;

  // Only a SKU with none: a barcode is unique in the brand, and one already given stays.
  for (const { skuId, barcode } of barcodes) {
    await admin.put(`/v1/catalog/skus/${skuId}/barcode`, { barcode });
  }
}

/**
 * A till barcode: 13 digits in the in-store `200…` range no supplier prints, from the
 * product's place in the range and the size, so a code means the same item on every run
 * (the Classic Cotton Tee in M is `2000000000102`).
 */
export function previewBarcode(productIndex: number, size: string): string {
  const sizeIndex = SIZES.indexOf(size as (typeof SIZES)[number]);
  return `200000000${String(productIndex + 1).padStart(2, '0')}${String(sizeIndex + 1).padStart(2, '0')}`;
}

function costOf(slug: string): bigint {
  return PRODUCTS.find((product) => product.slug === slug)?.cost ?? 0n;
}

export async function ensureSupply(ctx: Context): Promise<void> {
  const accounts = (await ctx.people.robot('accounts')).client;
  const suppliers = [
    { code: 'DEMO-TEX', name: 'Demo Textile Mills', paymentTermsDays: 30 },
    { code: 'DEMO-STITCH', name: 'Demo Stitching House', paymentTermsDays: 15 },
  ];
  const ids: string[] = [];
  for (const supplier of suppliers) {
    const found = itemsOf<{ id: string; code: string }>(
      await accounts.get(`/v1/supply/suppliers?q=${encodeURIComponent(supplier.code)}`),
    ).find((row) => row.code === supplier.code);
    ids.push(
      found?.id ?? (await accounts.post<{ id: string }>('/v1/supply/suppliers', supplier)).id,
    );
  }
  ctx.ids.supplierIds = ids;
  const [textile = '', stitching = ''] = ids;

  // Stock in: tees, polos, shirts from the mill; panjabi, denim and hoodies from the
  // stitching house. Client ids make a second run replay rather than buy again.
  const purchases = [
    {
      name: 'purchase:mill',
      supplierId: textile,
      invoiceNumber: 'DTM-2026-101',
      slugs: ['classic-cotton-tee', 'premium-polo-shirt', 'linen-casual-shirt'],
      qty: 40,
    },
    {
      name: 'purchase:stitching',
      supplierId: stitching,
      invoiceNumber: 'DSH-2026-044',
      slugs: ['festive-cotton-panjabi', 'slim-fit-denim', 'hooded-sweatshirt'],
      qty: 30,
    },
  ];
  for (const purchase of purchases) {
    const lines = ctx.ids.skus
      .filter((sku) => purchase.slugs.includes(sku.productSlug))
      .map((sku) => ({
        skuId: sku.id,
        qty: purchase.qty,
        unitCostPoisha: String(costOf(sku.productSlug)),
      }));
    const result = await accounts.post<{ created?: boolean }>('/v1/supply/entries', {
      supplyId: ctx.id(purchase.name),
      supplierId: purchase.supplierId,
      locationId: ctx.ids.warehouseId,
      invoiceNumber: purchase.invoiceNumber,
      occurredAt: new Date().toISOString(),
      lines,
    });
    if (result.created !== false) ctx.count('purchases');
  }

  // Two payments to the mill from the bank: one approved and posted, one left waiting for
  // a checker so the owner can approve it.
  const admin = (await ctx.people.robot('admin')).client;
  const paid = await accounts.post<{ status: string; approvalId: string | null }>(
    '/v1/supply/payments',
    {
      paymentId: ctx.id('supplier-payment:1'),
      supplierId: textile,
      walletAccountId: account(ctx, '1100'),
      kind: 'payment',
      amountPoisha: '5000000',
      memo: 'Part payment, invoice DTM-2026-101',
    },
  );
  if (paid.status === 'pending_approval' && paid.approvalId !== null) {
    await admin.post(`/v1/approvals/${paid.approvalId}/decide`, {
      decision: 'approved',
      note: 'Checked against the invoice',
    });
  }
  await accounts.post('/v1/supply/payments', {
    paymentId: ctx.id('supplier-payment:2'),
    supplierId: stitching,
    walletAccountId: account(ctx, '1100'),
    kind: 'payment',
    amountPoisha: '3000000',
    memo: 'Part payment, invoice DSH-2026-044',
  });
}

/** Stock to the showroom: the warehouse sends, the branch manager receives. */
export async function ensureShowroomStock(ctx: Context): Promise<void> {
  const warehouse = (await ctx.people.as('warehouse')).client;
  const transfers = itemsOf<unknown>(await warehouse.get('/v1/inventory/transfers'));
  if (transfers.length > 0) return;
  const lines = ctx.ids.skus
    .filter((sku) => sku.size !== 'XL' || sku.productSlug === 'festive-cotton-panjabi')
    .map((sku) => ({ skuId: sku.id, qty: 6 }));
  const sent = await warehouse.post<{ id: string }>('/v1/inventory/transfers', {
    fromLocationId: ctx.ids.warehouseId,
    toLocationId: ctx.ids.showroomId,
    memo: 'Opening stock for the Dhanmondi showroom',
    lines,
  });
  const branch = (await ctx.people.as('branch')).client;
  await branch.post(`/v1/inventory/transfers/${sent.id}/receive`);
  ctx.count('transfers');

  // A damaged unit found on the shelf: a write-off waiting for an approver.
  await warehouse.post('/v1/inventory/adjustments', {
    locationId: ctx.ids.warehouseId,
    direction: 'loss',
    reason: 'Torn seam found while packing',
    lines: [{ skuId: ctx.sku('classic-cotton-tee', 'S').id, qty: 1 }],
  });
}

/** The fake courier, hung on a "Demo Courier" row so no real courier's name is used. */
export async function ensureCourierAccount(ctx: Context): Promise<void> {
  const accounts = (await ctx.people.robot('accounts')).client;
  const existing = itemsOf<{ courierId: string }>(await accounts.get('/v1/courier/accounts'));
  if (existing.some((row) => row.courierId === ctx.ids.demoCourierId)) return;
  await accounts.post('/v1/courier/accounts', {
    courierId: ctx.ids.demoCourierId,
    providerCode: 'fake',
    label: 'Demo Courier (fake, no real parcels)',
    mode: 'sandbox',
    // Without a secret the fake accepts any webhook unauthenticated, and a webhook can
    // deliver an order — which posts revenue. Nobody needs this value, so it is not kept.
    webhookSecret: randomBytes(24).toString('base64url'),
    pollAfterHours: 168,
    settlementWalletId: ctx.ids.wallets['1100'],
    isActive: true,
  });
}
