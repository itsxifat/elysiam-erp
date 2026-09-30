import { businessDate, withinPostingWindow, type IsoDate } from '../dates/index.js';
import type { Poisha } from '../money/index.js';
import { linesAboveCeiling, type PricedLine } from './cart.js';

/**
 * Why a sale that reached the server is held for a manager instead of posted
 * (architecture §14 "Offline").
 *
 * The till is offline for hours at a time, so by the time a sale arrives it has
 * already happened: the customer paid and walked out with the goods. That rules
 * out the two easy answers. Refusing it would drop real money on the floor, and
 * posting it regardless would let a stale price, a discount nobody authorised or
 * a unit the system does not know about straight into the ledger. So a sale that
 * cannot be posted as it stands becomes a **review item** — recorded, visible,
 * and waiting for a person — and is never silently dropped.
 *
 * `stock_shortfall` is not decided here: whether the shelf held enough is only
 * known by trying, under the database's own guard (invariant 3). Every other
 * reason is a pure function of the sale and what the server knows about it.
 *
 * New reasons go at the end: the list is a Postgres enum (`pos.hold_reason`), and
 * `ALTER TYPE … ADD VALUE` appends.
 */
export const HOLD_REASONS = [
  /** The branch location held too few units when the sale arrived. */
  'stock_shortfall',
  /** The till charged a price other than the catalog's selling price. */
  'price_mismatch',
  /** A line's discount is above the seller's ceiling at this branch. */
  'discount_above_ceiling',
  /** The shift was closed and counted before the sale reached the server. */
  'shift_closed',
  /** The sale is dated before yesterday or after today (Asia/Dhaka, D-112). */
  'outside_posting_window',
  /** A SKU is archived in the catalog. */
  'sku_unavailable',
  /** A return names a sale whose own journal has not posted. */
  'sale_not_posted',
  /**
   * A return asks for more units, or a different refund, than the receipt still
   * allows — another till returned some of them first, or the sale was voided.
   * The refund already left the drawer, so it is held rather than refused.
   */
  'return_mismatch',
  /**
   * The document says it happened before its shift opened, after it closed, or in
   * the future (D-174). A till's clock that is wrong, or a payload somebody edited,
   * would otherwise post straight into a day that was already counted.
   */
  'outside_shift',
] as const;

export type HoldReason = (typeof HOLD_REASONS)[number];

export function isHoldReason(value: string): value is HoldReason {
  return (HOLD_REASONS as readonly string[]).includes(value);
}

export interface HoldCheckLine extends PricedLine {
  /**
   * The catalog's selling price now, archived SKUs included (D-173).
   *
   * It used to be null for an archived SKU, which switched the discount check off
   * for exactly the lines being cleared out: a ৳2,000 shirt rung up at ৳200 was
   * held only as "unavailable", and a reviewer with no discount right could post it.
   */
  readonly catalogPricePoisha: Poisha;
  /** Whether the SKU is active in the catalog. */
  readonly available: boolean;
}

export interface ShiftWindow {
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

export interface HoldCheckInput {
  readonly lines: readonly HoldCheckLine[];
  /** The seller's ceiling at this sale's branch (`discountCeilingBps`). */
  readonly ceilingBps: number;
  readonly shiftOpen: boolean;
  readonly shift: ShiftWindow;
  readonly occurredAt: Date;
  readonly now: Date;
}

/**
 * How far a till's clock may disagree with the server's before a document's time
 * is not believed. Five minutes covers a phone that drifted since its last sync;
 * it does not cover a clock set to yesterday.
 */
export const TILL_CLOCK_TOLERANCE_MS = 5 * 60_000;

/** Whether a document's time falls outside the shift it names, or in the future. */
export function outsideShift(occurredAt: Date, shift: ShiftWindow, now: Date): boolean {
  const at = occurredAt.getTime();
  if (at < shift.openedAt.getTime() - TILL_CLOCK_TOLERANCE_MS) return true;
  if (at > now.getTime() + TILL_CLOCK_TOLERANCE_MS) return true;
  if (shift.closedAt !== null && at > shift.closedAt.getTime() + TILL_CLOCK_TOLERANCE_MS) {
    return true;
  }
  return false;
}

/** Every reason this sale may not post as it stands, in a stable order. */
export function saleHoldReasons(input: HoldCheckInput): HoldReason[] {
  const reasons: HoldReason[] = [];
  if (input.lines.some((line) => !line.available)) reasons.push('sku_unavailable');
  if (input.lines.some((line) => line.catalogPricePoisha !== line.unitPricePoisha)) {
    reasons.push('price_mismatch');
  }
  const catalogPrices = input.lines.map((line) => line.catalogPricePoisha);
  if (linesAboveCeiling(input.lines, catalogPrices, input.ceilingBps).length > 0) {
    reasons.push('discount_above_ceiling');
  }
  if (!input.shiftOpen) reasons.push('shift_closed');
  if (!withinPostingWindow(input.occurredAt, input.now)) reasons.push('outside_posting_window');
  if (outsideShift(input.occurredAt, input.shift, input.now)) reasons.push('outside_shift');
  return reasons;
}

/**
 * The business date a held sale's journal carries when a manager posts it.
 *
 * Its own day when that day is still inside the posting window and its branch has
 * not closed it, so a sale held for twenty minutes over a stock correction lands in
 * the day book it belongs to. Today otherwise: §7 needs an approval for anything
 * earlier than yesterday, and a day whose till was counted and signed off must not
 * change after the fact (D-174). The original date stays on the sale row, and the
 * journal memo names it.
 */
export function postingDateFor(occurredAt: Date, now: Date, dayClosed = false): IsoDate {
  return withinPostingWindow(occurredAt, now) && !dayClosed
    ? businessDate(occurredAt)
    : businessDate(now);
}
