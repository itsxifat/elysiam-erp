import { api } from '../../api.js';
import { env } from '../../env.js';

/**
 * `/v1/customers`, `/v1/customers/:id/profile` and `/v1/crm/reengagement`, typed to what
 * the controllers return (M10, M16).
 *
 * Hand-written for the reason the orders client gives. Every amount is a decimal string
 * of poisha, rendered with `<Money>` as it arrives; nothing here adds amounts up.
 */

export const RFM_SEGMENTS = [
  'champions',
  'loyal',
  'new',
  'promising',
  'at_risk',
  'hibernating',
  'needs_attention',
  'prospect',
] as const;
export type RfmSegment = (typeof RFM_SEGMENTS)[number];

export interface CustomerStats {
  readonly orders: number;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  readonly ltvPoisha: string;
  readonly firstOrderAt: string | null;
  readonly lastOrderAt: string | null;
}

export interface Customer {
  readonly id: string;
  readonly phone: string;
  readonly name: string;
  readonly birthday: string | null;
  readonly anniversary: string | null;
  readonly stats: CustomerStats;
}

export interface BuyerProfile {
  readonly customer: Customer;
  readonly averageOrderPoisha: string | null;
  readonly favourites: {
    readonly categories: readonly { readonly name: string; readonly units: number }[];
    readonly sizes: readonly { readonly label: string; readonly units: number }[];
  };
  readonly segment: {
    readonly segment: string;
    readonly recency: number;
    readonly frequency: number;
    readonly monetary: number;
    readonly computedOn: string;
  } | null;
  readonly greetings: readonly {
    readonly occasion: string;
    readonly year: number;
    readonly sentAt: string;
  }[];
  readonly recentOrders: readonly {
    readonly id: string;
    readonly orderNo: string;
    readonly status: string;
    readonly channel: string;
    readonly codAmountPoisha: string;
    readonly createdAt: string;
  }[];
}

export interface LapsedBuyer {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string;
  readonly segment: string | null;
  readonly delivered: number;
  readonly ltvPoisha: string;
  readonly lastOrderOn: string;
}

export interface LapsedFilters {
  readonly days: number;
  readonly minDelivered: number;
  readonly segment?: RfmSegment | undefined;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text === '' ? '' : `?${text}`;
}

export const listCustomers = (q: string | undefined, limit: number, offset: number) =>
  api.get<{ items: Customer[] }>(`/v1/customers${query({ q, limit, offset })}`);

/** Set (a date), clear (`null`) or leave (absent) a buyer's occasions. */
export const updateOccasions = (
  id: string,
  body: { readonly birthday: string | null; readonly anniversary: string | null },
) => api.patch<unknown>(`/v1/customers/${encodeURIComponent(id)}`, body);

export const buyerProfile = (id: string) =>
  api.get<BuyerProfile>(`/v1/customers/${encodeURIComponent(id)}/profile`);

export const listLapsed = (filters: LapsedFilters, limit: number, offset: number) =>
  api.get<{ items: LapsedBuyer[]; total: number; lastOrderOnOrBefore: string }>(
    `/v1/crm/reengagement${query({ ...filters, limit, offset })}`,
  );

/** The file, opened by the browser with the cookie it already has (see the buyer export). */
export const lapsedExportUrl = (
  filters: LapsedFilters,
  // `meta_audience` (M18): the same buyers as SHA-256 phone hashes for a Meta customer list.
  format: 'csv' | 'xlsx' | 'meta_audience',
) =>
  new URL(
    `/v1/crm/reengagement/export${query({ ...filters, format })}`,
    env.VITE_API_URL,
  ).toString();
