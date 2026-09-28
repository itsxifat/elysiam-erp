import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LedgerError, validateJournalDraft } from '../ledger/index.js';
import { poisha, sum } from '../money/index.js';
import { handoverDraft, type HandoverInput } from './handover.js';
import { stockAdjustmentDraft, type StockAdjustmentInput } from './stock-adjustment.js';
import { supplierReturnDraft, type SupplierReturnInput } from './supplier-return.js';
import { supplyReceivedDraft, type SupplyReceivedInput } from './supply-received.js';

/**
 * M07's four posting rules (architecture §7), each with the two tests a rule owes
 * (`.claude/rules/money-and-ledger.md`): a fast-check property that it balances
 * for random input, and a worked example whose numbers a person can check.
 *
 * The supplier return's property is the one that earns its keep. Two of its three
 * lines are computed from *different* unit costs, and the third is their
 * difference — so "debits equal credits" is not a weak check here but the exact
 * statement of the rule: if the variance were computed with the wrong sign, or
 * dropped when the two costs differ, the journal would not balance. The property
 * therefore also asserts which side the variance lands on, because a sign error
 * that flips both the variance and its side still balances.
 */

const INVENTORY = '11111111-1111-4111-8111-111111111111';
const PAYABLE = '22222222-2222-4222-8222-222222222222';
const VARIANCE = '33333333-3333-4333-8333-333333333333';
const TRANSIT = '44444444-4444-4444-8444-444444444444';
const WRITE_OFF = '55555555-5555-4555-8555-555555555555';
const GAIN = '66666666-6666-4666-8666-666666666666';
const SUPPLIER = '77777777-7777-4777-8777-777777777777';
const SOURCE = '88888888-8888-4888-8888-888888888888';
const BRANCH = '99999999-9999-4999-8999-999999999999';

function debits(draft: { lines: readonly { debitPoisha: bigint }[] }): bigint {
  return sum(draft.lines.map((line) => poisha(line.debitPoisha)));
}
function credits(draft: { lines: readonly { creditPoisha: bigint }[] }): bigint {
  return sum(draft.lines.map((line) => poisha(line.creditPoisha)));
}

// --- supply received ---------------------------------------------------------

function receipt(overrides: Partial<SupplyReceivedInput> = {}): SupplyReceivedInput {
  return {
    supplyId: SOURCE,
    occurredAt: new Date('2026-04-10T04:00:00Z'),
    inventory: { accountId: INVENTORY, subtype: 'inventory', branchId: null },
    payable: { accountId: PAYABLE, subtype: 'supplier_payable', branchId: null },
    supplierId: SUPPLIER,
    lines: [
      { qty: 30, unitCostPoisha: poisha(54_000) },
      { qty: 10, unitCostPoisha: poisha(50_000) },
    ],
    branchId: null,
    memo: 'Invoice 4412',
    ...overrides,
  };
}

describe('supply received', () => {
  it('debits inventory and credits the supplier with Σ qty × unit cost', () => {
    const draft = supplyReceivedDraft(receipt());
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`supply:${SOURCE}:received`);
    // 30 × 54,000 + 10 × 50,000 = 2,120,000 poisha (৳21,200.00).
    expect(draft.lines[0]).toMatchObject({ accountId: INVENTORY, debitPoisha: 2_120_000n });
    expect(draft.lines[1]).toMatchObject({
      accountId: PAYABLE,
      creditPoisha: 2_120_000n,
      partyType: 'supplier',
      partyId: SUPPLIER,
    });
  });

  it('balances for random lines, and always names the supplier', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 900 }),
            unitCost: fc.bigInt({ min: 1n, max: 9_000_000n }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        fc.option(fc.uuid({ version: 4 }), { nil: null }),
        (lines, branchId) => {
          const draft = supplyReceivedDraft(
            receipt({
              lines: lines.map((line) => ({
                qty: line.qty,
                unitCostPoisha: poisha(line.unitCost),
              })),
              branchId,
            }),
          );
          validateJournalDraft(draft);
          expect(debits(draft)).toBe(credits(draft));
          expect(draft.lines.filter((line) => line.partyType === 'supplier')).toHaveLength(1);
          // An org-level account takes the caller's branch; a branch account keeps its own.
          expect(draft.lines[0]?.branchId).toBe(branchId);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses a receipt worth nothing, and points at the right entry instead', () => {
    expect(() =>
      supplyReceivedDraft(receipt({ lines: [{ qty: 5, unitCostPoisha: poisha(0) }] })),
    ).toThrow(/stock gain/);
  });

  it('refuses the wrong kind of account', () => {
    expect(() =>
      supplyReceivedDraft(
        receipt({ inventory: { accountId: INVENTORY, subtype: 'cogs', branchId: null } }),
      ),
    ).toThrow(LedgerError);
  });
});

