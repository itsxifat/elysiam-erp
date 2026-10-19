import { api } from '../../api.js';

/**
 * Selling from the chat over HTTP (M44b), typed to what `selling.controller.ts` returns. Selling
 * prices only, as decimal strings of poisha; nothing here has a cost. The order is placed through
 * the order desk's own `createOrder` (`../orders/api.ts`), the advance through `recordAdvance`.
 */

export interface PickerVariant {
  readonly skuId: string;
  readonly code: string;
  readonly size: string | null;
  readonly colour: string | null;
  /** `M / Black`, or empty for a product with one size. */
  readonly label: string;
  readonly pricePoisha: string;
  readonly compareAtPoisha: string | null;
  /** Units in hand where the order desk sells from. */
  readonly available: number;
}

export interface PickerProduct {
  readonly id: string;
  readonly name: string;
  readonly imageFileId: string | null;
  readonly sizeChartId: string | null;
  /** The SKU an exact code or barcode named. */
  readonly matchedSkuId: string | null;
  readonly minPricePoisha: string | null;
  readonly maxPricePoisha: string | null;
  readonly variants: readonly PickerVariant[];
}

export interface SizeChart {
  readonly id: string;
  readonly name: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface SellingContext {
  readonly colours: readonly string[];
  readonly siteHosts: readonly string[];
}

export const SELL_KEY = ['inbox', 'sell'] as const;

export const getSellingContext = () => api.get<SellingContext>('/v1/inbox/selling-context');

/**
 * The picker's search, a page at a time (M49, D-890: every match, as the agent scrolls), or the
 * customer's interests by id. `nextOffset` is the next page's start, null on the last one.
 */
export const pickProducts = (
  query: { readonly q: string; readonly offset?: number } | { readonly ids: readonly string[] },
) =>
  api.get<{ items: PickerProduct[]; nextOffset: number | null }>(
    'q' in query
      ? `/v1/inbox/products?q=${encodeURIComponent(query.q)}${
          query.offset === undefined || query.offset === 0 ? '' : `&offset=${String(query.offset)}`
        }`
      : `/v1/inbox/products?ids=${query.ids.map(encodeURIComponent).join(',')}`,
  );

export const getSizeChart = (id: string) =>
  api.get<SizeChart>(`/v1/inbox/size-charts/${encodeURIComponent(id)}`);
