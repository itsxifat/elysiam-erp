import type { LeaderboardMetric } from '@elysium/domain/analytics';

import {
  figureKpis,
  openOrdersTotal,
  WALLET_KINDS,
  type Figures,
  type SnapshotFigures,
  type WalletKind,
} from './figures.js';

/**
 * The mother API's response shapes, as they cross the wire (D-480).
 *
 * Money is integer poisha as a decimal string, because JSON has no bigint and a crore in
 * poisha is past `Number.MAX_SAFE_INTEGER` (invariant 1); the console renders it with
 * `<Money>`. Rates are basis points as strings, null where there is nothing to divide by.
 */

export interface FiguresWire {
  readonly ordersPlaced: number;
  readonly ordersConfirmed: number;
  readonly ordersDelivered: number;
  readonly ordersReturned: number;
  readonly ordersCancelled: number;
  readonly deliveredRevenuePoisha: string;
  readonly grossProfitPoisha: string;
  readonly spendPoisha: string;
  readonly pickupCount: number;
  readonly deliveredOutsideDhaka: number;
  readonly returnedOutsideDhaka: number;
  readonly aovPoisha: string | null;
  readonly returnRateBps: string | null;
  readonly deliverySuccessBps: string | null;
  readonly cpoPoisha: string | null;
  readonly cpdoPoisha: string | null;
  readonly roasBps: string | null;
  readonly pickupMeanSeconds: number | null;
}

const text = (value: bigint | null): string | null => (value === null ? null : value.toString());

/** A sum of days and its ratios, ready to send. */
export function figuresWire(figures: Figures): FiguresWire {
  const ratios = figureKpis(figures);
  return {
    ordersPlaced: figures.ordersPlaced,
    ordersConfirmed: figures.ordersConfirmed,
    ordersDelivered: figures.ordersDelivered,
    ordersReturned: figures.ordersReturned,
    ordersCancelled: figures.ordersCancelled,
    deliveredRevenuePoisha: figures.deliveredRevenuePoisha.toString(),
    grossProfitPoisha: figures.grossProfitPoisha.toString(),
    spendPoisha: figures.spendPoisha.toString(),
    pickupCount: figures.pickupCount,
    deliveredOutsideDhaka: figures.deliveredOutsideDhaka,
    returnedOutsideDhaka: figures.returnedOutsideDhaka,
    aovPoisha: text(ratios.aovPoisha),
    returnRateBps: text(ratios.returnRateBps),
    deliverySuccessBps: text(ratios.deliverySuccessBps),
    cpoPoisha: text(ratios.cpoPoisha),
    cpdoPoisha: text(ratios.cpdoPoisha),
    roasBps: text(ratios.roasBps),
    pickupMeanSeconds: ratios.pickupMeanSeconds,
  };
}

export interface SnapshotWire {
  readonly cashPoisha: string;
  readonly cashByKind: Readonly<Record<WalletKind, string>>;
  readonly stockValuePoisha: string;
  readonly goodsInTransitPoisha: string;
  readonly codHeldPoisha: string;
  readonly supplierPayablesPoisha: string;
  readonly receivablesPoisha: string;
  readonly openOrders: Readonly<Record<string, number>>;
  readonly openOrdersTotal: number;
  readonly staffHeadcount: number;
  readonly activeSkus: number;
  readonly lowStockSkus: number;
}

export function snapshotWire(snapshot: SnapshotFigures): SnapshotWire {
  const cashByKind = {} as Record<WalletKind, string>;
  for (const kind of WALLET_KINDS) cashByKind[kind] = snapshot.cashByKind[kind].toString();
  return {
    cashPoisha: snapshot.cashPoisha.toString(),
    cashByKind,
    stockValuePoisha: snapshot.stockValuePoisha.toString(),
    goodsInTransitPoisha: snapshot.goodsInTransitPoisha.toString(),
    codHeldPoisha: snapshot.codHeldPoisha.toString(),
    supplierPayablesPoisha: snapshot.supplierPayablesPoisha.toString(),
    receivablesPoisha: snapshot.receivablesPoisha.toString(),
    openOrders: snapshot.openOrders,
    openOrdersTotal: openOrdersTotal(snapshot.openOrders),
    staffHeadcount: snapshot.staffHeadcount,
    activeSkus: snapshot.activeSkus,
    lowStockSkus: snapshot.lowStockSkus,
  };
}

