import { randomUUID } from 'node:crypto';

import {
  assertNoCostFields,
  MEMBERSHIP_ROLES,
  serializeFor,
  type MembershipRole,
} from '@elysium/contracts';
import { SEED_ORG_IDS, withOrg } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActiveContext } from '../../platform/http/context.js';
import { CatalogService } from './catalog.service.js';
import type { CreateProductInput } from './catalog.schemas.js';
import { toCatalogHttpError } from './catalog.errors.js';
import { applyCatalogMigrations } from './catalog.testing.js';
import { CatalogImportService } from './import.service.js';
import { renderLabelSheetHtml, LABELS_PER_SHEET } from './labels.service.js';

/**
 * The catalog against real PostgreSQL (M06 checks 1, 3 and 4, plus the tenancy
 * and immutability rules the database itself enforces).
 *
 * The services are driven directly rather than over HTTP, and that is a
 * consequence of this session's split rather than a preference: `app.module.ts` is
 * edited by several milestones at once, so `CatalogModule` is registered by the
 * integrator and `startHttpHarness()` cannot reach these routes until then. What
 * that costs is coverage of the guard and the serializer *on this module's routes*
 * — which the route-matrix suite provides once the manifest lines land, and which
 * the `assertNoCostFields` block below covers for the response shapes themselves.
 *
 * What it does not cost is any of the milestone's real claims: check 1 is about the
 * matrix, check 3 about the shapes, check 4 about a transaction, and all three are
 * exercised here against the same SQL production runs.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';

let database: TestDatabase;
const catalog = new CatalogService();
const imports = new CatalogImportService();

const contextFor = (orgId: string): ActiveContext =>
  ({
    userId: `usr_catalog_${orgId.slice(0, 8)}`,
    orgId,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: { org_admin: [] },
    isSuperAdmin: false,
    requestId: randomUUID(),
  }) as unknown as ActiveContext;

const A = contextFor(ORG_A);
const B = contextFor(ORG_B);

/**
 * `createProduct` with the schema's defaults filled in.
 *
 * The service takes the *parsed* input, so `status`, `axes` and `generateSkus` are
 * required there — Zod has already applied their defaults by the time a controller
 * calls it. Filling them here keeps each test about the one thing it varies.
 */
function newProduct(
  overrides: Partial<CreateProductInput> & {
    readonly name: string;
    readonly slug: string;
    readonly pricePoisha: string;
  },
): CreateProductInput {
  return { status: 'draft', axes: [], generateSkus: true, ...overrides };
}

interface Axis {
  readonly attributeId: string;
  readonly valueIds: string[];
}

async function seedAttribute(
  context: ActiveContext,
  code: string,
  kind: 'size' | 'colour' | 'custom',
  values: readonly string[],
): Promise<Axis> {
  const attribute = await catalog.createAttribute(context, {
    code,
    name: code,
    kind,
    isVariant: true,
  });
  const valueIds: string[] = [];
  for (const [index, value] of values.entries()) {
    const created = await catalog.createAttributeValue(context, attribute.id, {
      code: value,
      label: value,
      position: index,
    });
    valueIds.push(created.id);
  }
  return { attributeId: attribute.id, valueIds };
}

let colour: Axis;
let size: Axis;
let categoryId: string;

beforeAll(async () => {
  database = await startTestDatabase('catalog');
  await applyCatalogMigrations();

  const category = await catalog.createCategory(A, {
    name: 'Shirts',
    slug: 'shirts',
    code: 'SHRT',
  });
  categoryId = category.id;

  colour = await seedAttribute(A, 'COLOUR', 'colour', ['RED', 'BLUE', 'GREEN']);
  size = await seedAttribute(A, 'SIZE', 'size', ['S', 'M', 'L', 'XL', 'XXL']);
}, 180_000);

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/** Whatever a promise rejected with, for the error-mapping assertions. */
async function capture(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('expected this to be refused');
}

/** PostgreSQL's own message and SQLSTATE, from under Drizzle's wrapper. */
async function refusal(work: Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await work;
  } catch (error) {
    const messages: string[] = [];
    let code = '';
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
      const candidate = (current as { code?: unknown }).code;
      if (typeof candidate === 'string' && code === '') code = candidate;
    }
    return { message: messages.join(' | '), code };
  }
  throw new Error('expected this to be refused');
}

