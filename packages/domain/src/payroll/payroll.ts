import { poisha, sub, sum, ZERO, type Poisha } from '../money/index.js';

import type { AttendanceSummary } from './attendance.js';
import { PayrollError } from './errors.js';
import { applyLoanDeductions, type LoanDeduction, type OutstandingInstalment } from './loans.js';
import type { PayrollMonth } from './months.js';
import { prorate } from './proration.js';

/**
 * One payslip's arithmetic, and a run's totals (architecture §12, D-029).
 *
 * D-029: **basic + allowances + bonus − loan instalment − absence deduction, all
 * configurable**. That sentence is this file, in that order, and the order is load
 * bearing — the loan instalment is taken *after* the absence deduction, because a
 * month with three unpaid weeks cannot afford a full instalment and taking it
 * anyway is how a payslip ends up negative.
 *
 * Everything here is a function of its arguments (invariant 11), so the preview
 * screen, the run that gets approved and the journal that posts all compute the
 * same numbers. That is not a tidiness argument: the checker approves an amount,
 * and the amount that posts has to be that amount or the approval was about
 * something else.
 *
 * ## The one thing this file will not do
 *
 * It will not clamp. A net pay below zero throws, rather than being floored — see
 * `PayrollError`. Every other branch is arithmetic that cannot fail.
 */

/** Which way a salary component moves, and whether absence touches it. */
export interface SalaryComponentInput {
  /** A stable code: `house_rent`, `medical`, `transport`, `mobile`, `provident`. */
  readonly code: string;
  /** What the payslip prints. Bangla or English; the caller has already chosen. */
  readonly label: string;
  readonly direction: 'earning' | 'deduction';
  readonly amountPoisha: Poisha;
  /**
   * Whether this component prorates with attendance.
   *
   * Earnings default to true — a house-rent allowance is part of the monthly
   * salary and is docked with it, which is how it is paid in Bangladesh. A
   * component that must be paid whole regardless of attendance (a fixed mobile
   * bill reimbursement) sets this false, and then an absence never touches it.
   * Deductions are never prorated: a provident-fund contribution is a fixed
   * amount, and shrinking it because somebody was ill is not a policy anybody has.
   */
  readonly prorated?: boolean;
}

/** One row on the payslip, after the arithmetic. */
export interface PayslipComponent {
  readonly code: string;
  readonly label: string;
  readonly direction: 'earning' | 'deduction';
  readonly amountPoisha: Poisha;
}

export interface PayrollLineInput {
  readonly employeeId: string;
  /** The employee's branch, snapshotted onto the line so the journal can split P&L. */
  readonly branchId: string | null;
  readonly month: PayrollMonth;
  readonly basicPoisha: Poisha;
  /** The salary structure's allowances and fixed deductions. */
  readonly components: readonly SalaryComponentInput[];
  /** Bonus inputs for this run, already summed. Never prorated (§12). */
  readonly bonusPoisha?: Poisha;
  /** One-off deduction inputs for this run, already summed. */
  readonly otherDeductionPoisha?: Poisha;
  readonly attendance: AttendanceSummary;
  readonly loanInstalments?: readonly OutstandingInstalment[];
}

export interface PayrollLine {
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly basicPoisha: Poisha;
  readonly allowancesPoisha: Poisha;
  readonly bonusPoisha: Poisha;
  /** basic + allowances + bonus, before anything is taken off. */
  readonly grossPoisha: Poisha;
  readonly absenceDeductionPoisha: Poisha;
  /** The structure's own deduction components. */
  readonly fixedDeductionPoisha: Poisha;
  /** One-off deductions entered for this run. */
  readonly otherDeductionPoisha: Poisha;
  readonly loanDeductionPoisha: Poisha;
  readonly loanShortfallPoisha: Poisha;
  readonly deductionsPoisha: Poisha;
  readonly netPoisha: Poisha;
  /**
   * What debits `salary_expense` for this employee (§7's payroll journal).
   *
   * Earned salary net of everything except the bonus and the loan: the bonus has
   * its own expense account, and a loan deduction is a receivable coming back
   * rather than a reduction in wage cost. Derived here rather than in the posting
   * rule so the journal and the payslip cannot disagree about it.
   */
  readonly salaryExpensePoisha: Poisha;
  readonly loanDeductions: readonly LoanDeduction[];
  readonly components: readonly PayslipComponent[];
  readonly attendance: AttendanceSummary;
}

