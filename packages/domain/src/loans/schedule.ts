import type { IsoDate } from '../dates/index.js';
import { allocate, divideRounded, poisha, ZERO, type Poisha } from '../money/index.js';

/**
 * A company loan's repayment schedule (architecture §15, M26).
 *
 * The company borrows; the lender is owed principal plus interest, paid monthly. Two
 * methods (D-020, reducing balance by default), both monthly with a nominal annual rate
 * in basis points (1200 = 12% a year, so 1% a month; D-294):
 *
 * - **flat**: interest is charged on the original principal for the whole term,
 *   `principal × rate × months / 12`, rounded once. Principal and interest are each
 *   spread over the instalments with `allocate` (largest remainder), so both sum exactly.
 * - **reducing**: equal instalments `P·r·(1+r)^n / ((1+r)^n − 1)`, `r = rate / 12`,
 *   computed as an exact ratio of bigints and rounded once. Each month's interest is the
 *   principal still owed × r, rounded; the principal is the instalment less that
 *   interest; **the last instalment takes whatever principal remains** (last-instalment
 *   rounding). That is how a bank's own table is built, and it is what makes
 *   Σ principal = the loan amount exactly rather than within a poisha or two.
 *
 * Every rounding goes through `divideRounded` (half away from zero), the money module's
 * single rounding rule. A zero rate splits the principal evenly with `allocate`.
 */

export const LOAN_METHODS = ['flat', 'reducing'] as const;
export type LoanMethod = (typeof LOAN_METHODS)[number];

/** Thirty years of monthly instalments. */
export const MAX_LOAN_TENURE_MONTHS = 360;
/** 100% a year. A rate above it is a typo in basis points, not a loan. */
export const MAX_LOAN_RATE_BPS = 10_000;

/** 12 months × 10,000 basis points: a monthly rate is `rateBps / 120,000`. */
const MONTHLY_DENOMINATOR = 120_000n;

export type LoansErrorCode = 'LOAN_TERMS_INVALID';

/** What the schedule refuses. The code is in `packages/contracts/src/errors.ts`. */
export class LoansError extends Error {
  constructor(
    readonly code: LoansErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LoansError';
  }
}

export interface LoanTerms {
  readonly principalPoisha: Poisha;
  /** Nominal annual rate in basis points: 1200 = 12% a year. */
  readonly rateBps: number;
  readonly method: LoanMethod;
  /** How many monthly instalments. */
  readonly tenureMonths: number;
  /** The first instalment's due date; the rest follow monthly from its day. */
  readonly firstDueOn: IsoDate;
}

export interface LoanInstalment {
  /** 1-based, so a statement can say "instalment 3 of 12". */
  readonly seq: number;
  readonly dueOn: IsoDate;
  readonly principalPoisha: Poisha;
  readonly interestPoisha: Poisha;
  readonly totalPoisha: Poisha;
  /** Principal still owed once this instalment is paid. Zero after the last. */
  readonly balanceAfterPoisha: Poisha;
}

/**
 * `date` plus `months` calendar months, keeping its day where the month has it and
 * otherwise the month's last day: 31 Jan + 1 month is 28 (or 29) Feb, + 2 is 31 Mar.
 * Always counted from the same anchor, so the dates never drift.
 */
export function addMonthsClamped(date: IsoDate, months: number): IsoDate {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10) as IsoDate;
}

function assertTerms(terms: LoanTerms): void {
  if (terms.principalPoisha <= 0n) {
    throw new LoansError('LOAN_TERMS_INVALID', 'A loan needs a positive principal.');
  }
  if (
    !Number.isInteger(terms.tenureMonths) ||
    terms.tenureMonths < 1 ||
    terms.tenureMonths > MAX_LOAN_TENURE_MONTHS
  ) {
    throw new LoansError(
      'LOAN_TERMS_INVALID',
      `A loan runs for 1 to ${String(MAX_LOAN_TENURE_MONTHS)} monthly instalments.`,
    );
  }
  if (!Number.isInteger(terms.rateBps) || terms.rateBps < 0 || terms.rateBps > MAX_LOAN_RATE_BPS) {
    throw new LoansError(
      'LOAN_TERMS_INVALID',
      'The rate is whole basis points a year, from 0 to 10,000 (0% to 100%).',
    );
  }
  if (!(LOAN_METHODS as readonly string[]).includes(terms.method)) {
    throw new LoansError('LOAN_TERMS_INVALID', 'The method is flat or reducing.');
  }
  // Every instalment has to carry at least a poisha of principal to be worth a row.
  if (terms.principalPoisha < BigInt(terms.tenureMonths)) {
    throw new LoansError(
      'LOAN_TERMS_INVALID',
      'That loan is too small to split into that many instalments.',
    );
  }
}