let productCounter = 0;
const uniqueSlug = (prefix: string) => {
  productCounter += 1;
  return `${prefix}-${String(productCounter)}-${Math.random().toString(36).slice(2, 7)}`;
};

describe('the variant matrix (check 1)', () => {
  it('creates 15 unique SKUs from 3 colours x 5 sizes, and only the new ones when a size is added', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Oxford shirt',
        slug: uniqueSlug('oxford'),
        categoryId,
        status: 'active',
        pricePoisha: '149000',
        axes: [
          { attributeId: colour.attributeId, valueIds: colour.valueIds },
          { attributeId: size.attributeId, valueIds: size.valueIds },
        ],
        generateSkus: true,
      }),
    );

    expect(product.skus).toHaveLength(15);
    expect(new Set(product.skus.map((sku) => sku.skuCode)).size).toBe(15);
    // The §8 pattern, with the per-org prefix, the category code and a padded
    // sequence. `ELY` comes from the seeded slug `elysium-lifestyle-bd`.
    expect(product.skus[0]?.skuCode).toMatch(/^ELY-SHRT-\d{4,}-RED-S$/);

    const before = product.skus.map((sku) => sku.skuCode).sort();

    // Now a sixth size, six months later.
    const xxxl = await catalog.createAttributeValue(A, size.attributeId, {
      code: 'XXXL',
      label: 'XXXL',
      position: 5,
    });
    const extended = await catalog.extendMatrix(A, product.id, {
      axes: [
        { attributeId: colour.attributeId, valueIds: colour.valueIds },
        { attributeId: size.attributeId, valueIds: [...size.valueIds, xxxl.id] },
      ],
    });

    expect(extended.created).toHaveLength(3);
    expect(extended.created.every((code) => code.endsWith('-XXXL'))).toBe(true);
    expect(extended.unchanged).toBe(15);
    expect(extended.product.skus).toHaveLength(18);

    // The original fifteen are untouched — same ids, same codes. This is the whole
    // point: M07's movements and M10's order lines reference those ids.
    const after = extended.product.skus.map((sku) => sku.skuCode);
    expect(before.every((code) => after.includes(code))).toBe(true);
  });

  it('is idempotent: extending with the same axes twice creates nothing the second time', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Polo',
        slug: uniqueSlug('polo'),
        categoryId,
        pricePoisha: '99000',
        axes: [{ attributeId: colour.attributeId, valueIds: colour.valueIds.slice(0, 2) }],
        generateSkus: true,
      }),
    );
    expect(product.skus).toHaveLength(2);

    const again = await catalog.extendMatrix(A, product.id, {
      axes: [{ attributeId: colour.attributeId, valueIds: colour.valueIds.slice(0, 2) }],
    });
    expect(again.created).toEqual([]);
    expect(again.product.skus).toHaveLength(2);
  });

  it('reports a dropped value as orphaned and leaves its SKU in place', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Tee',
        slug: uniqueSlug('tee'),
        categoryId,
        pricePoisha: '59000',
        axes: [{ attributeId: colour.attributeId, valueIds: colour.valueIds }],
        generateSkus: true,
      }),
    );

    const narrowed = await catalog.extendMatrix(A, product.id, {
      axes: [{ attributeId: colour.attributeId, valueIds: colour.valueIds.slice(0, 2) }],
    });

    expect(narrowed.created).toEqual([]);
    expect(narrowed.orphaned).toHaveLength(1);
    expect(narrowed.product.skus).toHaveLength(3);
  });

  it('gives a product with no axes one unvaried SKU, and allows a draft with none at all', async () => {
    const single = await catalog.createProduct(
      A,
      newProduct({
        name: 'Tote bag',
        slug: uniqueSlug('tote'),
        pricePoisha: '45000',
        axes: [],
        generateSkus: true,
      }),
    );
    expect(single.skus).toHaveLength(1);
    // No category, so no {CAT} segment.
    expect(single.skus[0]?.skuCode).toMatch(/^ELY-\d{4,}$/);

    const draft = await catalog.createProduct(
      A,
      newProduct({
        name: 'Unnamed draft',
        slug: uniqueSlug('draft'),
        pricePoisha: '10000',
        axes: [],
        generateSkus: false,
      }),
    );
    expect(draft.skus).toEqual([]);
    expect(draft.status).toBe('draft');
  });

  it('refuses a value that belongs to another attribute', async () => {
    await expect(
      catalog.createProduct(
        A,
        newProduct({
          name: 'Mismatched',
          slug: uniqueSlug('mismatch'),
          pricePoisha: '10000',
          axes: [{ attributeId: colour.attributeId, valueIds: [size.valueIds[0] ?? ''] }],
          generateSkus: true,
        }),
      ),
    ).rejects.toThrow(/does not belong to it/);
  });
});

