import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS } from '@elysium/db';

import type { ActiveContext } from '../../platform/http/context.js';
import { CatalogService } from './catalog.service.js';
import { applyCatalogMigrations } from './catalog.testing.js';

/**
 * How the route-matrix suite calls M06's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment `CatalogModule`
 * is registered in `app.module.ts`, that suite fails until these exist. They live
 * here rather than in the suite because the suite is one file shared by every
 * milestone building in parallel, and a second write to it silently discards the
 * first; the integrator adds one import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is which
 * roles the *guard* admits, so a 404 or a 409 from a handler is as good as a 201 —
 * what matters is that it is not a 403. The exceptions are the mutations, which the
 * suite also checks leave an audit row, so those are given real ids to work on and a
 * fresh code, slug or price per call: §6 gives `create`/`update`/`delete Catalog` to
 * org_admin alone, but a fixture that collided with itself would turn a second
 * admitted role's 201 into a 409 the day the matrix widens, and the failure would
 * read as a permission bug rather than as a fixture bug.
 *
 * `prepare()` is idempotent and cheap after the first call. It applies this
 * milestone's migrations (the journal is integrated separately) and then seeds
 * through `CatalogService` itself rather than with INSERTs, which is possible
 * because the service takes no constructor dependencies — the same trick
 * `catalog.db.test.ts` uses. Seeding through the real code means the category
 * closure, the SKU counter and the variant keys these fixtures point at are the
 * ones production would have written.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

/** Upper-case hex, which is a valid SKU segment, category code and barcode. */
function token(length = 6): string {
  return randomUUID().replace(/-/g, '').slice(0, length).toUpperCase();
}

let priceStep = 0;
/** A price no earlier call used, so every reprice really changes something. */
function nextPricePoisha(): string {
  priceStep += 1;
  return String(150_000 + priceStep * 100);
}

