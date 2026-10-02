/**
 * Why parcels come back (M17 check 3, D-234).
 *
 * A COD brand's return rate is its margin, and "return rate is 18%" is not something anyone
 * can act on. "Half of the returns are `customer_unreachable`" is: call before dispatch.
 *
 * The reasons are a fixed list, translated, plus the free-text note every return already
 * carries. A brand-editable list would make the report incomparable across months the moment
 * someone renamed an entry, and across the five brands for the owner who reads all five. A
 * reason that does not fit is `other` with a note, and a note that keeps recurring is a
 * candidate for the list (a decision row, not a setting).
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
  'other',
] as const;

export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export function isReturnReasonCode(value: unknown): value is ReturnReasonCode {
  return typeof value === 'string' && (RETURN_REASON_CODES as readonly string[]).includes(value);
}

/** A return is a parcel received back; an exchange is a delivered order swapped (§9). */
export type ReturnKind = 'return' | 'exchange';

/** One group of recorded returns, as the SQL counts them. */
export interface ReturnReasonCount {
  readonly reason: ReturnReasonCode;
  readonly kind: ReturnKind;
  readonly count: number;
}

export interface ReturnReasonLine {
  readonly reason: ReturnReasonCode;
  readonly returns: number;
  readonly exchanges: number;
  readonly total: number;
  /** Basis points of every return and exchange. The lines sum to exactly 10,000. */
  readonly shareBps: number;
}

export interface ReturnReasonReport {
  readonly total: number;
  readonly returns: number;
  readonly exchanges: number;
  /** Most common first; ties keep the list's own order, so the table does not reshuffle. */
  readonly reasons: readonly ReturnReasonLine[];
}

/**
 * Split 10,000 basis points across counts by largest remainder, so the shares sum to exactly
 * 10,000. Rounding each share on its own lets a column of percentages add up to 99.99% or
 * 100.01%, which is the first thing anybody checks on a report.
 */
export function sharesBps(counts: readonly number[]): number[] {
  for (const count of counts) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('sharesBps(): a count must be a whole number ≥ 0.');
    }
  }
  const total = counts.reduce((acc, count) => acc + count, 0);
  if (total === 0) return counts.map(() => 0);
  const whole = BigInt(total);
  const floors = counts.map((count) => (BigInt(count) * 10_000n) / whole);
  const order = counts
    .map((count, index) => ({ index, rest: (BigInt(count) * 10_000n) % whole }))
    // Largest remainder first; ties to the earlier entry, so the result is deterministic.
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.index - b.index));
  let left = 10_000n - floors.reduce((acc, value) => acc + value, 0n);
  const result = [...floors];
  for (const { index } of order) {
    if (left === 0n) break;
    result[index] = (result[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return result.map((value) => Number(value));
}

/** The report by reason (check 3): counts per reason, split by kind, with exact shares. */
export function summarizeReturnReasons(rows: readonly ReturnReasonCount[]): ReturnReasonReport {
  const byReason = new Map<ReturnReasonCode, { returns: number; exchanges: number }>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.count) || row.count < 0) {
      throw new RangeError('summarizeReturnReasons(): a count must be a whole number ≥ 0.');
    }
    if (!isReturnReasonCode(row.reason)) {
      throw new RangeError(`summarizeReturnReasons(): "${String(row.reason)}" is not a reason.`);
    }
    const entry = byReason.get(row.reason) ?? { returns: 0, exchanges: 0 };
    if (row.kind === 'exchange') entry.exchanges += row.count;
    else entry.returns += row.count;
    byReason.set(row.reason, entry);
  }

  const present = RETURN_REASON_CODES.map((reason) => {
    const entry = byReason.get(reason) ?? { returns: 0, exchanges: 0 };
    return { reason, ...entry, total: entry.returns + entry.exchanges };
  }).filter((line) => line.total > 0);
  // Stable sort: most common first, ties keep the list's order.
  present.sort((a, b) => b.total - a.total);
  const shares = sharesBps(present.map((line) => line.total));

  return {
    total: present.reduce((acc, line) => acc + line.total, 0),
    returns: present.reduce((acc, line) => acc + line.returns, 0),
    exchanges: present.reduce((acc, line) => acc + line.exchanges, 0),
    reasons: present.map((line, index) => ({ ...line, shareBps: shares[index] ?? 0 })),
  };
}