describe('the SKU sequence and its uniqueness', () => {
  it('hands out a distinct sequence to every concurrent product creation', async () => {
    // Ten at once. A select-then-update counter gives at least two of them the
    // same number, and the loser dies on products_org_sequence_idx.
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        catalog.createProduct(
          A,
          newProduct({
            name: `Concurrent ${String(index)}`,
            slug: uniqueSlug('concurrent'),
            pricePoisha: '10000',
            axes: [],
            generateSkus: true,
          }),
        ),
      ),
    );

    const sequences = created.map((product) => product.sequence);
    expect(new Set(sequences).size).toBe(10);
  });

  it('numbers each brand separately, so the same sequence exists in two orgs', async () => {
    await applyCatalogMigrations();
    const inB = await catalog.createProduct(
      B,
      newProduct({
        name: 'Oura shirt',
        slug: 'oura-shirt',
        pricePoisha: '199000',
        axes: [],
        generateSkus: true,
      }),
    );

    expect(inB.sequence).toBe(1);
    // A different prefix, from Oura's own slug, so the codes cannot collide even
    // at the same sequence number.
    expect(inB.skus[0]?.skuCode).toMatch(/^OUR-0001$/);
  });

  it("keeps one brand from reading or reaching another brand's catalog", async () => {
    const inA = await catalog.createProduct(
      A,
      newProduct({
        name: 'Isolated',
        slug: uniqueSlug('isolated'),
        pricePoisha: '10000',
        axes: [],
        generateSkus: true,
      }),
    );

    await expect(catalog.product(B, inA.id)).rejects.toThrow(/No such product/);

    const fromB = await catalog.listProducts(B, { limit: 100 });
    expect(fromB.items.some((item) => item.id === inA.id)).toBe(false);

    // And the foreign key cannot be used to point across the boundary either
    // (D-047): org B inserting a SKU under org A's product is refused by the
    // composite key, not merely hidden by the policy.
    const refused = await refusal(
      withOrg({ orgId: ORG_B, userId: 'usr_x' }, (tx) =>
        tx.execute(sql`
          insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha)
          values (${ORG_B}, ${inA.id}, 'OUR-9999', 'x', 1000)
        `),
      ),
    );
    expect(refused.code).toBe('23503');
  });
});