interface Fixtures {
  readonly categoryId: string;
  readonly attributeId: string;
  /**
   * An attribute value the seeded product's matrix does **not** use, so
   * `POST /products/:id/variants` has a combination to add. Extending a matrix
   * that is already complete is not an error, but it creates nothing, and a
   * fixture that changes nothing is a fixture that proves nothing.
   */
  readonly spareValueId: string;
  readonly productId: string;
  readonly skuId: string;
  readonly skuCode: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`, after the harness boots. */
export async function prepareCatalogFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  await applyCatalogMigrations();

  const catalog = new CatalogService();
  // The seeding actor, not an actor under test: every role the suite drives signs
  // in for itself, and rows created by one of them would make that role's audit
  // count move for reasons the suite did not cause.
  const context = {
    userId: 'usr_route_matrix',
    orgId: ORG_A,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: { org_admin: [] },
    isSuperAdmin: false,
    requestId: randomUUID(),
  } as unknown as ActiveContext;

  const category = await catalog.createCategory(context, {
    name: 'Route matrix',
    slug: 'route-matrix',
    code: 'RMTX',
  });

  const attribute = await catalog.createAttribute(context, {
    code: 'RM_COLOUR',
    name: 'Route matrix colour',
    kind: 'colour',
    isVariant: true,
  });
  const used = await catalog.createAttributeValue(context, attribute.id, {
    code: 'RED',
    label: 'Red',
    position: 0,
  });
  const spare = await catalog.createAttributeValue(context, attribute.id, {
    code: 'GREEN',
    label: 'Green',
    position: 1,
  });

  const product = await catalog.createProduct(context, {
    name: 'Route matrix tee',
    slug: 'route-matrix-tee',
    categoryId: category.id,
    status: 'active',
    pricePoisha: '150000',
    axes: [{ attributeId: attribute.id, valueIds: [used.id] }],
    generateSkus: true,
  });
  const sku = product.skus[0];
  if (sku === undefined) throw new Error('seeding a product produced no SKU');

  prepared = {
    categoryId: category.id,
    attributeId: attribute.id,
    spareValueId: spare.id,
    productId: product.id,
    skuId: sku.id,
    skuCode: sku.skuCode,
  };
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareCatalogFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

/** A file the importer accepts: `sku,price_taka` and nothing else (M06 check 4). */
function priceCsv(takaText: string): string {
  return `sku,price_taka\n${state().skuCode},${takaText}\n`;
}

export const CATALOG_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/catalog/categories': () => ({ url: '/v1/catalog/categories' }),
  'POST /v1/catalog/categories': () => ({
    url: '/v1/catalog/categories',
    body: {
      name: 'Route matrix child',
      slug: `rm-cat-${token().toLowerCase()}`,
      code: `RM${token(6)}`,
    },
  }),
  'PATCH /v1/catalog/categories/:id': () => ({
    url: `/v1/catalog/categories/${state().categoryId}`,
    body: { name: 'Route matrix' },
  }),

  'GET /v1/catalog/attributes': () => ({ url: '/v1/catalog/attributes' }),
  'POST /v1/catalog/attributes': () => ({
    url: '/v1/catalog/attributes',
    body: { code: `RM_${token()}`, name: 'Route matrix attribute', kind: 'custom' },
  }),
  'POST /v1/catalog/attributes/:id/values': () => ({
    url: `/v1/catalog/attributes/${state().attributeId}/values`,
    body: { code: `V${token(7)}`, label: 'Route matrix value' },
  }),

  'GET /v1/catalog/products': () => ({ url: '/v1/catalog/products' }),
  'GET /v1/catalog/products/:id': () => ({ url: `/v1/catalog/products/${state().productId}` }),
  'POST /v1/catalog/products': () => ({
    url: '/v1/catalog/products',
    // No axes: the schema's defaults make that one unvaried SKU, which is the
    // cheapest body that still exercises the SKU counter.
    body: {
      name: 'Route matrix product',
      slug: `route-matrix-${token().toLowerCase()}`,
      pricePoisha: '150000',
    },
  }),
  'PATCH /v1/catalog/products/:id': () => ({
    url: `/v1/catalog/products/${state().productId}`,
    body: { status: 'active' },
  }),
  'POST /v1/catalog/products/:id/variants': () => ({
    url: `/v1/catalog/products/${state().productId}/variants`,
    // The spare value, so this adds the one combination the product lacks. Run
    // twice it adds nothing and still answers 200 — the SKUs that exist are never
    // replaced (M06 check 1) — so a second admitted role would not be refused.
    body: { axes: [{ attributeId: state().attributeId, valueIds: [state().spareValueId] }] },
  }),

  'GET /v1/catalog/skus': () => ({ url: '/v1/catalog/skus' }),
  'PUT /v1/catalog/prices': () => ({
    url: '/v1/catalog/prices',
    body: {
      prices: [{ skuId: state().skuId, pricePoisha: nextPricePoisha() }],
      reason: 'Route matrix',
    },
  }),
  'GET /v1/catalog/skus/:id/price-history': () => ({
    url: `/v1/catalog/skus/${state().skuId}/price-history`,
  }),
  'PUT /v1/catalog/skus/:id/barcode': () => ({
    url: `/v1/catalog/skus/${state().skuId}/barcode`,
    // A fresh payload per call: a barcode is unique within the brand.
    body: { barcode: `RM-${token(10)}` },
  }),

  /*
   * The three image routes point at ids that do not exist, and that is the
   * design rather than a shortcut. An image is a finalized, public `files.objects`
   * row of the `product-image` purpose (§22), and minting one here would mean this
   * file owned a second copy of the files module's upload rules — which would then
   * drift from it. An admitted role gets a 404 for the missing file, a refused one
   * gets a 403, and the suite can tell them apart, which is all it asks.
   */
  'POST /v1/catalog/products/:id/images': () => ({
    url: `/v1/catalog/products/${state().productId}/images`,
    body: { fileId: randomUUID(), altText: 'Route matrix' },
  }),
  'PUT /v1/catalog/products/:id/images/order': () => ({
    url: `/v1/catalog/products/${state().productId}/images/order`,
    body: { imageIds: [randomUUID()] },
  }),
  'DELETE /v1/catalog/products/:id/images/:imageId': () => ({
    url: `/v1/catalog/products/${state().productId}/images/${randomUUID()}`,
  }),

  /*
   * The dry run reports and changes nothing, so every role that holds
   * `read Catalog` runs it against the same file. The commit is `update Catalog`
   * and is reached by org_admin alone; 1590 taka differs from the seeded 1500, so
   * it really applies a row and is really audited.
   */
  'POST /v1/catalog/imports/prices/dry-run': () => ({
    url: '/v1/catalog/imports/prices/dry-run',
    body: { csv: priceCsv('1590') },
  }),
  'POST /v1/catalog/imports/prices': () => ({
    url: '/v1/catalog/imports/prices',
    body: { csv: priceCsv('1590'), reason: 'Route matrix import' },
  }),

  /*
   * The label sheet names a SKU that is not in this brand, on purpose.
   *
   * `sheetPdf` looks the SKUs up before it renders, so this answers 404 without
   * calling Gotenberg — and Gotenberg is a container from
   * `infra/docker-compose.dev.yml` that the route-matrix suite does not require.
   * A fixture that rendered a real sheet would make this whole suite fail on a
   * machine where only PostgreSQL is up, and the failure would look like a
   * permission failure. The renderer has its own coverage in `catalog.db.test.ts`.
   */
  'POST /v1/catalog/labels': () => ({
    url: '/v1/catalog/labels',
    body: { items: [{ skuId: randomUUID(), copies: 1 }] },
  }),
};

/** The manifest entries the integrator appends, derived from the fixtures. */
export const CATALOG_ROUTE_KEYS: readonly string[] = Object.keys(CATALOG_ROUTE_FIXTURES);
