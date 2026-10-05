import { add, MoneyError, sub, ZERO, type Poisha } from '../money/index.js';
import type { OrderStatus } from './state.js';

/**
 * Advances against an order (architecture §7, M17, D-013, D-230 to D-233).
 *
 * A buyer sends money by bKash before the parcel moves, usually the delivery charge. That
 * money has a life of its own, and these functions are its rules. The service does the
 * writing.
 *
 * 1. The agent records a **claim**: method, transaction reference, amount. Nothing posts,
 *    and the COD does not move. A claim is a promise, not money (D-013).
 * 2. Accounts **verifies** it into a named wallet (or rejects it). Verification posts
 *    Dr Wallet / Cr Customer advance and, while the parcel has not gone, lowers the COD.
 * 3. On **delivery** the delivery journal relieves Customer advance by what the delivery
 *    earned (`applicableAdvance`), and each verified advance records its share.
 * 4. On a **cancel** or a **return**, whatever is left of each advance is refunded or kept,
 *    per the brand's policy (D-232).
 */

/** How the buyer sent the money, as an agent records it. bKash is the one D-013 names. */
export const ADVANCE_METHODS = ['bkash', 'nagad', 'bank'] as const;

/**
 * Money a payment gateway took on the website and the ERP checked with that gateway (M34,
 * D-526). Never typed by an agent: the website's payment is validated with SSLCommerz and
 * becomes a verified advance at once, the gateway's validation being the evidence accounts
 * would otherwise look for.
 */
export const GATEWAY_ADVANCE_METHODS = ['sslcommerz'] as const;
export type GatewayAdvanceMethod = (typeof GATEWAY_ADVANCE_METHODS)[number];

export type AdvanceMethod = (typeof ADVANCE_METHODS)[number] | GatewayAdvanceMethod;

export const ADVANCE_STATUSES = [
  /** Recorded by the agent. Nothing posted. */
  'pending',
  /** Accounts found no such money. Nothing posted, and nothing ever will be. */
  'rejected',
  /** In the wallet and in the books, waiting for the order to end. */
  'verified',
  /** All of it paid for a delivery. */
  'applied',
  /** Owed back to the buyer: the order ended without using it. Still a liability. */
  'refund_due',
  /** Sent back. */
  'refunded',
  /** All of what was left kept by the brand, per its policy: Other income. */
  'forfeited',
  /** A verification undone before anything used it: reversed in the books (D-236). */
  'voided',
] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

/** What a brand does with an advance its order did not use (D-232). */
export type AdvanceDisposition = 'refund' | 'forfeit';

export interface AdvancePolicy {
  readonly onCancel: AdvanceDisposition;
  readonly onReturn: AdvanceDisposition;
}

/**
 * The defaults when a brand has not chosen (D-232, ASSUMED).
 *
 * A cancel before the parcel moves is usually the brand's doing (out of stock, a duplicate,
 * a wrong size), and keeping a buyer's money for a parcel that never left is a complaint at
 * best: refund. A return is a buyer refusing a parcel the brand paid a courier to carry, and
 * that trip is what the advance was taken for: keep it, up to the delivery charge
 * (`settlementsFor`).
 */
export const DEFAULT_ADVANCE_POLICY: AdvancePolicy = { onCancel: 'refund', onReturn: 'forfeit' };

/** A stored setting, or the default when it is unset or not one of the two words. */
export function parseAdvanceDisposition(
  value: unknown,
  fallback: AdvanceDisposition,
): AdvanceDisposition {
  return value === 'refund' || value === 'forfeit' ? value : fallback;
}

/**
 * A bKash, Nagad or bank reference, as stored and compared, or null if it cannot be one.
 *
 * Upper-cased, with spaces and dashes removed and Bangla digits made ASCII, because that is
 * how an agent copying from an SMS gets it wrong. A bKash TrxID is ten letters and digits;
 * the bounds here (6 to 30) are wider because the Nagad and bank formats are not pinned down
 * by anything this system can read. At least one digit, because every reference these
 * services issue has one and a run of letters is a sentence with its spaces taken out.
 */
