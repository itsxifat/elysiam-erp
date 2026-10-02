import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate, type IsoDate } from '../dates/index.js';
import { parseTaka, poisha } from '../money/index.js';
import {
  addMonthsClamped,
  instalmentState,
  isReminderDue,
  loanPosition,
  loanSchedule,
  payableInstalment,
  LoansError,
  MAX_LOAN_TENURE_MONTHS,
  reducingInstalment,
  scheduleTotals,
  type InstalmentFacts,
  type LoanInstalment,
  type LoanMethod,
} from './index.js';

/**
 * Company loan schedules (M26 checks 1 and 2, architecture §15).
 *
 * Check 1 is a property: **Σ principal = the loan amount**, for any principal, rate,
 * tenure and method. It is a property rather than examples because rounding failures are
 * data-dependent — ৳1,00,000 over 7 months splits unevenly and over 8 does not — and the
 * consequence of one poisha lost is a loan that never reaches zero in the ledger.
 *
 * Check 2 is a reducing-balance table worked by hand, line by line, below.
 */

const FIRST_DUE = toIsoDate('2026-11-05');

function taka(value: string) {
  return parseTaka(value);
}

/** Rows as taka strings, so a table in the test reads like the one on paper. */
function asTable(rows: readonly LoanInstalment[]) {
  const fmt = (value: bigint) => {
    const whole = value / 100n;
    const part = (value % 100n).toString().padStart(2, '0');
    return `${whole.toString()}.${part}`;
  };
  return rows.map((row) => [
    row.seq,
    row.dueOn,
    fmt(row.principalPoisha),
    fmt(row.interestPoisha),
    fmt(row.totalPoisha),
    fmt(row.balanceAfterPoisha),
  ]);
}

describe('check 1: Σ principal = the loan amount (property)', () => {
  const method = fc.constantFrom<LoanMethod>('flat', 'reducing');
  // ৳10,000 to ৳10 crore, 0% to 24% a year, 1 to 240 months: every loan a brand takes.
  const realistic = fc.record({
    principalPoisha: fc.bigInt({ min: 1_000_000n, max: 10_000_000_000n }).map((v) => poisha(v)),
    rateBps: fc.integer({ min: 0, max: 2_400 }),
    method,
    tenureMonths: fc.integer({ min: 1, max: 240 }),
  });

  it('holds for every realistic loan, with no instalment empty and none negative', () => {
    fc.assert(
      fc.property(realistic, (terms) => {
        const rows = loanSchedule({ ...terms, firstDueOn: FIRST_DUE });
        const totals = scheduleTotals(rows);
        expect(rows).toHaveLength(terms.tenureMonths);
        expect(totals.principalPoisha).toBe(terms.principalPoisha);
        expect(totals.totalPoisha).toBe(totals.principalPoisha + totals.interestPoisha);
        for (const row of rows) {
          expect(row.principalPoisha >= 0n).toBe(true);
          expect(row.interestPoisha >= 0n).toBe(true);
          expect(row.totalPoisha > 0n).toBe(true);
          expect(row.totalPoisha).toBe(row.principalPoisha + row.interestPoisha);
        }
        // The balance after the last instalment is nothing, and it only ever falls.
        expect(rows.at(-1)?.balanceAfterPoisha).toBe(0n);
        rows.reduce((previous, row) => {
          expect(row.balanceAfterPoisha <= previous).toBe(true);
          return row.balanceAfterPoisha;
        }, terms.principalPoisha as bigint);
      }),
      { numRuns: 1_500 },
    );
  });

  it('holds at the edges too, or the terms are refused with the documented code', () => {
    const any = fc.record({
      principalPoisha: fc.bigInt({ min: 1n, max: 9_000_000_000_000n }).map((v) => poisha(v)),
      rateBps: fc.integer({ min: 0, max: 10_000 }),
      method,
      tenureMonths: fc.integer({ min: 1, max: MAX_LOAN_TENURE_MONTHS }),
    });
    fc.assert(
      fc.property(any, (terms) => {
        let rows: LoanInstalment[];
        try {
          rows = loanSchedule({ ...terms, firstDueOn: FIRST_DUE });
        } catch (error) {
          expect(error).toBeInstanceOf(LoansError);
          expect((error as LoansError).code).toBe('LOAN_TERMS_INVALID');
          return;
        }
        expect(scheduleTotals(rows).principalPoisha).toBe(terms.principalPoisha);
        for (const row of rows) expect(row.totalPoisha > 0n).toBe(true);
      }),
      { numRuns: 1_500 },
    );
  });

  it('spreads a flat loan’s principal and interest by largest remainder', () => {
    // ৳1,00,000 at 12% flat over 7 months: interest 1,00,000 × 12% × 7/12 = ৳7,000.
    // 10,000,000 poisha / 7 = 1,428,571 rem 3, so the first three carry the extra poisha.
    const rows = loanSchedule({
      principalPoisha: taka('100000'),
      rateBps: 1_200,
      method: 'flat',
      tenureMonths: 7,
      firstDueOn: FIRST_DUE,
    });
    expect(rows.map((row) => row.principalPoisha)).toEqual(
      [1_428_572n, 1_428_572n, 1_428_572n, 1_428_571n, 1_428_571n, 1_428_571n, 1_428_571n].map(
        (v) => poisha(v),
      ),
    );
    expect(rows.every((row) => row.interestPoisha === 100_000n)).toBe(true);
    expect(scheduleTotals(rows)).toEqual({
      principalPoisha: taka('100000'),
      interestPoisha: taka('7000'),
      totalPoisha: taka('107000'),
    });
  });

  it('charges a zero-rate loan no interest, under either method', () => {
    for (const method of ['flat', 'reducing'] as const) {
      const rows = loanSchedule({
        principalPoisha: taka('1000'),
        rateBps: 0,
        method,
        tenureMonths: 3,
        firstDueOn: FIRST_DUE,
      });
      expect(rows.map((row) => row.principalPoisha)).toEqual([33_334n, 33_333n, 33_333n]);
      expect(rows.every((row) => row.interestPoisha === 0n)).toBe(true);
    }
  });
});

