import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { LedgerError, validateJournalDraft, type JournalDraft } from '../ledger/index.js';
import { loanSchedule } from '../loans/index.js';
import { parseTaka, poisha, sum } from '../money/index.js';
import {
  companyLoanReceivedDraft,
  loanInstalmentPaidDraft,
  type CompanyLoanReceivedInput,
  type LoanInstalmentPaidInput,
} from './company-loan.js';

/**
 * M26's two posting rules (architecture §7), each with a fast-check balance property and a
 * worked example (.claude/rules/money-and-ledger.md). The repayment's property is driven by
 * real schedules: every instalment of a random loan must post, and together they must clear
 * exactly the principal the receipt credited.
 */

const BANK = '11111111-1111-4111-8111-111111111111';
const TILL = '22222222-2222-4222-8222-222222222222';
const LOAN_PAYABLE = '33333333-3333-4333-8333-333333333333';
const INTEREST = '44444444-4444-4444-8444-444444444444';
const LENDER = '55555555-5555-4555-8555-555555555555';
const LOAN = '66666666-6666-4666-8666-666666666666';
const INSTALMENT = '77777777-7777-4777-8777-777777777777';
const BRANCH = '88888888-8888-4888-8888-888888888888';

const wallet = { accountId: BANK, subtype: 'wallet_bank' as const, branchId: null };
const payable = { accountId: LOAN_PAYABLE, subtype: 'loan_payable' as const, branchId: null };
const interestExpense = {
  accountId: INTEREST,
  subtype: 'interest_expense' as const,
  branchId: null,
};

function received(overrides: Partial<CompanyLoanReceivedInput> = {}): CompanyLoanReceivedInput {
  return {
    loanId: LOAN,
    lenderId: LENDER,
    occurredAt: new Date('2026-10-01T20:00:00Z'),
    wallet,
    loanPayable: payable,
    principalPoisha: parseTaka('500000'),
    memo: ' Term loan ',
    ...overrides,
  };
}

function paid(overrides: Partial<LoanInstalmentPaidInput> = {}): LoanInstalmentPaidInput {
  return {
    instalmentId: INSTALMENT,
    lenderId: LENDER,
    occurredAt: new Date('2026-11-05T04:00:00Z'),
    wallet,
    loanPayable: payable,
    interestExpense,
    principalPoisha: parseTaka('7884.88'),
    interestPoisha: parseTaka('1000'),
    memo: null,
    ...overrides,
  };
}

function totals(draft: JournalDraft) {
  return {
    debit: sum(draft.lines.map((line) => line.debitPoisha)),
    credit: sum(draft.lines.map((line) => line.creditPoisha)),
  };
}

