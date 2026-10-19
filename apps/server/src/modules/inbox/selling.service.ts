import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';

import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { STOREFRONT_API, type StorefrontApi } from '../storefront/storefront.api.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';

/**
 * How many products one page of the picker lists (M49, D-890): every match is reachable, a page at
 * a time as the agent scrolls, because many products share a name.
 */
export const PICKER_LIMIT = 20;
/** The furthest a search pages: well past any real catalogue's matches for one phrase. */
export const PICKER_MAX_OFFSET = 5_000;
/** How many interests `?ids=` lists: what the route accepts (`selling.controller.ts`). */
export const PICKER_IDS_LIMIT = 20;

/** The brand website's host, without `www.`, or nothing when it has no valid site URL. */
function hostOf(siteUrl: string): string | null {
  if (siteUrl.trim() === '') return null;
  try {
    const host = new URL(siteUrl.includes('://') ? siteUrl : `https://${siteUrl}`).host;
    return host === '' ? null : host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Selling from the chat (M44b, D-770 to D-773): what the customer panel's side card, product
 * picker and draft order read. Reads only; the order itself is placed through the order desk's
 * own route (`POST /v1/orders`), with every check that route makes.
 *
 * Products and colours are the catalog's (`CatalogApi`), stock in hand the orders module's
 * (`OrdersApi.deskAvailability`, the order desk's own location, D-741), size charts and the
 * website's address the storefront's (`StorefrontApi`): asked, never read from their tables
 * (invariant 12). Selling prices only; nothing here has, or could carry, a cost (invariant 5).
 */
@Injectable()
export class InboxSellingService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(STOREFRONT_API) private readonly storefront: StorefrontApi,
  ) {}

  /** What the detector needs to know about the brand: its colours and its website. */
  async context(context: ActiveContext) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const [colours, site] = await Promise.all([
          this.catalog.colourNames(tx, context.orgId),
          this.storefront.siteFacts(tx, context.orgId),
        ]);
        const host = hostOf(site.siteUrl);
        return { colours, siteHosts: host === null ? [] : [host] };
      }),
    );
  }

  /**
   * The picker: products for what was typed (or these ids, the customer's interests), each with
   * its photo, size chart and every active size and colour at its selling price with the units
   * in hand where the desk sells from.
   */
  async products(
    context: ActiveContext,
    query:
      | { readonly q: string; readonly offset?: number | undefined }
      | { readonly ids: readonly string[] },
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const page = await this.catalog.pickerProducts(
          tx,
          context.orgId,
          'q' in query
            ? { q: query.q, limit: PICKER_LIMIT, offset: query.offset ?? 0 }
            : { ids: query.ids, limit: PICKER_IDS_LIMIT },
        );
        const products = page.items;
        if (products.length === 0) return { items: [], nextOffset: page.nextOffset };
        const skus = await this.catalog.webSkus(
          tx,
          context.orgId,
          products.map((product) => product.id),
        );
        const available = await this.orders.deskAvailability(
          tx,
          context.orgId,
          skus.map((sku) => sku.id),
        );
        return {
          items: products.map((product) => {
            const variants = skus
              .filter((sku) => sku.productId === product.id)
              .map((sku) => ({
                skuId: sku.id,
                code: sku.code,
                size: sku.values.find((value) => value.kind === 'size')?.label ?? null,
                colour: sku.values.find((value) => value.kind === 'colour')?.label ?? null,
                label: sku.values.map((value) => value.label).join(' / '),
                pricePoisha: sku.pricePoisha.toString(),
                compareAtPoisha: sku.compareAtPoisha?.toString() ?? null,
                available: available.get(sku.id) ?? 0,
              }));
            const prices = variants.map((variant) => BigInt(variant.pricePoisha));
            return {
              id: product.id,
              name: product.name,
              imageFileId: product.imageFileId,
              sizeChartId: product.sizeChartId,
              matchedSkuId: product.matchedSkuId,
              minPricePoisha:
                prices.length === 0 ? null : prices.reduce((a, b) => (b < a ? b : a)).toString(),
              maxPricePoisha:
                prices.length === 0 ? null : prices.reduce((a, b) => (b > a ? b : a)).toString(),
              variants,
            };
          }),
          nextOffset: page.nextOffset,
        };
      }),
    );
  }

  /** One size chart, for turning a measurement into a size (D-771). */
  async sizeChart(context: ActiveContext, id: string) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const chart = await this.storefront.sizeChart(tx, context.orgId, id);
        if (chart === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such size chart.');
        return chart;
      }),
    );
  }
}
