import { Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';

import type { ActiveContext } from '../../platform/http/context.js';
import {
  buildSkuCode,
  matrixPlan,
  poisha,
  variantCombinations,
  variantPrices,
  type Poisha,
  type VariantAxis,
} from '@elysium/domain';

import { assertNotInternal, nextInternalBarcodes } from './barcodes.js';
import { CatalogError } from './catalog.errors.js';
import * as repo from './catalog.repository.js';
import * as web from './catalog-web.repository.js';
import type {
  AttachImageInput,
  CreateAttributeInput,
  CreateAttributeValueInput,
  CreateCategoryInput,
  CreateProductInput,
  ExtendMatrixInput,
  ProductQuery,
  ReorderImagesInput,
  SetBarcodeInput,
  SetPricesInput,
  SkuQuery,
  UpdateAttributeInput,
  UpdateAttributeValueInput,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateSkuInput,
} from './catalog.schemas.js';

/**
 * The catalog (architecture §8, M06).
 *
 * ## What this service is careful about
 *
 * **The matrix is extended, never regenerated** (check 1). `createProduct` and
 * `extendMatrix` both go through `matrixPlan` from @elysium/domain, which takes
 * the keys that already exist and returns only the additions. There is
 * deliberately no method that computes a full matrix and writes it — the SKUs it
 * would replace have M07 stock movements, M10 order lines and printed labels
 * behind them, and `catalog.skus` has no delete path for that reason.
 *
 * **The sequence is taken atomically.** `takeSequence` is one
 * `insert … on conflict do update … returning`. A select-then-update hands two
 * concurrent creations the same number and the loser dies on a unique index.
 *
 * **No cost, anywhere.** Invariant 5. `price_poisha` is the selling price.
 * Nothing in this file reads, writes or returns a purchase cost, and
 * `catalog.no-cost.test.ts` asserts that of every response shape below for every
 * role.
 *
 * **Prices cross the wire as strings.** The driver hands `bigint` back as a
 * decimal string and it stays one all the way out (§23): a crore-scale poisha
 * value through `JSON.parse` is a double that has already lost its last digits,
 * and every screen downstream would look right.
 */

/** A product as the API returns it. */
export interface ProductView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly sequence: number;
  readonly categoryId: string | null;
  readonly description: string | null;
  readonly status: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly skus: readonly SkuView[];
  readonly images: readonly ImageView[];
  /** The website's fields (M33, D-500): shown on the product page's Website card. */
  readonly web: WebFieldsView;
}

export interface WebFieldsView {
  readonly webVisible: boolean;
  readonly featured: boolean;
  readonly newArrival: boolean;
  readonly gender: string | null;
  readonly material: string | null;
  readonly careInstructions: string | null;
  readonly tags: readonly string[];
  readonly sizeChartId: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly previousSlugs: readonly string[];
}

export interface SkuView {
  readonly id: string;
  readonly skuCode: string;
  readonly barcode: string | null;
  /** Integer poisha as a decimal string. The **selling** price. */
  readonly pricePoisha: string;
  readonly status: string;
  readonly attributes: readonly {
    readonly attributeId: string;
    readonly code: string;
    readonly name: string;
    readonly valueId: string;
    readonly valueCode: string;
    readonly valueLabel: string;
  }[];
}

export interface ImageView {
  readonly id: string;
  readonly fileId: string;
  readonly position: number;
  readonly altText: string | null;
}

export interface ProductListItem {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly sequence: number;
  readonly status: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly skuCount: number;
  readonly fromPricePoisha: string | null;
  readonly toPricePoisha: string | null;
  readonly imageFileId: string | null;
}

@Injectable()
export class CatalogService {
  // --- categories -----------------------------------------------------------

