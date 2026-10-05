import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  availableForWeb,
  decodeNcomCursor,
  encodeNcomCursor,
  isMeaningfulSize,
  mergeNcomLines,
  NCOM_CONTRACT,
  NCOM_PRICE_CURRENCY,
  ncomIdsFrom,
  ncomPrice,
  searchTokens,
} from '@elysium/domain/storefront';
import { poisha } from '@elysium/domain';

import {
  CATALOG_API,
  type CatalogApi,
  type MarketplaceProduct,
  type WebSku,
} from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { STOREFRONT_API, type StorefrontApi } from '../storefront/storefront.api.js';
import type { ConnectorContext } from './ncom-auth.service.js';
import * as repo from './marketplace.repository.js';
import { connectorError, NcomRefusal } from './ncom.http.js';

/** Contract 1's ceilings, held on this side too. */
export const MAX_PRODUCT_IDS = 250;
export const MAX_STOCK_IDS = 1000;
export const MAX_PAGE_LIMIT = 100;
export const MAX_RESERVE_LINES = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_REF = /^[!-~]{1,128}$/;

/** The actor a marketplace hold is taken by. */
export const NCOM_ACTOR = 'marketplace:ncom';

interface Resolution {
  /** ERP id → the id ncom knows it by (the old site's, when one is recorded). */
  readonly outward: (kind: 'product' | 'variant' | 'category', erpId: string) => string;
}

/**
 * The connector ncom reads the brand's catalogue through (M35b, D-553), contract 1, as the old
 * site's `lib/ncom-connector.js` served it: products (by page, by ids, by id or handle), the
 * categories, live stock, and holds.
 *
 * - **Ids.** A product, a variant or a category is named by the old site's id when M36's map
 *   holds one (`storefront.legacy_ids`), so an offer ncom saved against the old site keeps
 *   resolving; otherwise by its ERP id (a variant is a SKU). Both are accepted on the way in.
 * - **What is sold.** An active product with an active size, shown on the website, is
 *   `active`; one not yet shown is a `draft` — listed only when the brand allows drafts, and
 *   never sellable (its stock reads zero). Prices are the catalog's selling prices; stock is
 *   what the website's locations can sell (`availableForWeb`), never a cost (invariant 5).
 * - **Holds.** `reserve` holds every line at one web location through the inventory
 *   reservation, keyed by ncom's order reference, all or nothing; a retry with the same
 *   reference is answered from the hold; `release` gives back exactly what the hold took,
 *   once.
 */
