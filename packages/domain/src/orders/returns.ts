/**
 * Why parcels come back, and how often (M17, D-237).
 *
 * A COD brand's return rate is its margin. A ৳1,200 kurti that comes back has cost two
 * courier legs and a week of stock held, and earned nothing. "Return rate is 18%" is not
 * actionable. "Half of Outside Dhaka's returns are `customer_unreachable`" is: call
 * before dispatch.
 *
 * The reasons are a fixed list, translated, plus a note. A brand-editable list would
 * make the summary incomparable across months the moment someone renamed an entry, and
 * across the five brands for the owner who reads all five. A reason that does not fit
 * is `other` with a note, and a recurring note is a candidate for the list (a decision
 * row, not a setting).
 */

export const RETURN_REASON_CODES = [
  /** The buyer refused the parcel at the door. */
  'customer_refused',
  /** The rider could not reach the buyer: phone off, wrong number, nobody home. */
  'customer_unreachable',
  /** The address was wrong or could not be found. */
  'wrong_address',
  /** The buyer no longer wanted it. */
  'changed_mind',
  /** Wrong size or fit. */
  'size_issue',
  /** Quality, or not as pictured. */
  'quality_issue',
  /** We sent the wrong item. */
  'wrong_item',
  /** Damaged on the way. */
  'damaged_in_transit',
  /** It arrived too late to be wanted. */
  'late_delivery',
  /** The buyer disputed the price or the delivery charge at the door. */
  'price_dispute',
  /** The order was never real. */
  'fake_order',
  'other',
] as const;

export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export function isReturnReasonCode(value: string): value is ReturnReasonCode {
  return (RETURN_REASON_CODES as readonly string[]).includes(value);
}

/** The statuses an order may be in for a return reason to be recorded against it. */
export const RETURN_REASON_STATUSES = [
  'return_in_transit',
  'partially_delivered',
  'returned',
] as const;

/** One group of orders the summary reads: how many, and what happened to them. */
export interface ReturnSummaryRow {
  readonly outcome: 'delivered' | 'returned';
  /** Null for a return nobody gave a reason for. Ignored for a delivered order. */
  readonly reason: ReturnReasonCode | null;
  readonly zoneId: string | null;
  readonly channel: string;
  readonly count: number;
}

export interface ReasonShare {
  readonly reason: ReturnReasonCode | null;
  readonly count: number;
  /** Basis points of all returns. The shares sum to exactly 10,000 when there are any. */
  readonly shareBps: number;
}

export interface RateRow {
  readonly key: string | null;
  readonly delivered: number;
  readonly returned: number;
  /** returned / (delivered + returned), in basis points, rounded half up. 0 when both are 0. */
  readonly returnRateBps: number;
  /** The most common stated reason for this group's returns, or null. */
  readonly topReason: ReturnReasonCode | null;
}

export interface ReturnSummary {
  readonly delivered: number;
  readonly returned: number;
  readonly returnRateBps: number;
  /** Returns with no reason recorded. Shown, because a summary that hides them over-states the rest. */
  readonly unspecified: number;
  /** Most common first; ties in the list's own order, so the table does not reshuffle. */
  readonly reasons: readonly ReasonShare[];
  readonly zones: readonly RateRow[];
  readonly channels: readonly RateRow[];
}

/** `part / whole` in basis points, rounded half up, on integers. */
export function rateBps(part: number, whole: number): number {
  if (!Number.isSafeInteger(part) || !Number.isSafeInteger(whole) || part < 0 || whole < 0) {
    throw new RangeError('rateBps(): counts must be whole numbers ≥ 0.');
  }
  if (part > whole) throw new RangeError('rateBps(): a part cannot exceed its whole.');
  if (whole === 0) return 0;
  const p = BigInt(part);
  const w = BigInt(whole);
  return Number((p * 20_000n + w) / (2n * w));
}

