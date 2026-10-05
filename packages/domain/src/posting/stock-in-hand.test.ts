import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { LedgerError, validateJournalDraft } from '../ledger/index.js';
import { poisha, sum } from '../money/index.js';
import { openingBalanceDraft } from './opening-balance.js';
import {
  STOCK_IN_HAND_MAX_LINES,
  stockInHandDraft,
  stockInHandValue,
  type StockInHandInput,
} from './stock-in-hand.js';

/**
 * Stock in hand at the start (M38a, D-602): the two tests every posting rule owes
 * (`.claude/rules/money-and-ledger.md`), a property that it balances for any lines and a
 * worked example a person can check, plus what makes this rule different from M14a's: a key
 * per entry, and no plug.
 */

const INVENTORY = '11111111-1111-4111-8111-111111111111';
const EQUITY = '22222222-2222-4222-8222-222222222222';
const ENTRY = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const BRANCH = '55555555-5555-4555-8555-555555555555';

function entry(overrides: Partial<StockInHandInput> = {}): StockInHandInput {
  return {
    entryId: ENTRY,
    occurredAt: new Date('2026-10-05T06:00:00Z'),
    inventory: { accountId: INVENTORY, subtype: 'inventory', branchId: null },
    equity: { accountId: EQUITY, subtype: 'opening_equity', branchId: null },
    lines: [
      { qty: 12, unitCostPoisha: poisha(85_000) },
      { qty: 8, unitCostPoisha: poisha(92_550) },
    ],
    branchId: null,
    memo: 'Shelf A, counted in',
    ...overrides,
  };
}

describe('stock in hand', () => {
  it('debits inventory and credits opening equity with Σ qty × cost per piece', () => {
    const draft = stockInHandDraft(entry());
    validateJournalDraft(draft);
    // 12 × 85,000 + 8 × 92,550 = 1,020,000 + 740,400 = 1,760,400 poisha (৳17,604.00).
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0]).toMatchObject({
      accountId: INVENTORY,
      debitPoisha: 1_760_400n,
      creditPoisha: 0n,
    });
    expect(draft.lines[1]).toMatchObject({
      accountId: EQUITY,
      debitPoisha: 0n,
      creditPoisha: 1_760_400n,
    });
    expect(draft.idempotencyKey).toBe(`stock_in_hand:${ENTRY}:posted`);
    expect(draft.sourceType).toBe('stock_in_hand');
    // 06:00 UTC is 12:00 in Dhaka, the same calendar day.
    expect(draft.businessDate).toBe('2026-10-05');
  });

  it('balances for any lines, and the credit is exactly the value the lines hold', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 5_000 }),
            cost: fc.bigInt({ min: 1n, max: 50_000_000n }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        fc.option(fc.uuid({ version: 4 }), { nil: null }),
        fc.uuid({ version: 4 }),
        (lines, branchId, entryId) => {
          const priced = lines.map((line) => ({
            qty: line.qty,
            unitCostPoisha: poisha(line.cost),
          }));
          const draft = stockInHandDraft(entry({ lines: priced, branchId, entryId }));
          validateJournalDraft(draft);
          const debit = sum(draft.lines.map((line) => poisha(line.debitPoisha)));
          const credit = sum(draft.lines.map((line) => poisha(line.creditPoisha)));
          expect(debit).toBe(credit);
          const expected = lines.reduce((total, line) => total + line.cost * BigInt(line.qty), 0n);
          expect(debit).toBe(expected);
          expect(stockInHandValue(priced)).toBe(expected);
          // One journal per entry: the key is the entry's.
          expect(draft.idempotencyKey).toBe(`stock_in_hand:${entryId.toLowerCase()}:posted`);
          // An org-level account takes the stock's branch.
          expect(draft.lines[0]?.branchId).toBe(branchId);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('never shares a key with M14a’s one opening journal', () => {
    const opening = openingBalanceDraft({
      orgId: ORG,
      asOf: toIsoDate('2026-10-04'),
      assets: [
        {
          account: { accountId: INVENTORY, subtype: 'inventory', branchId: null },
          amountPoisha: poisha(100),
        },
      ],
      liabilities: [],
      equity: { accountId: EQUITY, subtype: 'opening_equity', branchId: null },
    });
    fc.assert(
      fc.property(fc.uuid({ version: 4 }), (entryId) => {
        expect(stockInHandDraft(entry({ entryId })).idempotencyKey).not.toBe(
          opening.idempotencyKey,
        );
      }),
    );
  });

  it('keeps a branch account’s own branch', () => {
    const draft = stockInHandDraft(
      entry({
        inventory: { accountId: INVENTORY, subtype: 'inventory', branchId: BRANCH },
        branchId: null,
      }),
    );
    expect(draft.lines[0]?.branchId).toBe(BRANCH);
  });

  it('refuses a cost of zero, a quantity of zero and an empty entry', () => {
    expect(() =>
      stockInHandDraft(entry({ lines: [{ qty: 3, unitCostPoisha: poisha(0) }] })),
    ).toThrow(/cost of zero/);
    expect(() =>
      stockInHandDraft(entry({ lines: [{ qty: 0, unitCostPoisha: poisha(100) }] })),
    ).toThrow(LedgerError);
    expect(() => stockInHandDraft(entry({ lines: [] }))).toThrow(LedgerError);
    expect(() =>
      stockInHandDraft(
        entry({
          lines: Array.from({ length: STOCK_IN_HAND_MAX_LINES + 1 }, () => ({
            qty: 1,
            unitCostPoisha: poisha(100),
          })),
        }),
      ),
    ).toThrow(LedgerError);
  });

  it('refuses the wrong accounts and an entry id that is not a uuid', () => {
    expect(() =>
      stockInHandDraft(
        entry({ equity: { accountId: EQUITY, subtype: 'retained_earnings', branchId: null } }),
      ),
    ).toThrow(LedgerError);
    expect(() =>
      stockInHandDraft(
        entry({ inventory: { accountId: INVENTORY, subtype: 'cogs', branchId: null } }),
      ),
    ).toThrow(LedgerError);
    expect(() => stockInHandDraft(entry({ entryId: 'shelf-a' }))).toThrow(LedgerError);
  });
});
