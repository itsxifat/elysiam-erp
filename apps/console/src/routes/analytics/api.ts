import { api } from '../../api.js';
import { env } from '../../env.js';

/**
 * `/v1/analytics/*`, typed to what the controller returns (M24).
 *
 * Hand-written for the reason the orders client gives. Amounts are decimal strings of
 * poisha; rates are basis points as decimal strings (10,000 = 100%, or 1× for ROAS), null
 * where there is nothing to divide by. Gross profit and stock value are absent for a role
 * without cost (the server strips them).
 */

export interface OrderMetrics {
  readonly ordersPlaced: number;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: string;
  readonly grossProfitPoisha?: string;
  readonly returnRateBps: string | null;
}

export interface Kpis {
  readonly aovPoisha: string | null;
  readonly returnRateBps: string | null;
  readonly deliverySuccessBps: string | null;
  readonly cpoPoisha: string | null;
  readonly cpdoPoisha: string | null;
  readonly roasBps: string | null;
  readonly pickupMeanSeconds: number | null;
}

export interface SeriesPoint {
  readonly date: string;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly deliveredRevenuePoisha: string;
  readonly spendPoisha: string;
}

export interface Dashboard {
  readonly from: string;
  readonly to: string;
  readonly coverage: {
    readonly days: number;
    readonly computedDays: number;
    readonly computedAt: string | null;
  };
  readonly totals: OrderMetrics &
    Kpis & { readonly spendPoisha: string; readonly pickupCount: number };
  readonly series: readonly SeriesPoint[];
  readonly byChannel: readonly (OrderMetrics & { readonly channel: string })[];
  readonly byBranch: readonly (OrderMetrics & {
    readonly branchId: string;
    readonly name: string | null;
  })[];
  readonly byCampaign: readonly {
    readonly campaignId: string | null;
    readonly name: string | null;
    readonly spendPoisha: string;
    readonly ordersConfirmed: number;
    readonly ordersDelivered: number;
    readonly deliveredRevenuePoisha: string;
    readonly cpdoPoisha: string | null;
    readonly roasBps: string | null;
  }[];
  readonly agents: readonly {
    readonly userId: string;
    readonly name: string | null;
    readonly employeeCode: string | null;
    readonly ordersConfirmed: number;
    readonly ordersDelivered: number;
    readonly deliveredRevenuePoisha: string;
    readonly pickupCount: number;
    readonly pickupMeanSeconds: number | null;
  }[];
  readonly topSkus: readonly {
    readonly skuId: string;
    readonly skuCode: string;
    readonly productName: string;
    readonly units: number;
  }[];
  readonly cashPoisha: string;
  readonly cashAsOf: string;
  readonly stockValuePoisha?: string;
}

export const INSIGHT_CODES = [
  'outside_dhaka_returns',
  'return_rate_rising',
  'campaign_below_break_even',
  'cpdo_rising',
  'slow_pickup',
  'channel_returns',
  'delivery_success_below_usual',
] as const;
export type InsightCode = (typeof INSIGHT_CODES)[number];

export interface InsightItem {
  readonly code: InsightCode;
  readonly severity: 'warning' | 'info';
  readonly params: Readonly<Record<string, string>>;
  readonly campaignName: string | null;
}

export type Narrative =
  | { readonly enabled: false; readonly month: string }
  | {
      readonly enabled: true;
      readonly month: string;
      readonly text: string;
      readonly provider: string;
      readonly generatedOn: string;
      readonly cached: boolean;
    };

function query(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}`;
}

export const getDashboard = (from: string, to: string) =>
  api.get<Dashboard>(`/v1/analytics/dashboard${query({ from, to })}`);

export const getInsights = (month: string) =>
  api.get<{ month: string; items: InsightItem[] }>(`/v1/analytics/insights${query({ month })}`);

export const getNarrative = (month: string) =>
  api.get<Narrative>(`/v1/analytics/narrative${query({ month })}`);

export const refreshRollups = (from: string, to: string) =>
  api.post<{ from: string; to: string; days: number }>('/v1/analytics/rollups/refresh', {
    from,
    to,
  });

/** A link, not a script download: the browser saves the file the server names. */
export const exportUrl = (from: string, to: string, format: 'csv' | 'xlsx') =>
  new URL(`/v1/analytics/export${query({ from, to, format })}`, env.VITE_API_URL).toString();
