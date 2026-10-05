import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { withinPostingWindow } from '../dates/index.js';
import { poisha } from '../money/index.js';
import { formatBdPhoneForDisplay, isE164Phone, normalizeBdPhone } from './phone.js';
import { formatOrderNo, orderPeriodFor, orderPrefixFor, parseOrderNo } from './numbering.js';
import {
  ORDER_STATUSES,
  ORDER_TRIGGERS,
  OrderError,
  TERMINAL_STATUSES,
  TRANSITIONS,
  canTransition,
  holdsStock,
  transition,
  transitionFor,
  triggersFrom,
  type OrderStatus,
  type OrderTrigger,
} from './state.js';
import {
  applicableAdvance,
  computeExchangeReturn,
  computeOrderTotals,
  computePartialDelivery,
} from './totals.js';

const AT = new Date('2026-09-25T06:00:00Z');

/**
 * M10 acceptance check 1: "Every (from, to) pair in the transition table is asserted
 * allowed or forbidden."
 *
 * Written as an enumeration of all 11 × 11 pairs against an independently spelled-out
 * allow-list rather than against `TRANSITIONS` itself. Asserting the table against
 * itself would pass whatever the table said, which is the failure mode this check
 * exists to catch — a row quietly added to `TRANSITIONS` in a later milestone, without
 * an architecture edit, and a green suite.
 */
const ALLOWED: readonly `${OrderStatus}->${OrderStatus}`[] = [
  'pending->confirmed',
  'pending->cancelled',
  'confirmed->on_hold',
  'on_hold->confirmed',
  'confirmed->packed',
  'confirmed->cancelled',
  'packed->cancelled',
  'confirmed->shipped',
  'packed->shipped',
  'shipped->delivered',
  'shipped->partially_delivered',
  'shipped->return_in_transit',
  'return_in_transit->returned',
  'partially_delivered->returned',
  'delivered->exchange',
];

