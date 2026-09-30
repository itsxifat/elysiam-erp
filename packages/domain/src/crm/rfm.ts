import { addDays, type IsoDate } from '../dates/index.js';
import type { Poisha } from '../money/index.js';

/**
 * RFM segments (architecture §10, M16 check 1): how recently, how often and how much
 * a buyer has bought, scored 1–5 against the brand's other buyers and named.
 *
 * Quintiles by rank within the brand rather than fixed thresholds: a "frequent"
 * buyer of a saree brand and of a T-shirt brand are different numbers, and rank is
 * the one scale both share. Equal values always get the same score, so two buyers
 * with the same history never land in different segments because of sort order.
 *
 * Only delivered orders count. A buyer whose orders were all returned has bought
 * nothing, and ranking them as a regular would send a birthday code to the address
 * that refuses every parcel.
 */

export interface BuyerActivity {
  readonly customerId: string;
  /** The last delivered order's Asia/Dhaka date, or null for none. */
  readonly lastOrderOn: IsoDate | null;
  /** Delivered orders. */
  readonly orders: number;
  /** Delivered value, in poisha. */
  readonly spentPoisha: Poisha;
}

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

export interface RfmScore {
  readonly recency: number;
  readonly frequency: number;
  readonly monetary: number;
  readonly segment: RfmSegment;
}

/** 1–5 by rank, higher is better, equal values scoring alike. */
function quintiles(values: readonly { id: string; value: bigint }[]): Map<string, number> {
  const sorted = [...values].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const scores = new Map<string, number>();
  const firstIndex = new Map<bigint, number>();
  sorted.forEach((entry, index) => {
    if (!firstIndex.has(entry.value)) firstIndex.set(entry.value, index);
  });
  for (const entry of sorted) {
    const index = firstIndex.get(entry.value) ?? 0;
    scores.set(entry.id, 1 + Math.floor((5 * index) / sorted.length));
  }
  return scores;
}

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function segmentFor(recency: number, frequency: number, monetary: number): RfmSegment {
  if (recency >= 4 && frequency >= 4 && monetary >= 4) return 'champions';
  if (recency >= 3 && frequency >= 4) return 'loyal';
  if (recency >= 4 && frequency <= 1) return 'new';
  if (recency >= 4) return 'promising';
  if (recency <= 2 && frequency >= 3) return 'at_risk';
  if (recency <= 2) return 'hibernating';
  return 'needs_attention';
}

/** Every buyer's scores and segment, as of `today`. */
export function rfm(buyers: readonly BuyerActivity[], today: IsoDate): Map<string, RfmScore> {
  const active = buyers.filter((buyer) => buyer.orders > 0 && buyer.lastOrderOn !== null);
  // Recency: fewer days since the last order is better, so rank the negation.
  const recency = quintiles(
    active.map((buyer) => ({
      id: buyer.customerId,
      value: -BigInt(daysBetween(buyer.lastOrderOn ?? today, today)),
    })),
  );
  const frequency = quintiles(
    active.map((buyer) => ({ id: buyer.customerId, value: BigInt(buyer.orders) })),
  );
  const monetary = quintiles(
    active.map((buyer) => ({ id: buyer.customerId, value: buyer.spentPoisha })),
  );

  const out = new Map<string, RfmScore>();
  for (const buyer of buyers) {
    const r = recency.get(buyer.customerId);
    const f = frequency.get(buyer.customerId);
    const m = monetary.get(buyer.customerId);
    if (r === undefined || f === undefined || m === undefined) {
      out.set(buyer.customerId, { recency: 0, frequency: 0, monetary: 0, segment: 'prospect' });
      continue;
    }
    out.set(buyer.customerId, {
      recency: r,
      frequency: f,
      monetary: m,
      segment: segmentFor(r, f, m),
    });
  }
  return out;
}

/** The re-engagement cut-off: buyers whose last order is on or before this date. */
export function lapsedSince(today: IsoDate, days: number): IsoDate {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('At least one day.');
  return addDays(today, -days);
}
