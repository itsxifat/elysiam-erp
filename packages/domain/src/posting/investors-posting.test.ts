import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { splitDistribution } from '../investors/index.js';
import { LedgerError, validateJournalDraft } from '../ledger/index.js';
import { poisha, sum } from '../money/index.js';
import { investorCapitalDraft, type InvestorCapitalInput } from './investor-capital.js';
import { investorPaymentDraft, type InvestorPaymentInput } from './investor-payment.js';
import { profitDistributionDraft, type ProfitDistributionInput } from './profit-distribution.js';

/**
 * M25's three posting rules (architecture §7, §15), each with the two tests a
 * rule owes (.claude/rules/money-and-ledger.md): a fast-check property that it
 * balances for random input, and a worked example whose numbers a person can
 * check by hand.
 *
 * The distribution's property is the one that matters most, and it is
 * deliberately driven by `splitDistribution` rather than by pre-balanced input:
 * the thing under test is the *pair* — a split that loses a poisha produces a
 * journal that cannot post, so proving the two agree for random totals and random
 * shares is what proves a distribution can always be declared.
 */

const BANK = '11111111-1111-4111-8111-111111111111';
const HAND_CASH = '22222222-2222-4222-8222-222222222222';
const CAPITAL = '33333333-3333-4333-8333-333333333333';
const PAYABLE = '44444444-4444-4444-8444-444444444444';
const DISTRIBUTION = '55555555-5555-4555-8555-555555555555';
const BRANCH = '66666666-6666-4666-8666-666666666666';
const INVESTOR_A = '77777777-7777-4777-8777-777777777777';
const INVESTOR_B = '88888888-8888-4888-8888-888888888888';
const ROW_ID = '99999999-9999-4999-8999-999999999999';

const anyId = (n: number): string => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

// --- capital received --------------------------------------------------------

function capital(overrides: Partial<InvestorCapitalInput> = {}): InvestorCapitalInput {
  return {
    investmentId: ROW_ID,
    investorId: INVESTOR_A,
    occurredAt: new Date('2026-09-01T23:30:00Z'),
    wallet: { accountId: BANK, subtype: 'wallet_bank', branchId: null },
    capital: { accountId: CAPITAL, subtype: 'investor_capital', branchId: null },
    amountPoisha: poisha(50_00_000_00),
    memo: 'First tranche',
    ...overrides,
  };
}

describe('investor capital: worked example', () => {
  it('posts ৳5,00,000 banked at 05:30 Dhaka on 2 Sep as Dr bank / Cr investor capital', () => {
    expect(investorCapitalDraft(capital())).toEqual({
      // 23:30 UTC on 1 Sep is 05:30 on 2 Sep in Dhaka (invariant 8).
      businessDate: '2026-09-02',
      sourceType: 'investment',
      sourceId: ROW_ID,
      event: 'received',
      idempotencyKey: `investment:${ROW_ID}:received`,
      memo: 'First tranche',
      reversesJournalId: null,
      lines: [
        {
          accountId: BANK,
          debitPoisha: 50_00_000_00n,
          creditPoisha: 0n,
          branchId: null,
          partyType: null,
          partyId: null,
          memo: null,
        },
        {
          accountId: CAPITAL,
          debitPoisha: 0n,
          creditPoisha: 50_00_000_00n,
          branchId: null,
          partyType: 'investor',
          partyId: INVESTOR_A,
          memo: null,
        },
      ],
    });
  });

  it('keeps the branch on the cash and off the equity', () => {
    // Cash into a showroom till is that showroom's; the equity it created is the
    // org's. A branch balance sheet showing investor equity would read as if the
    // showroom had been capitalised on its own.
    const draft = investorCapitalDraft(
      capital({ wallet: { accountId: HAND_CASH, subtype: 'wallet_cash', branchId: BRANCH } }),
    );
    expect(draft.lines[0]?.branchId).toBe(BRANCH);
    expect(draft.lines[1]?.branchId).toBeNull();
  });

  it('refuses to credit capital to income', () => {
    // The mistake that balances: a ৳50,00,000 injection booked as a profitable
    // month, with an empty capital account when the investor asks for it back.
    expect(() =>
      investorCapitalDraft(
        capital({ capital: { accountId: CAPITAL, subtype: 'other_income', branchId: null } }),
      ),
    ).toThrow(LedgerError);
  });

  it('refuses a receipt into something that is not a wallet', () => {
    expect(() =>
      investorCapitalDraft(
        capital({ wallet: { accountId: BANK, subtype: 'other_receivable', branchId: null } }),
      ),
    ).toThrow(/wallet/);
  });

  it('refuses a zero or negative contribution', () => {
    expect(() => investorCapitalDraft(capital({ amountPoisha: poisha(0) }))).toThrow(/positive/);
  });

  it('balances for any amount, and always names the investor', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 9_000_000_000_000_000n }), (amount) => {
        const draft = investorCapitalDraft(capital({ amountPoisha: poisha(amount) }));
        expect(() => validateJournalDraft(draft)).not.toThrow();
        expect(draft.lines.filter((line) => line.partyType === 'investor')).toHaveLength(1);
      }),
      { numRuns: 500 },
    );
  });
});