function componentsFor(input: PayrollLineInput): {
  allowances: Poisha;
  proratableAllowances: Poisha;
  fixedDeductions: Poisha;
} {
  let allowances = 0n;
  let proratable = 0n;
  let fixedDeductions = 0n;

  for (const component of input.components) {
    if (component.amountPoisha < 0n) {
      throw new PayrollError(
        'PAYROLL_INPUT_INVALID',
        `Salary component "${component.code}" is negative; use a deduction instead.`,
      );
    }
    if (component.direction === 'earning') {
      allowances += BigInt(component.amountPoisha);
      if (component.prorated !== false) proratable += BigInt(component.amountPoisha);
    } else {
      fixedDeductions += BigInt(component.amountPoisha);
    }
  }

  return {
    allowances: poisha(allowances),
    proratableAllowances: poisha(proratable),
    fixedDeductions: poisha(fixedDeductions),
  };
}

export function computePayrollLine(input: PayrollLineInput): PayrollLine {
  if (input.basicPoisha <= 0n) {
    throw new PayrollError(
      'PAYROLL_INPUT_INVALID',
      'A salary structure needs a positive basic salary.',
    );
  }
  const bonusPoisha = input.bonusPoisha ?? ZERO;
  const otherDeductionPoisha = input.otherDeductionPoisha ?? ZERO;
  if (bonusPoisha < 0n || otherDeductionPoisha < 0n) {
    throw new PayrollError(
      'PAYROLL_INPUT_INVALID',
      'A bonus and a deduction are both entered as positive amounts.',
    );
  }

  const { allowances, proratableAllowances, fixedDeductions } = componentsFor(input);
  const grossPoisha = poisha(BigInt(input.basicPoisha) + BigInt(allowances) + BigInt(bonusPoisha));

  // The absence deduction is taken against basic plus the allowances that prorate.
  // A bonus is outside it by definition (§12: bonuses come from the rules, not from
  // the calendar), and so is a component the structure marked unproratable.
  const prorateBase = poisha(BigInt(input.basicPoisha) + BigInt(proratableAllowances));
  const { deductionPoisha: absenceDeductionPoisha } = prorate({
    basePoisha: prorateBase,
    units: input.attendance.units,
    unpaidUnits: input.attendance.unpaidUnits,
  });

  const beforeLoan =
    BigInt(absenceDeductionPoisha) + BigInt(fixedDeductions) + BigInt(otherDeductionPoisha);
  if (beforeLoan > BigInt(grossPoisha)) {
    /*
     * Refused, not clamped (see the file header). This fires when a fixed deduction
     * was typed in taka rather than poisha, which is the most common way a payroll
     * input is wrong by a factor of a hundred — and the alternative behaviour, a net
     * of zero, is a payslip that looks deliberate.
     */
    throw new PayrollError(
      'PAYROLL_NET_NEGATIVE',
      'The deductions for that employee are larger than their salary for the month.',
    );
  }

  const availablePoisha = poisha(BigInt(grossPoisha) - beforeLoan);
  const loan = applyLoanDeductions({
    availablePoisha,
    month: input.month,
    instalments: input.loanInstalments ?? [],
  });

  const deductionsPoisha = poisha(beforeLoan + BigInt(loan.totalPoisha));
  const netPoisha = sub(grossPoisha, deductionsPoisha);

  // gross − bonus − (absence + fixed + other). Equivalently net + loan − bonus,
  // which is the identity §7's journal balances on; a test asserts both readings
  // agree, because two ways of saying the same number is two things that can drift.
  const salaryExpensePoisha = poisha(BigInt(input.basicPoisha) + BigInt(allowances) - beforeLoan);

  const components: PayslipComponent[] = [
    { code: 'basic', label: 'Basic', direction: 'earning', amountPoisha: input.basicPoisha },
    ...input.components.map((component) => ({
      code: component.code,
      label: component.label,
      direction: component.direction,
      amountPoisha: component.amountPoisha,
    })),
    ...(bonusPoisha > 0n
      ? [
          {
            code: 'bonus',
            label: 'Bonus',
            direction: 'earning' as const,
            amountPoisha: bonusPoisha,
          },
        ]
      : []),
    ...(absenceDeductionPoisha > 0n
      ? [
          {
            code: 'absence',
            label: 'Absence',
            direction: 'deduction' as const,
            amountPoisha: absenceDeductionPoisha,
          },
        ]
      : []),
    ...(otherDeductionPoisha > 0n
      ? [
          {
            code: 'other_deduction',
            label: 'Other deduction',
            direction: 'deduction' as const,
            amountPoisha: otherDeductionPoisha,
          },
        ]
      : []),
    ...(loan.totalPoisha > 0n
      ? [
          {
            code: 'loan_instalment',
            label: 'Loan instalment',
            direction: 'deduction' as const,
            amountPoisha: loan.totalPoisha,
          },
        ]
      : []),
  ];

  return {
    employeeId: input.employeeId,
    branchId: input.branchId,
    basicPoisha: input.basicPoisha,
    allowancesPoisha: allowances,
    bonusPoisha,
    grossPoisha,
    absenceDeductionPoisha,
    fixedDeductionPoisha: fixedDeductions,
    otherDeductionPoisha,
    loanDeductionPoisha: loan.totalPoisha,
    loanShortfallPoisha: loan.shortfallPoisha,
    deductionsPoisha,
    netPoisha,
    salaryExpensePoisha,
    loanDeductions: loan.deductions,
    components,
    attendance: input.attendance,
  };
}