  async listCategories(context: ActiveContext) {
    return withOrg(context, async (tx) => {
      const rows = await repo.listCategories(tx, context.orgId);
      return {
        items: rows.map((row) => ({
          id: row.id,
          parentId: row.parent_id,
          name: row.name,
          slug: row.slug,
          code: row.code,
          path: row.path,
          depth: row.depth,
          position: row.position,
          isActive: row.is_active,
          web: {
            webVisible: row.web_visible ?? true,
            featured: row.featured ?? false,
            gender: row.gender ?? null,
            description: row.description ?? null,
            imageFileId: row.image_file_id ?? null,
          },
        })),
      };
    });
  }

  async createCategory(context: ActiveContext, input: CreateCategoryInput) {
    return withOrg(context, async (tx) => {
      // The composite foreign key refuses a parent in another org, and 0026's
      // trigger refuses a cycle and computes the path. Both are the database's
      // job on purpose: a service check here would be the *second* place the rule
      // lives, and the two would eventually disagree.
      const row = await repo.insertCategory(tx, context.orgId, {
        name: input.name,
        slug: input.slug,
        code: input.code,
        parentId: input.parentId ?? null,
        position: input.position ?? 0,
      });
      return { id: row.id, path: row.path, depth: row.depth };
    });
  }

  async updateCategory(context: ActiveContext, id: string, input: UpdateCategoryInput) {
    return withOrg(context, async (tx) => {
      const row = await repo.updateCategory(tx, context.orgId, id, {
        name: input.name,
        slug: input.slug,
        position: input.position,
        isActive: input.isActive,
        // `parentId` present-and-null means "make this a root category"; absent
        // means "leave it". `coalesce` cannot tell those apart, so the flag does.
        changeParent: 'parentId' in input,
        parentId: input.parentId ?? null,
      });
      if (row === undefined) throw notFound('category');
      return { id: row.id, path: row.path, depth: row.depth };
    });
  }

  // --- attributes -----------------------------------------------------------

  async listAttributes(context: ActiveContext) {
    return withOrg(context, async (tx) => {
      const [attributes, values] = await Promise.all([
        repo.listAttributes(tx, context.orgId),
        repo.listAttributeValues(tx, context.orgId),
      ]);
      return {
        items: attributes.map((attribute) => ({
          id: attribute.id,
          code: attribute.code,
          name: attribute.name,
          kind: attribute.kind,
          isVariant: attribute.is_variant,
          position: attribute.position,
          values: values
            .filter((value) => value.attribute_id === attribute.id)
            .map((value) => ({
              id: value.id,
              code: value.code,
              label: value.label,
              position: value.position,
            })),
        })),
      };
    });
  }

  async createAttribute(context: ActiveContext, input: CreateAttributeInput) {
    return withOrg(context, async (tx) => {
      const row = await repo.insertAttribute(tx, context.orgId, {
        code: input.code,
        name: input.name,
        kind: input.kind,
        isVariant: input.isVariant,
        position: input.position ?? 0,
      });
      return { id: row.id, code: row.code };
    });
  }

  async createAttributeValue(
    context: ActiveContext,
    attributeId: string,
    input: CreateAttributeValueInput,
  ) {
    return withOrg(context, async (tx) => {
      if (!(await repo.attributeExists(tx, context.orgId, attributeId))) {
        throw notFound('attribute');
      }
      const row = await repo.insertAttributeValue(tx, context.orgId, attributeId, {
        code: input.code,
        label: input.label,
        position: input.position ?? 0,
      });
      return { id: row.id, code: row.code };
    });
  }