describe('what the database refuses', () => {
  it("freezes a SKU's code, product and variant key, and allows a reprice", async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Frozen',
        slug: uniqueSlug('frozen'),
        pricePoisha: '10000',
        axes: [],
        generateSkus: true,
      }),
    );
    const skuId = product.skus[0]?.id ?? '';

    const renamed = await refusal(
      withOrg({ orgId: ORG_A, userId: 'usr_x' }, (tx) =>
        tx.execute(sql`update catalog.skus set code = 'ELY-HACKED' where id = ${skuId}`),
      ),
    );
    expect(renamed.message).toContain('CATALOG_SKU_IMMUTABLE');

    // A price change is the row's state, not its identity.
    await catalog.setPrices(A, { prices: [{ skuId, pricePoisha: '12000' }], reason: 'sale' });
    const history = await catalog.priceHistory(A, skuId);
    expect(history.items.map((row) => row.toPricePoisha)).toEqual(['12000', '10000']);
    expect(history.items[0]?.reason).toBe('sale');
    // The first row has no "from": there was no price before.
    expect(history.items[1]?.fromPricePoisha).toBeNull();
  });

  it('refuses to update or delete a price history row, whoever asks', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'History',
        slug: uniqueSlug('history'),
        pricePoisha: '20000',
        axes: [],
        generateSkus: true,
      }),
    );
    const skuId = product.skus[0]?.id ?? '';

    const updated = await refusal(
      withOrg({ orgId: ORG_A, userId: 'usr_x' }, (tx) =>
        tx.execute(sql`update catalog.sku_price_history set to_poisha = 1 where sku_id = ${skuId}`),
      ),
    );
    expect(updated.code).toBe('42501');
  });

  it('refuses a category cycle a CHECK constraint cannot see', async () => {
    const parent = await catalog.createCategory(A, {
      name: 'Men',
      slug: uniqueSlug('men'),
      code: 'MEN',
    });
    const child = await catalog.createCategory(A, {
      name: 'Kurta',
      slug: uniqueSlug('kurta'),
      code: 'KRT',
      parentId: parent.id,
    });

    expect(child.path.endsWith(`/${child.path.split('/').pop() ?? ''}`)).toBe(true);
    expect(child.depth).toBe(1);

    // Two-row loop: the CHECK only catches parent_id = id.
    // Read through the cause chain: the service throws what Drizzle wrapped, and
    // the trigger's own message — the one a client will see once
    // `mapCatalogErrors` has translated it — is underneath.
    const cycle = await refusal(catalog.updateCategory(A, parent.id, { parentId: child.id }));
    expect(cycle.message).toContain('CATALOG_CATEGORY_CYCLE');
    expect(
      toCatalogHttpError(
        await capture(catalog.updateCategory(A, parent.id, { parentId: child.id })),
      ),
    ).toMatchObject({ response: { code: 'CATALOG_CATEGORY_CYCLE' } });
  });

  it('refuses a duplicate SKU code and a duplicate variant within one product', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Dupe',
        slug: uniqueSlug('dupe'),
        pricePoisha: '10000',
        axes: [],
        generateSkus: true,
      }),
    );
    const code = product.skus[0]?.skuCode ?? '';

    const duplicate = await refusal(
      withOrg({ orgId: ORG_A, userId: 'usr_x' }, (tx) =>
        tx.execute(sql`
          insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha)
          values (${ORG_A}, ${product.id}, ${code}, 'other', 1000)
        `),
      ),
    );
    expect(duplicate.code).toBe('23505');
  });

  it('refuses a zero or negative selling price', async () => {
    const refused = await refusal(
      withOrg({ orgId: ORG_A, userId: 'usr_x' }, (tx) =>
        tx
          .execute(
            sql`
          insert into catalog.products (org_id, sequence, name, slug, status)
          values (${ORG_A}, 999999, 'Bad', 'bad-price-product', 'draft')
        `,
          )
          .then(() =>
            tx.execute(sql`
            insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha)
            select ${ORG_A}, id, 'ELY-BAD', '', 0 from catalog.products
            where org_id = ${ORG_A} and slug = 'bad-price-product'
          `),
          ),
      ),
    );
    expect(refused.message).toContain('skus_price_positive');
  });
});

