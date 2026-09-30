import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LedgerError, validateJournalDraft } from '../ledger/index.js';
import { poisha, sum } from '../money/index.js';
import { cashInDraft, type CashInInput } from './cash-in.js';

/**
 * Cash in: Dr W / Cr other income (architecture §7). The two tests every
 * posting rule owes (.claude/rules/money-and-ledger.md): a property that it
 * balances for random input, and a worked example with numbers a person can
 * check by hand.
 */

const WALLET = '22222222-2222-4222-8222-222222222222';
const INCOME = '33333333-3333-4333-8333-333333333333';
const BRANCH = '44444444-4444-4444-8444-444444444444';
const ENTRY = '55555555-5555-4555-8555-555555555555';

function input(overrides: Partial<CashInInput> = {}): CashInInput {
  return {
    entryId: ENTRY,
    occurredAt: new Date('2026-09-01T23:30:00Z'),
    wallet: { accountId: WALLET, subtype: 'wallet_cash', branchId: BRANCH },
    income: { accountId: INCOME, subtype: 'other_income', branchId: null },
    amountPoisha: poisha(125_050),
    memo: 'Scrap cartons sold',
    ...overrides,
  };
}

describe('cash in: worked example', () => {
  it('posts ৳1,250.50 received at 05:30 Dhaka on 2 Sep as Dr hand cash / Cr other income', () => {
    const draft = cashInDraft(input());

    expect(draft).toEqual({
      // 23:30 UTC on 1 Sep is 05:30 on 2 Sep in Dhaka.
      businessDate: '2026-09-02',
      sourceType: 'cash_in',
      sourceId: ENTRY,
      event: 'received',
      idempotencyKey: `cash_in:${ENTRY}:received`,
      memo: 'Scrap cartons sold',
      reversesJournalId: null,
      lines: [
        {
          accountId: WALLET,
          debitPoisha: 125_050n,
          creditPoisha: 0n,
          branchId: BRANCH,
          partyType: null,
          partyId: null,
          memo: null,
        },
        {
          accountId: INCOME,
          debitPoisha: 0n,
          creditPoisha: 125_050n,
          branchId: BRANCH,
          partyType: null,
          partyId: null,
          memo: null,
        },
      ],
    });
    expect(() => validateJournalDraft(draft)).not.toThrow();
  });
});

describe('cash in: balances for any input', () => {
  it('debits equal credits, equal the amount, and the draft validates', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9n * 10n ** 14n }),
        fc.constantFrom('wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other' as const),
        fc.option(fc.uuid({ version: 4 }), { nil: null }),
        fc.date({
          min: new Date('2020-01-01T00:00:00Z'),
          max: new Date('2035-01-01T00:00:00Z'),
          noInvalidDate: true,
        }),
        fc.uuid({ version: 4 }),
        (amount, subtype, branchId, occurredAt, entryId) => {
          fc.pre(!Number.isNaN(occurredAt.getTime()));
          const draft = cashInDraft(
            input({
              amountPoisha: poisha(amount),
              wallet: { accountId: WALLET, subtype, branchId },
              occurredAt,
              entryId,
            }),
          );
          validateJournalDraft(draft);
          const debits = sum(draft.lines.map((l) => l.debitPoisha));
          const credits = sum(draft.lines.map((l) => l.creditPoisha));
          expect(debits).toBe(credits);
          expect(debits).toBe(amount);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('cash in: refuses what it must not post', () => {
  const refuse = (overrides: Partial<CashInInput>): void => {
    expect(() => cashInDraft(input(overrides))).toThrow(LedgerError);
  };

  it('a zero or negative amount', () => {
    refuse({ amountPoisha: poisha(0) });
    refuse({ amountPoisha: poisha(-100) });
  });

  it('a non-wallet account on the debit side', () => {
    refuse({ wallet: { accountId: WALLET, subtype: 'inventory', branchId: null } });
  });

  it('crediting anything but other income — sales revenue would be a sale with no order', () => {
    refuse({ income: { accountId: INCOME, subtype: 'sales_revenue', branchId: null } });
    refuse({ income: { accountId: INCOME, subtype: 'inventory_adjustment_gain', branchId: null } });
    refuse({ income: { accountId: INCOME, subtype: 'owner_capital', branchId: null } });
  });

  it("an income category tied to another branch than the wallet's", () => {
    refuse({
      income: {
        accountId: INCOME,
        subtype: 'other_income',
        branchId: '66666666-6666-4666-8666-666666666666',
      },
    });
  });
});
