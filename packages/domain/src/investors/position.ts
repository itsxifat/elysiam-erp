import type { IsoDate } from '../dates/index.js';
import { sub, sum, ZERO, type Poisha } from '../money/index.js';
import { InvestorsError } from './errors.js';

/**
 * An investor's position, from the movements behind it (architecture §15).
 *
 * Two balances, and keeping them apart is the point. §7 gives an investor **two**
 * accounts: `investor_capital` (equity — what they put in) and `investor_payable`
 * (a liability — profit that has been declared theirs but not yet paid). One
 * "investor balance" would be the sum of an equity account and a liability
 * account, which is not a number that means anything, and the withdrawal it
 * authorized would post to whichever account the code happened to pick.
 *
 * So a withdrawal names its kind, and the kind decides both which balance it is
 * checked against and which account it debits:
 *
 * - `capital` → Dr Investor capital / Cr W. Bounded by capital **not under
 *   lock-in**.
 * - `profit`  → Dr Investor payable / Cr W. Bounded by what has been declared
 *   and not yet paid.
 *
 * **Lock-in is per contribution, not per investor** (§15: "amount, date, terms,
 * lock-in"). An investor who put in ৳5,00,000 two years ago and ৳10,00,000 last
 * month under a one-year lock-in may withdraw the first and not the second, and
 * a single `locked_until` on the investor row cannot express that — it would
 * either freeze the old money or release the new.
 *
 * Every function here is a function of its arguments (invariant 11): the service
 * reads the rows, this decides what they mean, and the same arithmetic answers in
 * the API, in a statement and in a test.
 */

/** One capital contribution, as the position needs to see it. */
export interface CapitalLot {
  readonly amountPoisha: Poisha;
  /** The date the lock-in ends. Null when the money was never locked. */
  readonly lockInUntil: IsoDate | null;
}

export interface PositionInput {
  /** Every posted contribution. */
  readonly lots: readonly CapitalLot[];
  /** Capital already withdrawn and paid. */
  readonly capitalPaidPoisha: readonly Poisha[];
  /** Profit declared as this investor's share, per distribution line. */
  readonly declaredPoisha: readonly Poisha[];
  /** Declared profit already paid out. */
  readonly profitPaidPoisha: readonly Poisha[];
  /** The Asia/Dhaka business date the position is asked about (invariant 8). */
  readonly onDate: IsoDate;
}

export interface InvestorPosition {
  readonly contributedPoisha: Poisha;
  readonly capitalWithdrawnPoisha: Poisha;
  /** Contributions less capital withdrawn: the `investor_capital` balance. */
  readonly capitalPoisha: Poisha;
  /** Of that capital, how much is still inside its lock-in on `onDate`. */
  readonly lockedPoisha: Poisha;
  /** Capital a withdrawal may draw on today. Never negative. */
  readonly withdrawableCapitalPoisha: Poisha;
  readonly declaredPoisha: Poisha;
  readonly profitPaidPoisha: Poisha;
  /** Declared less paid: the `investor_payable` balance. */
  readonly payablePoisha: Poisha;
}

/** What a withdrawal takes out of. */
export const WITHDRAWAL_KINDS = ['capital', 'profit'] as const;
export type WithdrawalKind = (typeof WITHDRAWAL_KINDS)[number];

export function investorPosition(input: PositionInput): InvestorPosition {
  const contributed = sum(input.lots.map((lot) => lot.amountPoisha));
  const capitalWithdrawn = sum(input.capitalPaidPoisha);
  const capital = sub(contributed, capitalWithdrawn);

  const declared = sum(input.declaredPoisha);
  const profitPaid = sum(input.profitPaidPoisha);

  /*
   * Locked capital is the sum of the lots still inside their lock-in, capped at
   * the capital that is actually left. Without the cap, an investor who put in
   * two locked lots and withdrew one of them would still show both as locked,
   * and the money they legitimately hold would be frozen forever.
   *
   * `>` rather than `>=`: a lock-in "until 31 Dec" is over on 31 Dec, which is
   * how every other date in this system reads — a period ends on its last day.
   */
  const stillLocked = sum(
    input.lots
      .filter((lot) => lot.lockInUntil !== null && lot.lockInUntil > input.onDate)
      .map((lot) => lot.amountPoisha),
  );
  const locked = stillLocked > capital ? capital : stillLocked;
  const free = sub(capital, locked);

  return {
    contributedPoisha: contributed,
    capitalWithdrawnPoisha: capitalWithdrawn,
    capitalPoisha: capital,
    lockedPoisha: locked < 0n ? ZERO : locked,
    // A negative capital balance would mean more was paid out than came in,
    // which the withdrawal check makes impossible; clamped anyway, because a
    // negative "withdrawable" would read as an allowance rather than a debt.
    withdrawableCapitalPoisha: free < 0n ? ZERO : free,
    declaredPoisha: declared,
    profitPaidPoisha: profitPaid,
    payablePoisha: sub(declared, profitPaid),
  };
}

/** The ceiling on a withdrawal of this kind, from this position. */
export function withdrawableFor(position: InvestorPosition, kind: WithdrawalKind): Poisha {
  const available =
    kind === 'capital' ? position.withdrawableCapitalPoisha : position.payablePoisha;
  return available < 0n ? ZERO : available;
}

/**
 * Refuse a withdrawal the position cannot cover, and say which limit it hit.
 *
 * Capital under lock-in gets its own code, because "you hold this money but not
 * yet" and "you do not hold this money" are different conversations with an
 * investor, and a single `INSUFFICIENT` would leave the console unable to tell
 * them apart.
 */
export function assertWithdrawable(
  position: InvestorPosition,
  kind: WithdrawalKind,
  amountPoisha: Poisha,
): void {
  if (amountPoisha <= 0n) {
    throw new InvestorsError(
      'INVESTOR_POSITION_INSUFFICIENT',
      'A withdrawal amount must be positive.',
    );
  }

  const available = withdrawableFor(position, kind);
  if (amountPoisha <= available) return;

  if (kind === 'capital' && position.lockedPoisha > 0n && amountPoisha <= position.capitalPoisha) {
    throw new InvestorsError(
      'INVESTOR_CAPITAL_LOCKED',
      `${position.lockedPoisha.toString()} poisha of this capital is still inside its lock-in.`,
    );
  }
  throw new InvestorsError(
    'INVESTOR_POSITION_INSUFFICIENT',
    kind === 'capital'
      ? `Only ${available.toString()} poisha of capital can be withdrawn.`
      : `Only ${available.toString()} poisha of declared profit is unpaid.`,
  );
}
