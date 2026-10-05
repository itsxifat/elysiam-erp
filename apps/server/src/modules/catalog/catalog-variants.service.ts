import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { axisOrderFromCode, buildSkuCode, productSlug, uniqueSlug } from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { nextInternalBarcodes } from './barcodes.js';
import { CatalogError } from './catalog.errors.js';
import { assertCategoryLive } from './catalog-deletes.service.js';
import * as del from './catalog-deletes.repository.js';
import * as pricing from './catalog-pricing.repository.js';
import * as repo from './catalog.repository.js';
import { CatalogService, type ProductView } from './catalog.service.js';
import * as web from './catalog-web.repository.js';
import type {
  BulkProductsInput,
  DuplicateProductInput,
  ImageColourInput,
  SkuWeightInput,
} from './catalog.schemas.js';

/**
 * M39b's product management (D-636, D-641 to D-645): one price history for every variant, a
 * photo's colour, a variant's weight, duplicating a product, and the product list's bulk
 * changes.
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
   * A copy of a product under a new name and web address (D-641).
   *
   * Copied: the category, description, weight, the website's fields (except "shown on the
   * website", which starts off like any new product's, D-500), the size chart, the photos with
   * their colours and order, and every **active** variant with its price, regular price and
   * weight, coded in the source's segment order under the new product's sequence, each with a
   * new internal barcode. Not copied: stock, costs, orders, price history, old addresses, and
   * archived variants. The copy is a draft, so it is checked before it sells.
   */
  async duplicateProduct(
    context: ActiveContext,
    productId: string,
    input: DuplicateProductInput,
  ): Promise<ProductView> {
    return withOrg(context, async (tx) => {
      const source = await repo.productById(tx, context.orgId, productId);
      if (source === undefined) throw notFound('product');

      const [skus, webRow] = await Promise.all([
        repo.skusOfProduct(tx, context.orgId, productId),
        web.webFieldsOf(tx, context.orgId, productId),
      ]);
      const selling = skus.filter((sku) => sku.status === 'active');
      const values = await repo.valuesOfSkus(
        tx,
        context.orgId,
        selling.map((sku) => sku.id),
      );
      // A size, colour or list archived since (M39a, D-624) goes on no new variant: the copy
      // leaves out the variants that carry one, and refuses when that is every variant.
      const archived = new Set(
        (
          await del.archivedAmong(
            tx,
            context.orgId,
            values.map((value) => value.value_id),
          )
        ).map((value) => value.id),
      );
      const active = selling.filter(
        (sku) => !values.some((value) => value.sku_id === sku.id && archived.has(value.value_id)),
      );
      if (selling.length > 0 && active.length === 0) {
        throw new CatalogError(
          'CATALOG_VARIANT_INVALID',
          `Every variant of ${source.name} has an archived size, colour or list. Restore it in Catalog setup to copy them.`,
        );
      }

      const { sequence, orgCode } = await repo.takeSequence(tx, context.orgId);
      const category =
        source.category_id === null
          ? undefined
          : await repo.categoryById(tx, context.orgId, source.category_id);
      // A copy is a new product, and no new product goes into an archived category (D-623).
      await assertCategoryLive(
        tx,
        context.orgId,
        category,
        'Restore it in Catalog setup, or move this product to another category first.',
      );

      const base = input.slug ?? productSlug(input.name, String(sequence));
      const slug = uniqueSlug(base, await pricing.slugsNear(tx, context.orgId, base));

      const product = await repo.insertProduct(tx, context.orgId, {
        categoryId: source.category_id,
        sequence,
        name: input.name,
        slug,
        description: source.description,
        status: 'draft',
        createdBy: context.userId,
        weightGrams: source.weight_grams ?? null,
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
      await repo.setPriceContext(tx, `Copied from ${source.name}`.slice(0, 200));
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
      await pricing.copyImages(tx, context.orgId, productId, product.id);

      return this.catalog.viewOf(tx, context.orgId, product);
    });
  }

  /**
   * Archive, restore or re-file many products at once (D-642). All or nothing: an id that is
   * not this brand's product refuses the whole change.
   */
  async bulkProducts(context: ActiveContext, input: BulkProductsInput) {
    return withOrg(context, async (tx) => {
      const ids = [...new Set(input.productIds)];
      if (input.categoryId != null) {
        const category = await repo.categoryById(tx, context.orgId, input.categoryId);
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
