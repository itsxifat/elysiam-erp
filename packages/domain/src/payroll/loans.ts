import { allocate, poisha, sum, ZERO, type Poisha } from '../money/index.js';

import { PayrollError } from './errors.js';
import { addMonths, compareMonths, type PayrollMonth } from './months.js';

/**
 * Employee loans and their schedules (architecture §12, §7).
 *
 * A loan is company money in an employee's hands: `employee_loan_receivable`, an
 * asset with the employee as its party. Two properties make the arithmetic here
 * safe, and both are about never inventing or losing a poisha.
 *
 * **The schedule sums to the principal exactly.** ৳25,000.00 over 6 months is
 * 416,666.66… poisha an instalment, and six rounded instalments are either 4 poisha
 * short or 2 poisha over — either way the loan never reaches zero and the employee
 * is chased for four poisha forever, or the company writes off two. `allocate`
 * spreads the remainder one poisha at a time, so the instalments are
 * 416,667/416,667/416,667/416,667/416,666/416,666 and the six of them are the
 * principal.
 *
 * **A deduction never rounds at all.** It takes whole poisha off what is
 * outstanding, capped by what the payslip can afford, so an instalment is either
 * fully taken, partly taken, or not taken. Carry-over is then automatic: next
 * month's run picks up any instalment still owing with a due month that has
 * arrived. Nothing is recomputed, so nothing can drift.
 */

export interface LoanScheduleInput {
  readonly principalPoisha: Poisha;
  /** How many monthly instalments. §12 leaves the count to the agreement. */
  readonly instalments: number;
  /** The month the first instalment is deducted in. */
  readonly firstMonth: PayrollMonth;
}

export interface ScheduledInstalment {
  /** 1-based, so a payslip can say "instalment 3 of 6". */
  readonly seq: number;
  readonly dueMonth: PayrollMonth;
  readonly amountPoisha: Poisha;
}

const MAX_INSTALMENTS = 120;

export function loanSchedule(input: LoanScheduleInput): ScheduledInstalment[] {
  if (input.principalPoisha <= 0n) {
    throw new PayrollError('PAYROLL_LOAN_INVALID', 'A loan needs a positive principal.');
  }
  if (!Number.isInteger(input.instalments) || input.instalments < 1) {
    throw new PayrollError('PAYROLL_LOAN_INVALID', 'A loan needs at least one instalment.');
  }
  if (input.instalments > MAX_INSTALMENTS) {
    throw new PayrollError(
      'PAYROLL_LOAN_INVALID',
      `A loan cannot run beyond ${String(MAX_INSTALMENTS)} instalments.`,
    );
  }
  /*
   * An instalment of zero poisha is refused rather than allowed through.
   *
   * It happens when the principal is smaller than the instalment count — ৳0.05 over
   * 6 months — and a schedule with zero-value rows would mark itself deducted
   * against a payslip that took nothing, so the loan would report itself settled
   * while money was still out. Refusing says what to do instead: fewer instalments.
   */
  if (input.principalPoisha < BigInt(input.instalments)) {
    throw new PayrollError(
      'PAYROLL_LOAN_INVALID',
      'That loan is too small to split into that many instalments.',
    );
  }

  const amounts = allocate(
    input.principalPoisha,
    Array.from({ length: input.instalments }, () => 1),
  );
  return amounts.map((amountPoisha, index) => ({
    seq: index + 1,
    dueMonth: addMonths(input.firstMonth, index),
    amountPoisha,
  }));
}

/** An instalment as the payroll run finds it: what is still owed on it. */
export interface OutstandingInstalment {
  readonly instalmentId: string;
  readonly dueMonth: PayrollMonth;
  readonly remainingPoisha: Poisha;
}

export interface LoanDeduction {
  readonly instalmentId: string;
  readonly amountPoisha: Poisha;
}

export interface LoanDeductionResult {
  readonly deductions: readonly LoanDeduction[];
  readonly totalPoisha: Poisha;
  /**
   * What was due and could not be taken this month.
   *
   * On the payslip, and on the run summary the checker reads. An instalment that
   * silently did not come out is how an employee discovers in month nine that they
   * still owe four months.
   */
  readonly shortfallPoisha: Poisha;
}

export interface LoanDeductionInput {
  /** Net pay before loan deductions. Never negative; the caller has checked. */
  readonly availablePoisha: Poisha;
  readonly month: PayrollMonth;
  readonly instalments: readonly OutstandingInstalment[];
}

/**
 * Take this month's instalments out of what the payslip can afford.
 *
 * Oldest instalment first, so an arrear is cleared before a current instalment —
 * the order a person would use, and the only order in which "how many months am I
 * behind" has a stable answer. An instalment due in a later month is left alone: a
 * loan is not accelerated because somebody had a good month.
 *
 * Never takes more than `availablePoisha`, so the net pay this produces cannot go
 * negative. That cap is why nothing here needs to round: the amount taken is
 * always a whole number of poisha bounded by two whole numbers of poisha.
 */
export function applyLoanDeductions(input: LoanDeductionInput): LoanDeductionResult {
  if (input.availablePoisha < 0n) {
    throw new PayrollError(
      'PAYROLL_LOAN_INVALID',
      'Loan deductions were applied to a negative net pay.',
    );
  }

  const due = input.instalments
    .filter((instalment) => compareMonths(instalment.dueMonth, input.month) <= 0)
    .filter((instalment) => instalment.remainingPoisha > 0n)
    .slice()
    .sort((a, b) =>
      a.dueMonth === b.dueMonth
        ? a.instalmentId < b.instalmentId
          ? -1
          : a.instalmentId > b.instalmentId
            ? 1
            : 0
        : compareMonths(a.dueMonth, b.dueMonth),
    );

  let available = BigInt(input.availablePoisha);
  const deductions: LoanDeduction[] = [];
  let shortfall = 0n;

  for (const instalment of due) {
    const remaining = BigInt(instalment.remainingPoisha);
    const taken = remaining <= available ? remaining : available;
    if (taken > 0n) {
      deductions.push({ instalmentId: instalment.instalmentId, amountPoisha: poisha(taken) });
      available -= taken;
    }
    shortfall += remaining - taken;
  }

  return {
    deductions,
    totalPoisha: deductions.length === 0 ? ZERO : sum(deductions.map((one) => one.amountPoisha)),
    shortfallPoisha: poisha(shortfall),
  };
}
