import { Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { axisOrderFromCode, buildSkuCode, parentSkuCode, parentSkuSlug } from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { nextInternalBarcodes } from './barcodes.js';
import { CatalogError } from './catalog.errors.js';
import { assertCategoryLive, freeProductSlug } from './catalog-deletes.service.js';
import * as del from './catalog-deletes.repository.js';
import * as pricing from './catalog-pricing.repository.js';
import * as repo from './catalog.repository.js';
import { CatalogService, type ProductView } from './catalog.service.js';
import * as web from './catalog-web.repository.js';
import type {
  BulkDuplicateInput,
  BulkProductsInput,
  DuplicateProductInput,
  ImageColourInput,
  SkuWeightInput,
} from './catalog.schemas.js';

/** One product a duplicate made (D-662, D-663). */
export interface ProductCopy {
  readonly id: string;
  /** The product it was copied from. */
  readonly sourceId: string;
  readonly name: string;
  /** Its parent SKU (D-661): the source's with the next number, `ELY-HAWA-0021`. */
  readonly parentSku: string;
  /** Its web address: the parent SKU in lower case. */
  readonly slug: string;
}

/** A product being copied, read once for all its copies. */
interface CopySource {
  readonly product: repo.ProductRow;
  readonly webRow: Awaited<ReturnType<typeof web.webFieldsOf>>;
  /** Its active variants; archived ones are never copied. */
  readonly selling: readonly repo.SkuRow[];
  readonly values: readonly repo.SkuValueRow[];
}

/** What every copy of one source carries, decided under lock once. */
interface CopyPlan {
  /** The variants copied: the active ones with no archived size, colour or list. */
  readonly active: readonly repo.SkuRow[];
  /** The source's category, locked `for share`; undefined for none. */
  readonly category: del.CategoryImage | undefined;
}

/**
 * M39b's product management (D-636, D-641 to D-645): one price history for every variant, a
 * photo's colour, a variant's weight, duplicating a product (several copies, and many products
 * at once, since D-662 and D-663), and the product list's bulk changes.
 *
 * The catalog's own, like the rest of `CatalogService`, and like it **without cost**
 * (invariant 5): a duplicate copies selling prices and regular prices, never a buying price,
 * and no stock (stock enters only through a receipt, invariant 3).
 */
@Injectable()
export class CatalogVariantsService {
  constructor(private readonly catalog: CatalogService) {}

  /** Every price change of every variant of the product, newest first (D-636). */
  async productPriceHistory(context: ActiveContext, productId: string) {
    return withOrg(context, async (tx) => {
      const product = await repo.productById(tx, context.orgId, productId);
      if (product === undefined) throw notFound('product');
      const rows = await pricing.productPriceHistory(tx, context.orgId, productId, 200);
      const labels = await repo.variantLabels(tx, context.orgId, [
        ...new Set(rows.map((row) => row.sku_id)),
      ]);
      return {
        items: rows.map((row) => ({
          skuId: row.sku_id,
          skuCode: row.sku_code,
          variantLabel: labels.get(row.sku_id) ?? '',
          fromPricePoisha: row.from_poisha,
          toPricePoisha: row.to_poisha,
          compareAtFromPoisha: row.compare_at_from_poisha,
          compareAtToPoisha: row.compare_at_to_poisha,
          changedBy: row.changed_by,
          reason: row.reason,
          changedAt: row.created_at,
        })),
      };
    });
  }

  /** Which colour a photo shows, or every colour (D-643). */
  async setImageColour(
    context: ActiveContext,
    productId: string,
    imageId: string,
    input: ImageColourInput,
  ) {
    return withOrg(context, async (tx) => {
      if (input.colourValueId !== null) {
        await this.catalog.assertColourValue(tx, context.orgId, input.colourValueId);
      }
      const applied = await pricing.setImageColour(
        tx,
        context.orgId,
        productId,
        imageId,
        input.colourValueId,
      );
      if (!applied) throw notFound('image');
      return { id: imageId, colourValueId: input.colourValueId };
    });
  }

  /** A variant's own weight in grams, or null for the product's (D-645). */
  async setSkuWeight(context: ActiveContext, skuId: string, input: SkuWeightInput) {
    return withOrg(context, async (tx) => {
      const row = await pricing.setSkuWeight(tx, context.orgId, skuId, input.weightGrams);
      if (row === undefined) throw notFound('SKU');
      return { id: row.id, skuCode: row.code, weightGrams: input.weightGrams };
    });
  }

  /**
   * Copies of a product (D-641, D-662): `copies` new products in one transaction, numbered
   * one after another (`ELY-HAWA-0021`, `ELY-HAWA-0022`, …), each its own parent SKU and web
   * address (D-661), named `name` or the source's name.
   *
   * Copied: the category, description, weight, the website's fields (except "shown on the
   * website", which starts off like any new product's, D-500), the size chart, the photos with
   * their colours and order, and every **active** variant with its price, regular price and
   * weight, coded in the source's segment order under the new product's sequence, each with a
   * new internal barcode. Not copied: stock, costs, orders, price history, old addresses, and
   * archived variants. A copy is a draft, so it is checked before it sells.
   *
   * Answers the first copy as the product page reads it, and `copies`: every copy made.
   */
  async duplicateProduct(
    context: ActiveContext,
    productId: string,
    input: DuplicateProductInput,
  ): Promise<ProductView & { readonly copies: readonly ProductCopy[] }> {
    return withOrg(context, async (tx) => {
      const source = await this.copySource(tx, context.orgId, productId);
      const made = await this.copiesOf(tx, context, source, input.copies, input.name);
      const first = made[0];
      if (first === undefined) throw notFound('product');
      const view = await this.catalog.viewOf(tx, context.orgId, first.row);
      return { ...view, copies: made.map((copy) => copy.copy) };
    });
  }

  /**
   * Copies of many products from the product list (D-663): `copies` of each, under its own
   * name, the products taken in the order given so their numbers run in that order (two copies
   * of A then two of B: 0021, 0022 for A, 0023, 0024 for B). All or nothing: a product not in
   * this brand, an archived one, one in an archived category or one whose every variant carries
   * an archived size or colour refuses the whole request, and nothing is made.
   */
  async duplicateProducts(
    context: ActiveContext,
    input: BulkDuplicateInput,
  ): Promise<{ readonly products: readonly ProductCopy[] }> {
    return withOrg(context, async (tx) => {
      const products: ProductCopy[] = [];
      // A product ticked twice is copied once, in the place it was first given.
      for (const productId of [...new Set(input.productIds)]) {
        const source = await this.copySource(tx, context.orgId, productId);
        if (source.product.status === 'archived') {
          throw new CatalogError(
            'CATALOG_VARIANT_INVALID',
            `${source.product.name} is archived. Restore it to copy it, or untick it; nothing was copied.`,
          );
        }
        const made = await this.copiesOf(tx, context, source, input.copies, undefined);
        products.push(...made.map((copy) => copy.copy));
      }
      return { products };
    });
  }

  /** What a copy is made from, read once however many copies are made. */
  private async copySource(tx: Tx, orgId: string, productId: string): Promise<CopySource> {
    const product = await repo.productById(tx, orgId, productId);
    if (product === undefined) throw notFound('product');
    const [skus, webRow] = await Promise.all([
      repo.skusOfProduct(tx, orgId, productId),
      web.webFieldsOf(tx, orgId, productId),
    ]);
    const selling = skus.filter((sku) => sku.status === 'active');
    const values = await repo.valuesOfSkus(
      tx,
      orgId,
      selling.map((sku) => sku.id),
    );
    return { product, webRow, selling, values };
  }

  /**
   * `copies` copies of one source, in this transaction. The first takes the brand's SKU
   * counter, which stays locked until the transaction ends, so the copies' numbers are
   * consecutive and no other product in the brand takes one in between.
   */
  private async copiesOf(
    tx: Tx,
    context: ActiveContext,
    source: CopySource,
    copies: number,
    name: string | undefined,
  ): Promise<{ readonly row: repo.ProductRow; readonly copy: ProductCopy }[]> {
    const made: { row: repo.ProductRow; copy: ProductCopy }[] = [];
    let plan: CopyPlan | undefined;
    for (let index = 0; index < copies; index += 1) {
      const { sequence, orgCode } = await repo.takeSequence(tx, context.orgId);
      // Locked after the first sequence, as one copy always was (ledger re-audit N1); the
      // shared locks hold to the end of the transaction, so the later copies reuse the plan.
      plan ??= await this.copyPlan(tx, context.orgId, source);
      const row = await this.insertCopy(tx, context, source, plan, {
        sequence,
        orgCode,
        name: name ?? source.product.name,
      });
      made.push({
        row,
        copy: {
          id: row.id,
          sourceId: source.product.id,
          name: row.name,
          parentSku: parentSkuCode({ orgCode, categoryCode: plan.category?.code, sequence }),
          slug: row.slug,
        },
      });
    }
    return made;
  }

  /**
   * Which variants a copy carries, and the category it goes into, under the locks that keep
   * both true until the copies are written.
   */
  private async copyPlan(tx: Tx, orgId: string, source: CopySource): Promise<CopyPlan> {
    const { product, selling, values } = source;
    // A size, colour or list archived since (M39a, D-624) goes on no new variant: the copy
    // leaves out the variants that carry one, and refuses when that is every variant. Read
    // under a shared lock, after the sequence, so an archive cannot slip in between the
    // check and the insert (ledger re-audit N1).
    const archived = await pricing.lockValuesLive(
      tx,
      orgId,
      values.map((value) => value.value_id),
    );
    const active = selling.filter(
      (sku) => !values.some((value) => value.sku_id === sku.id && archived.has(value.value_id)),
    );
    if (selling.length > 0 && active.length === 0) {
      throw new CatalogError(
        'CATALOG_VARIANT_INVALID',
        `Every variant of ${product.name} has an archived size, colour or list. Restore it in Catalog setup to copy them.`,
      );
    }

    // The category locked `for share`, as an empty-and-delete locks it: an archive or a
    // delete of it either commits first (and is seen) or waits for these copies.
    const category =
      product.category_id === null
        ? undefined
        : await del.lockCategory(tx, orgId, product.category_id, 'share');
    if (product.category_id !== null && category === undefined) throw notFound('category');
    // A copy is a new product, and no new product goes into an archived category (D-623).
    await assertCategoryLive(
      tx,
      orgId,
      category,
      'Restore it in Catalog setup, or move this product to another category first.',
    );
    return { active, category };
  }

  /** One copy: the product row, its website fields, its variants and its photos. */
  private async insertCopy(
    tx: Tx,
    context: ActiveContext,
    source: CopySource,
    plan: CopyPlan,
    copy: { readonly sequence: number; readonly orgCode: string; readonly name: string },
  ): Promise<repo.ProductRow> {
    const { product: from, webRow, values } = source;
    const { active, category } = plan;
    const { sequence, orgCode } = copy;
    const parentSku = parentSkuCode({ orgCode, categoryCode: category?.code, sequence });

    const product = await repo.insertProduct(tx, context.orgId, {
      categoryId: from.category_id,
      sequence,
      name: copy.name,
      // Its own parent SKU in lower case, as every new product's (D-661).
      slug: await freeProductSlug(tx, context.orgId, parentSkuSlug(parentSku), sequence),
      description: from.description,
      status: 'draft',
      createdBy: context.userId,
      weightGrams: from.weight_grams ?? null,
    });

    if (webRow !== undefined) {
      const keep = <T>(value: T) => ({ set: true as const, value });
      await web.setWebFields(tx, context.orgId, product.id, {
        featured: keep(webRow.featured),
        newArrival: keep(webRow.new_arrival),
        gender: keep(webRow.gender),
        material: keep(webRow.material),
        careInstructions: keep(webRow.care_instructions),
        tags: keep(webRow.tags),
        sizeChartId: keep(webRow.size_chart_id),
        seoTitle: keep(webRow.seo_title),
        seoDescription: keep(webRow.seo_description),
      });
    }

    // The copy's first price-history rows say where the prices came from.
    await repo.setPriceContext(tx, `Copied from ${from.name}`.slice(0, 200));
    const barcodes = await nextInternalBarcodes(tx, context.orgId, active.length);
    await repo.insertSkus(
      tx,
      context.orgId,
      active.map((sku, index) => {
        const own = values.filter((value) => value.sku_id === sku.id);
        const order = axisOrderFromCode(
          sku.code,
          own.map((value) => ({ attributeId: value.attribute_id, valueCode: value.value_code })),
        );
        const place = (attributeId: string) => {
          const at = order.indexOf(attributeId);
          return at === -1 ? Number.MAX_SAFE_INTEGER : at;
        };
        const ordered = [...own].sort(
          (a, b) =>
            place(a.attribute_id) - place(b.attribute_id) ||
            a.attribute_position - b.attribute_position ||
            (a.attribute_code < b.attribute_code
              ? -1
              : a.attribute_code > b.attribute_code
                ? 1
                : 0),
        );
        return {
          productId: product.id,
          code: buildSkuCode({
            orgCode,
            categoryCode: category?.code,
            sequence,
            variantCodes: ordered.map((value) => value.value_code),
          }),
          variantKey: sku.variant_key,
          pricePoisha: BigInt(sku.price_poisha),
          compareAtPoisha: sku.compare_at_poisha === null ? null : BigInt(sku.compare_at_poisha),
          weightGrams: sku.weight_grams,
          position: index,
          barcode: barcodes[index] ?? null,
          values: ordered.map((value) => ({
            attributeId: value.attribute_id,
            valueId: value.value_id,
          })),
        };
      }),
    );
    await pricing.copyImages(tx, context.orgId, from.id, product.id);
    return product;
  }

  /**
   * Archive, restore or re-file many products at once (D-642). All or nothing: an id that is
   * not this brand's product refuses the whole change.
   */
  async bulkProducts(context: ActiveContext, input: BulkProductsInput) {
    return withOrg(context, async (tx) => {
      const ids = [...new Set(input.productIds)];
      if (input.categoryId != null) {
        // Locked `for share`, so an archive or delete of the target cannot pass the check.
        const category = await del.lockCategory(tx, context.orgId, input.categoryId, 'share');
        if (category === undefined) throw notFound('category');
        // Moving products into an archived category would take them off the website without
        // anyone deciding that (M39a, D-623), as the one-product edit refuses.
        await assertCategoryLive(tx, context.orgId, category);
      }
      const changed = await pricing.updateProducts(tx, context.orgId, ids, {
        status: input.status,
        changeCategory: input.categoryId !== undefined,
        categoryId: input.categoryId ?? null,
      });
      if (changed.length !== ids.length) {
        throw new CatalogError(
          'CATALOG_NOT_FOUND',
          `${String(ids.length - changed.length)} of those products are not in this brand's catalog. Nothing was changed.`,
        );
      }
      return { updated: changed.length };
    });
  }
}

function notFound(what: string): CatalogError {
  return new CatalogError('CATALOG_NOT_FOUND', `No such ${what} in this brand's catalog.`);
}
