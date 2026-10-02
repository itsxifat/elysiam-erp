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

export const LEADERBOARD_METRICS = [
  'revenueGrowth',
  'deliverySuccess',
  'returnRate',
  'roas',
  'cpdo',
  'aovGrowth',
  'pickupTime',
] as const;
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number];

interface MonthFigures {
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: string;
  readonly spendPoisha: string;
  readonly pickupCount: number;
  readonly pickupSeconds: number;
}

export interface BoardRow {
  /** `full`: the viewer's own brand, or any brand for Super Admin. `normalized`: D-023. */
  readonly visibility: 'full' | 'normalized';
  readonly orgId: string;
  readonly orgName: string;
  readonly rank: number;
  readonly compositeBps: number;
  readonly metrics: Readonly<Record<LeaderboardMetric, string | null>>;
  readonly ranks: Readonly<Record<LeaderboardMetric, number | null>>;
  readonly scores: Readonly<Record<LeaderboardMetric, number>>;
  readonly raw?: { readonly current: MonthFigures; readonly previous: MonthFigures };
}

export interface Leaderboard {
  readonly month: string;
  readonly metrics: readonly LeaderboardMetric[];
  readonly weights: Readonly<Record<LeaderboardMetric, number>>;
  readonly rows: readonly BoardRow[];
}

export const INSIGHT_CODES = [
  'outside_dhaka_returns',
  'return_rate_rising',
  'campaign_below_break_even',
  'cpdo_rising',
  'slow_pickup',
  'channel_returns',
  'delivery_success_below_group',
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

export interface Consolidated {
  readonly from: string;
  readonly to: string;
  readonly brands: readonly (OrderMetrics &
    Kpis & { readonly orgId: string; readonly orgName: string; readonly spendPoisha: string })[];
  readonly group: OrderMetrics & Kpis & { readonly spendPoisha: string };
}

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

export const getLeaderboard = (month: string) =>
  api.get<Leaderboard>(`/v1/analytics/leaderboard${query({ month })}`);

export const getConsolidated = (from: string, to: string) =>
  api.get<Consolidated>(`/v1/analytics/consolidated${query({ from, to })}`);

/** A link, not a script download: the browser saves the file the server names. */
export const exportUrl = (from: string, to: string, format: 'csv' | 'xlsx') =>
  new URL(`/v1/analytics/export${query({ from, to, format })}`, env.VITE_API_URL).toString();