describe('the order state machine (§9, invariant 7)', () => {
  it('allows exactly §9’s pairs and forbids every other one of the 121', () => {
    const asserted: string[] = [];
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const key = `${from}->${to}` as const;
        const expected = ALLOWED.includes(key);
        expect(
          canTransition(from, to),
          `${key} should be ${expected ? 'allowed' : 'forbidden'}`,
        ).toBe(expected);
        asserted.push(key);
      }
    }
    expect(asserted).toHaveLength(ORDER_STATUSES.length * ORDER_STATUSES.length);
    expect(TRANSITIONS).toHaveLength(ALLOWED.length);
  });

  it('never lets a shipped order be cancelled — §9 says it becomes a return', () => {
    for (const from of [
      'shipped',
      'delivered',
      'partially_delivered',
      'return_in_transit',
    ] as const) {
      expect(canTransition(from, 'cancelled')).toBe(false);
      expect(() =>
        transition({ from, trigger: 'cancel', at: AT, reason: 'customer changed mind' }),
      ).toThrow(OrderError);
    }
  });

  it('leaves cancelled, returned and exchange terminal', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['cancelled', 'exchange', 'returned']);
    for (const status of TERMINAL_STATUSES) {
      expect(triggersFrom(status)).toEqual([]);
    }
  });

  it('refuses a transition that needs a reason without one', () => {
    expect(() => transition({ from: 'confirmed', trigger: 'hold', at: AT })).toThrowError(
      /needs a reason/,
    );
    expect(() =>
      transition({ from: 'confirmed', trigger: 'hold', at: AT, reason: '   ' }),
    ).toThrowError(/needs a reason/);
    expect(
      transition({ from: 'confirmed', trigger: 'hold', at: AT, reason: ' no answer ' }).reason,
    ).toBe('no answer');
  });

  it('keeps the reservation on hold and releases it only on cancel (§9)', () => {
    expect(
      transition({ from: 'confirmed', trigger: 'hold', at: AT, reason: 'no answer' }).effects,
    ).toEqual([]);
    expect(
      transition({ from: 'confirmed', trigger: 'cancel', at: AT, reason: 'duplicate' }).effects,
    ).toContain('release_reservation');
  });

  it('fires the courier booking on whichever transition the org’s policy names', () => {
    const confirmOnConfirm = transition({
      from: 'pending',
      trigger: 'confirm',
      at: AT,
      bookingPolicy: 'on_confirm',
    });
    expect(confirmOnConfirm.effects).toContain('enqueue_courier_booking');

    const confirmOnPack = transition({
      from: 'pending',
      trigger: 'confirm',
      at: AT,
      bookingPolicy: 'on_pack',
    });
    expect(confirmOnPack.effects).not.toContain('enqueue_courier_booking');
    expect(
      transition({ from: 'confirmed', trigger: 'pack', at: AT, bookingPolicy: 'on_pack' }).effects,
    ).toContain('enqueue_courier_booking');

    // `manual` books nothing automatically, and a cancel only cancels a real parcel.
    expect(transition({ from: 'pending', trigger: 'confirm', at: AT }).effects).toEqual([
      'reserve_stock',
    ]);
    expect(
      transition({ from: 'packed', trigger: 'cancel', at: AT, reason: 'out of stock' }).effects,
    ).not.toContain('enqueue_courier_cancel');
    expect(
      transition({
        from: 'packed',
        trigger: 'cancel',
        at: AT,
        reason: 'out of stock',
        parcelBooked: true,
      }).effects,
    ).toContain('enqueue_courier_cancel');
  });

  it('dates the transition in Asia/Dhaka, not UTC (invariant 8)', () => {
    // 20:30 UTC on the 24th is 02:30 on the 25th in Dhaka.
    const result = transition({
      from: 'pending',
      trigger: 'confirm',
      at: new Date('2026-09-24T20:30:00Z'),
    });
    expect(result.businessDate).toBe('2026-09-25');
  });

  /**
   * The property test the milestone asks for: random sequences of triggers.
   *
   * What it proves is not that the machine reaches any particular state but that
   * **nothing outside the table can ever happen** — including through a path no
   * hand-written test would think to walk. The two invariants it pins are the ones with
   * money behind them: an order cannot be delivered without having been shipped, and it
   * cannot be cancelled after it was.
   */
  it('property: a random walk only ever moves along the table', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ORDER_STATUSES),
        fc.array(fc.constantFrom<OrderTrigger>(...ORDER_TRIGGERS), { maxLength: 40 }),
        (start, triggers) => {
          let status: OrderStatus = start;
          const visited: OrderStatus[] = [status];

          for (const trigger of triggers) {
            const entry = transitionFor(status, trigger);
            let moved: OrderStatus | undefined;
            try {
              moved = transition({
                from: status,
                trigger,
                at: AT,
                // Supplied unconditionally so a refusal can only ever be the table's
                // doing, never a missing reason (or a missing return reason, M17).
                reason: 'property test',
                returnReason: 'other',
              }).to;
            } catch (error) {
              expect(error).toBeInstanceOf(OrderError);
              expect(entry).toBeUndefined();
              continue;
            }
            expect(entry).toBeDefined();
            expect(moved).toBe(entry?.to);
            expect(canTransition(status, moved)).toBe(true);
            status = moved;
            visited.push(status);
          }

          // Nothing leaves a terminal status, whatever came after it in the sequence.
          const firstTerminal = visited.findIndex((seen) => TERMINAL_STATUSES.includes(seen));
          if (firstTerminal >= 0) {
            expect(visited.slice(firstTerminal)).toEqual([visited[firstTerminal]]);
          }
          /*
           * Revenue is never recognised on an order that was not shipped (D-003).
           *
           * `indexOf > 0` rather than `includes`: the walk is allowed to *start* in any
           * status, including `delivered`, because the point is to prove no sequence of
           * triggers can reach one illegitimately — not to re-assert that the generator
           * picked a reachable starting point.
           */
          for (const outcome of ['delivered', 'partially_delivered'] as const) {
            if (visited.indexOf(outcome) > 0) expect(visited).toContain('shipped');
          }
          // And a shipped order is never cancelled — it returns (§9).
          if (visited.includes('shipped')) {
            expect(visited.slice(visited.indexOf('shipped'))).not.toContain('cancelled');
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('order totals (§9, check 3)', () => {
  const line = (qty: number, price: number, discount = 0) => ({
    qty,
    unitPricePoisha: poisha(price),
    lineDiscountPoisha: poisha(discount),
  });

  it('works the §9 formula on a hand-computed order', () => {
    // Two shirts at ৳1,250, one ৳100 line discount, ৳200 off the order, ৳60 delivery,
    // ৳60 already paid on bKash.
    const totals = computeOrderTotals({
      lines: [line(2, 125_000, 10_000)],
      orderDiscountPoisha: poisha(20_000),
      deliveryChargePoisha: poisha(6_000),
      advancePaidPoisha: poisha(6_000),
    });
    expect(totals.itemsPoisha).toBe(250_000n);
    expect(totals.discountPoisha).toBe(30_000n);
    expect(totals.netItemsPoisha).toBe(220_000n);
    // 220000 + 6000 − 6000
    expect(totals.codAmountPoisha).toBe(220_000n);
  });

  it('rejects a negative COD rather than clamping it', () => {
    expect(() =>
      computeOrderTotals({
        lines: [line(1, 100_000)],
        deliveryChargePoisha: poisha(6_000),
        advancePaidPoisha: poisha(200_000),
      }),
    ).toThrowError(/nothing to collect/);
  });

  it('rejects a discount larger than the items', () => {
    expect(() =>
      computeOrderTotals({ lines: [line(1, 100_000)], orderDiscountPoisha: poisha(100_001) }),
    ).toThrowError(/revenue cannot be negative/);
  });

  it('property: COD = items − discount + delivery − advance, refused exactly when negative', () => {
    /*
     * An oracle, not a tolerance.
     *
     * The first version of this property returned early on *any* `ORDER_TOTAL_INVALID`, so an
     * implementation that refused perfectly good orders passed it — a property that cannot
     * fail on over-rejection is only half a property. So the expected outcome is computed
     * here, independently and in plain bigint arithmetic, *before* the domain is asked, and
     * the domain must match it both ways: refuse precisely when the discount exceeds the
     * items or the COD would be negative (the two refusals §9 and §7 state), with the
     * message that names which, and accept every other order with exactly the oracle's
     * figures.
     *
     * The counters at the end are what stop this from becoming vacuous again: a generator
     * drift that made every case valid (or every case invalid) would leave one side of the
     * property unexercised, and the run fails if either side is thin.
     */
    let accepted = 0;
    let refusedDiscount = 0;
    let refusedCod = 0;

    const price = fc.oneof(
      fc.integer({ min: 0, max: 5_000_000 }),
      // Small prices, so the discount and advance ranges below cross the order's value
      // often enough to exercise both refusals.
      fc.integer({ min: 0, max: 60_000 }),
    );

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 20 }),
            price,
            discountBp: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 1_500_000 }),
        fc.integer({ min: 0, max: 1_500_000 }),
        (rawLines, delivery, orderDiscount, advance) => {
          const lines = rawLines.map((raw) => ({
            qty: raw.qty,
            unitPricePoisha: poisha(raw.price),
            // A share of the line's own value, so the per-line rule is never the thing
            // that fails and the property under test is the order-level arithmetic.
            lineDiscountPoisha: poisha(
              (BigInt(raw.price) * BigInt(raw.qty) * BigInt(raw.discountBp)) / 10_000n,
            ),
          }));

          // The oracle.
          const items = lines.reduce(
            (total, entry) => total + BigInt(entry.unitPricePoisha) * BigInt(entry.qty),
            0n,
          );
          const discount =
            lines.reduce((total, entry) => total + BigInt(entry.lineDiscountPoisha), 0n) +
            BigInt(orderDiscount);
          const cod = items - discount + BigInt(delivery) - BigInt(advance);
          const expected: 'discount' | 'cod' | 'ok' =
            discount > items ? 'discount' : cod < 0n ? 'cod' : 'ok';

          let totals;
          try {
            totals = computeOrderTotals({
              lines,
              orderDiscountPoisha: poisha(orderDiscount),
              deliveryChargePoisha: poisha(delivery),
              advancePaidPoisha: poisha(advance),
            });
          } catch (error) {
            // A refusal the oracle did not predict is the over-rejection this test exists
            // to catch; one it did predict must be the right refusal, for the right reason.
            expect(expected, `refused a valid order: ${String(error)}`).not.toBe('ok');
            expect(error).toBeInstanceOf(OrderError);
            expect((error as OrderError).code).toBe('ORDER_TOTAL_INVALID');
            expect((error as OrderError).message).toMatch(
              expected === 'discount' ? /revenue cannot be negative/ : /nothing to collect/,
            );
            if (expected === 'discount') refusedDiscount += 1;
            else refusedCod += 1;
            return;
          }

          expect(expected, 'accepted an order whose discount or COD is invalid').toBe('ok');
          accepted += 1;
          expect(totals.itemsPoisha).toBe(items);
          expect(totals.discountPoisha).toBe(discount);
          expect(totals.codAmountPoisha).toBe(cod);
          expect(totals.codAmountPoisha).toBeGreaterThanOrEqual(0n);
          expect(totals.netItemsPoisha).toBe(items - discount);
          expect(totals.codAmountPoisha).toBe(
            totals.itemsPoisha -
              totals.discountPoisha +
              totals.deliveryChargePoisha -
              totals.advancePaidPoisha,
          );
        },
      ),
      { numRuns: 1_000 },
    );

    expect(accepted).toBeGreaterThan(200);
    expect(refusedDiscount).toBeGreaterThan(20);
    expect(refusedCod).toBeGreaterThan(20);
  });

  it('property: a COD of exactly zero is accepted, and one poisha less is refused', () => {
    // The boundary the oracle above only reaches by luck, asserted directly: an advance
    // that pays the order in full is an ordinary prepaid order, not an error.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        (qty, unitPrice, delivery) => {
          const payable = BigInt(unitPrice) * BigInt(qty) + BigInt(delivery);
          const exact = computeOrderTotals({
            lines: [line(qty, unitPrice)],
            deliveryChargePoisha: poisha(delivery),
            advancePaidPoisha: poisha(payable),
          });
          expect(exact.codAmountPoisha).toBe(0n);
          expect(() =>
            computeOrderTotals({
              lines: [line(qty, unitPrice)],
              deliveryChargePoisha: poisha(delivery),
              advancePaidPoisha: poisha(payable + 1n),
            }),
          ).toThrowError(/nothing to collect/);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('property: a discount of exactly the items is accepted, and one poisha more is refused', () => {
    // A free gift with paid delivery is a real order. The random property meets
    // "discount = items" almost never, which is how an off-by-one refusing it survived a
    // mutation run; so the boundary is its own property, split across line and order
    // discounts so neither placement can hide it.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 2_000_000 }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.integer({ min: 0, max: 100 }),
        (qty, unitPrice, delivery, lineSharePct) => {
          const items = BigInt(unitPrice) * BigInt(qty);
          const onLine = (items * BigInt(lineSharePct)) / 100n;
          const onOrder = items - onLine;
          const free = computeOrderTotals({
            lines: [line(qty, unitPrice, Number(onLine))],
            orderDiscountPoisha: poisha(onOrder),
            deliveryChargePoisha: poisha(delivery),
          });
          expect(free.netItemsPoisha).toBe(0n);
          expect(free.codAmountPoisha).toBe(BigInt(delivery));
          expect(() =>
            computeOrderTotals({
              lines: [line(qty, unitPrice, Number(onLine))],
              orderDiscountPoisha: poisha(onOrder + 1n),
              deliveryChargePoisha: poisha(delivery),
            }),
          ).toThrowError(/revenue cannot be negative/);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('caps an exchange credit at what the replacement is worth', () => {
    const { appliedPoisha, remainingPoisha } = applicableAdvance({
      netItemsPoisha: poisha(100_000),
      deliveryChargePoisha: poisha(6_000),
      creditPoisha: poisha(250_000),
    });
    expect(appliedPoisha).toBe(106_000n);
    expect(remainingPoisha).toBe(144_000n);
  });
});

describe('partial delivery (§7, check 5)', () => {
  it('apportions the order discount to the delivered units and keeps the delivery charge whole', () => {
    // Three units at ৳1,000 and one at ৳500, ৳350 off the order. Two of the ৳1,000
    // units arrive; the ৳500 one does not.
    const split = computePartialDelivery({
      lines: [
        { qty: 3, unitPricePoisha: poisha(100_000), deliveredQty: 2 },
        { qty: 1, unitPricePoisha: poisha(50_000), deliveredQty: 0 },
      ],
      orderDiscountPoisha: poisha(35_000),
      deliveryChargePoisha: poisha(6_000),
    });
    // Gross delivered 200000 of 350000; 35000 × 200/350 = 20000.
    expect(split.deliveredDiscountPoisha).toBe(20_000n);
    expect(split.deliveredNetItemsPoisha).toBe(180_000n);
    expect(split.undeliveredNetItemsPoisha).toBe(135_000n);
    expect(split.expectedCollectionPoisha).toBe(186_000n);
    // The two halves plus the discount reconstruct the order exactly.
    expect(split.deliveredNetItemsPoisha + split.undeliveredNetItemsPoisha + 35_000n).toBe(
      350_000n,
    );
  });

  it('refuses a "partial" delivery of nothing — that is a return', () => {
    expect(() =>
      computePartialDelivery({
        lines: [{ qty: 2, unitPricePoisha: poisha(100_000), deliveredQty: 0 }],
      }),
    ).toThrowError(/return rather than a partial delivery/);
  });

  it('property: the delivered and undelivered halves always sum back to the order', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 10 }),
            price: fc.integer({ min: 1, max: 1_000_000 }),
            deliveredFraction: fc.integer({ min: 0, max: 10 }),
            lineDiscountBp: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 100_000 }),
        (rawLines, orderDiscount) => {
          const lines = rawLines.map((raw) => ({
            qty: raw.qty,
            unitPricePoisha: poisha(raw.price),
            deliveredQty: Math.min(raw.qty, Math.round((raw.qty * raw.deliveredFraction) / 10)),
            lineDiscountPoisha: poisha(
              (BigInt(raw.price) * BigInt(raw.qty) * BigInt(raw.lineDiscountBp)) / 10_000n,
            ),
          }));
          if (!lines.some((entry) => entry.deliveredQty > 0)) return;

          const gross = lines.reduce(
            (acc, entry) => acc + BigInt(entry.unitPricePoisha) * BigInt(entry.qty),
            0n,
          );
          const lineDiscounts = lines.reduce(
            (acc, entry) => acc + BigInt(entry.lineDiscountPoisha ?? 0n),
            0n,
          );
          if (lineDiscounts + BigInt(orderDiscount) > gross) return;

          const split = computePartialDelivery({
            lines,
            orderDiscountPoisha: poisha(orderDiscount),
          });
          // Nothing is lost or invented by the apportioning: the two net halves plus
          // every discount given equal the gross order value, to the poisha.
          expect(
            split.deliveredNetItemsPoisha +
              split.undeliveredNetItemsPoisha +
              lineDiscounts +
              BigInt(orderDiscount),
          ).toBe(gross);
          expect(split.deliveredNetItemsPoisha).toBeGreaterThanOrEqual(0n);
          expect(split.undeliveredNetItemsPoisha).toBeGreaterThanOrEqual(0n);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('phone normalisation (§9, check 6)', () => {
  it('normalises the ten shapes a Bangladeshi customer actually sends', () => {
    const expected = '+8801712345678';
    for (const input of [
      '+8801712345678',
      '8801712345678',
      '01712345678',
      '+880 1712 345678',
      '+880-17-1234-5678',
      '0171-234-5678',
      '01712 345678',
      '(+880) 1712345678',
      // Both the country code and the trunk zero. Malformed, common, unambiguous.
      '+880 0171 2345678',
      '০১৭১২৩৪৫৬৭৮',
      '+৮৮০১৭১২৩৪৫৬৭৮',
    ]) {
      expect(normalizeBdPhone(input), input).toBe(expected);
    }
    expect(isE164Phone(expected)).toBe(true);
    expect(formatBdPhoneForDisplay(expected)).toBe('01712-345678');
  });

  it('accepts every operator BTRC has issued', () => {
    for (const digit of ['3', '4', '5', '6', '7', '8', '9', '1']) {
      expect(normalizeBdPhone(`01${digit}12345678`)).toBe(`+8801${digit}12345678`);
    }
  });

  it('rejects what a courier could not deliver to', () => {
    const invalid = [
      '',
      '01712',
      '017123456789',
      '01012345678',
      '01212345678',
      '+9101712345678',
      '02-9611000',
      '0171234567o',
      'not a number',
    ];
    for (const input of invalid) {
      expect(() => normalizeBdPhone(input), input).toThrow(OrderError);
    }
  });

  it('never reveals the number it rejected', () => {
    try {
      normalizeBdPhone('017123456789');
      expect.unreachable();
    } catch (error) {
      // Invariant 10: a phone number never reaches a log or an error unmasked, and an
      // error message is the most quoted, most pasted string in the system.
      expect((error as Error).message).not.toContain('017123456789');
      expect((error as Error).message).toContain('*');
    }
  });
});

describe('order numbering (§9)', () => {
  it('builds §9’s example shape', () => {
    expect(orderPeriodFor('2026-09-25')).toBe('2609');
    expect(orderPrefixFor({ slug: 'oura-lifestyle' })).toBe('OUR');
    expect(formatOrderNo({ prefix: 'OUR', period: '2609', sequence: 42 })).toBe('OUR-2609-00042');
    expect(parseOrderNo('our-2609-00042')).toEqual({
      prefix: 'OUR',
      period: '2609',
      sequence: 42,
    });
  });

  it('widens past five digits rather than wrapping', () => {
    expect(formatOrderNo({ prefix: 'ELY', period: '2609', sequence: 123_456 })).toBe(
      'ELY-2609-123456',
    );
  });

  it('honours a configured prefix and refuses a nonsense one', () => {
    expect(orderPrefixFor({ slug: 'wear-x-clothing', configured: 'wx' })).toBe('WX');
    expect(() => orderPrefixFor({ slug: 'beownz', configured: '7up' })).toThrow(OrderError);
  });

  it('property: every sequence round-trips through the format', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9_999_999 }), (sequence) => {
        const formatted = formatOrderNo({ prefix: 'ELY', period: '2609', sequence });
        expect(parseOrderNo(formatted)?.sequence).toBe(sequence);
      }),
    );
  });
});

