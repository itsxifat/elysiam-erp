import { allocate, sub, sum, ZERO, type Poisha } from '../money/index.js';

import { PayrollError } from './errors.js';

/**
 * The one rounding site in payroll (invariant 1).
 *
 * Every taka of a monthly salary has to end up in exactly one of two places: the
 * employee's pay, or the absence deduction. That is not a nice property, it is the
 * milestone's first acceptance check — "3 employees, 1 loan and some absences
 * produce exact net pay and journals" — and the obvious implementation fails it.
 *
 * The obvious implementation is `perDay = gross / workingDays` and then
 * `deduction = perDay × absentDays`. With ৳30,000.00 over 22 days that is
 * 136,363.6363… poisha a day; rounded to 136,364 and multiplied by 3 absences the
 * deduction is 409,092 and the pay is 2,590,908 — which sums to 3,000,000, by luck.
 * With 26 days and 7 absences it does not, and the shortfall lands nowhere: the
 * journal still balances because it is built from the same wrong numbers, so
 * nothing in the system notices. That is the failure this function exists to make
 * impossible.
 *
 * Instead the salary is split across the month's half-day units **once**, with
 * `allocate`'s largest-remainder method, which guarantees the parts sum to the
 * total exactly. The deduction is then a sum of whole parts, so pay + deduction =
 * salary by construction rather than by arithmetic luck.
 *
 * ## Which units are forfeited
 *
 * `allocate` gives its leftover poisha to the earliest parts, so the parts are not
 * all equal — with 3,000,000 over 44 units, four of them are 68,182 and forty are
 * 68,181. The deduction therefore takes the **last** `unpaid` parts, the cheapest
 * ones. It is an arbitrary choice that has to be made somewhere and made the same
 * way every time; making it this way means a stray rounding poisha goes to the
 * employee rather than to the company, which is the direction to be wrong in.
 */

export interface ProrationInput {
  /** Basic plus the allowances that prorate. Never includes a bonus. */
  readonly basePoisha: Poisha;
  /** Twice the month's working days, from `attendanceSummary`. */
  readonly units: number;
  /** Forfeited plus not-employed half-day units. */
  readonly unpaidUnits: number;
}

export interface ProrationResult {
  readonly payablePoisha: Poisha;
  readonly deductionPoisha: Poisha;
}

export function prorate(input: ProrationInput): ProrationResult {
  const { basePoisha, units, unpaidUnits } = input;
  if (basePoisha < 0n) {
    throw new PayrollError('PAYROLL_INPUT_INVALID', 'A salary cannot be negative.');
  }
  if (!Number.isInteger(units) || units < 0) {
    throw new PayrollError('PAYROLL_INPUT_INVALID', 'Half-day units are a whole count.');
  }
  if (!Number.isInteger(unpaidUnits) || unpaidUnits < 0) {
    throw new PayrollError('PAYROLL_INPUT_INVALID', 'Unpaid half-day units are a whole count.');
  }
  if (unpaidUnits > units) {
    // Not clamped. More unpaid units than the month has is a counting bug
    // upstream, and silently paying zero would hide it behind a plausible-looking
    // payslip.
    throw new PayrollError(
      'PAYROLL_ATTENDANCE_INVALID',
      'More half-days are unpaid than the month has working half-days.',
    );
  }

  /*
   * A month with no working days pays in full.
   *
   * It looks like a degenerate case to refuse, but it is a real one: an org whose
   * calendar marks a whole week of Eid as holidays in a short month can reach zero
   * working days, and then nobody was absent — there was nothing to be absent
   * from. Paying zero would dock everybody for the holiday the org declared.
   */
  if (units === 0 || unpaidUnits === 0) {
    return { payablePoisha: basePoisha, deductionPoisha: ZERO };
  }
  if (unpaidUnits === units) {
    return { payablePoisha: ZERO, deductionPoisha: basePoisha };
  }

  const shares = allocate(
    basePoisha,
    Array.from({ length: units }, () => 1),
  );
  const deductionPoisha = sum(shares.slice(units - unpaidUnits));
  return { payablePoisha: sub(basePoisha, deductionPoisha), deductionPoisha };
}