describe('check 2: a reducing-balance example matches a hand-computed table', () => {
  it('৳10,000 at 12% a year over 3 months, worked by hand', () => {
    /*
     * r = 12% / 12 = 1% a month. (1.01)^3 = 1.030301.
     * Instalment = 10,000 × 0.01 × 1.030301 / 0.030301 = 3,400.2211… → ৳3,400.22.
     *
     *   month 1: interest 10,000.00 × 1% = 100.00;  principal 3,400.22 − 100.00 = 3,300.22;
     *            balance 10,000.00 − 3,300.22 = 6,699.78
     *   month 2: interest  6,699.78 × 1% = 66.9978 → 67.00 (half away from zero);
     *            principal 3,400.22 − 67.00 = 3,333.22;  balance 6,699.78 − 3,333.22 = 3,366.56
     *   month 3: interest  3,366.56 × 1% = 33.6656 → 33.67;
     *            principal = the balance left, 3,366.56 (the last instalment takes it);
     *            instalment 3,366.56 + 33.67 = 3,400.23;  balance 0.00
     *
     *   Σ principal = 3,300.22 + 3,333.22 + 3,366.56 = 10,000.00
     *   Σ interest  =   100.00 +    67.00 +    33.67 =    200.67
     */
    expect(reducingInstalment(taka('10000'), 1_200, 3)).toBe(taka('3400.22'));
    const rows = loanSchedule({
      principalPoisha: taka('10000'),
      rateBps: 1_200,
      method: 'reducing',
      tenureMonths: 3,
      firstDueOn: toIsoDate('2026-11-30'),
    });
    expect(asTable(rows)).toEqual([
      [1, '2026-11-30', '3300.22', '100.00', '3400.22', '6699.78'],
      [2, '2026-12-30', '3333.22', '67.00', '3400.22', '3366.56'],
      [3, '2027-01-30', '3366.56', '33.67', '3400.23', '0.00'],
    ]);
    expect(scheduleTotals(rows)).toEqual({
      principalPoisha: taka('10000'),
      interestPoisha: taka('200.67'),
      totalPoisha: taka('10200.67'),
    });
  });

  it('৳1,00,000 at 12% over 12 months: the published ৳8,884.88 table', () => {
    // The standard amortisation table for these terms (instalment ৳8,884.88), each line
    // computed as above: interest on the balance at 1%, rounded; the last takes the rest.
    const rows = loanSchedule({
      principalPoisha: taka('100000'),
      rateBps: 1_200,
      method: 'reducing',
      tenureMonths: 12,
      firstDueOn: toIsoDate('2027-01-31'),
    });
    expect(asTable(rows)).toEqual([
      [1, '2027-01-31', '7884.88', '1000.00', '8884.88', '92115.12'],
      [2, '2027-02-28', '7963.73', '921.15', '8884.88', '84151.39'],
      [3, '2027-03-31', '8043.37', '841.51', '8884.88', '76108.02'],
      [4, '2027-04-30', '8123.80', '761.08', '8884.88', '67984.22'],
      [5, '2027-05-31', '8205.04', '679.84', '8884.88', '59779.18'],
      [6, '2027-06-30', '8287.09', '597.79', '8884.88', '51492.09'],
      [7, '2027-07-31', '8369.96', '514.92', '8884.88', '43122.13'],
      [8, '2027-08-31', '8453.66', '431.22', '8884.88', '34668.47'],
      [9, '2027-09-30', '8538.20', '346.68', '8884.88', '26130.27'],
      [10, '2027-10-31', '8623.58', '261.30', '8884.88', '17506.69'],
      [11, '2027-11-30', '8709.81', '175.07', '8884.88', '8796.88'],
      [12, '2027-12-31', '8796.88', '87.97', '8884.85', '0.00'],
    ]);
    expect(scheduleTotals(rows).interestPoisha).toBe(taka('6618.53'));
  });
});

