import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LedgerError, validateJournalDraft } from '../ledger/index.js';
import { poisha, sum } from '../money/index.js';
import { cashOutDraft, type CashOutInput } from './cash-out.js';
import { closingVarianceDraft, type ClosingVarianceInput } from './closing-variance.js';
import { walletTransferDraft, type WalletTransferInput } from './wallet-transfer.js';

/**
 * M08's three posting rules (architecture §7), each with the two tests a rule
 * owes (.claude/rules/money-and-ledger.md): a fast-check property that it
 * balances for random input, and a worked example whose numbers a person can
 * check by hand.
 *
 * The transfer's property is the one that matters most. A two-line transfer
 * balances perfectly while silently absorbing the bank charge, so "debits equal
 * credits" alone would pass the bug this milestone was warned about. The
 * property therefore also asserts that the charge reaches the charge account and
 * that the paying wallet is credited amount **plus** charge.
 */

const HAND_CASH = '11111111-1111-4111-8111-111111111111';
const BANK = '22222222-2222-4222-8222-222222222222';
const RENT = '33333333-3333-4333-8333-333333333333';
const CHARGES = '44444444-4444-4444-8444-444444444444';
const OVER_SHORT = '55555555-5555-4555-8555-555555555555';
const BRANCH = '66666666-6666-4666-8666-666666666666';
const ID_A = '77777777-7777-4777-8777-777777777777';
const ID_B = '88888888-8888-4888-8888-888888888888';

// --- cash out and petty cash ------------------------------------------------

function cashOut(overrides: Partial<CashOutInput> = {}): CashOutInput {
  return {
    entryId: ID_A,
    kind: 'petty_cash',
    occurredAt: new Date('2026-09-01T23:30:00Z'),
    wallet: { accountId: HAND_CASH, subtype: 'wallet_cash', branchId: BRANCH },
    expense: { accountId: RENT, subtype: 'operating_expense', branchId: null },
    amountPoisha: poisha(45_000),
    memo: 'Tea and biscuits for the showroom',
    ...overrides,
  };
}

describe('cash out: worked example', () => {
  it('posts ৳450 paid at 05:30 Dhaka on 2 Sep as Dr operating expense / Cr hand cash', () => {
    expect(cashOutDraft(cashOut())).toEqual({
      // 23:30 UTC on 1 Sep is 05:30 on 2 Sep in Dhaka (invariant 8).
      businessDate: '2026-09-02',
      sourceType: 'petty_cash',
      sourceId: ID_A,
      event: 'paid',
      idempotencyKey: `petty_cash:${ID_A}:paid`,
      memo: 'Tea and biscuits for the showroom',
      reversesJournalId: null,
      lines: [
        {
          accountId: RENT,
          debitPoisha: 45_000n,
          creditPoisha: 0n,
          branchId: BRANCH,
          partyType: null,
          partyId: null,
          memo: null,
        },
        {
          accountId: HAND_CASH,
          debitPoisha: 0n,
          creditPoisha: 45_000n,
          branchId: BRANCH,
          partyType: null,
          partyId: null,
          memo: null,
        },
      ],
    });
  });

  it('keys a cash out apart from a petty cash entry with the same id', () => {
    expect(cashOutDraft(cashOut({ kind: 'cash_out' })).idempotencyKey).toBe(
      `cash_out:${ID_A}:paid`,
    );
  });

  it('refuses a category that is not an operating expense', () => {
    // Debiting COGS here would book a cost of sale with no order behind it.
    expect(() =>
      cashOutDraft(cashOut({ expense: { accountId: RENT, subtype: 'cogs', branchId: null } })),
    ).toThrow(LedgerError);
  });

  it('refuses paying out of something that is not a wallet', () => {
    expect(() =>
      cashOutDraft(
        cashOut({ wallet: { accountId: HAND_CASH, subtype: 'inventory', branchId: BRANCH } }),
      ),
    ).toThrow(LedgerError);
  });

  it("refuses another branch's expense category", () => {
    expect(() =>
      cashOutDraft(
        cashOut({
          expense: { accountId: RENT, subtype: 'operating_expense', branchId: ID_B },
        }),
      ),
    ).toThrow(LedgerError);
  });

  it('balances for any positive amount', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 9_000_000_000_000_000n }), (amount) => {
        const draft = cashOutDraft(cashOut({ amountPoisha: poisha(amount) }));
        validateJournalDraft(draft);
        expect(sum(draft.lines.map((line) => line.debitPoisha))).toBe(
          sum(draft.lines.map((line) => line.creditPoisha)),
        );
      }),
    );
  });
});

// --- wallet transfer --------------------------------------------------------

function transfer(overrides: Partial<WalletTransferInput> = {}): WalletTransferInput {
  return {
    transferId: ID_A,
    occurredAt: new Date('2026-09-02T04:00:00Z'),
    from: { walletId: ID_A, accountId: HAND_CASH, subtype: 'wallet_cash', branchId: BRANCH },
    to: { walletId: ID_B, accountId: BANK, subtype: 'wallet_bank', branchId: null },
    amountPoisha: poisha(500_000),
    chargePoisha: poisha(2_000),
    charge: { accountId: CHARGES, subtype: 'bank_charges', branchId: null },
    memo: 'Till banked',
    ...overrides,
  };
}