describe('exchange returns (§9, check 7)', () => {
  const line = {
    skuId: 'sku-a',
    qty: 3,
    deliveredQty: 3,
    returnedQty: 0,
    unitPricePoisha: poisha(100_000n),
    lineDiscountPoisha: poisha(101n),
    dispatchUnitCostPoisha: poisha(40_000n),
  };

  it('aggregates a SKU named twice instead of counting it twice', () => {
    /*
     * The bug this exists for: `[{A,2},{A,2}]` against three delivered units used to pass a
     * per-entry check twice, credit twice the line's value and post four units of cost,
     * while inventory's dedupe key wrote one movement. A balanced journal, a trial balance
     * at zero, and a free item.
     */
    const returned = computeExchangeReturn({
      lines: [line],
      returning: [
        { skuId: 'sku-a', qty: 1 },
        { skuId: 'sku-a', qty: 2 },
      ],
    });

    expect(returned.lines).toHaveLength(1);
    expect(returned.lines[0]).toMatchObject({
      skuId: 'sku-a',
      qty: 3,
      deliveredQty: 0,
      returnedQty: 3,
    });
    // Three units at 40,000, and the whole line's net value — once.
    expect(returned.costPoisha).toBe(120_000n);
    expect(returned.netItemsPoisha).toBe(299_899n);
  });

  it('refuses an aggregate beyond what was delivered, however it is split', () => {
    expect(() =>
      computeExchangeReturn({
        lines: [line],
        returning: [
          { skuId: 'sku-a', qty: 2 },
          { skuId: 'sku-a', qty: 2 },
        ],
      }),
    ).toThrow(OrderError);

    expect(() =>
      computeExchangeReturn({ lines: [line], returning: [{ skuId: 'sku-b', qty: 1 }] }),
    ).toThrow(/not on the delivered order/);
    expect(() => computeExchangeReturn({ lines: [line], returning: [] })).toThrow(OrderError);
  });

  it('apportions a part-line return with largest remainder rather than truncating', () => {
    const two = computeExchangeReturn({ lines: [line], returning: [{ skuId: 'sku-a', qty: 2 }] });
    const one = computeExchangeReturn({ lines: [line], returning: [{ skuId: 'sku-a', qty: 1 }] });

    // 299,899 over three units does not divide. Truncating each share lost a poisha the
    // buyer had paid; the two largest-remainder shares add back to the whole line.
    expect(BigInt(two.netItemsPoisha) + BigInt(one.netItemsPoisha)).toBe(299_899n);
    expect(two.costPoisha).toBe(80_000n);
  });

  it('property: the credit is bounded by the line and the counters stay legal', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        (qty, wanted, price, discountBp, cost) => {
          const gross = BigInt(price) * BigInt(qty);
          const discount = (gross * BigInt(discountBp)) / 10_000n;
          const state = {
            skuId: 'sku',
            qty,
            deliveredQty: qty,
            returnedQty: 0,
            unitPricePoisha: poisha(BigInt(price)),
            lineDiscountPoisha: poisha(discount),
            dispatchUnitCostPoisha: poisha(BigInt(cost)),
          };

          if (wanted === 0 || wanted > qty) {
            expect(() =>
              computeExchangeReturn({ lines: [state], returning: [{ skuId: 'sku', qty: wanted }] }),
            ).toThrow(OrderError);
            return;
          }

          const returned = computeExchangeReturn({
            lines: [state],
            returning: [{ skuId: 'sku', qty: wanted }],
          });
          const lineNet = gross - discount;
          // Never more than the line was sold for, and never negative.
          expect(BigInt(returned.netItemsPoisha)).toBeLessThanOrEqual(lineNet);
          expect(BigInt(returned.netItemsPoisha) >= 0n).toBe(true);
          expect(returned.costPoisha).toBe(BigInt(cost) * BigInt(wanted));
          // `order_lines_fulfilled_within_qty` would refuse anything else.
          const entry = returned.lines[0];
          expect(entry?.deliveredQty).toBe(qty - wanted);
          expect(entry?.returnedQty).toBe(wanted);
          expect((entry?.deliveredQty ?? 0) + (entry?.returnedQty ?? 0)).toBeLessThanOrEqual(qty);
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('the posting window (§7)', () => {
  const now = new Date('2026-09-25T06:00:00Z');

  it('allows today and yesterday in Dhaka and nothing else', () => {
    // `now` is 12:00 on the 25th in Dhaka, so the window is the 24th and the 25th.
    expect(withinPostingWindow(new Date('2026-09-25T10:00:00Z'), now)).toBe(true);
    expect(withinPostingWindow(new Date('2026-09-24T04:00:00Z'), now)).toBe(true);

    /*
     * The two boundaries UTC reasoning gets wrong, in opposite directions.
     *
     * 18:30Z is already 00:30 the *next* day in Dhaka, so it is out of the window even
     * though it is "the same day" in UTC. 2026-09-23T18:30Z is 00:30 on the 24th in Dhaka,
     * so it is *in* the window even though it looks like the day before yesterday.
     */
    expect(withinPostingWindow(new Date('2026-09-25T18:30:00Z'), now)).toBe(false);
    expect(withinPostingWindow(new Date('2026-09-23T18:30:00Z'), now)).toBe(true);
    expect(withinPostingWindow(new Date('2026-09-23T17:00:00Z'), now)).toBe(false);

    // And nothing in the future: revenue dated forward lands where no close can reach it.
    expect(withinPostingWindow(new Date('2026-09-26T04:00:00Z'), now)).toBe(false);
  });
});

describe('a promo code goes back on a cancel, and only on a cancel (D-204)', () => {
  it('declares release_promo on every row that ends in cancelled', () => {
    const cancels = TRANSITIONS.filter((row) => row.to === 'cancelled');
    // Pending, confirmed and packed: every state an order can be cancelled from.
    expect(cancels.map((row) => row.from).sort()).toEqual(['confirmed', 'packed', 'pending']);
    for (const row of cancels) expect(row.effects).toContain('release_promo');
  });

  it('declares it nowhere else, so a shipped, returned or held order keeps its use', () => {
    // A return is not "never bought": the goods went out, so the use stays spent.
    const elsewhere = TRANSITIONS.filter(
      (row) => row.to !== 'cancelled' && row.effects.includes('release_promo'),
    );
    expect(elsewhere).toEqual([]);
  });

  it('releases on a pending cancel, which declares no stats effect to hang it on', () => {
    // The bug this effect exists to fix: the release was first written inside the
    // customer-stats step, and a cancel from `pending` declares no such step.
    const fromPending = transition({ from: 'pending', trigger: 'cancel', at: AT, reason: 'dup' });
    expect(fromPending.effects).toContain('release_promo');
    expect(fromPending.effects).not.toContain('update_customer_stats');
  });
});

describe('a website order holds its stock from the checkout (M34, D-532)', () => {
  it('does not reserve again on confirm, and releases on a pending cancel', () => {
    expect(
      transition({ from: 'pending', trigger: 'confirm', at: AT, stockHeld: true }).effects,
    ).toEqual([]);
    expect(transition({ from: 'pending', trigger: 'confirm', at: AT }).effects).toEqual([
      'reserve_stock',
    ]);
    const heldCancel = transition({
      from: 'pending',
      trigger: 'cancel',
      at: AT,
      reason: 'unpaid',
      stockHeld: true,
    });
    expect(heldCancel.effects).toEqual(['release_reservation', 'release_promo', 'settle_advances']);
    const plainCancel = transition({ from: 'pending', trigger: 'cancel', at: AT, reason: 'dup' });
    expect(plainCancel.effects).not.toContain('release_reservation');
  });

  it('leaves every other transition as it was, held or not', () => {
    for (const entry of TRANSITIONS) {
      if (entry.from === 'pending') continue;
      const args = {
        from: entry.from,
        trigger: entry.trigger,
        at: AT,
        reason: 'property',
        returnReason: 'other',
      } as const;
      expect(transition({ ...args, stockHeld: true }).effects).toEqual(transition(args).effects);
    }
  });

  /**
   * Reserve once, release once: along any walk of the machine from `pending`, a held order is
   * reserved exactly once (at the checkout, or never again) and released at most once, and
   * never released without having been reserved.
   */
  it('property: a held order is reserved once and released at most once on any walk', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(fc.constantFrom<OrderTrigger>(...ORDER_TRIGGERS), { maxLength: 30 }),
        (held, triggers) => {
          let status: OrderStatus = 'pending';
          let reserved = held ? 1 : 0;
          let released = 0;
          for (const trigger of triggers) {
            if (transitionFor(status, trigger) === undefined) continue;
            const result = transition({
              from: status,
              trigger,
              at: AT,
              reason: 'property',
              returnReason: 'other',
              stockHeld: held,
            });
            if (result.effects.includes('reserve_stock')) reserved += 1;
            if (result.effects.includes('release_reservation')) released += 1;
            status = result.to;
            expect(released).toBeLessThanOrEqual(reserved);
          }
          expect(reserved).toBeLessThanOrEqual(1);
          expect(released).toBeLessThanOrEqual(1);
          expect(holdsStock(status, held)).toBe(
            reserved === 1 &&
              released === 0 &&
              ['pending', 'confirmed', 'on_hold', 'packed'].includes(status),
          );
        },
      ),
    );
  });
});