/** Why the latest figures are what they are. */
export type SchemaStatus = 'ok' | 'version_mismatch' | 'unknown';

export interface BrandStatusWire {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly adminUrl: string;
  readonly isActive: boolean;
  /** When the figures shown were read from the brand. Null until the first good pull. */
  readonly figuresAt: string | null;
  readonly lastAttemptAt: string | null;
  /** A short code and a sentence, never a connection string (D-486). */
  readonly lastError: { readonly code: string; readonly at: string } | null;
  readonly schema: SchemaStatus;
  readonly brandMigrations: number | null;
  readonly expectedMigrations: number;
  readonly hasOwnerLinkKey: boolean;
  readonly ownerLinkKeyFingerprint: string | null;
  readonly connectionFingerprint: string;
}

export interface OverviewBrandWire {
  readonly brand: BrandStatusWire;
  readonly figures: FiguresWire;
  readonly previous: FiguresWire;
  readonly snapshot: (SnapshotWire & { readonly takenAt: string; readonly asOf: string }) | null;
  readonly computedDays: number;
}

export interface SeriesPoint {
  readonly date: string;
  /** Per brand id: the day's figures that the trend chart can draw. */
  readonly byBrand: Readonly<
    Record<
      string,
      {
        readonly ordersPlaced: number;
        readonly ordersDelivered: number;
        readonly deliveredRevenuePoisha: string;
        readonly grossProfitPoisha: string;
        readonly spendPoisha: string;
      }
    >
  >;
}

export interface OverviewWire {
  readonly from: string;
  readonly to: string;
  readonly previousFrom: string;
  readonly previousTo: string;
  readonly days: number;
  readonly totals: FiguresWire;
  readonly previousTotals: FiguresWire;
  readonly snapshotTotals: SnapshotWire;
  readonly brands: readonly OverviewBrandWire[];
  readonly series: readonly SeriesPoint[];
}

export interface LeaderboardRowWire {
  readonly brandId: string;
  readonly name: string;
  readonly rank: number;
  readonly compositeBps: number;
  readonly metrics: Readonly<Record<LeaderboardMetric, string | null>>;
  readonly ranks: Readonly<Record<LeaderboardMetric, number | null>>;
  readonly scores: Readonly<Record<LeaderboardMetric, number>>;
  readonly current: FiguresWire;
  readonly previous: FiguresWire;
}

export interface LeaderboardWire {
  readonly month: string;
  readonly previousMonth: string;
  readonly metrics: readonly LeaderboardMetric[];
  readonly weights: Readonly<Record<LeaderboardMetric, number>>;
  readonly rows: readonly LeaderboardRowWire[];
}

export interface BrandFiguresWire {
  readonly brand: BrandStatusWire;
  readonly from: string;
  readonly to: string;
  readonly figures: FiguresWire;
  readonly previous: FiguresWire;
  readonly snapshot: OverviewBrandWire['snapshot'];
  readonly series: readonly {
    readonly date: string;
    readonly ordersPlaced: number;
    readonly ordersDelivered: number;
    readonly deliveredRevenuePoisha: string;
    readonly grossProfitPoisha: string;
    readonly spendPoisha: string;
  }[];
  readonly byChannel: readonly ({ readonly channel: string } & FiguresWire)[];
  readonly byCampaign: readonly {
    readonly campaignKey: string;
    readonly name: string | null;
    readonly spendPoisha: string;
    readonly ordersConfirmed: number;
    readonly ordersDelivered: number;
    readonly deliveredRevenuePoisha: string;
    readonly roasBps: string | null;
    readonly cpdoPoisha: string | null;
  }[];
}