describe('wallet transfer: worked example', () => {
  it('banks ৳5,000 with a ৳20 charge as three lines, crediting the till ৳5,020', () => {
    const draft = walletTransferDraft(transfer());

    expect(draft.sourceType).toBe('wallet_transfer');
    expect(draft.idempotencyKey).toBe(`wallet_transfer:${ID_A}:transferred`);
    expect(draft.lines).toEqual([
      {
        accountId: BANK,
        debitPoisha: 500_000n,
        creditPoisha: 0n,
        branchId: null,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: CHARGES,
        debitPoisha: 2_000n,
        creditPoisha: 0n,
        // The charge follows the wallet that bore it, not the one that received.
        branchId: BRANCH,
        partyType: null,
        partyId: null,
        memo: 'Transfer charge',
      },
      {
        accountId: HAND_CASH,
        debitPoisha: 0n,
        // Everything that left the till: ৳5,000 + ৳20.
        creditPoisha: 502_000n,
        branchId: BRANCH,
        partyType: null,
        partyId: null,
        memo: null,
      },
    ]);
  });

  it('posts two lines when there is no charge', () => {
    const draft = walletTransferDraft(transfer({ chargePoisha: poisha(0), charge: null }));
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[1]?.creditPoisha).toBe(500_000n);
  });

  it('refuses a charge with no account, and an account with no charge', () => {
    expect(() => walletTransferDraft(transfer({ charge: null }))).toThrow(LedgerError);
    expect(() => walletTransferDraft(transfer({ chargePoisha: poisha(0) }))).toThrow(LedgerError);
  });

  it('refuses a charge on anything but bank charges', () => {
    expect(() =>
      walletTransferDraft(
        transfer({ charge: { accountId: CHARGES, subtype: 'operating_expense', branchId: null } }),
      ),
    ).toThrow(LedgerError);
  });

  it('refuses a transfer to the same wallet, or to a wallet sharing its account', () => {
    expect(() =>
      walletTransferDraft(
        transfer({
          to: { walletId: ID_A, accountId: BANK, subtype: 'wallet_bank', branchId: null },
        }),
      ),
    ).toThrow(LedgerError);
    expect(() =>
      walletTransferDraft(
        transfer({
          to: { walletId: ID_B, accountId: HAND_CASH, subtype: 'wallet_bank', branchId: null },
        }),
      ),
    ).toThrow(LedgerError);
  });

  it('balances, and never absorbs the charge, for any amount and charge', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        (amount, charge) => {
          const input = transfer({
            amountPoisha: poisha(amount),
            chargePoisha: poisha(charge),
            charge:
              charge > 0n ? { accountId: CHARGES, subtype: 'bank_charges', branchId: null } : null,
          });
          // A charge larger than the transfer is an expense in disguise (M30, the ledger
          // audit's C-1), refused before any line is built.
          if (charge > amount) {
            expect(() => walletTransferDraft(input)).toThrow(/larger than the amount/);
            return;
          }
          const draft = walletTransferDraft(input);
          validateJournalDraft(draft);

          const debits = sum(draft.lines.map((line) => line.debitPoisha));
          const credits = sum(draft.lines.map((line) => line.creditPoisha));
          expect(debits).toBe(credits);

          // The property a two-line transfer would pass and must not: the
          // charge is its own line, and the payer is out amount + charge.
          const charged = draft.lines
            .filter((line) => line.accountId === CHARGES)
            .reduce((total, line) => total + line.debitPoisha, 0n);
          expect(charged).toBe(charge);
          const paid = draft.lines
            .filter((line) => line.accountId === HAND_CASH)
            .reduce((total, line) => total + line.creditPoisha, 0n);
          expect(paid).toBe(amount + charge);
        },
      ),
    );
  });
});

// --- closing variance -------------------------------------------------------

function variance(overrides: Partial<ClosingVarianceInput> = {}): ClosingVarianceInput {
  return {
    closingId: ID_A,
    businessDate: '2026-09-02',
    wallet: { accountId: HAND_CASH, subtype: 'wallet_cash', branchId: BRANCH },
    cashOverShort: { accountId: OVER_SHORT, subtype: 'cash_over_short' },
    variancePoisha: poisha(-15_000),
    memo: 'Counted ৳150 short',
    ...overrides,
  };
}

describe('closing variance: worked example', () => {
  it('posts a ৳150 shortfall as Dr cash over/short / Cr hand cash', () => {
    const draft = closingVarianceDraft(variance());

    expect(draft.businessDate).toBe('2026-09-02');
    expect(draft.idempotencyKey).toBe(`wallet_closing:${ID_A}:variance_posted`);
    expect(
      draft.lines.map((line) => [line.accountId, line.debitPoisha, line.creditPoisha]),
    ).toEqual([
      [OVER_SHORT, 15_000n, 0n],
      [HAND_CASH, 0n, 15_000n],
    ]);
  });

  it('posts an overage the other way round', () => {
    const draft = closingVarianceDraft(variance({ variancePoisha: poisha(15_000) }));
    expect(
      draft.lines.map((line) => [line.accountId, line.debitPoisha, line.creditPoisha]),
    ).toEqual([
      [HAND_CASH, 15_000n, 0n],
      [OVER_SHORT, 0n, 15_000n],
    ]);
  });

  it('refuses a balanced close, which has nothing to post', () => {
    expect(() => closingVarianceDraft(variance({ variancePoisha: poisha(0) }))).toThrow(
      LedgerError,
    );
  });

  it('refuses any account but cash over/short for the other side', () => {
    expect(() =>
      closingVarianceDraft(
        variance({ cashOverShort: { accountId: OVER_SHORT, subtype: 'operating_expense' } }),
      ),
    ).toThrow(LedgerError);
  });

  it('balances either way, for any non-zero variance', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000_000n, max: 1_000_000_000n }).filter((value) => value !== 0n),
        (amount) => {
          const draft = closingVarianceDraft(variance({ variancePoisha: poisha(amount) }));
          validateJournalDraft(draft);
          expect(sum(draft.lines.map((line) => line.debitPoisha))).toBe(
            sum(draft.lines.map((line) => line.creditPoisha)),
          );
        },
      ),
    );
  });
});
