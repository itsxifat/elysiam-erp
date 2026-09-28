import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { poisha, sum } from '../money/index.js';
import { employeeLoanDisbursedDraft } from '../posting/employee-loan.js';
import {
  payrollPostedDraft,
  salaryPaidDraft,
  type PayrollAccount,
} from '../posting/payroll-posted.js';
import { validateJournalDraft } from '../ledger/index.js';

import {
  applyLoanDeductions,
  attendanceSummary,
  computePayrollLine,
  loanSchedule,
  payrollRunTotals,
  payslipTotals,
  PayrollError,
  prorate,
  reviewAttendanceCsv,
  toPayrollMonth,
  workingDays,
  addMonths,
  type WorkCalendar,
} from './index.js';

/**
 * Payroll arithmetic, proved rather than sampled (M19 acceptance check 1).
 *
 * The properties here are the ones a worked example cannot establish. "3 employees,
 * 1 loan and some absences produce exact net pay" is checked at the bottom with
 * hand-computed numbers, because a worked example is what catches a plausible but
 * wrong *model*; the fast-check properties above it are what catch the rounding bug
 * that only shows up at 26 working days and 7 absences.
 *
 * The one that matters most is the first: **pay + absence deduction = salary,
 * always**. Every implementation of proration that divides and multiplies passes a
 * handful of examples and fails this, and the poisha it loses lands nowhere — the
 * journal still balances, because it is built from the same wrong numbers.
 */

// ৳0.01 to ৳20,00,000.00, which covers a packer and a managing director.
const salary = () => fc.bigInt({ min: 1n, max: 200_000_000n }).map((value) => poisha(value));
const units = () => fc.integer({ min: 0, max: 62 });

const FRIDAY_OFF: WorkCalendar = { weeklyOff: [5], holidays: [] };

