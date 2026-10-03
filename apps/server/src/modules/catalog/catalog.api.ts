import type { RequestContext, Tx } from '@elysium/db';
import { poisha, variantKey } from '@elysium/domain';
import { importSlug, type ImportProduct, type SkusRefs } from '@elysium/domain/migration';

import * as repo from './catalog.repository.js';

/**
 * What other modules may ask the catalog (invariant 12).
 *
 * Modules talk through `*.api.ts` interfaces or events, never through each other's
 * tables. M07 needs to know a SKU exists before it moves stock; M10 needs the
 * selling price when it prices an order line; M23's POS needs to resolve a scanned
 * barcode. Each of those is a question, and each one is answered here rather than
 * by a join into `catalog.skus` from somebody else's repository.
 *
 * **The interface has no cost in it and cannot grow one.** Invariant 5: a caller
 * that wants a unit cost is asking inventory or supply, not the catalog. That is
 * the boundary this file is drawn to protect — a `CatalogApi.costOf(sku)` would be
 * the single change that made invariant 5 unenforceable, because every module
 * would then have a legitimate-looking way to read cost through the catalog.
 */

/** One SKU, as another module sees it. */
export interface CatalogSku {
  readonly id: string;
  readonly productId: string;
  readonly code: string;
  readonly productName: string;
  /**
   * The product's category, or null when it has none.
   *
   * Here so a caller that scopes by category — a promo code limited to Sarees (M16) —
   * can do it without reading `catalog.products` itself, which is what invariant 12
   * forbids and `module-boundaries.test.ts` fails the build over.
   */
  readonly categoryId: string | null;
  /** The **selling** price, in integer poisha. */
  readonly pricePoisha: bigint;
  readonly status: 'active' | 'archived';
}

export interface CatalogApi {
  /**
   * Resolve SKU ids inside an existing transaction.
   *
   * Takes the `tx` rather than opening its own, so a caller posting a journal and
   * pricing its lines does both in one transaction — and so a SKU cannot be
   * archived between the price this returns and the row that used it.
   */
  skusByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<CatalogSku[]>;

  /** Resolve a scanned code or barcode to one SKU, or nothing (M23's POS). */
  skuByCode(tx: Tx, orgId: string, code: string): Promise<CatalogSku | undefined>;

  /**
   * Active SKUs of active products, ordered by code, after `afterCode` (exclusive).
   *
   * The till's offline price list (M23, §14): a showroom scans with no connection,
   * so the PWA keeps every sellable SKU and refreshes it when it is online. Keyset
   * paged, because a brand's catalog is thousands of rows and an offset page shifts
   * under a concurrent edit.
   */
  sellableSkus(
    tx: Tx,
    orgId: string,
    page: { readonly afterCode: string | null; readonly limit: number },
  ): Promise<SellableSku[]>;

  /**
   * Each SKU's category name and size label, for the buyer profile's favourites (M16).
   *
   * The size is the label of the SKU's value for an attribute of kind `size`, as the
   * catalog defines it, not a guess from the code. A SKU with no size, or a product with no
   * category, comes back with null there; an unknown id is simply absent.
   */
  skuFacets(tx: Tx, orgId: string, ids: readonly string[]): Promise<SkuFacets[]>;

  /** SKU ids by code, any status (M14a's opening stock). An unknown code is absent. */
  skusByCodes(tx: Tx, orgId: string, codes: readonly string[]): Promise<Map<string, string>>;

  /**
   * What M14a's SKU importer checks a file against: the codes, barcodes and product names
   * already in use, the categories by code, and the size and colour attributes with their
   * values by code and by label. Read inside the caller's transaction, so the commit is
   * checked against the catalog it writes into.
   */
  importRefs(tx: Tx, orgId: string): Promise<SkusRefs>;

  /**
   * Create a brand's opening catalog (M14a, D-219), inside the caller's transaction.
   *
   * Every product is `active` and keeps the SKU codes the file named, because they are
   * printed on labels already on the shelves. Products, SKUs, their variant values and
   * their barcodes go in together or, with the caller's transaction, not at all. The
   * review in `@elysium/domain/migration` has already refused anything this would
   * otherwise have to refuse; the database's unique indexes are the backstop.
   */
  importProducts(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    products: readonly ImportProduct[],
  ): Promise<{ readonly products: number; readonly skus: number }>;

  /**
   * Each SKU's size, colour and other values as one label (`M / Red`), for the stock
   * screens (D-427). A SKU with no values is absent from the map.
   */
  variantLabels(tx: Tx, orgId: string, skuIds: readonly string[]): Promise<Map<string, string>>;

  /** A category's id and every id below it; empty when the brand has no such category. */
  categorySubtree(tx: Tx, orgId: string, categoryId: string): Promise<string[]>;
}

export interface SkuFacets {
  readonly skuId: string;
  readonly categoryName: string | null;
  readonly sizeLabel: string | null;
}

/** One row of the till's price list. Selling price only: no field a cost could use. */
export interface SellableSku {
  readonly id: string;
  readonly code: string;
  readonly barcode: string | null;
  readonly productName: string;
  readonly pricePoisha: bigint;
}

export const CATALOG_API = Symbol('CatalogApi');

/** The implementation. Registered under `CATALOG_API` by `CatalogModule`. */
export class CatalogApiService implements CatalogApi {
  async skusByIds(tx: Tx, orgId: string, ids: readonly string[]): Promise<CatalogSku[]> {
    const rows = await repo.skusByIds(tx, orgId, ids);
    return rows.map(toSku);
  }

