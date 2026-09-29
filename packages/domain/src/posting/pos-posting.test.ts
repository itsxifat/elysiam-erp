import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LedgerError, validateJournalDraft, type JournalDraft } from '../ledger/index.js';
import { allocate, poisha, sum, type Poisha } from '../money/index.js';
import { posReturnDraft, type PosReturnInput } from './pos-return.js';
import { posSaleDraft, type PosSaleInput } from './pos-sale.js';
import type { PostingAccount } from './supply-received.js';

/**
 * M23's two journals: balance for random inputs (fast-check), a worked example to
 * the poisha, the deterministic key a re-sync depends on, and the refusals.
 */

const SALE = '0b7e9d0c-3f1a-4c55-9a53-6f0f4d1a2b01';
const RETURN = '5d1c3e7a-8b2f-4e61-a0c4-2e9b7f6d5c02';
const BRANCH = 'c2f9a1e0-7d3b-4a8e-9f10-1b2c3d4e5f60';

const account = (id: string, subtype: PostingAccount['subtype'], branchId: string | null = null) =>
  ({ accountId: id, subtype, branchId }) satisfies PostingAccount;

const HAND_CASH = account('00000000-0000-4000-8000-000000001010', 'wallet_cash', BRANCH);
const BKASH = account('00000000-0000-4000-8000-000000001110', 'wallet_bkash');
const BANK = account('00000000-0000-4000-8000-000000001100', 'wallet_bank');
const REVENUE = account('00000000-0000-4000-8000-000000004000', 'sales_revenue');
const COGS = account('00000000-0000-4000-8000-000000005000', 'cogs');
const INVENTORY = account('00000000-0000-4000-8000-000000001300', 'inventory');

function totals(draft: JournalDraft) {
  return {
    debit: sum(draft.lines.map((line) => line.debitPoisha)),
    credit: sum(draft.lines.map((line) => line.creditPoisha)),
  };
}

function saleInput(overrides: Partial<PosSaleInput> = {}): PosSaleInput {
  return {
    saleId: SALE,
    businessDate: '2026-09-28',
    tenders: [
      { account: HAND_CASH, amountPoisha: poisha(100_000) },
      { account: BKASH, amountPoisha: poisha(50_000) },
    ],
    salesRevenue: REVENUE,
    cogs: COGS,
    inventory: INVENTORY,
    netPoisha: poisha(150_000),
    costPoisha: poisha(90_000),
    branchId: BRANCH,
    memo: null,
    ...overrides,
  };
}