describe("search (check 2's query shape)", () => {
  it('finds a product by a fragment of its name and by a fragment of a SKU code', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Panjabi embroidered',
        slug: uniqueSlug('panjabi'),
        categoryId,
        status: 'active',
        pricePoisha: '250000',
        axes: [{ attributeId: colour.attributeId, valueIds: [colour.valueIds[0] ?? ''] }],
        generateSkus: true,
      }),
    );
    const code = product.skus[0]?.skuCode ?? '';

    const byName = await catalog.listProducts(A, { q: 'embroider', limit: 25 });
    expect(byName.items.map((item) => item.id)).toContain(product.id);

    // The SKU code is part of the product's search text (0026), which is why a
    // picker can paste a code into the product search and land on the product.
    const bySku = await catalog.listProducts(A, { q: code.slice(-12).toLowerCase(), limit: 25 });
    expect(bySku.items.map((item) => item.id)).toContain(product.id);

    const skuHit = await catalog.searchSkus(A, { code, limit: 10 });
    expect(skuHit.items).toHaveLength(1);
    expect(skuHit.items[0]?.skuCode).toBe(code);
  });

  it('pages by keyset without repeating or skipping a product', async () => {
    const first = await catalog.listProducts(A, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();

    const second = await catalog.listProducts(A, {
      limit: 3,
      cursor: first.nextCursor ?? undefined,
    });
    const overlap = second.items.filter((item) =>
      first.items.some((earlier) => earlier.id === item.id),
    );
    expect(overlap).toEqual([]);
  });

  it('ignores a hand-edited cursor rather than erroring on it', async () => {
    const page = await catalog.listProducts(A, { limit: 2, cursor: 'not-a-cursor' });
    expect(page.items).toHaveLength(2);
  });
});

describe('the CSV importer (check 4)', () => {
  let skuCodes: string[] = [];

  beforeAll(async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Import target',
        slug: uniqueSlug('import'),
        categoryId,
        pricePoisha: '100000',
        axes: [{ attributeId: size.attributeId, valueIds: size.valueIds.slice(0, 3) }],
        generateSkus: true,
      }),
    );
    skuCodes = product.skus.map((sku) => sku.skuCode);
  });

  it('reports row-level errors in a dry run and changes nothing', async () => {
    const csv = [
      'sku,price_taka',
      `${skuCodes[0] ?? ''},1590`,
      'ELY-SHRT-9999-NOPE,1590',
      `${skuCodes[1] ?? ''},not-a-price`,
    ].join('\n');

    const report = await imports.dryRun(A, { csv });

    expect(report.canCommit).toBe(false);
    expect(report.problems.map((problem) => problem.line)).toEqual([3, 4]);
    expect(report.problems[0]?.column).toBe('sku');
    expect(report.problems[1]?.column).toBe('price_taka');

    // Nothing moved.
    const unchanged = await catalog.searchSkus(A, { code: skuCodes[0] ?? '', limit: 1 });
    expect(unchanged.items[0]?.pricePoisha).toBe('100000');
  });

  it('applies the whole file or none of it', async () => {
    const good = [
      'sku,price_taka',
      `${skuCodes[0] ?? ''},159`,
      `${skuCodes[1] ?? ''},169.50`,
      `${skuCodes[2] ?? ''},179`,
    ].join('\n');

    const preview = await imports.dryRun(A, { csv: good });
    expect(preview.canCommit).toBe(true);
    expect(preview.willChange).toBe(3);

    const applied = await imports.commit(A, { csv: good, reason: 'Eid pricing' });
    expect(applied.applied).toBe(3);

    const after = await catalog.searchSkus(A, { q: skuCodes[0]?.slice(-8) ?? '', limit: 10 });
    const first = after.items.find((item) => item.skuCode === skuCodes[0]);
    expect(first?.pricePoisha).toBe('15900');

    // And a file with one bad row leaves every price exactly where it was.
    const bad = [
      'sku,price_taka',
      `${skuCodes[0] ?? ''},9999`,
      `${skuCodes[1] ?? ''},9999`,
      'ELY-SHRT-0000-GONE,9999',
    ].join('\n');

    await expect(imports.commit(A, { csv: bad })).rejects.toThrow(/cannot be applied/);

    const stillThere = await catalog.searchSkus(A, { code: skuCodes[0] ?? '', limit: 1 });
    expect(stillThere.items[0]?.pricePoisha).toBe('15900');
  });

  it('refuses a file carrying a cost column (invariant 5)', async () => {
    const csv = `sku,price_taka,unit_cost_poisha\n${skuCodes[0] ?? ''},159,90\n`;
    const report = await imports.dryRun(A, { csv });
    expect(report.canCommit).toBe(false);
    expect(report.problems[0]?.message).toContain('purchase cost');
    await expect(imports.commit(A, { csv })).rejects.toThrow(/cannot be applied/);
  });

  it('writes one price history row per changed SKU and none for an unchanged one', async () => {
    const skuId =
      (await catalog.searchSkus(A, { code: skuCodes[2] ?? '', limit: 1 })).items[0]?.id ?? '';
    const before = (await catalog.priceHistory(A, skuId)).items.length;

    // Same price as it already has: the trigger's early return means no row.
    await imports.commit(A, { csv: `sku,price_taka\n${skuCodes[2] ?? ''},179\n` });
    expect((await catalog.priceHistory(A, skuId)).items).toHaveLength(before);

    await imports.commit(A, { csv: `sku,price_taka\n${skuCodes[2] ?? ''},189\n` });
    expect((await catalog.priceHistory(A, skuId)).items).toHaveLength(before + 1);
  });
});