@Injectable()
export class NcomConnectorService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(STOREFRONT_API) private readonly storefront: StorefrontApi,
  ) {}

  ping(context: ConnectorContext) {
    this.assertServing(context);
    return {
      ok: true,
      contract: NCOM_CONTRACT,
      platform: 'erp/1',
      currency: NCOM_PRICE_CURRENCY,
      capabilities: context.capabilities,
    };
  }

  async products(
    context: ConnectorContext,
    query: {
      readonly ids: readonly string[];
      readonly limit: string | undefined;
      readonly cursor: string | undefined;
      readonly status: string | undefined;
      readonly category: string | undefined;
      readonly q: string | undefined;
    },
  ) {
    this.assertServing(context);
    const { orgId, settings } = context;
    return withOrg({ orgId }, async (tx) => {
      const requested = ncomIdsFrom(query.ids, MAX_PRODUCT_IDS);
      if (requested.length > 0) {
        // ncom re-reading the products a saved offer names: answered in the order asked.
        const resolved = await this.resolveProducts(tx, orgId, requested);
        const ids = [...new Set([...resolved.values()])];
        const rows = await this.catalog.marketplaceProducts(
          tx,
          orgId,
          {
            ids,
            kinds: settings.include_drafts ? ['active', 'draft'] : ['active'],
            categoryIds: null,
            search: [],
            afterId: null,
          },
          ids.length,
        );
        const byId = new Map(rows.map((row) => [row.id, row]));
        const ordered = requested.flatMap((asked) => {
          const erp = resolved.get(asked);
          const row = erp === undefined ? undefined : byId.get(erp);
          return row === undefined ? [] : [row];
        });
        const unique = [...new Map(ordered.map((row) => [row.id, row])).values()];
        return {
          products: await this.serialise(tx, context, unique),
          nextCursor: null,
          total: unique.length,
        };
      }

      const kinds = this.kindsFor(settings.include_drafts, query.status);
      if (kinds.length === 0) return { products: [], nextCursor: null, total: 0 };
      const limit = Math.min(
        MAX_PAGE_LIMIT,
        Math.max(1, Number.parseInt(query.limit ?? '', 10) || 50),
      );
      let categoryIds: string[] | null = null;
      const category = (query.category ?? '').trim();
      if (category !== '') categoryIds = await this.resolveCategory(tx, orgId, category);
      const search = (query.q ?? '').trim();
      if (search !== '' && !context.capabilities.search) {
        throw new NcomRefusal(
          501,
          connectorError('not_implemented', 'Search is switched off for this connector.'),
        );
      }
      const after = decodeNcomCursor(query.cursor);
      const filter = {
        kinds,
        categoryIds,
        search: searchTokens(search.slice(0, 80)),
        afterId: after,
      };
      const rows = await this.catalog.marketplaceProducts(tx, orgId, filter, limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        products: await this.serialise(tx, context, page),
        nextCursor: rows.length > limit && last !== undefined ? encodeNcomCursor(last.id) : null,
        // Counted on the first page only: a convenience for ncom's dashboard.
        ...(after === null
          ? { total: await this.catalog.marketplaceProductCount(tx, orgId, filter) }
          : {}),
      };
    });
  }

  /** One product by id (ours or the old site's) or handle; null when it is not served. */
  async product(context: ConnectorContext, key: string) {
    this.assertServing(context);
    const { orgId, settings } = context;
    const trimmed = key.trim();
    if (trimmed === '' || trimmed.length > 200) return null;
    return withOrg({ orgId }, async (tx) => {
      let id: string | undefined = (await this.resolveProducts(tx, orgId, [trimmed])).get(trimmed);
      if (id === undefined && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(trimmed.toLowerCase())) {
        id = await this.catalog.marketplaceProductIdBySlug(tx, orgId, trimmed.toLowerCase());
      }
      if (id === undefined) return null;
      const rows = await this.catalog.marketplaceProducts(
        tx,
        orgId,
        {
          ids: [id],
          kinds: settings.include_drafts ? ['active', 'draft'] : ['active'],
          categoryIds: null,
          search: [],
          afterId: null,
        },
        1,
      );
      const [shaped] = await this.serialise(tx, context, rows);
      return shaped ?? null;
    });
  }

  async categories(context: ConnectorContext) {
    this.assertServing(context);
    if (!context.capabilities.categories) {
      throw new NcomRefusal(
        501,
        connectorError('not_implemented', 'Categories are switched off for this connector.'),
      );
    }
    const { orgId } = context;
    return withOrg({ orgId }, async (tx) => {
      const all = await this.catalog.webCategories(tx, orgId);
      // The website's rule (D-501, D-623): a category is shown when it and every category above
      // it are switched on and on the website, so an archived or hidden one takes its subtree
      // with it, as its products already leave the listing (joined at the M35b merge).
      const byId = new Map(all.map((category) => [category.id, category]));
      const live = (category: (typeof all)[number]): boolean => {
        let current: (typeof all)[number] | undefined = category;
        for (let depth = 0; current !== undefined && depth <= all.length; depth += 1) {
          if (!current.isActive || !current.webVisible) return false;
          current = current.parentId === null ? undefined : byId.get(current.parentId);
        }
        return true;
      };
      const shown = all.filter(live);
      const legacy = await this.storefront.legacyIdsFor(
        tx,
        orgId,
        'category',
        shown.map((category) => category.id),
      );
      const outward = (id: string) => legacy.get(id) ?? id;
      return {
        categories: shown
          .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
          .map((category) => ({
            id: outward(category.id),
            handle: category.slug,
            name: category.name,
            parentId:
              category.parentId === null || !shown.some((other) => other.id === category.parentId)
                ? null
                : outward(category.parentId),
            position: category.position,
            ...(context.origin === ''
              ? {}
              : { url: `${context.origin}/shop?category=${encodeURIComponent(category.slug)}` }),
          })),
      };
    });
  }

  /** Live stock for variant ids, in the order asked; an unknown id is `0, deny`. */
  async stock(context: ConnectorContext, ids: unknown) {
    this.assertServing(context);
    const list = Array.isArray(ids) ? (ids as unknown[]) : [];
    if (list.length > MAX_STOCK_IDS) {
      throw new NcomRefusal(
        422,
        connectorError('invalid_request', `At most ${String(MAX_STOCK_IDS)} ids per request.`),
      );
    }
    const asked = list.map((raw) =>
      typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '',
    );
    const { orgId } = context;
    return withOrg({ orgId }, async (tx) => {
      const resolved = await this.resolveVariants(
        tx,
        orgId,
        asked.filter((id) => id !== ''),
      );
      const available = await this.availability(tx, orgId, [...new Set(resolved.values())]);
      return {
        stock: asked.map((id) => {
          const skuId = resolved.get(id);
          return {
            id,
            available: skuId === undefined ? 0 : (available.get(skuId) ?? 0),
            policy: 'deny',
          };
        }),
      };
    });
  }

  /** Hold units for an order ncom is about to write: every line at one place, or none. */
  async reserve(context: ConnectorContext, body: unknown) {
    this.assertServing(context);
    if (!context.capabilities.reserve) {
      throw new NcomRefusal(
        501,
        connectorError('not_implemented', 'This connector does not hold stock.'),
      );
    }
    const record = (body ?? {}) as { orderRef?: unknown; lines?: unknown };
    const wanted = mergeNcomLines(record.lines);
    if (wanted.length === 0) {
      return { ok: false, rejected: [{ reason: 'No sellable lines in this request.' }] };
    }
    if (wanted.length > MAX_RESERVE_LINES) {
      return {
        ok: false,
        rejected: [{ reason: `Too many lines (max ${String(MAX_RESERVE_LINES)}).` }],
      };
    }
    const ref = typeof record.orderRef === 'string' ? record.orderRef.trim() : '';
    if (!ORDER_REF.test(ref)) {
      return { ok: false, rejected: [{ reason: 'orderRef is required.' }] };
    }
    const { orgId } = context;
    try {
      return await withOrg({ orgId, userId: NCOM_ACTOR }, async (tx) => {
        const existing = await repo.holdByRef(tx, orgId, ref, { lock: true });
        if (existing !== undefined) {
          if (existing.state !== 'released') return { ok: true, idempotent: true };
          return {
            ok: false,
            rejected: [{ reason: 'This order reference was released; hold under a new one.' }],
          };
        }
        const resolved = await this.resolveVariants(
          tx,
          orgId,
          wanted.map((line) => line.variantId),
        );
        const facts = new Map(
          (await this.catalog.webSkuFacts(tx, orgId, [...new Set(resolved.values())])).map(
            (fact) => [fact.id, fact],
          ),
        );
        const lines: { variantId: string; skuId: string; qty: number }[] = [];
        for (const line of wanted) {
          const skuId = resolved.get(line.variantId);
          const fact = skuId === undefined ? undefined : facts.get(skuId);
          if (skuId === undefined || fact === undefined) {
            return {
              ok: false,
              rejected: [{ variantId: line.variantId, reason: 'No longer sold' }],
            };
          }
          if (!fact.sellable) {
            return {
              ok: false,
              rejected: [{ variantId: line.variantId, reason: 'Not available' }],
            };
          }
          lines.push({ variantId: line.variantId, skuId, qty: line.quantity });
        }
        // Two variant ids for one SKU (an old id and a new one) are one line.
        const bySku = new Map<string, number>();
        for (const line of lines) bySku.set(line.skuId, (bySku.get(line.skuId) ?? 0) + line.qty);

        const locationId = await this.holdLocation(tx, orgId, bySku);
        if (typeof locationId !== 'string') {
          const short = lines.find((line) => line.skuId === locationId.skuId);
          return {
            ok: false,
            rejected: [
              {
                variantId: short?.variantId ?? locationId.skuId,
                reason:
                  locationId.available > 0
                    ? `Only ${String(locationId.available)} left`
                    : 'Sold out',
                available: locationId.available,
                requested: bySku.get(locationId.skuId) ?? 0,
              },
            ],
          };
        }
        const holdId = await repo.insertHold(tx, {
          orgId,
          orderRef: ref,
          locationId,
          lines: lines.map((line) => ({
            skuId: line.skuId,
            variantId: line.variantId,
            qty: line.qty,
          })),
        });
        if (holdId === undefined) return { ok: true, idempotent: true };
        await this.inventory.reserve(
          tx,
          { orgId, userId: NCOM_ACTOR },
          {
            refType: 'ncom_hold',
            refId: holdId,
            lines: [...bySku.entries()].map(([skuId, qty]) => ({ skuId, locationId, qty })),
          },
        );
        return { ok: true, held: lines.length };
      });
    } catch (error) {
      // Lost the race for the last units between the reading and the hold: nothing was held.
      if ((error as { code?: unknown } | null)?.code === 'STOCK_INSUFFICIENT') {
        return { ok: false, rejected: [{ reason: 'Sold out' }] };
      }
      throw error;
    }
  }

  /** Give back exactly what a hold took, once; a second release does nothing. */
  async release(context: ConnectorContext, body: unknown) {
    this.assertServing(context);
    if (!context.capabilities.release) {
      throw new NcomRefusal(
        501,
        connectorError('not_implemented', 'This connector does not hold stock.'),
      );
    }
    const ref =
      typeof (body as { orderRef?: unknown } | null)?.orderRef === 'string'
        ? (body as { orderRef: string }).orderRef.trim()
        : '';
    if (!ORDER_REF.test(ref)) return { ok: false, error: 'orderRef is required.' };
    const { orgId } = context;
    return withOrg({ orgId, userId: NCOM_ACTOR }, async (tx) => {
      const hold = await repo.holdByRef(tx, orgId, ref, { lock: true });
      if (hold?.state !== 'held') return { ok: true, released: 0, noop: true };
      await this.inventory.release(
        tx,
        { orgId, userId: NCOM_ACTOR },
        { refType: 'ncom_hold', refId: hold.id },
      );
      await repo.endHold(tx, { orgId, id: hold.id, state: 'released' });
      const released = (
        Array.isArray(hold.lines) ? (hold.lines as { qty?: unknown }[]) : []
      ).reduce((total, line) => total + (typeof line.qty === 'number' ? line.qty : 0), 0);
      return { ok: true, released };
    });
  }

  // --- pieces ---------------------------------------------------------------------------------

  private assertServing(context: ConnectorContext): void {
    // Credentials right, serving switched off: say so plainly rather than serve nothing.
    if (!context.settings.enabled) {
      throw new NcomRefusal(
        503,
        connectorError('not_serving', 'The product source is switched off in this shop’s ERP.'),
      );
    }
  }

  private kindsFor(includeDrafts: boolean, status: string | undefined): ('active' | 'draft')[] {
    const wanted = (status ?? '').toLowerCase();
    if (wanted === 'active') return ['active'];
    if (wanted === 'draft') return includeDrafts ? ['draft'] : [];
    // There is no archive state to offer: an explicit request for it matches nothing.
    if (wanted === 'archived') return [];
    return includeDrafts ? ['active', 'draft'] : ['active'];
  }

  /** Product ids as ncom sent them (ours or the old site's) → ERP ids. */
  private async resolveProducts(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const legacyWanted = ids.filter((id) => !UUID.test(id));
    const legacy =
      legacyWanted.length === 0
        ? new Map<string, string>()
        : await this.storefront.legacyIds(tx, orgId, 'product', legacyWanted);
    for (const id of ids) {
      if (UUID.test(id)) out.set(id, id.toLowerCase());
      else {
        const erp = legacy.get(id);
        if (erp !== undefined) out.set(id, erp);
      }
    }
    return out;
  }

  /** Variant ids as ncom sent them (SKU ids or the old site's variant ids) → SKU ids. */
  private async resolveVariants(
    tx: Tx,
    orgId: string,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const legacyWanted = [...new Set(ids.filter((id) => !UUID.test(id)))];
    const legacy =
      legacyWanted.length === 0
        ? new Map<string, string>()
        : await this.storefront.legacyIds(tx, orgId, 'variant', legacyWanted);
    const uuids = [...new Set(ids.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))];
    const known = new Set(
      uuids.length === 0
        ? []
        : (await this.catalog.webSkuFacts(tx, orgId, uuids)).map((fact) => fact.id),
    );
    for (const id of ids) {
      if (UUID.test(id)) {
        if (known.has(id.toLowerCase())) out.set(id, id.toLowerCase());
      } else {
        const erp = legacy.get(id);
        if (erp !== undefined) out.set(id, erp);
      }
    }
    return out;
  }

  private async resolveCategory(tx: Tx, orgId: string, key: string): Promise<string[]> {
    const categories = await this.catalog.webCategories(tx, orgId);
    if (UUID.test(key))
      return categories.some((c) => c.id === key.toLowerCase()) ? [key.toLowerCase()] : [];
    const legacy = await this.storefront.legacyIds(tx, orgId, 'category', [key]);
    const viaLegacy = legacy.get(key);
    if (viaLegacy !== undefined) return [viaLegacy];
    // A handle, because that is what a person pastes.
    const bySlug = categories.find((category) => category.slug === key.toLowerCase());
    return bySlug === undefined ? [] : [bySlug.id];
  }

  /** What the website's locations can sell of each SKU now; zero for anything not sellable. */
  private async availability(
    tx: Tx,
    orgId: string,
    skuIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (skuIds.length === 0) return new Map();
    const [facts, site] = await Promise.all([
      this.catalog.webSkuFacts(tx, orgId, skuIds),
      this.storefront.webLocationIds(tx, orgId),
    ]);
    const levels = await this.inventory.levelsAt(tx, orgId, skuIds, [...site]);
    const free = availableForWeb(levels, site);
    return new Map(
      facts.map((fact) => [fact.id, fact.sellable ? Math.max(0, free.get(fact.id) ?? 0) : 0]),
    );
  }

  /** The first web location that holds every line, or the line that ran short and what is left. */
  private async holdLocation(
    tx: Tx,
    orgId: string,
    bySku: ReadonlyMap<string, number>,
  ): Promise<string | { skuId: string; available: number }> {
    const locations = await this.storefront.webLocationIds(tx, orgId);
    const skuIds = [...bySku.keys()];
    const levels = await this.inventory.levelsAt(tx, orgId, skuIds, [...locations]);
    for (const locationId of locations) {
      const free = availableForWeb(
        levels.filter((level) => level.locationId === locationId),
        [locationId],
      );
      if (skuIds.every((skuId) => (free.get(skuId) ?? 0) >= (bySku.get(skuId) ?? 0))) {
        return locationId;
      }
    }
    const total = availableForWeb(levels, locations);
    const short =
      skuIds.find((skuId) => (total.get(skuId) ?? 0) < (bySku.get(skuId) ?? 0)) ?? skuIds[0] ?? '';
    return { skuId: short, available: Math.max(0, total.get(short) ?? 0) };
  }

  /** Our products in contract 1's shape. Nothing a product carries but what ncom reads. */
  private async serialise(tx: Tx, context: ConnectorContext, rows: readonly MarketplaceProduct[]) {
    if (rows.length === 0) return [];
    const { orgId } = context;
    const productIds = rows.map((row) => row.id);
    const [skus, images] = await Promise.all([
      this.catalog.webSkus(tx, orgId, productIds),
      this.catalog.webImages(tx, orgId, productIds),
    ]);
    const [productLegacy, variantLegacy, categoryLegacy, urls, available] = await Promise.all([
      this.storefront.legacyIdsFor(tx, orgId, 'product', productIds),
      this.storefront.legacyIdsFor(
        tx,
        orgId,
        'variant',
        skus.map((sku) => sku.id),
      ),
      this.storefront.legacyIdsFor(
        tx,
        orgId,
        'category',
        rows.flatMap((row) => (row.categoryId === null ? [] : [row.categoryId])),
      ),
      this.storefront.publicImageUrls(
        tx,
        orgId,
        images.map((image) => image.fileId),
      ),
      this.availability(
        tx,
        orgId,
        skus.map((sku) => sku.id),
      ),
    ]);
    const resolution: Resolution = {
      outward: (kind, erpId) =>
        (kind === 'product'
          ? productLegacy
          : kind === 'variant'
            ? variantLegacy
            : categoryLegacy
        ).get(erpId) ?? erpId,
    };
    const weight = context.settings.default_weight_grams;
    return rows.map((row) =>
      this.shape(
        row,
        skus.filter((sku) => sku.productId === row.id),
        images
          .filter((image) => image.productId === row.id)
          .flatMap((image) => {
            const url = urls.get(image.fileId);
            // Plain http is refused at ncom's end and blocked as mixed content besides.
            return url?.startsWith('https://') === true ? [{ url, alt: row.name }] : [];
          }),
        available,
        resolution,
        context,
        weight,
      ),
    );
  }

  private shape(
    row: MarketplaceProduct,
    skus: readonly WebSku[],
    images: readonly { url: string; alt: string }[],
    available: ReadonlyMap<string, number>,
    resolution: Resolution,
    context: ConnectorContext,
    weight: number,
  ) {
    // The options a shopper chooses between: each attribute kind the sizes carry, size first.
    const kinds = [...new Set(skus.flatMap((sku) => sku.values.map((value) => value.kind)))].sort(
      (a, b) => (a === 'size' ? -1 : b === 'size' ? 1 : a.localeCompare(b)),
    );
    const meaningful =
      skus.length > 1 ||
      skus.some((sku) => sku.values.some((value) => isMeaningfulSize(value.label)));
    const options = meaningful
      ? kinds.map((kind) => ({
          name:
            skus.flatMap((sku) => sku.values).find((value) => value.kind === kind)?.name ?? kind,
          values: [
            ...new Set(
              skus.flatMap((sku) =>
                sku.values.filter((value) => value.kind === kind).map((value) => value.label),
              ),
            ),
          ],
        }))
      : [];
    return {
      id: resolution.outward('product', row.id),
      handle: row.slug,
      title: row.name,
      // Only `active` is sellable; drafts appear so a page can be built before publishing.
      status: row.webVisible ? 'active' : 'draft',
      description: row.description ?? '',
      vendor: context.vendor,
      categoryId: row.categoryId === null ? null : resolution.outward('category', row.categoryId),
      ...(context.origin === '' ? {} : { url: `${context.origin}/shop/${row.slug}` }),
      images,
      options,
      variants: skus.map((sku) => {
        const labels = kinds.map(
          (kind) => sku.values.find((value) => value.kind === kind)?.label ?? '',
        );
        return {
          id: resolution.outward('variant', sku.id),
          title: labels.filter((label) => label !== '').join(' / ') || 'Default',
          sku: sku.code,
          price: ncomPrice(poisha(sku.pricePoisha)),
          options: meaningful ? labels : [],
          available: row.webVisible ? (available.get(sku.id) ?? 0) : 0,
          // We do not sell what we do not have: reserve refuses at zero.
          policy: 'deny',
          requiresShipping: true,
          ...(weight > 0 ? { weightGrams: weight } : {}),
        };
      }),
    };
  }
}