export function normalizeTransactionRef(input: string): string | null {
  const compact = input
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/[\s-]+/g, '')
    .toUpperCase();
  return /^[A-Z0-9]{6,30}$/.test(compact) && /[0-9]/.test(compact) ? compact : null;
}

/** What verifying a claim does, given where its order is (D-231). */
export type VerificationOutcome =
  /** Raise the order's advance and lower its COD by the amount. */
  | { readonly kind: 'apply' }
  /** The order has ended: post the receipt and settle it straight away. */
  | { readonly kind: 'settle'; readonly disposition: AdvanceDisposition }
  /** The parcel is with the courier at its old COD. Refused until the order ends. */
  | { readonly kind: 'wait' };

const BEFORE_SHIPPING: readonly OrderStatus[] = ['pending', 'confirmed', 'on_hold', 'packed'];
const IN_FLIGHT: readonly OrderStatus[] = ['shipped', 'return_in_transit', 'partially_delivered'];

/**
 * Where a verified advance goes (D-231).
 *
 * - **Before shipping, no parcel booked:** onto the order. The COD the rider collects falls by
 *   the amount, in the same transaction as the journal.
 * - **A parcel booked, or the order on the road:** the courier holds the COD it was given at
 *   booking, and lowering ours would make the rider collect one figure while the books expect
 *   another. So it waits: cancel the booking first, or verify once the order ends.
 * - **Cancelled or returned:** the money arrived and the order is over, so it is received and
 *   ended in one step, by that ending's policy.
 * - **Delivered or exchanged:** the rider collected the whole COD, so the buyer paid twice and
 *   the advance is owed back whatever the policy says. The policy is about orders that did
 *   not deliver.
 */
export function advanceVerification(input: {
  readonly status: OrderStatus;
  readonly parcelLive: boolean;
  readonly policy: AdvancePolicy;
}): VerificationOutcome {
  if (BEFORE_SHIPPING.includes(input.status)) {
    return input.parcelLive ? { kind: 'wait' } : { kind: 'apply' };
  }
  if (IN_FLIGHT.includes(input.status)) return { kind: 'wait' };
  if (input.status === 'cancelled') return { kind: 'settle', disposition: input.policy.onCancel };
  if (input.status === 'returned') return { kind: 'settle', disposition: input.policy.onReturn };
  // delivered, exchange
  return { kind: 'settle', disposition: 'refund' };
}

/** Whether a claim may still be recorded against an order in this status. */
export function acceptsAdvanceClaim(status: OrderStatus): boolean {
  return BEFORE_SHIPPING.includes(status);
}

/**
 * Whether a verification can be undone (D-236), and if not, why.
 *
 * A mistake is fixed with a reversal journal (invariant 2), and the COD has to go back up in
 * the same transaction. That is only honest while the COD is ours to change: before the
 * parcel moves and with no booking holding the old figure. And only while nothing has used
 * the advance: a delivery that applied part of it is history the reversal cannot rewrite.
 */
export function voidVerification(input: {
  readonly advanceStatus: AdvanceStatus;
  readonly appliedPoisha: Poisha;
  readonly orderStatus: OrderStatus;
  readonly parcelLive: boolean;
}): 'ok' | 'not_verified' | 'parcel_in_flight' {
  if (input.advanceStatus !== 'verified' || input.appliedPoisha !== 0n) return 'not_verified';
  if (!BEFORE_SHIPPING.includes(input.orderStatus) || input.parcelLive) return 'parcel_in_flight';
  return 'ok';
}

/** One verified advance, as far as its money is concerned. */
export interface HeldAdvance {
  readonly id: string;
  readonly amountPoisha: Poisha;
  /** Already paid towards a delivery. */
  readonly appliedPoisha: Poisha;
  /** Already kept by the brand at its order's ending (D-232). Zero while it is held. */
  readonly keptPoisha?: Poisha;
}

