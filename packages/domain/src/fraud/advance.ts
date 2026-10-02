import { add, MoneyError, sub, ZERO, type Poisha } from '../money/index.js';
import type { FraudDecision } from '../orders/state.js';
import type { AdvanceRequirement } from './rules.js';

/**
 * Advances against an order (architecture §7, §10, M17, D-233 to D-236).
 *
 * A low-trust buyer is asked to send money before the parcel moves, usually the delivery
 * charge, by bKash. The advance then has a life of its own:
 *
 * - the agent records the claim;
 * - accounts verifies it against the wallet;
 * - on delivery it pays part of the order;
 * - on a cancel or a return, whatever was not used is given back or kept, per the
 *   brand's policy.
 *
 * These functions are the arithmetic and the rules of that life. The service does the
 * writing.
 */

/** The amount the order has to have verified before it may confirm (D-233). */
export function requiredAdvancePoisha(
  requirements: readonly AdvanceRequirement[],
  deliveryChargePoisha: Poisha,
): Poisha {
  /*
   * The largest, not the sum. Two rules that each ask for "the delivery charge" ask for
   * the same money, and asking a buyer to pay it twice because two rules agreed would
   * be the rule list's bookkeeping leaking into the customer's bKash.
   */
  let required: Poisha = ZERO;
  for (const requirement of requirements) {
    const amount = requirement.basis === 'fixed' ? requirement.amountPoisha : deliveryChargePoisha;
    if (amount > required) required = amount;
  }
  return required;
}

export type AdvanceGateOutcome =
  /** The decision does not ask for an advance. */
  | { readonly outcome: 'not_required' }
  /** The verified advances cover the requirement. */
  | { readonly outcome: 'satisfied' }
  /** They do not, and an override reason was given; who may override is the server's question. */
  | { readonly outcome: 'overridden' }
  /** They do not. The confirm is refused with `ORDER_ADVANCE_REQUIRED`. */
  | { readonly outcome: 'missing'; readonly shortPoisha: Poisha };

/**
 * Whether a `require_advance` order may confirm (check 2).
 *
 * Only **verified** money counts. A claim the agent typed in is a promise, and the point
 * of the rule is that the brand has the money before the parcel moves (D-013).
 *
 * A requirement of zero is met. That happens when the delivery charge is the basis and
 * the order delivers free. There is nothing to collect up front, and a brand that wants
 * money even then names a fixed amount on its rule.
 */
export function advanceGate(input: {
  readonly decision: FraudDecision;
  readonly requiredPoisha: Poisha;
  readonly verifiedPoisha: Poisha;
  readonly overrideReason: string | null;
}): AdvanceGateOutcome {
  if (input.decision !== 'require_advance') return { outcome: 'not_required' };
  if (input.verifiedPoisha >= input.requiredPoisha) return { outcome: 'satisfied' };
  const reason = input.overrideReason?.trim() ?? '';
  if (reason !== '') return { outcome: 'overridden' };
  return { outcome: 'missing', shortPoisha: sub(input.requiredPoisha, input.verifiedPoisha) };
}

/** One verified advance, as far as its money is concerned. */
export interface HeldAdvance {
  readonly id: string;
  readonly amountPoisha: Poisha;
  /** Already applied to a delivery. */
  readonly appliedPoisha: Poisha;
  /** Already refunded or forfeited. */
  readonly settledPoisha: Poisha;
}

/** What is left of an advance that nothing has used yet. */
export function remainingOf(advance: HeldAdvance): Poisha {
  const used = add(advance.appliedPoisha, advance.settledPoisha);
  if (used > advance.amountPoisha) {
    throw new MoneyError(
      `Advance ${advance.id} has applied and settled more than was paid; the row is corrupt.`,
    );
  }
  return sub(advance.amountPoisha, used);
}

/**
 * Spread the amount a delivery applied across the advances that paid it, oldest first.
 *
 * The delivery journal debits Customer advance by one figure (`applicableAdvance`). The
 * rows have to agree with it, so each advance records its own share. Then a later
 * cancel or return settles exactly what is left, and Σ applied + Σ settled always equals
 * what was paid.
 *
 * Oldest first, because that is the order the buyer paid in. It is also the rule every
 * other open-item allocation in this system uses (D-193).
 *
 * Throws if the advances do not hold that much. The journal would then relieve a
 * liability the rows say was never there.
 */
export function allocateApplied(
  advances: readonly HeldAdvance[],
  appliedPoisha: Poisha,
): readonly { readonly id: string; readonly appliedPoisha: Poisha }[] {
  if (appliedPoisha < 0n) throw new MoneyError('An applied amount cannot be negative.');
  let left: Poisha = appliedPoisha;
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
      `A delivery applied ${appliedPoisha} poisha of advance, but the verified advances hold less.`,
    );
  }
  return shares;
}

/** What a brand does with an unused advance (D-235, D-236). */
export type AdvanceDisposition = 'refund' | 'forfeit';

export const ADVANCE_DISPOSITIONS: readonly AdvanceDisposition[] = ['refund', 'forfeit'];

/** The defaults when a brand has not chosen (D-235, D-236). */
export const DEFAULT_ADVANCE_POLICY: {
  readonly onCancel: AdvanceDisposition;
  readonly onReturn: AdvanceDisposition;
} = {
  /*
   * A cancel before the parcel moves is usually the brand's doing (out of stock, a
   * duplicate, a wrong size), and keeping a customer's money for a parcel that never
   * left is a complaint at best. So the default is to give it back.
   */
  onCancel: 'refund',
  /*
   * A return is the case `require_advance` exists for: the buyer refused the parcel, and
   * the advance paid for the trip. So the default is to keep it.
   */
  onReturn: 'forfeit',
};

/** What to post for one advance when its order is cancelled or returned. */
export interface AdvanceSettlement {
  readonly id: string;
  readonly disposition: AdvanceDisposition;
  readonly amountPoisha: Poisha;
}

/**
 * The settlements an ending owes: each verified advance's remainder, by the policy.
 *
 * An advance with nothing left produces no settlement (it was fully applied).
 */
export function settlementsFor(
  advances: readonly HeldAdvance[],
  disposition: AdvanceDisposition,
): readonly AdvanceSettlement[] {
  const owed: AdvanceSettlement[] = [];
  for (const advance of advances) {
    const remaining = remainingOf(advance);
    if (remaining > 0n) owed.push({ id: advance.id, disposition, amountPoisha: remaining });
  }
  return owed;
}

/**
 * A bKash, Nagad or bank reference, as stored and compared.
 *
 * Upper-cased, with spaces and dashes removed, because that is how an agent copying
 * from an SMS gets it wrong. A bKash TrxID is ten letters and digits. The bounds here
 * are wider (6 to 30) because the bank and Nagad formats are not pinned down by anything
 * this system can read. Letters and digits only, so a reference cannot carry a phone
 * number with a `+` or a sentence.
 */
export function normalizeTransactionRef(input: string): string | null {
  const compact = input
    .replace(/[০-৯]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6))
    .replace(/[\s-]+/g, '')
    .toUpperCase();
  // At least one digit: every reference these services issue has one, and a run of
  // letters is a sentence with its spaces taken out ("paid by bkash").
  return /^[A-Z0-9]{6,30}$/.test(compact) && /[0-9]/.test(compact) ? compact : null;
}