describe('loan received: worked example', () => {
  it('posts ৳5,00,000 banked at 02:00 Dhaka on 2 Oct as Dr bank / Cr loan payable (lender)', () => {
    expect(companyLoanReceivedDraft(received())).toEqual({
      // 20:00 UTC on 1 Oct is 02:00 on 2 Oct in Dhaka (invariant 8).
      businessDate: '2026-10-02',
      sourceType: 'company_loan',
      sourceId: LOAN,
      event: 'received',
      idempotencyKey: `company_loan:${LOAN}:received`,
      memo: 'Term loan',
      reversesJournalId: null,
      lines: [
        {
          accountId: BANK,
          debitPoisha: 50_000_000n,
          creditPoisha: 0n,
          branchId: null,
          partyType: null,
          partyId: null,
          memo: null,
        },
        {
          accountId: LOAN_PAYABLE,
          debitPoisha: 0n,
          creditPoisha: 50_000_000n,
          branchId: null,
          partyType: 'lender',
          partyId: LENDER,
          memo: null,
        },
      ],
    });
  });

  it('refuses income or equity as the credit, a non-wallet debit, and nothing at all', () => {
    expect(() =>
      companyLoanReceivedDraft(received({ loanPayable: { ...payable, subtype: 'other_income' } })),
    ).toThrow(LedgerError);
    expect(() =>
      companyLoanReceivedDraft(received({ wallet: { ...wallet, subtype: 'inventory' } })),
    ).toThrow(LedgerError);
    expect(() => companyLoanReceivedDraft(received({ principalPoisha: poisha(0) }))).toThrow(
      LedgerError,
    );
  });

  it('balances for any principal into any wallet (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9_000_000_000_000_000n }),
        fc.constantFrom('wallet_bank', 'wallet_bkash', 'wallet_cash' as const),
        (amount, subtype) => {
          const draft = companyLoanReceivedDraft(
            received({
              principalPoisha: poisha(amount),
              wallet: {
                accountId: TILL,
                subtype,
                branchId: subtype === 'wallet_cash' ? BRANCH : null,
              },
            }),
          );
          validateJournalDraft(draft);
          const { debit, credit } = totals(draft);
          expect(debit).toBe(credit);
          expect(credit).toBe(amount);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('instalment paid: worked example', () => {
  it('splits ৳8,884.88 into ৳7,884.88 off the debt and ৳1,000 of interest, from the bank', () => {
    expect(loanInstalmentPaidDraft(paid())).toEqual({
      // 04:00 UTC is 10:00 Dhaka, the same day.
      businessDate: '2026-11-05',
      sourceType: 'loan_instalment',
      sourceId: INSTALMENT,
      event: 'paid',
      idempotencyKey: `loan_instalment:${INSTALMENT}:paid`,
      memo: null,
      reversesJournalId: null,
      lines: [
        {
          accountId: LOAN_PAYABLE,
          debitPoisha: 788_488n,
          creditPoisha: 0n,
          branchId: null,
          partyType: 'lender',
          partyId: LENDER,
          memo: null,
        },
        {
          accountId: INTEREST,
          debitPoisha: 100_000n,
          creditPoisha: 0n,
          branchId: null,
          partyType: null,
          partyId: null,
          memo: null,
        },
        {
          accountId: BANK,
          debitPoisha: 0n,
          creditPoisha: 888_488n,
          branchId: null,
          partyType: null,
          partyId: null,
          memo: null,
        },
      ],
    });
  });

  it('has no interest line for an interest-free instalment', () => {
    const draft = loanInstalmentPaidDraft(paid({ interestPoisha: poisha(0) }));
    expect(draft.lines.map((line) => line.accountId)).toEqual([LOAN_PAYABLE, BANK]);
    validateJournalDraft(draft);
  });

  it('carries the till’s branch on the wallet line only', () => {
    const draft = loanInstalmentPaidDraft(
      paid({ wallet: { accountId: TILL, subtype: 'wallet_cash', branchId: BRANCH } }),
    );
    expect(draft.lines.map((line) => line.branchId)).toEqual([null, null, BRANCH]);
  });

  it('refuses the wrong accounts and a payment of nothing', () => {
    expect(() =>
      loanInstalmentPaidDraft(paid({ interestExpense: { ...interestExpense, subtype: 'cogs' } })),
    ).toThrow(LedgerError);
    expect(() =>
      loanInstalmentPaidDraft(paid({ loanPayable: { ...payable, subtype: 'other_payable' } })),
    ).toThrow(LedgerError);
    expect(() =>
      loanInstalmentPaidDraft(paid({ principalPoisha: poisha(0), interestPoisha: poisha(0) })),
    ).toThrow(LedgerError);
    expect(() => loanInstalmentPaidDraft(paid({ interestPoisha: poisha(-1) }))).toThrow(
      LedgerError,
    );
  });

  it('posts every instalment of any loan, and together they clear the principal (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000_000n, max: 1_000_000_000n }),
        fc.integer({ min: 0, max: 2_400 }),
        fc.constantFrom('flat' as const, 'reducing' as const),
        fc.integer({ min: 1, max: 60 }),
        (principal, rateBps, method, tenureMonths) => {
          const schedule = loanSchedule({
            principalPoisha: poisha(principal),
            rateBps,
            method,
            tenureMonths,
            firstDueOn: toIsoDate('2026-11-05'),
          });
          let principalDebited = 0n;
          for (const row of schedule) {
            const draft = loanInstalmentPaidDraft(
              paid({
                instalmentId: `${String(row.seq).padStart(8, '0')}-0000-4000-8000-000000000000`,
                principalPoisha: row.principalPoisha,
                interestPoisha: row.interestPoisha,
              }),
            );
            validateJournalDraft(draft);
            const { debit, credit } = totals(draft);
            expect(debit).toBe(credit);
            expect(credit).toBe(row.totalPoisha);
            principalDebited += draft.lines
              .filter((line) => line.accountId === LOAN_PAYABLE)
              .reduce((acc, line) => acc + line.debitPoisha, 0n);
          }
          // What the receipt credited to the lender is exactly what the instalments debit.
          expect(principalDebited).toBe(principal);
        },
      ),
      { numRuns: 300 },
    );
  });
});