/** Interest on `balance` for one month, rounded half away from zero. */
export function monthlyInterest(balance: Poisha, rateBps: number): Poisha {
  return poisha(divideRounded(balance * BigInt(rateBps), MONTHLY_DENOMINATOR));
}

/**
 * The equal monthly instalment of a reducing-balance loan, rounded once to the poisha.
 *
 * `P·r·(1+r)^n / ((1+r)^n − 1)` with `r = rate / 120,000`, rewritten over integers as
 * `P · rate · A^n / (D · (A^n − D^n))` with `A = 120,000 + rate` and `D = 120,000`, so
 * nothing is approximated before the single rounding.
 */
export function reducingInstalment(principal: Poisha, rateBps: number, months: number): Poisha {
  if (rateBps === 0) return poisha(divideRounded(principal, BigInt(months)));
  const a = MONTHLY_DENOMINATOR + BigInt(rateBps);
  const an = a ** BigInt(months);
  const dn = MONTHLY_DENOMINATOR ** BigInt(months);
  return poisha(divideRounded(principal * BigInt(rateBps) * an, MONTHLY_DENOMINATOR * (an - dn)));
}

function flatSchedule(terms: LoanTerms): LoanInstalment[] {
  const n = terms.tenureMonths;
  const totalInterest = poisha(
    divideRounded(terms.principalPoisha * BigInt(terms.rateBps) * BigInt(n), MONTHLY_DENOMINATOR),
  );
  const ones = Array.from({ length: n }, () => 1);
  const principals = allocate(terms.principalPoisha, ones);
  const interests = totalInterest === 0n ? ones.map(() => ZERO) : allocate(totalInterest, ones);

  let balance = terms.principalPoisha as bigint;
  return principals.map((principal, index) => {
    const interest = interests[index] ?? ZERO;
    balance -= principal;
    return {
      seq: index + 1,
      dueOn: addMonthsClamped(terms.firstDueOn, index),
      principalPoisha: principal,
      interestPoisha: interest,
      totalPoisha: poisha(principal + interest),
      balanceAfterPoisha: poisha(balance),
    };
  });
}

function reducingSchedule(terms: LoanTerms): LoanInstalment[] {
  const n = terms.tenureMonths;
  if (terms.rateBps === 0) {
    // No interest: an even split, exactly.
    return flatSchedule(terms);
  }

  const instalment = reducingInstalment(terms.principalPoisha, terms.rateBps, n);
  const rows: LoanInstalment[] = [];
  let balance = terms.principalPoisha as bigint;

  for (let index = 0; index < n; index += 1) {
    const interest = monthlyInterest(poisha(balance), terms.rateBps);
    const last = index === n - 1;
    // The last instalment clears the balance, whatever rounding left on it. Before that,
    // the instalment less its interest — never more than is owed. Interest never exceeds
    // the instalment: the first month's is round(P·r) and P·r < the exact instalment, and
    // the balance only falls from there.
    let principal = last ? balance : (instalment as bigint) - interest;
    if (principal > balance) principal = balance;
    if (principal < 0n) principal = 0n;
    balance -= principal;
    rows.push({
      seq: index + 1,
      dueOn: addMonthsClamped(terms.firstDueOn, index),
      principalPoisha: poisha(principal),
      interestPoisha: interest,
      totalPoisha: poisha(principal + interest),
      balanceAfterPoisha: poisha(balance),
    });
  }
  return rows;
}

/**
 * The schedule for a loan's terms. Throws `LoansError('LOAN_TERMS_INVALID')` for terms
 * that are not a loan, or that would leave an instalment of nothing to pay — which
 * happens only when a tiny principal is stretched over a long term at a high rate, and
 * the rounded instalment clears the debt early (D-294).
 */
export function loanSchedule(terms: LoanTerms): LoanInstalment[] {
  assertTerms(terms);
  const rows = terms.method === 'flat' ? flatSchedule(terms) : reducingSchedule(terms);
  if (rows.some((row) => row.totalPoisha <= 0n)) {
    throw new LoansError(
      'LOAN_TERMS_INVALID',
      'Those terms leave an instalment with nothing to pay. Shorten the tenure or check the rate.',
    );
  }
  return rows;
}

export interface ScheduleTotals {
  readonly principalPoisha: Poisha;
  readonly interestPoisha: Poisha;
  readonly totalPoisha: Poisha;
}

export function scheduleTotals(rows: readonly LoanInstalment[]): ScheduleTotals {
  let principal = 0n;
  let interest = 0n;
  for (const row of rows) {
    principal += row.principalPoisha;
    interest += row.interestPoisha;
  }
  return {
    principalPoisha: poisha(principal),
    interestPoisha: poisha(interest),
    totalPoisha: poisha(principal + interest),
  };
}