/** Lists read straight from the brand's database when its page opens. */
export interface BrandLiveWire {
  readonly readAt: string;
  readonly latestOrders: readonly {
    readonly orderNo: string;
    readonly status: string;
    readonly channel: string;
    readonly createdAt: string;
    readonly totalPoisha: string;
  }[];
  readonly topProducts: readonly {
    readonly skuCode: string;
    readonly productName: string;
    readonly units: number;
    readonly revenuePoisha: string;
  }[];
  readonly lowStock: readonly {
    readonly skuCode: string;
    readonly productName: string;
    readonly location: string;
    readonly available: number;
    readonly reorderLevel: number;
  }[];
  readonly wallets: readonly {
    readonly code: string;
    readonly name: string;
    readonly subtype: string;
    readonly balancePoisha: string;
  }[];
  readonly courierCod: readonly { readonly courier: string; readonly heldPoisha: string }[];
  readonly staff: {
    readonly headcount: number;
    readonly people: readonly {
      readonly code: string;
      readonly fullName: string;
      readonly designation: string | null;
      readonly branch: string | null;
      readonly status: string;
    }[];
  };
}

export type BrandLiveResult =
  | { readonly ok: true; readonly live: BrandLiveWire }
  | { readonly ok: false; readonly error: { readonly code: string } };

export interface WalletsWire {
  readonly brands: readonly {
    readonly brand: BrandStatusWire;
    readonly asOf: string | null;
    readonly takenAt: string | null;
    readonly cashByKind: Readonly<Record<WalletKind, string>> | null;
    readonly totalPoisha: string | null;
  }[];
  readonly cashByKind: Readonly<Record<WalletKind, string>>;
  readonly totalPoisha: string;
}

export interface ProfitAndLossWire {
  readonly from: string;
  readonly to: string;
  readonly brands: readonly {
    readonly brand: BrandStatusWire;
    readonly incomePoisha: string;
    readonly expensePoisha: string;
    readonly netPoisha: string;
    readonly lines: readonly {
      readonly subtype: string;
      readonly accountClass: 'income' | 'expense';
      readonly amountPoisha: string;
    }[];
  }[];
  readonly incomePoisha: string;
  readonly expensePoisha: string;
  readonly netPoisha: string;
}

export interface MeWire {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface PersonWire {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly twoFactorEnabled: boolean;
  readonly hasPassword: boolean;
  readonly createdAt: string;
  readonly lastSignInAt: string | null;
}

export interface TwoFactorResetWire {
  readonly id: string;
  readonly target: { readonly id: string; readonly name: string };
  readonly requestedBy: { readonly id: string; readonly name: string };
  readonly decidedBy: { readonly id: string; readonly name: string } | null;
  readonly reason: string;
  readonly status: 'pending' | 'approved' | 'rejected';
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface ActivityWire {
  readonly items: readonly {
    readonly id: number;
    readonly occurredAt: string;
    readonly actor: { readonly id: string | null; readonly name: string | null } | null;
    readonly action: string;
    readonly entityType: string;
    readonly entityId: string | null;
    readonly detail: Readonly<Record<string, unknown>>;
  }[];
  readonly next: number | null;
}

/** A one-time link handed to the owner who asked for it (an invite, D-487). */
export interface LinkWire {
  readonly link: string;
  readonly expiresAt: string;
}

/** The public key, shown once to paste into the brand's `OWNER_LINK_PUBLIC_KEY` (D-490). */
export interface OwnerLinkKeyWire {
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly envLine: string;
}

export interface OwnerLinkWire {
  /** `<admin URL>/owner-link#token=…`: the console navigates there at once. */
  readonly url: string;
  readonly expiresAt: string;
}

export interface ConnectionTestWire {
  readonly ok: boolean;
  readonly code: string;
  readonly brandMigrations: number | null;
  readonly expectedMigrations: number;
  readonly brandFound: boolean;
}