export interface PayrollTotals {
  readonly employeeCount: number;
  readonly grossPoisha: Poisha;
  readonly bonusPoisha: Poisha;
  readonly absenceDeductionPoisha: Poisha;
  readonly loanDeductionPoisha: Poisha;
  readonly deductionsPoisha: Poisha;
  readonly netPoisha: Poisha;
  readonly salaryExpensePoisha: Poisha;
}

/**
 * The run's totals, and the number the checker approves.
 *
 * `netPoisha` is what the approval carries and what `salary_payable` is credited
 * with. It is a sum of whole poisha over lines that each already balance, so there
 * is no rounding at this level at all — which is the point of doing all of it
 * inside `computePayrollLine`.
 */
export function payrollRunTotals(lines: readonly PayrollLine[]): PayrollTotals {
  const empty = lines.length === 0;
  const pick = (get: (line: PayrollLine) => Poisha): Poisha => (empty ? ZERO : sum(lines.map(get)));

  const totals: PayrollTotals = {
    employeeCount: lines.length,
    grossPoisha: pick((line) => line.grossPoisha),
    bonusPoisha: pick((line) => line.bonusPoisha),
    absenceDeductionPoisha: pick((line) => line.absenceDeductionPoisha),
    loanDeductionPoisha: pick((line) => line.loanDeductionPoisha),
    deductionsPoisha: pick((line) => line.deductionsPoisha),
    netPoisha: pick((line) => line.netPoisha),
    salaryExpensePoisha: pick((line) => line.salaryExpensePoisha),
  };

  /*
   * The identity §7's journal rests on, asserted here rather than only in a test.
   *
   *   salary expense + bonus expense = salary payable + employee loan receivable
   *
   * If it ever fails, the posting rule would still produce a balanced journal —
   * because it is built from these same numbers — and the books would be wrong
   * with nothing to notice. Checking it at the point the totals are produced is
   * what turns a silent wrong answer into a loud one.
   */
  const debits = BigInt(totals.salaryExpensePoisha) + BigInt(totals.bonusPoisha);
  const credits = BigInt(totals.netPoisha) + BigInt(totals.loanDeductionPoisha);
  if (debits !== credits) {
    throw new PayrollError(
      'PAYROLL_INPUT_INVALID',
      'The payroll totals do not balance; refusing to build a journal from them.',
    );
  }
  if (BigInt(totals.grossPoisha) - BigInt(totals.deductionsPoisha) !== BigInt(totals.netPoisha)) {
    throw new PayrollError(
      'PAYROLL_INPUT_INVALID',
      'The payroll totals do not add up; refusing to build a journal from them.',
    );
  }

  return totals;
}

/** Σ earnings and Σ deductions of a payslip's rows, for the PDF and its test. */
export function payslipTotals(components: readonly PayslipComponent[]): {
  readonly earningsPoisha: Poisha;
  readonly deductionsPoisha: Poisha;
  readonly netPoisha: Poisha;
} {
  const earnings = components.filter((one) => one.direction === 'earning');
  const deductions = components.filter((one) => one.direction === 'deduction');
  const earningsPoisha = earnings.length === 0 ? ZERO : sum(earnings.map((o) => o.amountPoisha));
  const deductionsPoisha =
    deductions.length === 0 ? ZERO : sum(deductions.map((o) => o.amountPoisha));
  return {
    earningsPoisha,
    deductionsPoisha,
    netPoisha: sub(earningsPoisha, deductionsPoisha),
  };
}