describe('images', () => {
  async function storedPublicFile(purpose: string, visibility: string): Promise<string> {
    const fileId = randomUUID();
    await withOrg({ orgId: ORG_A, userId: 'usr_x' }, (tx) =>
      tx.execute(sql`
        insert into files.objects
          (id, org_id, storage_key, driver, visibility, status, purpose, mime, size_bytes, sha256)
        values (
          ${fileId}, ${ORG_A}, ${`${visibility}/${ORG_A}/${fileId}.webp`}, 'local',
          ${visibility}::files.file_visibility, 'stored', ${purpose}, 'image/webp', 1024,
          ${'a'.repeat(64)}
        )
      `),
    );
    return fileId;
  }

  it('attaches, orders and detaches product images', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'With images',
        slug: uniqueSlug('images'),
        pricePoisha: '10000',
        axes: [],
        generateSkus: true,
      }),
    );

    const one = await catalog.attachImage(A, product.id, {
      fileId: await storedPublicFile('product-image', 'public'),
    });
    const two = await catalog.attachImage(A, product.id, {
      fileId: await storedPublicFile('product-image', 'public'),
      altText: 'Back view',
    });
    expect([one.position, two.position]).toEqual([0, 1]);

    await catalog.reorderImages(A, product.id, { imageIds: [two.id, one.id] });
    const reordered = await catalog.product(A, product.id);
    expect(reordered.images.map((image) => image.id)).toEqual([two.id, one.id]);

    await catalog.detachImage(A, product.id, one.id);
    expect((await catalog.product(A, product.id)).images).toHaveLength(1);
  });

  it('refuses a private file and a file uploaded for another purpose', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Bad images',
        slug: uniqueSlug('bad-images'),
        pricePoisha: '10000',
        axes: [],
        generateSkus: true,
      }),
    );

    await expect(
      catalog.attachImage(A, product.id, { fileId: await storedPublicFile('kyc', 'private') }),
    ).rejects.toThrow(/cannot be used as a product image/);
    await expect(
      catalog.attachImage(A, product.id, {
        fileId: await storedPublicFile('campaign-asset', 'public'),
      }),
    ).rejects.toThrow(/cannot be used as a product image/);
  });

  it('refuses a partial reorder rather than applying an order nobody chose', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Partial order',
        slug: uniqueSlug('partial'),
        pricePoisha: '10000',
        axes: [],
        generateSkus: true,
      }),
    );
    const first = await catalog.attachImage(A, product.id, {
      fileId: await storedPublicFile('product-image', 'public'),
    });
    await catalog.attachImage(A, product.id, {
      fileId: await storedPublicFile('product-image', 'public'),
    });

    await expect(catalog.reorderImages(A, product.id, { imageIds: [first.id] })).rejects.toThrow(
      /every image of this product exactly once/,
    );
  });
});