  /** Rename an attribute or move it (D-424). The code never changes. */
  async updateAttribute(context: ActiveContext, id: string, input: UpdateAttributeInput) {
    return withOrg(context, async (tx) => {
      const row = await repo.updateAttribute(tx, context.orgId, id, input);
      if (row === undefined) throw notFound('attribute');
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        kind: row.kind,
        isVariant: row.is_variant,
        position: row.position,
      };
    });
  }

  /** Fix a value's label or move it (D-424). The code is inside every SKU code built from it. */
  async updateAttributeValue(
    context: ActiveContext,
    attributeId: string,
    valueId: string,
    input: UpdateAttributeValueInput,
  ) {
    return withOrg(context, async (tx) => {
      const row = await repo.updateAttributeValue(tx, context.orgId, attributeId, valueId, input);
      if (row === undefined) throw notFound('attribute value');
      return { id: row.id, code: row.code, label: row.label, position: row.position };
    });
  }

  // --- products -------------------------------------------------------------

  /**
   * Create a product and, unless told not to, its whole variant matrix.
   *
   * `generateSkus: false` produces a product with no SKUs. That is a draft, and
   * it is allowed deliberately (D-121): the console's create flow lets somebody
   * name a product and pick its category before deciding what colours it comes
   * in, and forcing a SKU at that moment means either a placeholder SKU nobody
   * wanted or a wizard that cannot save halfway.
   */
  async createProduct(context: ActiveContext, input: CreateProductInput): Promise<ProductView> {
    return withOrg(context, (tx) => this.createProductIn(tx, context, input));
  }

  /**
   * The one path that creates a product, inside the caller's transaction.
   *
   * The new-product form and the spreadsheet importer (D-425) both come through here,
   * so an imported product gets its sequence, its SKU codes and its variant prices
   * exactly as a typed one does — and a file of forty products is one transaction.
   */
  async createProductIn(
    tx: Tx,
    context: ActiveContext,
    input: CreateProductInput,
  ): Promise<ProductView> {
    const price = poisha(input.pricePoisha);
    const { sequence, orgCode } = await repo.takeSequence(tx, context.orgId);

    const categoryCode =
      input.categoryId == null
        ? undefined
        : (await repo.categoryById(tx, context.orgId, input.categoryId))?.code;
    if (input.categoryId != null && categoryCode === undefined) throw notFound('category');

    const product = await repo.insertProduct(tx, context.orgId, {
      categoryId: input.categoryId ?? null,
      sequence,
      name: input.name,
      slug: input.slug,
      description: input.description ?? null,
      status: input.status,
      createdBy: context.userId,
    });

    const overrides = input.variantPrices ?? [];
    if (!input.generateSkus && overrides.length > 0) {
      throw new CatalogError(
        'CATALOG_VARIANT_INVALID',
        'Variant prices need variants: send the sizes and colours with them.',
      );
    }

    if (input.generateSkus) {
      const axes = await this.resolveAxes(tx, context.orgId, input.axes);
      // D-422: a typed price for some variants, the product price for the rest. A
      // price naming a combination these axes do not make is refused, not dropped.
      const prices =
        overrides.length === 0
          ? undefined
          : variantPrices(
              variantCombinations(axes),
              price,
              overrides.map((entry) => ({
                valueIds: entry.valueIds,
                pricePoisha: poisha(entry.pricePoisha),
              })),
            );
      await this.addVariants(tx, context.orgId, {
        productId: product.id,
        orgCode,
        categoryCode,
        sequence,
        axes,
        existingKeys: [],
        price,
        prices,
        startPosition: 0,
      });
    }

    return this.viewOf(tx, context.orgId, product);
  }

  async updateProduct(context: ActiveContext, id: string, input: UpdateProductInput) {
    return withOrg(context, async (tx) => {
      const row = await repo.updateProduct(tx, context.orgId, id, {
        name: input.name,
        slug: input.slug,
        status: input.status,
        changeCategory: 'categoryId' in input,
        categoryId: input.categoryId ?? null,
        changeDescription: 'description' in input,
        description: input.description ?? null,
      });
      if (row === undefined) throw notFound('product');
      return this.viewOf(tx, context.orgId, row);
    });
  }

  async product(context: ActiveContext, id: string): Promise<ProductView> {
    return withOrg(context, async (tx) => {
      const row = await repo.productById(tx, context.orgId, id);
      if (row === undefined) throw notFound('product');
      return this.viewOf(tx, context.orgId, row);
    });
  }

  /**
   * Add the SKUs a wider matrix implies, and only those (check 1).
   *
   * Adding XXXL to a product that already has 3 colours × 5 sizes creates three
   * SKUs. It does not touch the fifteen that exist — they have stock and history
   * behind them — and it does not remove a SKU whose value was dropped from the
   * axes: `matrixPlan` reports those as orphaned and they are returned for a human
   * to archive.
   */
  async extendMatrix(context: ActiveContext, productId: string, input: ExtendMatrixInput) {
    return withOrg(context, async (tx) => {
      const product = await repo.productById(tx, context.orgId, productId);
      if (product === undefined) throw notFound('product');

      const existing = await repo.skusOfProduct(tx, context.orgId, productId);
      const axes = await this.resolveAxes(tx, context.orgId, input.axes);

      const price =
        input.pricePoisha !== undefined
          ? poisha(input.pricePoisha)
          : (cheapest(existing) ??
            (() => {
              throw new CatalogError(
                'CATALOG_PRICE_INVALID',
                'This product has no SKU to take a price from. Send a price with the new variants.',
              );
            })());

      const categoryCode =
        product.category_id === null
          ? undefined
          : (await repo.categoryById(tx, context.orgId, product.category_id))?.code;

      const plan = await this.addVariants(tx, context.orgId, {
        productId,
        orgCode: (await repo.skuSettings(tx, context.orgId))?.orgCode ?? 'ORG',
        categoryCode,
        sequence: product.sequence,
        axes,
        existingKeys: existing.map((sku) => sku.variant_key),
        price,
        startPosition: existing.length,
      });

      return {
        created: plan.created,
        unchanged: plan.unchanged,
        /** Variants that exist but are no longer in the axes. Reported, never removed. */
        orphaned: plan.orphaned,
        product: await this.viewOf(tx, context.orgId, product),
      };
    });
  }

  async listProducts(context: ActiveContext, query: ProductQuery) {
    return withOrg(context, async (tx) => {
      const rows = await repo.searchProducts(tx, context.orgId, {
        q: query.q,
        categoryId: query.categoryId,
        status: query.status,
        // One extra row, so "is there another page" is answered without a count.
        limit: query.limit + 1,
        afterSequence: decodeCursor(query.cursor),
      });

      const page = rows.slice(0, query.limit);
      const items: ProductListItem[] = page.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        sequence: row.sequence,
        status: row.status,
        categoryId: row.category_id,
        categoryName: row.category_name,
        skuCount: row.sku_count,
        fromPricePoisha: row.min_price_poisha,
        toPricePoisha: row.max_price_poisha,
        imageFileId: row.image_file_id,
      }));

      const last = page.at(-1);
      return {
        items,
        nextCursor:
          rows.length > query.limit && last !== undefined ? encodeCursor(last.sequence) : null,
      };
    });
  }

  async searchSkus(context: ActiveContext, query: SkuQuery) {
    return withOrg(context, async (tx) => {
      const rows = await repo.searchSkus(tx, context.orgId, query);
      return {
        items: rows.map((row) => ({
          id: row.id,
          skuId: row.id,
          productId: row.product_id,
          name: row.product_name,
          skuCode: row.code,
          barcode: row.barcode,
          pricePoisha: row.price_poisha,
          status: row.status,
        })),
      };
    });
  }

  // --- prices ---------------------------------------------------------------

  /**
   * Reprice up to 500 SKUs in one transaction.
   *
   * All or nothing, because a bulk reprice that half-applied is unrecoverable
   * without knowing the prices from before — which is exactly what it destroyed.
   * The history rows come from 0026's trigger, and `reason` reaches it through a
   * transaction-local setting rather than through a column on `skus`.
   */
  async setPrices(context: ActiveContext, input: SetPricesInput) {
    return withOrg(context, async (tx) => {
      await repo.setPriceContext(tx, input.reason ?? null);

      const missing: string[] = [];
      for (const entry of input.prices) {
        const applied = await repo.setSkuPrice(
          tx,
          context.orgId,
          entry.skuId,
          poisha(entry.pricePoisha),
        );
        if (!applied) missing.push(entry.skuId);
      }
      if (missing.length > 0) {
        // Thrown inside the transaction, so nothing is applied. A partial answer
        // ("12 of 14 repriced") would leave the operator repairing by hand.
        throw new CatalogError(
          'CATALOG_NOT_FOUND',
          `${String(missing.length)} of those SKUs are not in this brand's catalog. Nothing was repriced.`,
        );
      }
      return { repriced: input.prices.length };
    });
  }

  async priceHistory(context: ActiveContext, skuId: string) {
    return withOrg(context, async (tx) => {
      const rows = await repo.priceHistory(tx, context.orgId, skuId, 50);
      return {
        items: rows.map((row) => ({
          fromPricePoisha: row.from_poisha,
          toPricePoisha: row.to_poisha,
          changedBy: row.changed_by,
          reason: row.reason,
          changedAt: row.created_at,
        })),
      };
    });
  }

  async setBarcode(context: ActiveContext, skuId: string, input: SetBarcodeInput) {
    return withOrg(context, async (tx) => {
      const [current] = await repo.skusByIds(tx, context.orgId, [skuId]);
      if (current === undefined) throw notFound('SKU');
      // A supplier's barcode may replace the ERP's; a number in the ERP's own range may not
      // be typed in (D-603), or it could equal one the counter hands out later.
      assertNotInternal(input.barcode, current.barcode);
      const applied = await repo.setSkuBarcode(tx, context.orgId, skuId, input.barcode);
      if (!applied) throw notFound('SKU');
      return { id: skuId, barcode: input.barcode };
    });
  }

  /**
   * Archive a SKU or bring it back (D-423).
   *
   * Nothing else about the SKU changes: its stock stays where it is and can still be
   * transferred, counted or written off, and its history stays joined to it. Archived
   * only means it cannot be sold — the order desk and the till already refuse one.
   */
  async updateSku(context: ActiveContext, skuId: string, input: UpdateSkuInput) {
    return withOrg(context, async (tx) => {
      const row = await repo.setSkuStatus(tx, context.orgId, skuId, input.status);
      if (row === undefined) throw notFound('SKU');
      return { id: row.id, skuCode: row.code, status: row.status };
    });
  }

  // --- images ---------------------------------------------------------------

  async attachImage(context: ActiveContext, productId: string, input: AttachImageInput) {
    return withOrg(context, async (tx) => {
      const product = await repo.productById(tx, context.orgId, productId);
      if (product === undefined) throw notFound('product');

      const row = await repo.attachImage(
        tx,
        context.orgId,
        productId,
        input.fileId,
        input.altText ?? null,
      );
      if (row === undefined) {
        // The insert's own WHERE decided this: the file is missing, still
        // `pending`, private, or was uploaded for some other purpose. One answer
        // for all four, because distinguishing them tells a caller which file ids
        // exist in this org.
        throw new CatalogError(
          'CATALOG_NOT_FOUND',
          'That file cannot be used as a product image. It must be a finished public upload made for product images.',
        );
      }
      return { id: row.id, fileId: row.file_id, position: row.position };
    });
  }

  async detachImage(context: ActiveContext, productId: string, imageId: string) {
    return withOrg(context, async (tx) => {
      if (!(await repo.detachImage(tx, context.orgId, productId, imageId))) {
        throw notFound('image');
      }
      return { id: imageId };
    });
  }

  async reorderImages(context: ActiveContext, productId: string, input: ReorderImagesInput) {
    return withOrg(context, async (tx) => {
      const current = await repo.imagesOfProduct(tx, context.orgId, productId);
      const wanted = new Set(input.imageIds);
      if (wanted.size !== input.imageIds.length || wanted.size !== current.length) {
        // A partial list would renumber some images and leave the rest at their
        // old positions, producing an order the caller did not ask for and cannot
        // predict. Refused rather than "helpfully" applied.
        throw new CatalogError(
          'CATALOG_VARIANT_INVALID',
          'Send every image of this product exactly once, in the order they should appear.',
        );
      }
      const applied = await repo.reorderImages(tx, context.orgId, productId, input.imageIds);
      if (applied !== current.length) throw notFound('image');
      return { ordered: applied };
    });
  }

  // --- internals ------------------------------------------------------------

  /**
   * Turn `{attributeId, valueIds}` from the request into domain axes.
   *
   * Every id is looked up rather than trusted: the composite foreign keys would
   * refuse a value from another org anyway, but they would refuse it with a
   * constraint violation halfway through a fifteen-row insert, and the caller
   * deserves to be told which attribute they got wrong.
   */
  private async resolveAxes(
    tx: Tx,
    orgId: string,
    axes: readonly { readonly attributeId: string; readonly valueIds: readonly string[] }[],
  ): Promise<VariantAxis[]> {
    if (axes.length === 0) return [];

    const attributeIds = axes.map((axis) => axis.attributeId);
    const [attributes, values] = await Promise.all([
      repo.listAttributes(tx, orgId),
      repo.listAttributeValues(tx, orgId, attributeIds),
    ]);

    const byId = new Map(attributes.map((attribute) => [attribute.id, attribute]));
    const valuesById = new Map(values.map((value) => [value.id, value]));

    return axes.map((axis, index) => {
      const attribute = byId.get(axis.attributeId);
      if (attribute === undefined) {
        throw new CatalogError(
          'CATALOG_NOT_FOUND',
          'One of those attributes is not in this brand.',
        );
      }
      if (!attribute.is_variant) {
        throw new CatalogError(
          'CATALOG_VARIANT_INVALID',
          `"${attribute.name}" is not a variant attribute, so it cannot be an axis of the matrix.`,
        );
      }

      return {
        attributeId: axis.attributeId,
        // The request's order is the matrix order, and the matrix order is the
        // order of the segments in every SKU code it produces. Using the
        // attribute's own `position` instead would make the same request produce
        // different codes after somebody reordered the attribute list.
        position: index,
        values: axis.valueIds.map((valueId) => {
          const value = valuesById.get(valueId);
          // The second half of the test is not redundant: a value id that exists
          // but belongs to another attribute would otherwise be accepted and
          // produce a SKU whose variant key claims an axis it is not on.
          if (value?.attribute_id !== axis.attributeId) {
            throw new CatalogError(
              'CATALOG_VARIANT_INVALID',
              `One of the values chosen for "${attribute.name}" does not belong to it.`,
            );
          }
          return { valueId, code: value.code };
        }),
      };
    });
  }

  /** Plan the additions and insert exactly those. The only path that writes SKUs. */
  private async addVariants(
    tx: Tx,
    orgId: string,
    input: {
      readonly productId: string;
      readonly orgCode: string;
      readonly categoryCode: string | undefined;
      readonly sequence: number;
      readonly axes: readonly VariantAxis[];
      readonly existingKeys: readonly string[];
      readonly price: Poisha;
      /** Per-variant prices by variant key (D-422); a variant not in it takes `price`. */
      readonly prices?: ReadonlyMap<string, Poisha> | undefined;
      readonly startPosition: number;
    },
  ): Promise<{ created: string[]; unchanged: number; orphaned: string[] }> {
    const plan =
      input.axes.length === 0
        ? // No axes means one unvaried SKU, whose key is the empty string. Going
          // through `matrixPlan` here too would mean a second code path for the
          // simplest product, which is the one most likely to be wrong.
          {
            additions: input.existingKeys.includes('')
              ? []
              : [{ key: '', pairs: [], codes: [] as string[] }],
            unchanged: input.existingKeys.includes('') ? [''] : [],
            orphaned: input.existingKeys.filter((key) => key !== ''),
          }
        : matrixPlan(input.axes, input.existingKeys);

    // One internal EAN-13 per new SKU (D-603), taken before the insert so the SKU is born
    // with its barcode and no row ever exists without one.
    const barcodes = await nextInternalBarcodes(tx, orgId, plan.additions.length);
    const created = await repo.insertSkus(
      tx,
      orgId,
      plan.additions.map((combination, index) => ({
        productId: input.productId,
        barcode: barcodes[index] ?? null,
        code: buildSkuCode({
          orgCode: input.orgCode,
          categoryCode: input.categoryCode,
          sequence: input.sequence,
          variantCodes: combination.codes,
        }),
        variantKey: combination.key,
        pricePoisha: input.prices?.get(combination.key) ?? input.price,
        position: input.startPosition + index,
        values: combination.pairs,
      })),
    );

    return {
      created: created.map((sku) => sku.code),
      unchanged: plan.unchanged.length,
      orphaned: [...plan.orphaned],
    };
  }

  private async viewOf(tx: Tx, orgId: string, product: repo.ProductRow): Promise<ProductView> {
    const [skus, images, webRow] = await Promise.all([
      repo.skusOfProduct(tx, orgId, product.id),
      repo.imagesOfProduct(tx, orgId, product.id),
      web.webFieldsOf(tx, orgId, product.id),
    ]);
    const values = await repo.valuesOfSkus(
      tx,
      orgId,
      skus.map((sku) => sku.id),
    );

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      sequence: product.sequence,
      categoryId: product.category_id,
      description: product.description,
      status: product.status,
      createdAt: product.created_at,
      updatedAt: product.updated_at,
      skus: skus.map((sku) => ({
        id: sku.id,
        skuCode: sku.code,
        barcode: sku.barcode,
        pricePoisha: sku.price_poisha,
        status: sku.status,
        attributes: values
          .filter((value) => value.sku_id === sku.id)
          .map((value) => ({
            attributeId: value.attribute_id,
            code: value.attribute_code,
            name: value.attribute_name,
            valueId: value.value_id,
            valueCode: value.value_code,
            valueLabel: value.value_label,
          })),
      })),
      images: images.map((image) => ({
        id: image.id,
        fileId: image.file_id,
        position: image.position,
        altText: image.alt_text,
      })),
      web: {
        webVisible: webRow?.web_visible ?? false,
        featured: webRow?.featured ?? false,
        newArrival: webRow?.new_arrival ?? false,
        gender: webRow?.gender ?? null,
        material: webRow?.material ?? null,
        careInstructions: webRow?.care_instructions ?? null,
        tags: webRow?.tags ?? [],
        sizeChartId: webRow?.size_chart_id ?? null,
        seoTitle: webRow?.seo_title ?? null,
        seoDescription: webRow?.seo_description ?? null,
        previousSlugs: webRow?.previous_slugs ?? [],
      },
    };
  }
}

function notFound(what: string): CatalogError {
  return new CatalogError('CATALOG_NOT_FOUND', `No such ${what} in this brand's catalog.`);
}

function cheapest(skus: readonly repo.SkuRow[]): Poisha | undefined {
  const prices = skus.map((sku) => poisha(sku.price_poisha));
  if (prices.length === 0) return undefined;
  return prices.reduce((lowest, price) => (price < lowest ? price : lowest));
}

/**
 * The keyset cursor: a sequence number, base64url'd.
 *
 * Encoded rather than sent raw so a client cannot reasonably hand-edit it into a
 * different query, and decoded defensively — a malformed cursor starts from the
 * beginning rather than erroring, because a stale bookmark is not a fault worth
 * showing anybody.
 */
function encodeCursor(sequence: number): string {
  return Buffer.from(`seq:${String(sequence)}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^seq:(\d{1,9})$/.exec(decoded);
  return match === null ? undefined : Number(match[1]);
}