/**
 * Split 10,000 basis points across counts by largest remainder, so the shares sum to
 * exactly 10,000. Rounding each share on its own would let a column of percentages add
 * up to 99.99% or 100.01%, which is the first thing anybody checks on a report.
 */
export function sharesBps(counts: readonly number[]): number[] {
  const total = counts.reduce((acc, count) => acc + count, 0);
  if (total === 0) return counts.map(() => 0);
  const whole = BigInt(total);
  const floors = counts.map((count) => (BigInt(count) * 10_000n) / whole);
  const remainders = counts.map((count, index) => ({
    index,
    rest: (BigInt(count) * 10_000n) % whole,
  }));
  let left = 10_000n - floors.reduce((acc, value) => acc + value, 0n);
  // Largest remainder first; ties to the earlier entry, so the result is deterministic.
  remainders.sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));
  const result = [...floors];
  for (const { index } of remainders) {
    if (left === 0n) break;
    result[index] = (result[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return result.map((value) => Number(value));
}

function topReasonOf(counts: Map<ReturnReasonCode, number>): ReturnReasonCode | null {
  let best: ReturnReasonCode | null = null;
  let bestCount = 0;
  for (const code of RETURN_REASON_CODES) {
    const count = counts.get(code) ?? 0;
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

function rateRows(
  rows: readonly ReturnSummaryRow[],
  keyOf: (row: ReturnSummaryRow) => string | null,
): RateRow[] {
  const groups = new Map<
    string | null,
    { delivered: number; returned: number; reasons: Map<ReturnReasonCode, number> }
  >();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? { delivered: 0, returned: 0, reasons: new Map() };
    if (row.outcome === 'delivered') group.delivered += row.count;
    else {
      group.returned += row.count;
      if (row.reason !== null) {
        group.reasons.set(row.reason, (group.reasons.get(row.reason) ?? 0) + row.count);
      }
    }
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      delivered: group.delivered,
      returned: group.returned,
      returnRateBps: rateBps(group.returned, group.delivered + group.returned),
      topReason: topReasonOf(group.reasons),
    }))
    .sort(
      (a, b) =>
        b.returned - a.returned || b.returnRateBps - a.returnRateBps || compareKeys(a.key, b.key),
    );
}

function compareKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * The return-reason summary (M17, D-237): by reason, by zone and by channel.
 *
 * Pure, over pre-grouped counts, so the SQL does the grouping and this does the
 * arithmetic: shares that sum exactly and rates rounded once.
 */
export function summarizeReturns(rows: readonly ReturnSummaryRow[]): ReturnSummary {
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) {
      throw new RangeError('summarizeReturns(): a count must be a whole number ≥ 0.');
    }
  }

  let delivered = 0;
  let returned = 0;
  let unspecified = 0;
  const byReason = new Map<ReturnReasonCode, number>();
  for (const row of rows) {
    if (row.outcome === 'delivered') {
      delivered += row.count;
      continue;
    }
    returned += row.count;
    if (row.reason === null) unspecified += row.count;
    else byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + row.count);
  }

  const entries: { reason: ReturnReasonCode | null; count: number }[] = RETURN_REASON_CODES.filter(
    (code) => (byReason.get(code) ?? 0) > 0,
  ).map((code) => ({ reason: code, count: byReason.get(code) ?? 0 }));
  if (unspecified > 0) entries.push({ reason: null, count: unspecified });
  // Stable sort: most common first, ties keep the list's order.
  entries.sort((a, b) => b.count - a.count);
  const shares = sharesBps(entries.map((entry) => entry.count));

  return {
    delivered,
    returned,
    returnRateBps: rateBps(returned, delivered + returned),
    unspecified,
    reasons: entries.map((entry, index) => ({ ...entry, shareBps: shares[index] ?? 0 })),
    zones: rateRows(rows, (row) => row.zoneId),
    channels: rateRows(rows, (row) => row.channel),
  };
}
