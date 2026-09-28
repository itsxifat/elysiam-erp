import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateJournalDraft, type JournalDraft } from '../ledger/index.js';
import { poisha } from '../money/index.js';
import { customerAdvanceDraft } from './customer-advance.js';
import { dispatchValue, orderDeliveredDraft } from './order-delivered.js';
import { orderExchangeDraft } from './order-exchange.js';
import { orderReturnDraft } from './order-return.js';
import type { PostingAccount } from './supply-received.js';

/**
 * The money-and-ledger rule for every posting function: a fast-check test proving it
 * balances for random inputs, and a worked example with hand-computed numbers.
 */

const ORDER_ID = '7f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
const COURIER_ID = '11111111-2222-3333-4444-555555555555';
const AT = new Date('2026-09-25T06:00:00Z');

/**
 * A stable uuid per subtype, derived from an index.
 *
 * `validateJournalDraft` insists every account id is a uuid — the same check the
 * database makes — so a readable placeholder like `acct-cogs` would pass every
 * assertion in this file and fail the one that matters. Deriving the id from the
 * subtype keeps the assertions readable and keeps them honest.
 */
let nextAccount = 0;
const accountIds = new Map<string, string>();

function accountIdFor(subtype: string): string {
  const existing = accountIds.get(subtype);
  if (existing !== undefined) return existing;
  nextAccount += 1;
  const id = `aaaaaaaa-0000-4000-8000-${String(nextAccount).padStart(12, '0')}`;
  accountIds.set(subtype, id);
  return id;
}

const account = (
  subtype: PostingAccount['subtype'],
  branchId: string | null = null,
): PostingAccount => ({ accountId: accountIdFor(subtype), subtype, branchId });

const ACCOUNTS = {
  courierReceivable: account('courier_receivable'),
  salesRevenue: account('sales_revenue'),
  deliveryIncome: account('delivery_charge_income'),
  cogs: account('cogs'),
  goodsInTransit: account('goods_in_transit'),
  inventory: account('inventory'),
  customerAdvance: account('customer_advance'),
  salesDiscounts: account('sales_discounts'),
  bkash: account('wallet_bkash'),
};

function totals(draft: JournalDraft): { debits: bigint; credits: bigint } {
  return draft.lines.reduce(
    (acc, line) => ({
      debits: acc.debits + BigInt(line.debitPoisha),
      credits: acc.credits + BigInt(line.creditPoisha),
    }),
    { debits: 0n, credits: 0n },
  );
}

/** Σ debits on one account, minus Σ credits. The trial-balance contribution. */
function net(draft: JournalDraft, accountId: string): bigint {
  return draft.lines
    .filter((line) => line.accountId === accountId)
    .reduce((acc, line) => acc + BigInt(line.debitPoisha) - BigInt(line.creditPoisha), 0n);
}