/** What is left of an advance that nothing has used or kept yet. */
export function remainingOf(advance: HeldAdvance): Poisha {
  const kept = advance.keptPoisha ?? ZERO;
  if (
    advance.appliedPoisha < 0n ||
    kept < 0n ||
    add(advance.appliedPoisha, kept) > advance.amountPoisha
  ) {
    throw new MoneyError(`Advance ${advance.id} has used more than was paid; the row is corrupt.`);
  }
  return sub(sub(advance.amountPoisha, advance.appliedPoisha), kept);
}

/**
 * Spread what a delivery applied across the advances that paid for it (D-233).
 *
 * The delivery journal debits Customer advance by one figure. The order's advance column is
 * the verified advances plus any exchange credit (M10), and the credit goes first: it is
 * already the buyer's money for this order and has no other way out, while an advance left
 * over has a refund path. What remains is shared out oldest first, the order the buyer paid
 * in and the rule every other open-item allocation here uses (D-193).
 *
 * Throws if the advances cannot hold their share: the journal would then relieve a liability
 * the rows say was never there.
 */
export function allocateApplied(
  advances: readonly HeldAdvance[],
  appliedPoisha: Poisha,
  otherCreditPoisha: Poisha = ZERO,
): readonly { readonly id: string; readonly appliedPoisha: Poisha }[] {
  if (appliedPoisha < 0n || otherCreditPoisha < 0n) {
    throw new MoneyError('An applied amount cannot be negative.');
  }
  let left: Poisha =
    appliedPoisha > otherCreditPoisha ? sub(appliedPoisha, otherCreditPoisha) : ZERO;
  const shares: { id: string; appliedPoisha: Poisha }[] = [];
  for (const advance of advances) {
    if (left === 0n) break;
    const remaining = remainingOf(advance);
    if (remaining === 0n) continue;
    const share = remaining < left ? remaining : left;
    shares.push({ id: advance.id, appliedPoisha: share });
    left = sub(left, share);
  }
  if (left > 0n) {
    throw new MoneyError(
      `A delivery applied ${String(appliedPoisha)} poisha of advance, but the verified advances hold less.`,
    );
  }
  return shares;
}

/** What one advance's ending is: how much the brand keeps, and how much goes back. */
export interface AdvanceSettlement {
  readonly id: string;
  /** Kept as Other income, now. */
  readonly keptPoisha: Poisha;
  /** Owed back to the buyer; posted when accounts records the refund. */
  readonly refundPoisha: Poisha;
}

/**
 * What an ending owes, advance by advance (D-232).
 *
 * `refund` gives back each advance's remainder. `forfeit` keeps it, **up to `keepCapPoisha`**
 * across the order, oldest first, and gives back the rest. The cap is the order's delivery
 * charge when nothing on it was delivered, and zero when something was (the delivery journal
 * already earned the charge). A brand keeps the advance because it paid for a courier trip;
 * a buyer who paid the whole order in advance and refused it is owed the goods back, and a
 * buyer who kept half a parcel paid the charge once already.
 *
 * An advance with nothing left produces nothing: it was fully applied.
 */
export function settlementsFor(
  advances: readonly HeldAdvance[],
  disposition: AdvanceDisposition,
  keepCapPoisha: Poisha = ZERO,
): readonly AdvanceSettlement[] {
  if (keepCapPoisha < 0n) throw new MoneyError('A keep cap cannot be negative.');
  let cap: Poisha = disposition === 'forfeit' ? keepCapPoisha : ZERO;
  const owed: AdvanceSettlement[] = [];
  for (const advance of advances) {
    const remaining = remainingOf(advance);
    if (remaining === 0n) continue;
    const kept = remaining < cap ? remaining : cap;
    cap = sub(cap, kept);
    owed.push({ id: advance.id, keptPoisha: kept, refundPoisha: sub(remaining, kept) });
  }
  return owed;
}

/** Σ amounts, for comparing the rows with the order's own advance column. */
export function totalOf(advances: readonly { readonly amountPoisha: Poisha }[]): Poisha {
  return advances.reduce<Poisha>((total, advance) => add(total, advance.amountPoisha), ZERO);
}