  async skuByCode(tx: Tx, orgId: string, code: string): Promise<CatalogSku | undefined> {
    const rows = await repo.searchSkus(tx, orgId, { code, limit: 2 });
    // Two rows means a barcode collides with a code. The unique indexes make that
    // impossible within either column, so returning nothing rather than guessing
    // is the honest answer if it ever happens.
    return rows.length === 1 && rows[0] !== undefined ? toSku(rows[0]) : undefined;
  }

  async sellableSkus(
    tx: Tx,
    orgId: string,
    page: { readonly afterCode: string | null; readonly limit: number },
  ): Promise<SellableSku[]> {
    const rows = await repo.sellableSkus(tx, orgId, page);
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      barcode: row.barcode,
      productName: row.product_name,
      pricePoisha: BigInt(row.price_poisha),
    }));
  }

  async skuFacets(tx: Tx, orgId: string, ids: readonly string[]): Promise<SkuFacets[]> {
    const rows = await repo.skuFacets(tx, orgId, ids);
    return rows.map((row) => ({
      skuId: row.sku_id,
      categoryName: row.category_name,
      sizeLabel: row.size_label,
    }));
  }

  async skusByCodes(tx: Tx, orgId: string, codes: readonly string[]): Promise<Map<string, string>> {
    const rows = await repo.skusByCodes(tx, orgId, [...new Set(codes)]);
    return new Map(rows.map((row) => [row.code, row.id]));
  }

  async importRefs(tx: Tx, orgId: string): Promise<SkusRefs> {
    const [skus, products, categories, attributes] = await Promise.all([
      repo.allSkuCodesAndBarcodes(tx, orgId),
      repo.productNamesAndSlugs(tx, orgId),
      repo.listCategories(tx, orgId),
      repo.listAttributes(tx, orgId),
    ]);
    const axis = (kind: 'size' | 'colour') =>
      attributes.find((attribute) => attribute.kind === kind && attribute.is_variant);
    const size = axis('size');
    const colour = axis('colour');
    const values = await repo.listAttributeValues(
      tx,
      orgId,
      [size?.id, colour?.id].filter((id): id is string => id !== undefined),
    );
    const valuesOf = (attributeId: string | undefined) => {
      if (attributeId === undefined) return null;
      const byText = new Map<string, string>();
      for (const value of values.filter((row) => row.attribute_id === attributeId)) {
        byText.set(value.code.toLowerCase(), value.id);
        byText.set(value.label.toLowerCase(), value.id);
      }
      return { attributeId, values: byText };
    };

    return {
      existingCodes: new Set(skus.map((row) => row.code)),
      existingBarcodes: new Set(
        skus.map((row) => row.barcode).filter((code): code is string => code !== null),
      ),
      existingProductNames: new Set(products.map((row) => row.name)),
      categories: new Map(categories.map((row) => [row.code.toLowerCase(), row.id])),
      size: valuesOf(size?.id),
      colour: valuesOf(colour?.id),
    };
  }

  async importProducts(
    tx: Tx,
    actor: { readonly orgId: string; readonly userId: string },
    products: readonly ImportProduct[],
  ): Promise<{ readonly products: number; readonly skus: number }> {
    const slugs = new Set(
      (await repo.productNamesAndSlugs(tx, actor.orgId)).map((row) => row.slug),
    );
    let skuCount = 0;

    for (const product of products) {
      const { sequence } = await repo.takeSequence(tx, actor.orgId);
      const slug = importSlug(product.name, sequence, slugs);
      slugs.add(slug);

      const row = await repo.insertProduct(tx, actor.orgId, {
        categoryId: product.categoryId,
        sequence,
        name: product.name,
        slug,
        description: null,
        status: 'active',
        createdBy: actor.userId,
      });

      const created = await repo.insertSkus(
        tx,
        actor.orgId,
        product.skus.map((sku, index) => {
          const pairs = sku.valueIds.map((valueId, axis) => ({
            attributeId: product.axisAttributeIds[axis] ?? '',
            valueId,
          }));
          return {
            productId: row.id,
            code: sku.code,
            variantKey: variantKey(pairs),
            pricePoisha: poisha(sku.pricePoisha),
            position: index,
            values: pairs,
          };
        }),
      );

      const idByCode = new Map(created.map((sku) => [sku.code, sku.id]));
      for (const sku of product.skus) {
        const id = idByCode.get(sku.code);
        if (sku.barcode !== null && id !== undefined) {
          await repo.setSkuBarcode(tx, actor.orgId, id, sku.barcode);
        }
      }
      skuCount += created.length;
    }

    return { products: products.length, skus: skuCount };
  }

  async variantLabels(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, string>> {
    return repo.variantLabels(tx, orgId, skuIds);
  }

  async categorySubtree(tx: Tx, orgId: string, categoryId: string): Promise<string[]> {
    return repo.categorySubtree(tx, orgId, categoryId);
  }
}

function toSku(
  row: repo.SkuRow & { product_name: string; category_id: string | null },
): CatalogSku {
  return {
    id: row.id,
    productId: row.product_id,
    code: row.code,
    categoryId: row.category_id,
    productName: row.product_name,
    // The driver hands `bigint` back as a decimal string; callers inside the server
    // want a bigint, and §23's string is the *wire* format, not the internal one.
    pricePoisha: BigInt(row.price_poisha),
    status: row.status === 'archived' ? 'archived' : 'active',
  };
}

/** For the rare caller that has a `RequestContext` but no transaction. */
export type CatalogContext = RequestContext;