// --- distribution declared ---------------------------------------------------

function distribution(overrides: Partial<ProfitDistributionInput> = {}): ProfitDistributionInput {
  return {
    distributionId: ROW_ID,
    declaredAt: new Date('2026-09-25T10:00:00Z'),
    distributionAccount: {
      accountId: DISTRIBUTION,
      subtype: 'profit_distribution',
      branchId: null,
    },
    totalPoisha: poisha(10_000),
    lines: [
      {
        investorId: INVESTOR_A,
        payableAccountId: PAYABLE,
        payableSubtype: 'investor_payable',
        amountPoisha: poisha(6_000),
      },
      {
        investorId: INVESTOR_B,
        payableAccountId: PAYABLE,
        payableSubtype: 'investor_payable',
        amountPoisha: poisha(4_000),
      },
    ],
    memo: 'August profit',
    ...overrides,
  };
}

describe('profit distribution: worked example', () => {
  it('posts ৳100 of August profit 60/40 as one debit and two credits', () => {
    expect(profitDistributionDraft(distribution())).toEqual({
      businessDate: '2026-09-25',
      sourceType: 'investor_distribution',
      sourceId: ROW_ID,
      event: 'declared',
      idempotencyKey: `investor_distribution:${ROW_ID}:declared`,
      memo: 'August profit',
      reversesJournalId: null,
      lines: [
        {
          accountId: DISTRIBUTION,
          debitPoisha: 10_000n,
          creditPoisha: 0n,
          branchId: null,
          partyType: null,
          partyId: null,
          memo: null,
        },
        {
          accountId: PAYABLE,
          debitPoisha: 0n,
          creditPoisha: 6_000n,
          branchId: null,
          partyType: 'investor',
          partyId: INVESTOR_A,
          memo: null,
        },
        {
          accountId: PAYABLE,
          debitPoisha: 0n,
          creditPoisha: 4_000n,
          branchId: null,
          partyType: 'investor',
          partyId: INVESTOR_B,
          memo: null,
        },
      ],
    });
  });

  it('is dated when it is declared, not on the period it distributes', () => {
    // A September declaration of August profit is a September equity movement,
    // which is also why declaring can never post into a closed month.
    expect(profitDistributionDraft(distribution()).businessDate).toBe('2026-09-25');
  });

  it('drops a zero share rather than posting an empty line', () => {
    // One poisha across two investors is 1 and 0. A journal line must have
    // exactly one positive side, so the empty share is not a line.
    const draft = profitDistributionDraft(
      distribution({
        totalPoisha: poisha(1),
        lines: [
          {
            investorId: INVESTOR_A,
            payableAccountId: PAYABLE,
            payableSubtype: 'investor_payable',
            amountPoisha: poisha(1),
          },
          {
            investorId: INVESTOR_B,
            payableAccountId: PAYABLE,
            payableSubtype: 'investor_payable',
            amountPoisha: poisha(0),
          },
        ],
      }),
    );
    expect(draft.lines).toHaveLength(2);
    expect(() => validateJournalDraft(draft)).not.toThrow();
  });

  it('refuses shares that do not add up to the declared total', () => {
    expect(() => profitDistributionDraft(distribution({ totalPoisha: poisha(10_001) }))).toThrow(
      /not the declared/,
    );
  });

  it('refuses a debit to anything but the profit distribution account', () => {
    expect(() =>
      profitDistributionDraft(
        distribution({
          distributionAccount: {
            accountId: DISTRIBUTION,
            subtype: 'operating_expense',
            branchId: null,
          },
        }),
      ),
    ).toThrow(/profit distribution account/);
  });

  it('refuses a credit to anything but investor payable', () => {
    // Crediting `investor_capital` here would turn declared profit into equity,
    // and the payment would then have nothing to settle.
    expect(() =>
      profitDistributionDraft(
        distribution({
          totalPoisha: poisha(6_000),
          lines: [
            {
              investorId: INVESTOR_A,
              payableAccountId: CAPITAL,
              payableSubtype: 'investor_capital',
              amountPoisha: poisha(6_000),
            },
          ],
        }),
      ),
    ).toThrow(/investor payable/);
  });

  it('refuses the same investor twice', () => {
    expect(() =>
      profitDistributionDraft(
        distribution({
          lines: [
            {
              investorId: INVESTOR_A,
              payableAccountId: PAYABLE,
              payableSubtype: 'investor_payable',
              amountPoisha: poisha(6_000),
            },
            {
              investorId: INVESTOR_A,
              payableAccountId: PAYABLE,
              payableSubtype: 'investor_payable',
              amountPoisha: poisha(4_000),
            },
          ],
        }),
      ),
    ).toThrow(/twice/);
  });

  it('balances for any total split across any shares', () => {
    // The pair under test: `splitDistribution` computes the parts and this rule
    // posts them. A poisha lost in the split is a journal that cannot post.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9_000_000_000_000n }),
        fc
          .array(fc.bigInt({ min: 0n, max: 100_000n }), { minLength: 1, maxLength: 10 })
          .filter((weights) => weights.some((weight) => weight > 0n)),
        (total, weights) => {
          const parts = splitDistribution(
            poisha(total),
            weights.map((weight, index) => ({ investorId: anyId(index + 1), weight })),
          );
          const draft = profitDistributionDraft(
            distribution({
              totalPoisha: poisha(total),
              lines: parts.map((part) => ({
                investorId: part.investorId,
                payableAccountId: PAYABLE,
                payableSubtype: 'investor_payable' as const,
                amountPoisha: part.amountPoisha,
              })),
            }),
          );
          expect(() => validateJournalDraft(draft)).not.toThrow();
          const credits = sum(draft.lines.slice(1).map((line) => line.creditPoisha));
          expect(credits).toBe(poisha(total));
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

// --- withdrawal or distribution paid ----------------------------------------

function payment(overrides: Partial<InvestorPaymentInput> = {}): InvestorPaymentInput {
  return {
    withdrawalId: ROW_ID,
    investorId: INVESTOR_A,
    kind: 'profit',
    occurredAt: new Date('2026-09-25T04:00:00Z'),
    debit: { accountId: PAYABLE, subtype: 'investor_payable', branchId: null },
    wallet: { accountId: BANK, subtype: 'wallet_bank', branchId: null },
    amountPoisha: poisha(6_000),
    memo: null,
    ...overrides,
  };
}

describe('investor payment: worked examples', () => {
  it('pays declared profit as Dr investor payable / Cr bank', () => {
    expect(investorPaymentDraft(payment())).toEqual({
      businessDate: '2026-09-25',
      sourceType: 'investor_withdrawal',
      sourceId: ROW_ID,
      event: 'paid',
      idempotencyKey: `investor_withdrawal:${ROW_ID}:paid`,
      memo: null,
      reversesJournalId: null,
      lines: [
        {
          accountId: PAYABLE,
          debitPoisha: 6_000n,
          creditPoisha: 0n,
          branchId: null,
          partyType: 'investor',
          partyId: INVESTOR_A,
          memo: null,
        },
        {
          accountId: BANK,
          debitPoisha: 0n,
          creditPoisha: 6_000n,
          branchId: null,
          partyType: null,
          partyId: null,
          memo: null,
        },
      ],
    });
  });

  it('returns capital as Dr investor capital / Cr bank', () => {
    const draft = investorPaymentDraft(
      payment({
        kind: 'capital',
        debit: { accountId: CAPITAL, subtype: 'investor_capital', branchId: null },
      }),
    );
    expect(draft.lines[0]?.accountId).toBe(CAPITAL);
  });

  it('refuses to pay profit out of the capital account', () => {
    // The invisible mistake: the payable stays standing, so the company still
    // shows the debt while the investor's capital says they took their money out.
    expect(() =>
      investorPaymentDraft(
        payment({ debit: { accountId: CAPITAL, subtype: 'investor_capital', branchId: null } }),
      ),
    ).toThrow(/debited to investor_payable/);
  });

  it('refuses to return capital out of the payable', () => {
    expect(() => investorPaymentDraft(payment({ kind: 'capital' }))).toThrow(
      /debited to investor_capital/,
    );
  });

  it('refuses a payment from something that is not a wallet', () => {
    expect(() =>
      investorPaymentDraft(
        payment({ wallet: { accountId: BANK, subtype: 'other_payable', branchId: null } }),
      ),
    ).toThrow(/wallet/);
  });

  it('balances for any amount and either kind, and always names the investor', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9_000_000_000_000_000n }),
        fc.constantFrom('capital' as const, 'profit' as const),
        (amount, kind) => {
          const draft = investorPaymentDraft(
            payment({
              amountPoisha: poisha(amount),
              kind,
              debit:
                kind === 'capital'
                  ? { accountId: CAPITAL, subtype: 'investor_capital', branchId: null }
                  : { accountId: PAYABLE, subtype: 'investor_payable', branchId: null },
            }),
          );
          expect(() => validateJournalDraft(draft)).not.toThrow();
          expect(draft.lines[0]?.partyId).toBe(INVESTOR_A);
          expect(draft.lines[0]?.debitPoisha).toBe(amount);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('keys a payment apart from the distribution it settles', () => {
    // A withdrawal and the distribution it draws on are different events with
    // different ids: one key could never answer for both.
    expect(investorPaymentDraft(payment()).idempotencyKey).not.toBe(
      profitDistributionDraft(distribution()).idempotencyKey,
    );
  });
});