describe('prorate', () => {
  it('never loses or invents a poisha', () => {
    fc.assert(
      fc.property(salary(), units(), fc.nat(), (basePoisha, total, rawUnpaid) => {
        const unpaidUnits = total === 0 ? 0 : rawUnpaid % (total + 1);
        const result = prorate({ basePoisha, units: total, unpaidUnits });
        expect(BigInt(result.payablePoisha) + BigInt(result.deductionPoisha)).toBe(
          BigInt(basePoisha),
        );
        expect(result.payablePoisha >= 0n).toBe(true);
        expect(result.deductionPoisha >= 0n).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('pays in full for a clean month and nothing for a month entirely unpaid', () => {
    fc.assert(
      fc.property(salary(), fc.integer({ min: 1, max: 62 }), (basePoisha, total) => {
        expect(prorate({ basePoisha, units: total, unpaidUnits: 0 }).payablePoisha).toBe(
          basePoisha,
        );
        expect(prorate({ basePoisha, units: total, unpaidUnits: total }).payablePoisha).toBe(0n);
      }),
    );
  });

  it('is monotonic: one more unpaid half-day never pays more', () => {
    fc.assert(
      fc.property(salary(), fc.integer({ min: 2, max: 62 }), (basePoisha, total) => {
        let previous = BigInt(prorate({ basePoisha, units: total, unpaidUnits: 0 }).payablePoisha);
        for (let unpaid = 1; unpaid <= total; unpaid += 1) {
          const next = BigInt(
            prorate({ basePoisha, units: total, unpaidUnits: unpaid }).payablePoisha,
          );
          expect(next <= previous).toBe(true);
          previous = next;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('refuses more unpaid half-days than the month has', () => {
    expect(() => prorate({ basePoisha: poisha(1000), units: 4, unpaidUnits: 5 })).toThrow(
      PayrollError,
    );
  });

  it('pays a month with no working days in full', () => {
    // An org that declared a whole short month as Eid holiday. Nobody was absent,
    // because there was nothing to be absent from.
    expect(prorate({ basePoisha: poisha(3_000_000), units: 0, unpaidUnits: 0 })).toEqual({
      payablePoisha: 3_000_000n,
      deductionPoisha: 0n,
    });
  });

  it('does not invent the poisha a per-day rate invents', () => {
    /*
     * ৳30,000.00 over 27 working days is 55,555.55… poisha a half-day. Rounded to
     * 55,556 and multiplied back by the month's 54 units that is 3,000,024 — the
     * per-day rate has invented 24 poisha out of nothing, and every payslip built
     * by multiplying it carries a share of them. Splitting once cannot: the shares
     * of the whole month are the salary, exactly.
     */
    const shares = 54;
    const perUnit = 55_556n;
    expect(perUnit * BigInt(shares)).toBe(3_000_024n);

    let total = 0n;
    for (let unpaid = 0; unpaid <= shares; unpaid += 1) {
      const result = prorate({ basePoisha: poisha(3_000_000), units: shares, unpaidUnits: unpaid });
      expect(BigInt(result.payablePoisha) + BigInt(result.deductionPoisha)).toBe(3_000_000n);
      total = BigInt(result.deductionPoisha);
    }
    expect(total).toBe(3_000_000n);
  });
});

describe('workingDays and attendanceSummary', () => {
  it('counts a Friday-off March 2026 as 27 working days', () => {
    // March 2026 has 31 days and 4 Fridays (6, 13, 20, 27).
    expect(workingDays(FRIDAY_OFF, toPayrollMonth('2026-03'))).toHaveLength(27);
  });

  it('does not count a holiday that lands on a weekly off twice', () => {
    const calendar: WorkCalendar = { weeklyOff: [5], holidays: [toIsoDate('2026-03-06')] };
    expect(workingDays(calendar, toPayrollMonth('2026-03'))).toHaveLength(27);
  });

  it('treats an unrecorded working day as present by default and absent on request', () => {
    const month = toPayrollMonth('2026-03');
    const joinedOn = toIsoDate('2026-03-01');
    const present = attendanceSummary({ month, calendar: FRIDAY_OFF, records: [], joinedOn });
    expect(present.unpaidUnits).toBe(0);
    expect(present.unrecordedDays).toBe(27);

    const absent = attendanceSummary({
      month,
      calendar: FRIDAY_OFF,
      records: [],
      joinedOn,
      unrecorded: 'absent',
    });
    expect(absent.unpaidUnits).toBe(54);
  });

  it('prorates a mid-month joiner through notEmployedUnits', () => {
    const summary = attendanceSummary({
      month: toPayrollMonth('2026-03'),
      calendar: FRIDAY_OFF,
      records: [],
      joinedOn: toIsoDate('2026-03-16'),
    });
    // 16–31 March 2026 has 14 working days with Fridays off (20, 27 are Fridays).
    expect(summary.workingDays).toBe(27);
    expect(summary.notEmployedUnits).toBe(summary.units - 14 * 2);
  });

  it('never reports more unpaid units than the month has', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 1, max: 31 }),
            status: fc.constantFrom(
              'present',
              'late',
              'half_day',
              'absent',
              'leave_unpaid',
              'leave_paid',
              'weekly_off',
              'holiday',
            ),
          }),
          { maxLength: 40 },
        ),
        (rows) => {
          const summary = attendanceSummary({
            month: toPayrollMonth('2026-03'),
            calendar: FRIDAY_OFF,
            joinedOn: toIsoDate('2026-03-01'),
            records: rows.map((row) => ({
              date: toIsoDate(`2026-03-${String(row.day).padStart(2, '0')}`),
              status: row.status,
            })),
          });
          expect(summary.unpaidUnits).toBeLessThanOrEqual(summary.units);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('loanSchedule', () => {
  it('always sums to the principal exactly', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 120n, max: 500_000_000n }).map((value) => poisha(value)),
        fc.integer({ min: 1, max: 120 }),
        (principalPoisha, instalments) => {
          const schedule = loanSchedule({
            principalPoisha,
            instalments,
            firstMonth: toPayrollMonth('2026-04'),
          });
          expect(schedule).toHaveLength(instalments);
          expect(BigInt(sum(schedule.map((one) => one.amountPoisha)))).toBe(
            BigInt(principalPoisha),
          );
          for (const instalment of schedule) expect(instalment.amountPoisha > 0n).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('walks the months, wrapping the year', () => {
    const schedule = loanSchedule({
      principalPoisha: poisha(300),
      instalments: 3,
      firstMonth: toPayrollMonth('2026-11'),
    });
    expect(schedule.map((one) => one.dueMonth)).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(addMonths(toPayrollMonth('2026-01'), -1)).toBe('2025-12');
  });

  it('refuses a loan too small to split', () => {
    expect(() =>
      loanSchedule({
        principalPoisha: poisha(5),
        instalments: 6,
        firstMonth: toPayrollMonth('2026-04'),
      }),
    ).toThrow(PayrollError);
  });
});

describe('applyLoanDeductions', () => {
  it('never takes more than is available or more than is owed, and the parts sum', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }).map((value) => poisha(value)),
        fc.array(fc.bigInt({ min: 1n, max: 2_000_000n }), { minLength: 1, maxLength: 8 }),
        (availablePoisha, remainders) => {
          const instalments = remainders.map((remaining, index) => ({
            instalmentId: `i${String(index).padStart(3, '0')}`,
            dueMonth: addMonths(toPayrollMonth('2026-01'), index),
            remainingPoisha: poisha(remaining),
          }));
          const result = applyLoanDeductions({
            availablePoisha,
            month: toPayrollMonth('2026-12'),
            instalments,
          });
          const owed = remainders.reduce((total, value) => total + value, 0n);
          expect(BigInt(result.totalPoisha) <= BigInt(availablePoisha)).toBe(true);
          expect(BigInt(result.totalPoisha) <= owed).toBe(true);
          expect(BigInt(result.totalPoisha) + BigInt(result.shortfallPoisha)).toBe(owed);
          if (result.deductions.length > 0) {
            expect(BigInt(sum(result.deductions.map((one) => one.amountPoisha)))).toBe(
              BigInt(result.totalPoisha),
            );
          }
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('leaves a future instalment alone and clears the oldest arrear first', () => {
    const result = applyLoanDeductions({
      availablePoisha: poisha(150),
      month: toPayrollMonth('2026-04'),
      instalments: [
        { instalmentId: 'b', dueMonth: toPayrollMonth('2026-04'), remainingPoisha: poisha(100) },
        { instalmentId: 'a', dueMonth: toPayrollMonth('2026-03'), remainingPoisha: poisha(100) },
        { instalmentId: 'c', dueMonth: toPayrollMonth('2026-05'), remainingPoisha: poisha(100) },
      ],
    });
    expect(result.deductions).toEqual([
      { instalmentId: 'a', amountPoisha: 100n },
      { instalmentId: 'b', amountPoisha: 50n },
    ]);
    expect(result.shortfallPoisha).toBe(50n);
  });
});

describe('computePayrollLine', () => {
  const clean = attendanceSummary({
    month: toPayrollMonth('2026-03'),
    calendar: FRIDAY_OFF,
    records: [],
    joinedOn: toIsoDate('2026-03-01'),
  });

  it('keeps gross − deductions = net, and the payslip rows agree with both', () => {
    fc.assert(
      fc.property(
        salary(),
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.integer({ min: 0, max: clean.units }),
        (basicPoisha, allowance, bonus, unpaid) => {
          const attendance = { ...clean, forfeitedUnits: unpaid, unpaidUnits: unpaid };
          const line = computePayrollLine({
            employeeId: '11111111-1111-4111-8111-111111111111',
            branchId: null,
            month: toPayrollMonth('2026-03'),
            basicPoisha,
            components: [
              {
                code: 'house_rent',
                label: 'House rent',
                direction: 'earning',
                amountPoisha: poisha(allowance),
              },
            ],
            bonusPoisha: poisha(bonus),
            attendance,
          });

          expect(BigInt(line.grossPoisha) - BigInt(line.deductionsPoisha)).toBe(
            BigInt(line.netPoisha),
          );
          expect(line.netPoisha >= 0n).toBe(true);
          // §7's journal identity, per line.
          expect(BigInt(line.salaryExpensePoisha) + BigInt(line.bonusPoisha)).toBe(
            BigInt(line.netPoisha) + BigInt(line.loanDeductionPoisha),
          );
          const totals = payslipTotals(line.components);
          expect(totals.netPoisha).toBe(line.netPoisha);
        },
      ),
      { numRuns: 1500 },
    );
  });

  it('refuses a net below zero rather than clamping it', () => {
    expect(() =>
      computePayrollLine({
        employeeId: '11111111-1111-4111-8111-111111111111',
        branchId: null,
        month: toPayrollMonth('2026-03'),
        basicPoisha: poisha(1_000_000),
        // A ৳15,000 deduction typed as taka against a ৳10,000 salary.
        components: [
          {
            code: 'advance',
            label: 'Advance',
            direction: 'deduction',
            amountPoisha: poisha(1_500_000),
          },
        ],
        attendance: clean,
      }),
    ).toThrow(PayrollError);
  });

  it('does not prorate a bonus or an unproratable component', () => {
    const half = { ...clean, forfeitedUnits: clean.units / 2, unpaidUnits: clean.units / 2 };
    const line = computePayrollLine({
      employeeId: '11111111-1111-4111-8111-111111111111',
      branchId: null,
      month: toPayrollMonth('2026-03'),
      basicPoisha: poisha(2_000_000),
      components: [
        {
          code: 'mobile',
          label: 'Mobile bill',
          direction: 'earning',
          amountPoisha: poisha(50_000),
          prorated: false,
        },
      ],
      bonusPoisha: poisha(300_000),
      attendance: half,
    });
    /*
     * Only the basic is prorated. 2,000,000 over 54 units is 54 × 37,037 + 2, so
     * the first two units carry the spare poisha each and the 27 forfeited units
     * are all the cheap ones: 27 × 37,037 = 999,999 docked, one poisha less than
     * half. That poisha is the employee's, by design (see `proration.ts`) — and
     * asserting the round number here instead would be asserting a bug.
     */
    expect(line.absenceDeductionPoisha).toBe(999_999n);
    expect(line.netPoisha).toBe(2_000_000n + 50_000n + 300_000n - 999_999n);
  });
});

describe('the worked scenario (M19 check 1)', () => {
  /*
   * Three employees in March 2026, Fridays off, 27 working days.
   *
   * Every number below is computed by hand, which is the point: if the code and the
   * arithmetic disagree, one of them is wrong and a property test cannot say which.
   *
   * Asha    basic ৳30,000, house rent ৳5,000, no absence, ৳2,000 bonus.
   *         gross 3,500,000 + 200,000 bonus = 3,700,000. net = 3,700,000.
   * Bashir  basic ৳20,000, no allowance, 3 days absent (6 units of 54).
   *         2,000,000 split over 54 units: 2,000,000 = 54 × 37,037 + 2, so two
   *         units are 37,038 and fifty-two are 37,037. The last six are the cheap
   *         ones: 6 × 37,037 = 222,222 docked. net = 1,777,778.
   * Chameli basic ৳25,000, one half day (1 unit), a ৳6,000 loan in 3 instalments
   *         starting March: 200,000 each. 2,500,000 over 54 units = 46,296 × 54
   *         + 16, so sixteen units are 46,297 and thirty-eight are 46,296. The
   *         last one is 46,296 docked. available = 2,453,704, loan takes 200,000.
   *         net = 2,253,704.
   */
  const month = toPayrollMonth('2026-03');
  const base = attendanceSummary({
    month,
    calendar: FRIDAY_OFF,
    records: [],
    joinedOn: toIsoDate('2026-03-01'),
  });

  const ASHA = '11111111-1111-4111-8111-111111111111';
  const BASHIR = '22222222-2222-4222-8222-222222222222';
  const CHAMELI = '33333333-3333-4333-8333-333333333333';

  const lines = [
    computePayrollLine({
      employeeId: ASHA,
      branchId: null,
      month,
      basicPoisha: poisha(3_000_000),
      components: [
        {
          code: 'house_rent',
          label: 'House rent',
          direction: 'earning',
          amountPoisha: poisha(500_000),
        },
      ],
      bonusPoisha: poisha(200_000),
      attendance: base,
    }),
    computePayrollLine({
      employeeId: BASHIR,
      branchId: null,
      month,
      basicPoisha: poisha(2_000_000),
      components: [],
      attendance: { ...base, absentDays: 3, forfeitedUnits: 6, unpaidUnits: 6 },
    }),
    computePayrollLine({
      employeeId: CHAMELI,
      branchId: null,
      month,
      basicPoisha: poisha(2_500_000),
      components: [],
      attendance: { ...base, halfDays: 1, forfeitedUnits: 1, unpaidUnits: 1 },
      loanInstalments: loanSchedule({
        principalPoisha: poisha(600_000),
        instalments: 3,
        firstMonth: month,
      }).map((instalment) => ({
        instalmentId: `loan-${String(instalment.seq)}`,
        dueMonth: instalment.dueMonth,
        remainingPoisha: instalment.amountPoisha,
      })),
    }),
  ];

  it('produces the exact net pay for each employee', () => {
    expect(base.workingDays).toBe(27);
    expect(lines[0]?.netPoisha).toBe(3_700_000n);
    expect(lines[1]?.absenceDeductionPoisha).toBe(222_222n);
    expect(lines[1]?.netPoisha).toBe(1_777_778n);
    expect(lines[2]?.absenceDeductionPoisha).toBe(46_296n);
    expect(lines[2]?.loanDeductionPoisha).toBe(200_000n);
    expect(lines[2]?.netPoisha).toBe(2_253_704n);
  });

  it('produces a balanced journal with the exact totals', () => {
    const totals = payrollRunTotals(lines);
    expect(totals.netPoisha).toBe(3_700_000n + 1_777_778n + 2_253_704n);
    expect(totals.loanDeductionPoisha).toBe(200_000n);
    expect(totals.bonusPoisha).toBe(200_000n);

    const account = (subtype: PayrollAccount['subtype'], id: string): PayrollAccount => ({
      accountId: id,
      subtype,
      branchId: null,
    });
    const draft = payrollPostedDraft({
      runId: '44444444-4444-4444-8444-444444444444',
      occurredAt: new Date('2026-04-01T04:00:00Z'),
      salaryExpense: account('salary_expense', '55555555-5555-4555-8555-555555555551'),
      bonusExpense: account('bonus_expense', '55555555-5555-4555-8555-555555555552'),
      salaryPayable: account('salary_payable', '55555555-5555-4555-8555-555555555553'),
      employeeLoanReceivable: account(
        'employee_loan_receivable',
        '55555555-5555-4555-8555-555555555554',
      ),
      lines: lines.map((line) => ({
        employeeId: line.employeeId,
        branchId: line.branchId,
        salaryExpensePoisha: line.salaryExpensePoisha,
        bonusPoisha: line.bonusPoisha,
        netPoisha: line.netPoisha,
        loanDeductionPoisha: line.loanDeductionPoisha,
      })),
      memo: 'March 2026 payroll',
    });

    // Balanced, and dated in Dhaka: 04:00Z on 1 April is 10:00 on 1 April in Dhaka.
    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.businessDate).toBe('2026-04-01');
    expect(draft.idempotencyKey).toBe('payroll_run:44444444-4444-4444-8444-444444444444:posted');

    const debits = sum(draft.lines.map((line) => line.debitPoisha));
    const credits = sum(draft.lines.map((line) => line.creditPoisha));
    expect(debits).toBe(credits);
    expect(BigInt(credits)).toBe(BigInt(totals.netPoisha) + 200_000n);

    // Exactly one loan line, carrying Chameli as its party.
    const loanLines = draft.lines.filter(
      (line) => line.accountId === '55555555-5555-4555-8555-555555555554',
    );
    expect(loanLines).toHaveLength(1);
    expect(loanLines[0]?.partyType).toBe('employee');
    expect(loanLines[0]?.partyId).toBe(CHAMELI);
  });

  it('splits the salary expense by branch and keeps the payable whole', () => {
    const branchA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const branchB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const draft = payrollPostedDraft({
      runId: '44444444-4444-4444-8444-444444444444',
      occurredAt: new Date('2026-04-01T04:00:00Z'),
      salaryExpense: {
        accountId: '55555555-5555-4555-8555-555555555551',
        subtype: 'salary_expense',
        branchId: null,
      },
      bonusExpense: {
        accountId: '55555555-5555-4555-8555-555555555552',
        subtype: 'bonus_expense',
        branchId: null,
      },
      salaryPayable: {
        accountId: '55555555-5555-4555-8555-555555555553',
        subtype: 'salary_payable',
        branchId: null,
      },
      employeeLoanReceivable: {
        accountId: '55555555-5555-4555-8555-555555555554',
        subtype: 'employee_loan_receivable',
        branchId: null,
      },
      lines: [
        {
          employeeId: ASHA,
          branchId: branchA,
          salaryExpensePoisha: poisha(1_000_000),
          bonusPoisha: poisha(0),
          netPoisha: poisha(1_000_000),
          loanDeductionPoisha: poisha(0),
        },
        {
          employeeId: BASHIR,
          branchId: branchB,
          salaryExpensePoisha: poisha(500_000),
          bonusPoisha: poisha(0),
          netPoisha: poisha(500_000),
          loanDeductionPoisha: poisha(0),
        },
      ],
      memo: null,
    });

    const expense = draft.lines.filter(
      (line) => line.accountId === '55555555-5555-4555-8555-555555555551',
    );
    expect(expense.map((line) => line.branchId)).toEqual([branchA, branchB]);
    const payable = draft.lines.filter(
      (line) => line.accountId === '55555555-5555-4555-8555-555555555553',
    );
    expect(payable).toHaveLength(1);
    expect(payable[0]?.creditPoisha).toBe(1_500_000n);
  });
});

describe('payrollPostedDraft balances for random runs', () => {
  /*
   * `.claude/rules/money-and-ledger.md`: every posting rule needs a fast-check test proving
   * debits equal credits for random inputs, as well as a worked example.
   *
   * The generator builds each line the way `computePayrollLine` does rather than picking four
   * independent numbers, because §7's journal only balances when
   * `salary expense + bonus = net + loan` holds per line — so a generator that ignored the
   * identity would be testing that the rule refuses nonsense, which is a different test (and
   * it is below).
   */
  const ACCOUNTS = {
    salaryExpense: {
      accountId: '55555555-5555-4555-8555-555555555551',
      subtype: 'salary_expense',
      branchId: null,
    },
    bonusExpense: {
      accountId: '55555555-5555-4555-8555-555555555552',
      subtype: 'bonus_expense',
      branchId: null,
    },
    salaryPayable: {
      accountId: '55555555-5555-4555-8555-555555555553',
      subtype: 'salary_payable',
      branchId: null,
    },
    employeeLoanReceivable: {
      accountId: '55555555-5555-4555-8555-555555555554',
      subtype: 'employee_loan_receivable',
      branchId: null,
    },
  } as const satisfies Record<string, PayrollAccount>;

  const BRANCHES = [
    null,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  ];

  it('produces a balanced journal for any set of payslips', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            index: fc.integer({ min: 0, max: 0xff_ff }),
            branch: fc.integer({ min: 0, max: 2 }),
            /*
             * `net = bonus + beyondBonus` rather than an independent net.
             *
             * A bonus is part of what somebody is paid, so a payslip whose net is smaller
             * than its bonus means the other deductions swallowed the whole salary — which
             * makes the branch's salary expense negative, and an expense account with a
             * credit balance is a branch P&L showing wage income. The rule refuses that
             * deliberately (the next test), so the generator does not produce it.
             */
            bonus: fc.bigInt({ min: 0n, max: 5_000_000n }),
            beyondBonus: fc.bigInt({ min: 1n, max: 50_000_000n }),
            loan: fc.bigInt({ min: 0n, max: 5_000_000n }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (people) => {
          const draft = payrollPostedDraft({
            runId: '44444444-4444-4444-8444-444444444444',
            occurredAt: new Date('2026-04-01T04:00:00Z'),
            ...ACCOUNTS,
            lines: people.map((person, position) => ({
              // Distinct ids: two payslips for one employee is a different bug, caught by a
              // unique index rather than by a posting rule.
              employeeId: `${String(position).padStart(8, '0')}-0000-4000-8000-${String(person.index).padStart(12, '0')}`,
              branchId: BRANCHES[person.branch] ?? null,
              // The identity §7's journal rests on, by construction.
              salaryExpensePoisha: poisha(person.beyondBonus + person.loan),
              bonusPoisha: poisha(person.bonus),
              netPoisha: poisha(person.bonus + person.beyondBonus),
              loanDeductionPoisha: poisha(person.loan),
            })),
            memo: null,
          });

          expect(() => validateJournalDraft(draft)).not.toThrow();
          const debits = sum(draft.lines.map((line) => line.debitPoisha));
          const credits = sum(draft.lines.map((line) => line.creditPoisha));
          expect(debits).toBe(credits);

          // Every loan credit names its employee, which the account's party type requires and
          // which is what makes the employee loan statement readable.
          for (const line of draft.lines) {
            if (line.accountId !== ACCOUNTS.employeeLoanReceivable.accountId) continue;
            expect(line.partyType).toBe('employee');
            expect(line.partyId).not.toBeNull();
          }
        },
      ),
      { numRuns: 800 },
    );
  });

  it('emits no line for a branch whose salary expense sums to exactly zero', () => {
    /*
     * A per-employee salary expense can legitimately be negative — somebody who joined on the
     * last day of the month with a fixed deduction — so a branch of two can total zero. A
     * `0 / 0` line is refused by `validateJournalDraft`, so without the skip the whole run
     * would fail inside the checker's approval for a branch that simply has no wage cost.
     */
    const branch = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const draft = payrollPostedDraft({
      runId: '44444444-4444-4444-8444-444444444444',
      occurredAt: new Date('2026-04-01T04:00:00Z'),
      ...ACCOUNTS,
      lines: [
        {
          employeeId: '11111111-1111-4111-8111-111111111111',
          branchId: branch,
          salaryExpensePoisha: poisha(-20_000n),
          bonusPoisha: poisha(20_000),
          netPoisha: poisha(0),
          loanDeductionPoisha: poisha(0),
        },
        {
          employeeId: '22222222-2222-4222-8222-222222222222',
          branchId: branch,
          salaryExpensePoisha: poisha(20_000),
          bonusPoisha: poisha(0),
          netPoisha: poisha(20_000),
          loanDeductionPoisha: poisha(0),
        },
        {
          employeeId: '33333333-3333-4333-8333-333333333333',
          branchId: null,
          salaryExpensePoisha: poisha(500_000),
          bonusPoisha: poisha(0),
          netPoisha: poisha(500_000),
          loanDeductionPoisha: poisha(0),
        },
      ],
      memo: null,
    });

    expect(() => validateJournalDraft(draft)).not.toThrow();
    const salary = draft.lines.filter(
      (line) => line.accountId === ACCOUNTS.salaryExpense.accountId,
    );
    // Only the org-level line: the branch nets to zero and is simply absent.
    expect(salary).toHaveLength(1);
    expect(salary[0]?.branchId).toBeNull();
    expect(sum(draft.lines.map((line) => line.debitPoisha))).toBe(
      sum(draft.lines.map((line) => line.creditPoisha)),
    );
  });

  it('refuses a run that does not balance rather than posting a wrong expense', () => {
    expect(() =>
      payrollPostedDraft({
        runId: '44444444-4444-4444-8444-444444444444',
        occurredAt: new Date(),
        ...ACCOUNTS,
        lines: [
          {
            employeeId: '11111111-1111-4111-8111-111111111111',
            branchId: null,
            // Negative for the whole branch: an expense account with a credit balance is a
            // branch P&L showing wage income.
            salaryExpensePoisha: poisha(-1000n),
            bonusPoisha: poisha(0),
            netPoisha: poisha(1000),
            loanDeductionPoisha: poisha(0),
          },
        ],
        memo: null,
      }),
    ).toThrow(/exceed its salary/);
  });

  it('refuses a run with no employees and one that pays nothing', () => {
    const base = {
      runId: '44444444-4444-4444-8444-444444444444',
      occurredAt: new Date(),
      ...ACCOUNTS,
      memo: null,
    };
    expect(() => payrollPostedDraft({ ...base, lines: [] })).toThrow(/no employees/);
    expect(() =>
      payrollPostedDraft({
        ...base,
        lines: [
          {
            employeeId: '11111111-1111-4111-8111-111111111111',
            branchId: null,
            salaryExpensePoisha: poisha(0),
            bonusPoisha: poisha(0),
            netPoisha: poisha(0),
            loanDeductionPoisha: poisha(0),
          },
        ],
      }),
    ).toThrow(/nothing to post/);
  });
});

describe('the cash journals', () => {
  const wallet: PayrollAccount = {
    accountId: '66666666-6666-4666-8666-666666666666',
    subtype: 'wallet_bkash',
    branchId: null,
  };

  it('pays salary out of a wallet against the payable', () => {
    const draft = salaryPaidDraft({
      runId: '44444444-4444-4444-8444-444444444444',
      occurredAt: new Date('2026-04-05T09:00:00Z'),
      salaryPayable: {
        accountId: '55555555-5555-4555-8555-555555555553',
        subtype: 'salary_payable',
        branchId: null,
      },
      wallet,
      amountPoisha: poisha(7_731_482),
      memo: null,
    });
    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.idempotencyKey).toBe('payroll_run:44444444-4444-4444-8444-444444444444:paid');
  });

  it('books a staff loan against the employee, not against nobody', () => {
    const draft = employeeLoanDisbursedDraft({
      loanId: '77777777-7777-4777-8777-777777777777',
      employeeId: '33333333-3333-4333-8333-333333333333',
      occurredAt: new Date('2026-02-20T09:00:00Z'),
      loanReceivable: {
        accountId: '55555555-5555-4555-8555-555555555554',
        subtype: 'employee_loan_receivable',
        branchId: null,
      },
      wallet,
      amountPoisha: poisha(600_000),
      memo: 'Six-month staff loan',
    });
    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.lines[0]?.partyType).toBe('employee');
    expect(draft.lines[0]?.partyId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('refuses to pay salary from something that is not a wallet', () => {
    expect(() =>
      salaryPaidDraft({
        runId: '44444444-4444-4444-8444-444444444444',
        occurredAt: new Date(),
        salaryPayable: {
          accountId: '55555555-5555-4555-8555-555555555553',
          subtype: 'salary_payable',
          branchId: null,
        },
        wallet: { ...wallet, subtype: 'other_receivable' },
        amountPoisha: poisha(100),
        memo: null,
      }),
    ).toThrow(/wallet/i);
  });
});

describe('reviewAttendanceCsv', () => {
  it('reads a device export with a BOM, CRLF and day-first dates', () => {
    const csv =
      '﻿"Emp ID","Date","In","Out","Status"\r\n' +
      'EMP-001,01/03/2026,09:05,18:00,P\r\n' +
      'EMP-002,2026-03-01,,,A\r\n' +
      'EMP-003,01/03/2026,09:00,17:30,HD\r\n';
    const review = reviewAttendanceCsv({
      text: csv,
      mapping: {
        employeeCode: 'Emp ID',
        date: 'Date',
        checkIn: 'In',
        checkOut: 'Out',
        status: 'Status',
      },
      month: toPayrollMonth('2026-03'),
    });
    expect(review.rejected).toEqual([]);
    expect(review.accepted).toHaveLength(3);
    expect(review.accepted[0]?.date).toBe('2026-03-01');
    expect(review.accepted[0]?.status).toBe('present');
    expect(review.accepted[1]?.status).toBe('absent');
    expect(review.accepted[2]?.status).toBe('half_day');
  });

  it('rejects rows rather than guessing, with the line number Excel shows', () => {
    const csv =
      'code,day\n' +
      'EMP-001,32/03/2026\n' +
      'EMP-001,01/03/2026\n' +
      'EMP-001,01/03/2026\n' +
      ',02/03/2026\n' +
      'EMP-002,01/04/2026\n';
    const review = reviewAttendanceCsv({
      text: csv,
      mapping: { employeeCode: 'code', date: 'day' },
      month: toPayrollMonth('2026-03'),
    });
    expect(review.accepted).toHaveLength(1);
    expect(review.rejected.map((row) => row.line)).toEqual([2, 4, 5, 6]);
    expect(review.rejected[2]?.reason).toMatch(/blank/);
    expect(review.rejected[3]?.reason).toMatch(/not in 2026-03/);
  });

  it('names the columns a mapping asked for that the file does not have', () => {
    const review = reviewAttendanceCsv({
      text: 'a,b\n1,2\n',
      mapping: { employeeCode: 'code', date: 'day' },
    });
    expect(review.missingColumns).toEqual(['code', 'day']);
    expect(review.accepted).toEqual([]);
  });
});