// --- supplier return ---------------------------------------------------------

function supplierReturn(overrides: Partial<SupplierReturnInput> = {}): SupplierReturnInput {
  return {
    returnId: SOURCE,
    occurredAt: new Date('2026-04-20T04:00:00Z'),
    payable: { accountId: PAYABLE, subtype: 'supplier_payable', branchId: null },
    inventory: { accountId: INVENTORY, subtype: 'inventory', branchId: null },
    variance: { accountId: VARIANCE, subtype: 'purchase_price_variance', branchId: null },
    supplierId: SUPPLIER,
    lines: [{ qty: 3, originalUnitCostPoisha: poisha(54_000), currentWacPoisha: poisha(53_000) }],
    branchId: null,
    memo: null,
    ...overrides,
  };
}

describe('supplier return', () => {
  it('reproduces §8’s worked example: 162,000 / 159,000 / 3,000 credit', () => {
    const draft = supplierReturnDraft(supplierReturn());
    validateJournalDraft(draft);
    expect(draft.lines).toHaveLength(3);
    expect(draft.lines[0]).toMatchObject({ accountId: PAYABLE, debitPoisha: 162_000n });
    expect(draft.lines[1]).toMatchObject({ accountId: INVENTORY, creditPoisha: 159_000n });
    expect(draft.lines[2]).toMatchObject({
      accountId: VARIANCE,
      debitPoisha: 0n,
      creditPoisha: 3_000n,
    });
  });

  it('drops the variance line when the two costs agree', () => {
    const draft = supplierReturnDraft(
      supplierReturn({
        lines: [
          { qty: 3, originalUnitCostPoisha: poisha(54_000), currentWacPoisha: poisha(54_000) },
        ],
      }),
    );
    validateJournalDraft(draft);
    expect(draft.lines).toHaveLength(2);
  });

  it('balances for random costs, and puts the variance on the right side', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        (qty, original, wac) => {
          fc.pre(original > 0n || wac > 0n);
          const draft = supplierReturnDraft(
            supplierReturn({
              lines: [
                {
                  qty,
                  originalUnitCostPoisha: poisha(original),
                  currentWacPoisha: poisha(wac),
                },
              ],
            }),
          );
          validateJournalDraft(draft);
          expect(debits(draft)).toBe(credits(draft));

          const varianceLine = draft.lines.find((line) => line.accountId === VARIANCE);
          if (original === wac) {
            expect(varianceLine).toBeUndefined();
          } else if (original > wac) {
            // Credited more than carried: a gain, so the variance is a credit.
            expect(varianceLine?.creditPoisha).toBe((original - wac) * BigInt(qty));
          } else {
            expect(varianceLine?.debitPoisha).toBe((wac - original) * BigInt(qty));
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// --- handover ----------------------------------------------------------------

function handover(overrides: Partial<HandoverInput> = {}): HandoverInput {
  return {
    orderId: SOURCE,
    occurredAt: new Date('2026-05-01T12:00:00Z'),
    goodsInTransit: { accountId: TRANSIT, subtype: 'goods_in_transit', branchId: null },
    inventory: { accountId: INVENTORY, subtype: 'inventory', branchId: null },
    lines: [{ qty: 2, unitCostPoisha: poisha(53_000) }],
    branchId: BRANCH,
    memo: null,
    ...overrides,
  };
}

describe('order handed to courier', () => {
  it('moves qty × WAC at handover from inventory to goods in transit', () => {
    const draft = handoverDraft(handover());
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${SOURCE}:handover`);
    expect(draft.lines[0]).toMatchObject({ accountId: TRANSIT, debitPoisha: 106_000n });
    expect(draft.lines[1]).toMatchObject({ accountId: INVENTORY, creditPoisha: 106_000n });
    // Both lines carry the dispatching branch, so a showroom's P&L sees it.
    expect(draft.lines.every((line) => line.branchId === BRANCH)).toBe(true);
  });

  it('balances for random lines', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 60 }),
            unitCost: fc.bigInt({ min: 1n, max: 2_000_000n }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (lines) => {
          const draft = handoverDraft(
            handover({
              lines: lines.map((l) => ({ qty: l.qty, unitCostPoisha: poisha(l.unitCost) })),
            }),
          );
          validateJournalDraft(draft);
          expect(debits(draft)).toBe(credits(draft));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses a handover of units carried at no cost, with a code the caller can act on', () => {
    expect(() =>
      handoverDraft(handover({ lines: [{ qty: 3, unitCostPoisha: poisha(0) }] })),
    ).toThrow(/posts nothing/);
  });
});

// --- write-off and gain ------------------------------------------------------

function adjustment(overrides: Partial<StockAdjustmentInput> = {}): StockAdjustmentInput {
  return {
    adjustmentId: SOURCE,
    occurredAt: new Date('2026-06-15T05:00:00Z'),
    direction: 'loss',
    inventory: { accountId: INVENTORY, subtype: 'inventory', branchId: null },
    counterAccount: { accountId: WRITE_OFF, subtype: 'inventory_writeoff', branchId: null },
    valuePoisha: poisha(159_000),
    branchId: BRANCH,
    memo: 'Water damage',
    ...overrides,
  };
}

describe('stock write-off and gain', () => {
  it('write-off debits the expense and credits inventory', () => {
    const draft = stockAdjustmentDraft(adjustment());
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`stock_adjustment:${SOURCE}:written_off`);
    expect(draft.lines[0]).toMatchObject({ accountId: WRITE_OFF, debitPoisha: 159_000n });
    expect(draft.lines[1]).toMatchObject({ accountId: INVENTORY, creditPoisha: 159_000n });
  });

  it('gain debits inventory and credits the adjustment gain', () => {
    const draft = stockAdjustmentDraft(
      adjustment({
        direction: 'gain',
        counterAccount: { accountId: GAIN, subtype: 'inventory_adjustment_gain', branchId: null },
      }),
    );
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`stock_adjustment:${SOURCE}:gained`);
    expect(draft.lines[0]).toMatchObject({ accountId: INVENTORY, debitPoisha: 159_000n });
    expect(draft.lines[1]).toMatchObject({ accountId: GAIN, creditPoisha: 159_000n });
  });

  it('balances for random values in both directions', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9n * 10n ** 14n }),
        fc.constantFrom('loss', 'gain' as const),
        (value, direction) => {
          const draft = stockAdjustmentDraft(
            adjustment({
              direction,
              valuePoisha: poisha(value),
              counterAccount:
                direction === 'loss'
                  ? { accountId: WRITE_OFF, subtype: 'inventory_writeoff', branchId: null }
                  : { accountId: GAIN, subtype: 'inventory_adjustment_gain', branchId: null },
            }),
          );
          validateJournalDraft(draft);
          expect(debits(draft)).toBe(credits(draft));
          expect(debits(draft)).toBe(value);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('refuses a write-off posted against the gain account', () => {
    expect(() =>
      stockAdjustmentDraft(
        adjustment({
          counterAccount: { accountId: GAIN, subtype: 'inventory_adjustment_gain', branchId: null },
        }),
      ),
    ).toThrow(LedgerError);
  });
});