describe('posSaleDraft', () => {
  it('posts the worked example: ৳1,500 split cash and bKash, cost ৳900', () => {
    /*
     * Two shirts at ৳800 with ৳100 off the pair: ৳1,500 net, paid ৳1,000 in cash and
     * ৳500 by bKash. Both left the shelf at a weighted average of ৳450.
     *
     *   Dr Hand cash   1,000.00     Cr Sales revenue  1,500.00
     *   Dr bKash         500.00
     *   Dr COGS          900.00     Cr Inventory        900.00
     */
    const draft = posSaleDraft(saleInput());
    validateJournalDraft(draft);
    expect(draft.lines.map((line) => [line.accountId, line.debitPoisha, line.creditPoisha])).toEqual([
      [HAND_CASH.accountId, 100_000n, 0n],
      [BKASH.accountId, 50_000n, 0n],
      [REVENUE.accountId, 0n, 150_000n],
      [COGS.accountId, 90_000n, 0n],
      [INVENTORY.accountId, 0n, 90_000n],
    ]);
    expect(totals(draft)).toEqual({ debit: 240_000n, credit: 240_000n });
  });

  it('keys on the till’s own sale id, so a re-sync reaches the ledger with the same key', () => {
    const first = posSaleDraft(saleInput());
    const again = posSaleDraft(saleInput({ saleId: SALE.toUpperCase() }));
    expect(first.idempotencyKey).toBe(`pos_sale:${SALE}:sold`);
    expect(again.idempotencyKey).toBe(first.idempotencyKey);
    expect(again.sourceId).toBe(first.sourceId);
  });

  it('carries the hand-cash account’s branch and the sale’s branch on org-level lines', () => {
    const draft = posSaleDraft(saleInput());
    expect(draft.lines.every((line) => line.branchId === BRANCH)).toBe(true);
  });

  it('balances for any split of any sale, with or without a cost', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        fc.array(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 3 }),
        (net, cost, weights) => {
          const wallets = [HAND_CASH, BKASH, BANK];
          const parts = allocate(poisha(net), weights);
          const tenders = parts
            .map((amount, index) => ({ account: wallets[index] ?? BANK, amountPoisha: amount }))
            .filter((tender) => tender.amountPoisha > 0n);
          const draft = posSaleDraft(
            saleInput({ tenders, netPoisha: poisha(net), costPoisha: poisha(cost) }),
          );
          validateJournalDraft(draft);
          const { debit, credit } = totals(draft);
          expect(debit).toBe(credit);
          expect(debit).toBe(net + cost);
        },
      ),
    );
  });

  it('posts only the cost pair for a sale given away in full', () => {
    const draft = posSaleDraft(saleInput({ tenders: [], netPoisha: poisha(0) }));
    validateJournalDraft(draft);
    expect(draft.lines.map((line) => line.accountId)).toEqual([COGS.accountId, INVENTORY.accountId]);
  });

  it('refuses tenders that do not pay the sale exactly', () => {
    expect(() => posSaleDraft(saleInput({ netPoisha: poisha(150_001) }))).toThrow(LedgerError);
  });

  it('refuses a tender into an account that is not a wallet', () => {
    expect(() =>
      posSaleDraft(
        saleInput({
          tenders: [{ account: REVENUE, amountPoisha: poisha(150_000) }],
        }),
      ),
    ).toThrow(/wallet/);
  });

  it('refuses a sale that moved no value rather than emitting an empty journal', () => {
    expect(() =>
      posSaleDraft(saleInput({ tenders: [], netPoisha: poisha(0), costPoisha: poisha(0) })),
    ).toThrow(/no journal/);
  });

  it('refuses the wrong account for revenue, cost or stock', () => {
    expect(() => posSaleDraft(saleInput({ salesRevenue: COGS }))).toThrow(/sales_revenue/);
    expect(() => posSaleDraft(saleInput({ inventory: COGS }))).toThrow(/inventory/);
  });
});

function returnInput(overrides: Partial<PosReturnInput> = {}): PosReturnInput {
  return {
    returnId: RETURN,
    businessDate: '2026-09-29',
    refunds: [{ account: HAND_CASH, amountPoisha: poisha(75_000) }],
    salesRevenue: REVENUE,
    cogs: COGS,
    inventory: INVENTORY,
    refundPoisha: poisha(75_000),
    costPoisha: poisha(45_000),
    branchId: BRANCH,
    memo: null,
    ...overrides,
  };
}

describe('posReturnDraft', () => {
  it('posts the worked example: one of the two shirts back, ৳750 refunded in cash', () => {
    /*
     * The customer returns one shirt from the sale above. Its line was ৳1,500 for two,
     * so the refund is ৳750; it left the shelf at ৳450 and comes back at ৳450.
     *
     *   Dr Sales revenue  750.00     Cr Hand cash  750.00
     *   Dr Inventory      450.00     Cr COGS       450.00
     */
    const draft = posReturnDraft(returnInput());
    validateJournalDraft(draft);
    expect(draft.lines.map((line) => [line.accountId, line.debitPoisha, line.creditPoisha])).toEqual([
      [REVENUE.accountId, 75_000n, 0n],
      [HAND_CASH.accountId, 0n, 75_000n],
      [INVENTORY.accountId, 45_000n, 0n],
      [COGS.accountId, 0n, 45_000n],
    ]);
    expect(draft.idempotencyKey).toBe(`pos_return:${RETURN}:returned`);
  });

  it('balances for any refund split and cost', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        (refund, cost) => {
          const [cash, bkash] = allocate(poisha(refund), [3, 1]) as [Poisha, Poisha];
          const refunds = [
            { account: HAND_CASH, amountPoisha: cash },
            { account: BKASH, amountPoisha: bkash },
          ].filter((line) => line.amountPoisha > 0n);
          const draft = posReturnDraft(
            returnInput({ refunds, refundPoisha: poisha(refund), costPoisha: poisha(cost) }),
          );
          validateJournalDraft(draft);
          const { debit, credit } = totals(draft);
          expect(debit).toBe(credit);
          expect(debit).toBe(refund + cost);
        },
      ),
    );
  });

  it('refuses refunds that do not add up to the refund', () => {
    expect(() => posReturnDraft(returnInput({ refundPoisha: poisha(74_999) }))).toThrow(LedgerError);
  });
});