describe('no cost, for any role (check 3)', () => {
  it('has no cost-shaped column in any catalog table', async () => {
    const columns = await withOrg({ orgId: ORG_A, userId: 'usr_x' }, async (tx) => {
      const rows = await tx.execute<{ table_name: string; column_name: string }>(sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'catalog'
      `);
      return [...rows];
    });

    expect(columns.length).toBeGreaterThan(0);
    const suspicious = columns.filter((column) =>
      /cost|wac|cogs|margin|profit|landed|purchase_price/i.test(column.column_name),
    );
    expect(suspicious).toEqual([]);

    // Positive control: the selling price is here, so the test above is looking at
    // the right schema rather than at an empty list.
    expect(columns.some((column) => column.column_name === 'price_poisha')).toBe(true);
  });

  it('passes assertNoCostFields for every membership role, on every catalog response', async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Serialized',
        slug: uniqueSlug('serialized'),
        categoryId,
        status: 'active',
        pricePoisha: '149000',
        axes: [{ attributeId: colour.attributeId, valueIds: colour.valueIds }],
        generateSkus: true,
      }),
    );
    await catalog.setPrices(A, {
      prices: [{ skuId: product.skus[0]?.id ?? '', pricePoisha: '159000' }],
    });

    const responses: Record<string, unknown> = {
      product: await catalog.product(A, product.id),
      list: await catalog.listProducts(A, { limit: 10 }),
      skus: await catalog.searchSkus(A, { q: 'ELY', limit: 10 }),
      categories: await catalog.listCategories(A),
      attributes: await catalog.listAttributes(A),
      history: await catalog.priceHistory(A, product.skus[0]?.id ?? ''),
      dryRun: await imports.dryRun(A, {
        csv: `sku,price_taka\n${product.skus[0]?.skuCode ?? ''},1590\n`,
      }),
    };

    // Every ordinary role, plus super_admin — which is the strongest form of the
    // claim: the catalog has no cost field for *anybody*, so even the role that
    // holds `read:cost` receives none from here.
    for (const role of [...MEMBERSHIP_ROLES, 'super_admin' as const]) {
      for (const [name, body] of Object.entries(responses)) {
        const serialized = serializeFor(
          {
            roles: [role] as readonly MembershipRole[],
            isSuperAdmin: role === 'super_admin',
          },
          'Catalog',
          body,
        );
        // Throws, naming every field that survived, if anything cost-shaped did.
        expect(() => assertNoCostFields(serialized), `${role} / ${name}`).not.toThrow();
      }
    }
  });

  it("gives a reseller only §6's allow-listed fields, and no selling price", async () => {
    const product = await catalog.createProduct(
      A,
      newProduct({
        name: 'Reseller view',
        slug: uniqueSlug('reseller'),
        pricePoisha: '149000',
        axes: [],
        generateSkus: true,
      }),
    );

    const serialized = serializeFor(
      { roles: ['reseller'], isSuperAdmin: false },
      'Catalog',
      await catalog.product(A, product.id),
    ) as unknown as Record<string, unknown>;

    expect(serialized.name).toBe('Reseller view');
    // `pricePoisha` is the staff selling price and is not on §6's reseller
    // allow-list — a reseller's price is `resellerPricePoisha`, which M21 adds.
    // The allow-list is what makes this true by default rather than by review.
    expect(serialized.slug).toBeUndefined();
    expect(serialized.sequence).toBeUndefined();
    const skus = serialized.skus as Record<string, unknown>[] | undefined;
    expect(skus?.[0]?.pricePoisha).toBeUndefined();
  });
});

describe('the label sheet', () => {
  it('renders one Code 128 symbol per label, with the same string in bars and text', () => {
    const html = renderLabelSheetHtml({
      labels: [
        {
          payload: 'ELY-SHRT-0001-RED-M',
          code: 'ELY-SHRT-0001-RED-M',
          productName: 'Oxford',
          priceTaka: null,
        },
        {
          payload: 'ELY-SHRT-0001-RED-L',
          code: 'ELY-SHRT-0001-RED-L',
          productName: 'Oxford',
          priceTaka: '৳1490.00',
        },
      ],
      fontCss: '',
    });

    expect([...html.matchAll(/<svg /g)]).toHaveLength(2);
    expect(html).toContain('aria-label="ELY-SHRT-0001-RED-M"');
    expect(html).toContain('৳1490.00');
    expect(LABELS_PER_SHEET).toBe(24);
  });

  it('escapes a product name rather than letting it become markup', () => {
    const html = renderLabelSheetHtml({
      labels: [
        {
          payload: 'ELY-0001',
          code: 'ELY-0001',
          productName: '<script>x</script>',
          priceTaka: null,
        },
      ],
      fontCss: '',
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