describe('the terms a schedule refuses', () => {
  const base = {
    principalPoisha: taka('1000'),
    rateBps: 1_200,
    method: 'reducing' as const,
    tenureMonths: 12,
    firstDueOn: FIRST_DUE,
  };

  it.each([
    ['a zero principal', { principalPoisha: poisha(0) }],
    ['no instalments', { tenureMonths: 0 }],
    ['more than thirty years', { tenureMonths: 361 }],
    ['a fractional tenure', { tenureMonths: 1.5 }],
    ['a negative rate', { rateBps: -1 }],
    ['a rate above 100%', { rateBps: 10_001 }],
    ['a fractional rate', { rateBps: 12.5 }],
    ['an unknown method', { method: 'balloon' as LoanMethod }],
    ['fewer poisha than instalments', { principalPoisha: poisha(11) }],
    // ৳1,000 over 212 months at 35.83%: the rounded instalment clears the debt early and
    // the last months would be empty (D-294). Found by the property below.
    [
      'terms that leave an empty instalment',
      { principalPoisha: poisha(100_000), rateBps: 3_583, tenureMonths: 212 },
    ],
  ])('refuses %s', (_label, change) => {
    expect(() => loanSchedule({ ...base, ...change })).toThrow(LoansError);
  });
});

describe('due dates and the reminder window', () => {
  it('keeps the first due date’s day, clamped to short months, without drifting', () => {
    const jan31 = toIsoDate('2027-01-31');
    expect([0, 1, 2, 3, 13].map((months) => addMonthsClamped(jan31, months))).toEqual<IsoDate[]>(
      ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2028-02-29'].map(toIsoDate),
    );
  });

  it('is due from N days before the due date, and stays due once passed', () => {
    const due = toIsoDate('2026-11-05');
    expect(isReminderDue(due, 3, toIsoDate('2026-11-01'))).toBe(false);
    expect(isReminderDue(due, 3, toIsoDate('2026-11-02'))).toBe(true);
    expect(isReminderDue(due, 3, toIsoDate('2026-11-09'))).toBe(true);
    expect(isReminderDue(due, 0, toIsoDate('2026-11-04'))).toBe(false);
    expect(isReminderDue(due, 0, toIsoDate('2026-11-05'))).toBe(true);
  });
});

describe('where a loan stands', () => {
  const row = (seq: number, payment: InstalmentFacts['payment']): InstalmentFacts => ({
    seq,
    dueOn: addMonthsClamped(toIsoDate('2026-11-05'), seq - 1),
    principalPoisha: poisha(10_000),
    interestPoisha: poisha(1_000),
    payment,
  });

  it('pays the lowest unposted instalment, and nothing while one waits for a checker', () => {
    expect(payableInstalment([row(2, null), row(1, 'posted')])).toEqual({ seq: 2 });
    expect(payableInstalment([row(1, 'pending_approval'), row(2, null)])).toEqual({
      seq: null,
      reason: 'waiting',
    });
    expect(payableInstalment([row(1, 'posted')])).toEqual({ seq: null, reason: 'settled' });
  });

  it('derives paid and outstanding from posted payments only', () => {
    expect(loanPosition([row(1, 'posted'), row(2, 'pending_approval'), row(3, null)])).toEqual({
      paidInstalments: 1,
      paidPrincipalPoisha: 10_000n,
      paidInterestPoisha: 1_000n,
      outstandingPrincipalPoisha: 20_000n,
      outstandingInterestPoisha: 2_000n,
    });
  });

  it('names each instalment’s state against today', () => {
    const today = toIsoDate('2026-12-01');
    expect(instalmentState(row(1, null), today)).toBe('overdue');
    expect(instalmentState(row(2, null), today)).toBe('due');
    expect(instalmentState(row(1, 'posted'), today)).toBe('paid');
    expect(instalmentState(row(1, 'pending_approval'), today)).toBe('pending_approval');
  });
});