describe('orderDeliveredDraft (§7, D-003)', () => {
  it('posts a hand-computed full COD delivery', () => {
    /*
     * Two shirts at ৳1,250 with ৳300 off, ৳60 delivery, nothing paid in advance, and
     * the two shirts cost ৳800 each at dispatch.
     *
     *   net items  = 250000 − 30000 = 220000
     *   collected  = 220000 + 6000  = 226000
     *   cost       = 2 × 80000      = 160000
     */
    const draft = orderDeliveredDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      partial: false,
      ...ACCOUNTS,
      courierId: COURIER_ID,
      netItemsPoisha: poisha(220_000),
      deliveryChargePoisha: poisha(6_000),
      advanceAppliedPoisha: poisha(0),
      collectedPoisha: poisha(226_000),
      costPoisha: dispatchValue([{ qty: 2, unitCostPoisha: poisha(80_000) }]),
      branchId: null,
      memo: null,
    });

    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:delivered`);
    expect(draft.businessDate).toBe('2026-09-25');
    expect(net(draft, accountIdFor('courier_receivable'))).toBe(226_000n);
    expect(net(draft, accountIdFor('sales_revenue'))).toBe(-220_000n);
    expect(net(draft, accountIdFor('delivery_charge_income'))).toBe(-6_000n);
    expect(net(draft, accountIdFor('cogs'))).toBe(160_000n);
    expect(net(draft, accountIdFor('goods_in_transit'))).toBe(-160_000n);
    // Gross profit: 220000 revenue − 160000 cost = 60000, and the delivery charge is
    // income rather than a discount on the goods.
    expect(-net(draft, accountIdFor('sales_revenue')) - net(draft, accountIdFor('cogs'))).toBe(
      60_000n,
    );
    expect(draft.lines.every((line) => line.partyId === null || line.partyType === 'courier')).toBe(
      true,
    );
  });

  it('names the courier on the receivable, because the balance is per courier (§7)', () => {
    const draft = orderDeliveredDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      partial: false,
      ...ACCOUNTS,
      courierId: COURIER_ID,
      netItemsPoisha: poisha(100_000),
      deliveryChargePoisha: poisha(6_000),
      advanceAppliedPoisha: poisha(0),
      collectedPoisha: poisha(106_000),
      costPoisha: poisha(50_000),
      branchId: null,
      memo: null,
    });
    const receivable = draft.lines.find(
      (line) => line.accountId === accountIdFor('courier_receivable'),
    );
    expect(receivable?.partyType).toBe('courier');
    expect(receivable?.partyId).toBe(COURIER_ID);
  });

  it('sends a short collection to Sales discounts with its reason (check 5)', () => {
    // The courier collected ৳2,200 against a door price of ৳2,260: ৳60 short.
    const draft = orderDeliveredDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      partial: true,
      ...ACCOUNTS,
      courierId: COURIER_ID,
      netItemsPoisha: poisha(220_000),
      deliveryChargePoisha: poisha(6_000),
      advanceAppliedPoisha: poisha(0),
      collectedPoisha: poisha(220_000),
      costPoisha: poisha(160_000),
      differenceReason: 'Rider waived the delivery charge.',
      branchId: null,
      memo: null,
    });
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:partially_delivered`);
    expect(net(draft, accountIdFor('sales_discounts'))).toBe(6_000n);
    expect(
      draft.lines.find((line) => line.accountId === accountIdFor('sales_discounts'))?.memo,
    ).toBe('Rider waived the delivery charge.');
    // Revenue is untouched by the shortfall: §7 puts the difference in its own account
    // so "what did we sell for" and "what did we give away" stay separable.
    expect(net(draft, accountIdFor('sales_revenue'))).toBe(-220_000n);
  });

  it('credits Sales discounts when the courier collected more than the door price', () => {
    const draft = orderDeliveredDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      partial: false,
      ...ACCOUNTS,
      courierId: COURIER_ID,
      netItemsPoisha: poisha(100_000),
      deliveryChargePoisha: poisha(0),
      advanceAppliedPoisha: poisha(0),
      collectedPoisha: poisha(105_000),
      costPoisha: poisha(60_000),
      branchId: null,
      memo: null,
    });
    validateJournalDraft(draft);
    expect(net(draft, accountIdFor('sales_discounts'))).toBe(-5_000n);
  });

  it('relieves the customer advance when the buyer had already paid', () => {
    const draft = orderDeliveredDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      partial: false,
      ...ACCOUNTS,
      courierId: COURIER_ID,
      netItemsPoisha: poisha(220_000),
      deliveryChargePoisha: poisha(6_000),
      advanceAppliedPoisha: poisha(6_000),
      collectedPoisha: poisha(220_000),
      costPoisha: poisha(160_000),
      branchId: null,
      memo: null,
    });
    validateJournalDraft(draft);
    expect(net(draft, accountIdFor('customer_advance'))).toBe(6_000n);
    expect(net(draft, accountIdFor('sales_discounts'))).toBe(0n);
  });

  it('refuses a difference with no Sales discounts account, rather than hiding it', () => {
    expect(() =>
      orderDeliveredDraft({
        orderId: ORDER_ID,
        occurredAt: AT,
        partial: false,
        ...ACCOUNTS,
        salesDiscounts: undefined,
        courierId: COURIER_ID,
        netItemsPoisha: poisha(220_000),
        deliveryChargePoisha: poisha(6_000),
        advanceAppliedPoisha: poisha(0),
        collectedPoisha: poisha(200_000),
        costPoisha: poisha(160_000),
        branchId: null,
        memo: null,
      }),
    ).toThrowError(/Sales discounts/);
  });

  it('property: balances for any delivery, however the money arrived', () => {
    fc.assert(
      fc.property(
        // From zero, not from one.
        //
        // `netItems` may legitimately be zero while the delivery still earns a charge:
        // `computeOrderTotals` and the `orders_discount_within_items` CHECK both permit
        // `discount == items`, which is the goodwill replacement the buyer pays only
        // postage on. A generator starting at 1 excluded precisely the input that emitted
        // a zero-for-zero revenue line and made the whole delivery unpostable, so the
        // property passed 400 runs over a bug that stuck real orders in `shipped`.
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        fc.boolean(),
        (netItems, delivery, advance, collected, cost, partial) => {
          // `earned <= 0` is refused by design and has its own test: a delivery worth
          // nothing has no revenue journal, and the caller posts the cost side alone.
          if (netItems + delivery === 0) return;
          const draft = orderDeliveredDraft({
            orderId: ORDER_ID,
            occurredAt: AT,
            partial,
            ...ACCOUNTS,
            courierId: COURIER_ID,
            netItemsPoisha: poisha(netItems),
            deliveryChargePoisha: poisha(delivery),
            advanceAppliedPoisha: poisha(advance),
            collectedPoisha: poisha(collected),
            costPoisha: poisha(cost),
            branchId: null,
            memo: null,
          });
          validateJournalDraft(draft);
          const { debits, credits } = totals(draft);
          expect(debits).toBe(credits);
          // Whatever the collection was, revenue is the net item value and nothing else.
          expect(net(draft, accountIdFor('sales_revenue'))).toBe(-BigInt(netItems));
          // And the cost side always empties exactly what the handover filled.
          expect(net(draft, accountIdFor('goods_in_transit'))).toBe(-BigInt(cost));
        },
      ),
      { numRuns: 400 },
    );
  });
  it('posts a delivery that earned only its delivery charge', () => {
    /*
     * The goodwill replacement: `discount == items`, so the buyer pays postage only.
     *
     * This was unpostable. The revenue line was pushed unconditionally, so the journal
     * carried `Dr 0 / Cr 0` and `validateJournalDraft` refused the whole thing. The order
     * could not leave `shipped`, its goods-in-transit debit never cleared, the COGS on a
     * real sale was never recognised, and the charge the rider had already collected
     * could not be booked — with no exit but a false return or hand-written SQL.
     */
    const draft = orderDeliveredDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      partial: false,
      ...ACCOUNTS,
      courierId: COURIER_ID,
      netItemsPoisha: poisha(0),
      deliveryChargePoisha: poisha(6000),
      advanceAppliedPoisha: poisha(0),
      collectedPoisha: poisha(6000),
      costPoisha: poisha(20000),
      branchId: null,
      memo: null,
    });

    expect(() => validateJournalDraft(draft)).not.toThrow();
    const { debits, credits } = totals(draft);
    expect(debits).toBe(credits);
    // No revenue line at all, rather than a zero one.
    expect(net(draft, accountIdFor('sales_revenue'))).toBe(0n);
    expect(net(draft, accountIdFor('delivery_charge_income'))).toBe(-6000n);
    // The cost still moves: this was a real sale of a real unit.
    expect(net(draft, accountIdFor('goods_in_transit'))).toBe(-20000n);
  });
});

describe('orderReturnDraft (§7)', () => {
  it('puts the dispatch value back into inventory and empties goods in transit', () => {
    const draft = orderReturnDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      inventory: ACCOUNTS.inventory,
      goodsInTransit: ACCOUNTS.goodsInTransit,
      valuePoisha: poisha(160_000),
      branchId: null,
      memo: null,
    });
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:returned`);
    expect(net(draft, accountIdFor('inventory'))).toBe(160_000n);
    expect(net(draft, accountIdFor('goods_in_transit'))).toBe(-160_000n);
    // No revenue is reversed: D-003 never recognised any on an order that never arrived.
    expect(draft.lines.some((line) => line.accountId === accountIdFor('sales_revenue'))).toBe(
      false,
    );
  });

  it('refuses a return of units carried at nothing rather than posting a zero journal', () => {
    expect(() =>
      orderReturnDraft({
        orderId: ORDER_ID,
        occurredAt: AT,
        inventory: ACCOUNTS.inventory,
        goodsInTransit: ACCOUNTS.goodsInTransit,
        valuePoisha: poisha(0),
        branchId: null,
        memo: null,
      }),
    ).toThrowError(/no cost/);
  });

  it('property: balances for any value', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000 }), (value) => {
        const draft = orderReturnDraft({
          orderId: ORDER_ID,
          occurredAt: AT,
          inventory: ACCOUNTS.inventory,
          goodsInTransit: ACCOUNTS.goodsInTransit,
          valuePoisha: poisha(value),
          branchId: null,
          memo: null,
        });
        validateJournalDraft(draft);
        const { debits, credits } = totals(draft);
        expect(debits).toBe(credits);
      }),
    );
  });
});

describe('orderExchangeDraft (§9, check 7)', () => {
  it('reverses the sale into a customer credit and puts the cost back on the shelf', () => {
    // One shirt sold for ৳1,100 net, dispatched at a cost of ৳800, sent back for a
    // different size.
    const draft = orderExchangeDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      inventory: ACCOUNTS.inventory,
      cogs: ACCOUNTS.cogs,
      salesRevenue: ACCOUNTS.salesRevenue,
      customerAdvance: ACCOUNTS.customerAdvance,
      returnedCostPoisha: poisha(80_000),
      returnedNetItemsPoisha: poisha(110_000),
      branchId: null,
      memo: null,
    });
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:exchanged`);
    expect(net(draft, accountIdFor('sales_revenue'))).toBe(110_000n);
    expect(net(draft, accountIdFor('customer_advance'))).toBe(-110_000n);
    expect(net(draft, accountIdFor('inventory'))).toBe(80_000n);
    expect(net(draft, accountIdFor('cogs'))).toBe(-80_000n);
    // Goods in transit is untouched: delivery already emptied it, and crediting it here
    // would push it negative and leave it there.
    expect(draft.lines.some((line) => line.accountId === accountIdFor('goods_in_transit'))).toBe(
      false,
    );
  });

  it('property: balances, and the credit always equals the revenue reversed', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }),
        fc.integer({ min: 0, max: 50_000_000 }),
        (netItems, cost) => {
          const draft = orderExchangeDraft({
            orderId: ORDER_ID,
            occurredAt: AT,
            inventory: ACCOUNTS.inventory,
            cogs: ACCOUNTS.cogs,
            salesRevenue: ACCOUNTS.salesRevenue,
            customerAdvance: ACCOUNTS.customerAdvance,
            returnedCostPoisha: poisha(cost),
            returnedNetItemsPoisha: poisha(netItems),
            branchId: null,
            memo: null,
          });
          validateJournalDraft(draft);
          const { debits, credits } = totals(draft);
          expect(debits).toBe(credits);
          expect(net(draft, accountIdFor('customer_advance'))).toBe(-BigInt(netItems));
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('customerAdvanceDraft (§7)', () => {
  it('books an advance as a liability, not as income', () => {
    const draft = customerAdvanceDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      direction: 'received',
      wallet: ACCOUNTS.bkash,
      customerAdvance: ACCOUNTS.customerAdvance,
      amountPoisha: poisha(6_000),
      branchId: null,
      memo: null,
    });
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:advance_received`);
    expect(net(draft, accountIdFor('wallet_bkash'))).toBe(6_000n);
    expect(net(draft, accountIdFor('customer_advance'))).toBe(-6_000n);
    expect(draft.lines.some((line) => line.accountId === accountIdFor('sales_revenue'))).toBe(
      false,
    );
  });

  it('refunds by reversing the same two accounts', () => {
    const draft = customerAdvanceDraft({
      orderId: ORDER_ID,
      occurredAt: AT,
      direction: 'refunded',
      wallet: ACCOUNTS.bkash,
      customerAdvance: ACCOUNTS.customerAdvance,
      amountPoisha: poisha(6_000),
      branchId: null,
      memo: null,
    });
    validateJournalDraft(draft);
    expect(draft.idempotencyKey).toBe(`order:${ORDER_ID}:advance_refunded`);
    expect(net(draft, accountIdFor('customer_advance'))).toBe(6_000n);
    expect(net(draft, accountIdFor('wallet_bkash'))).toBe(-6_000n);
  });

  it('refuses an advance credited against anything but a wallet', () => {
    expect(() =>
      customerAdvanceDraft({
        orderId: ORDER_ID,
        occurredAt: AT,
        direction: 'received',
        wallet: ACCOUNTS.courierReceivable,
        customerAdvance: ACCOUNTS.customerAdvance,
        amountPoisha: poisha(6_000),
        branchId: null,
        memo: null,
      }),
    ).toThrowError(/into a wallet/);
  });
});

/**
 * Golden books (M10 acceptance check 4), computed by hand and asserted here as the sum
 * of every draft the sequence produces.
 *
 * The database-level version of the same scenario lives in the server's e2e suite,
 * where real journals are posted and the trial balance is read back. This one runs in
 * milliseconds and pins the *arithmetic* — so when the e2e version fails, the question
 * "is the rule wrong or is the plumbing wrong" already has an answer.
 *
 *   Supply:   30 units at ৳800  → Dr Inventory 2,400,000 / Cr Supplier payable
 *   3 orders: 10 units each at ৳1,200, ৳60 delivery, no discount
 *   Ship all: Dr Goods in transit 2,400,000 / Cr Inventory
 *   2 delivered: Dr Courier receivable 2,412,000 / Cr Revenue 2,400,000 + Cr Delivery 12,000
 *                Dr COGS 1,600,000 / Cr Goods in transit
 *   1 returned:  Dr Inventory 800,000 / Cr Goods in transit
 */
describe('golden books: supply → 3 orders → ship all → 2 delivered, 1 returned (check 4)', () => {
  const UNIT_COST = poisha(80_000);
  const UNIT_PRICE = poisha(120_000);
  const DELIVERY = poisha(6_000);
  const orderIds = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
  ];

  it('leaves the trial balance at zero and the hand-computed P&L', () => {
    const drafts: JournalDraft[] = [];

    for (const orderId of orderIds.slice(0, 2)) {
      drafts.push(
        orderDeliveredDraft({
          orderId,
          occurredAt: AT,
          partial: false,
          ...ACCOUNTS,
          courierId: COURIER_ID,
          netItemsPoisha: poisha(BigInt(UNIT_PRICE) * 10n),
          deliveryChargePoisha: DELIVERY,
          advanceAppliedPoisha: poisha(0),
          collectedPoisha: poisha(BigInt(UNIT_PRICE) * 10n + BigInt(DELIVERY)),
          costPoisha: dispatchValue([{ qty: 10, unitCostPoisha: UNIT_COST }]),
          branchId: null,
          memo: null,
        }),
      );
    }
    drafts.push(
      orderReturnDraft({
        orderId: orderIds[2] ?? '',
        occurredAt: AT,
        inventory: ACCOUNTS.inventory,
        goodsInTransit: ACCOUNTS.goodsInTransit,
        valuePoisha: dispatchValue([{ qty: 10, unitCostPoisha: UNIT_COST }]),
        branchId: null,
        memo: null,
      }),
    );

    for (const draft of drafts) validateJournalDraft(draft);

    const sumOver = (accountId: string): bigint =>
      drafts.reduce((acc, draft) => acc + net(draft, accountId), 0n);

    // Trial balance: every journal balances, so the whole set does.
    const all = drafts.reduce(
      (acc, draft) => {
        const { debits, credits } = totals(draft);
        return { debits: acc.debits + debits, credits: acc.credits + credits };
      },
      { debits: 0n, credits: 0n },
    );
    expect(all.debits).toBe(all.credits);

    // Revenue: 20 units × ৳1,200.
    expect(-sumOver(accountIdFor('sales_revenue'))).toBe(2_400_000n);
    // Delivery income: two parcels × ৳60.
    expect(-sumOver(accountIdFor('delivery_charge_income'))).toBe(12_000n);
    // COGS: 20 units × ৳800.
    expect(sumOver(accountIdFor('cogs'))).toBe(1_600_000n);
    // Gross profit: 2,400,000 + 12,000 − 1,600,000.
    expect(
      -sumOver(accountIdFor('sales_revenue')) -
        sumOver(accountIdFor('delivery_charge_income')) -
        sumOver(accountIdFor('cogs')),
    ).toBe(812_000n);
    // Goods in transit: the handover put 2,400,000 in; delivery took 1,600,000 out and
    // the return took the other 800,000. It ends at zero, which is the whole point of
    // valuing every leg at the dispatch cost.
    const handover = -2_400_000n;
    expect(sumOver(accountIdFor('goods_in_transit')) - handover).toBe(0n);
    // The returned units are back in inventory at what they were dispatched at.
    expect(sumOver(accountIdFor('inventory'))).toBe(800_000n);
    // Courier receivable: what two riders collected.
    expect(sumOver(accountIdFor('courier_receivable'))).toBe(2_412_000n);
  });
});
