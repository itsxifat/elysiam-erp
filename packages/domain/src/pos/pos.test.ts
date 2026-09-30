import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  canonicalJson,
  cumulativeShare,
  discountCeilingBps,
  drawerVariance,
  expectedDrawerCash,
  linesAboveCeiling,
  maxDiscountFor,
  outsideShift,
  postingDateFor,
  priceLines,
  qtyBySku,
  refundFor,
  refundProblem,
  saleHoldReasons,
  settleTenders,
  type HoldCheckLine,
} from './index.js';
import { PosError } from './errors.js';

const SKU_A = 'a1b2c3d4-0000-4000-8000-00000000000a';
const SKU_B = 'a1b2c3d4-0000-4000-8000-00000000000b';
const BRANCH_GUL = 'b0000000-0000-4000-8000-000000000001';
const BRANCH_DHA = 'b0000000-0000-4000-8000-000000000002';

const line = (qty: number, unit: number, discount = 0, skuId = SKU_A) => ({
  skuId,
  qty,
  unitPricePoisha: poisha(unit),
  discountPoisha: poisha(discount),
});

describe('priceLines', () => {
  it('prices the worked basket to the poisha', () => {
    const totals = priceLines([line(2, 80_000, 10_000), line(1, 45_050)]);
    expect(totals.grossPoisha).toBe(205_050n);
    expect(totals.discountPoisha).toBe(10_000n);
    expect(totals.netPoisha).toBe(195_050n);
    expect(totals.lines.map((l) => l.netPoisha)).toEqual([150_000n, 45_050n]);
  });

  it('refuses an empty basket, a fractional quantity and a discount beyond the line', () => {
    expect(() => priceLines([])).toThrow(PosError);
    expect(() => priceLines([line(1.5, 100)])).toThrow(/whole number/);
    expect(() => priceLines([line(1, 100, 101)])).toThrow(/discount/);
    expect(() => priceLines([line(1, 100, -1)])).toThrow(/discount/);
  });

  it('net is always gross minus discount, and never negative', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 50 }),
            unit: fc.integer({ min: 0, max: 10_000_000 }),
            pct: fc.integer({ min: 0, max: 10_000 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        (raw) => {
          const lines = raw.map((r) => {
            const gross = poisha(BigInt(r.unit) * BigInt(r.qty));
            return line(r.qty, r.unit, Number(maxDiscountFor(gross, r.pct)));
          });
          const totals = priceLines(lines);
          expect(totals.netPoisha).toBe(totals.grossPoisha - totals.discountPoisha);
          expect(totals.netPoisha >= 0n).toBe(true);
        },
      ),
    );
  });
});

describe('settleTenders', () => {
  it('splits ৳1,500 into ৳1,000 cash and ৳500 bKash and gives change on the cash', () => {
    const settled = settleTenders(
      poisha(150_000),
      [
        { tender: 'cash', amountPoisha: poisha(100_000) },
        { tender: 'bkash', amountPoisha: poisha(50_000) },
      ],
      poisha(110_000),
    );
    expect(settled).toEqual({
      cashAppliedPoisha: 100_000n,
      cashReceivedPoisha: 110_000n,
      changePoisha: 10_000n,
    });
  });

  it('refuses tenders that under- or over-pay, a repeated tender, and change without cash', () => {
    const cash = (amount: number) => ({ tender: 'cash' as const, amountPoisha: poisha(amount) });
    expect(() => settleTenders(poisha(100), [cash(99)], null)).toThrow(/exactly/);
    expect(() => settleTenders(poisha(100), [cash(101)], null)).toThrow(/exactly/);
    expect(() => settleTenders(poisha(100), [cash(50), cash(50)], null)).toThrow(/once/);
    expect(() => settleTenders(poisha(100), [cash(100)], poisha(90))).toThrow(/Less cash/);
    expect(() =>
      settleTenders(poisha(100), [{ tender: 'card', amountPoisha: poisha(100) }], poisha(10)),
    ).toThrow(/not paid in cash/);
  });

  it('a sale given away in full needs no tender at all', () => {
    expect(settleTenders(poisha(0), [], null).changePoisha).toBe(0n);
  });
});

describe('discount ceilings', () => {
  it('lets a cashier reach their ceiling exactly, even when rounding goes up', () => {
    // ৳10.03 at 20% is 200.6 poisha, rounded half away from zero to 201. A cashier
    // typing "20%" gets 201 and must not be refused for it.
    const gross = poisha(1_003);
    expect(maxDiscountFor(gross, 2_000)).toBe(201n);
    const [priced] = priceLines([line(1, 1_003, 201)]).lines;
    expect(linesAboveCeiling([priced!], [poisha(1_003)], 2_000)).toEqual([]);
    const [over] = priceLines([line(1, 1_003, 202)]).lines;
    expect(linesAboveCeiling([over!], [poisha(1_003)], 2_000)).toEqual([0]);
  });

  it('counts a price below the catalog as discount, so the ceiling cannot be walked round', () => {
    // A ৳2,000 shirt rung up at ৳200 "with no discount" is a 90% discount.
    const [cheap] = priceLines([line(1, 20_000)]).lines;
    expect(linesAboveCeiling([cheap!], [poisha(200_000)], 2_000)).toEqual([0]);
    // Charging above the catalog earns nothing back against a typed discount.
    const [dear] = priceLines([line(1, 210_000, 50_000)]).lines;
    expect(linesAboveCeiling([dear!], [poisha(200_000)], 2_000)).toEqual([0]);
  });

  it('takes the best ceiling among roles that reach this branch, per role (D-075)', () => {
    const authority = {
      isSuperAdmin: false,
      roles: ['branch_manager', 'sales'],
      branchIdsByRole: { branch_manager: [BRANCH_GUL], sales: [BRANCH_DHA] },
    };
    expect(discountCeilingBps(authority, BRANCH_GUL)).toBe(2_000);
    expect(discountCeilingBps(authority, BRANCH_DHA)).toBe(500);
    expect(discountCeilingBps({ ...authority, roles: ['warehouse'] }, BRANCH_GUL)).toBe(0);
    // An empty list is the whole org; a missing entry is nothing (fail closed).
    expect(
      discountCeilingBps(
        { isSuperAdmin: false, roles: ['org_admin'], branchIdsByRole: { org_admin: [] } },
        BRANCH_DHA,
      ),
    ).toBe(10_000);
    expect(
      discountCeilingBps(
        { isSuperAdmin: false, roles: ['org_admin'], branchIdsByRole: {} },
        BRANCH_DHA,
      ),
    ).toBe(0);
    expect(
      discountCeilingBps({ isSuperAdmin: true, roles: [], branchIdsByRole: {} }, BRANCH_DHA),
    ).toBe(10_000);
  });
});

describe('saleHoldReasons', () => {
  const now = new Date('2026-09-29T06:00:00Z'); // 12:00 in Dhaka
  const shift = { openedAt: new Date('2026-09-29T03:00:00Z'), closedAt: null };
  const priced = (
    unit: number,
    catalog: number,
    discount = 0,
    available = true,
  ): HoldCheckLine => ({
    ...priceLines([line(1, unit, discount)]).lines[0]!,
    catalogPricePoisha: poisha(catalog),
    available,
  });

  it('holds nothing for a clean sale made an hour ago', () => {
    expect(
      saleHoldReasons({
        lines: [priced(100_000, 100_000, 5_000)],
        ceilingBps: 2_000,
        shiftOpen: true,
        shift,
        occurredAt: new Date('2026-09-29T05:00:00Z'),
        now,
      }),
    ).toEqual([]);
  });

  it('names every reason at once, in a stable order', () => {
    expect(
      saleHoldReasons({
        lines: [priced(50_000, 100_000), priced(100, 100, 0, false)],
        ceilingBps: 0,
        shiftOpen: false,
        shift,
        occurredAt: new Date('2026-09-26T05:00:00Z'),
        now,
      }),
    ).toEqual([
      'sku_unavailable',
      'price_mismatch',
      'discount_above_ceiling',
      'shift_closed',
      'outside_posting_window',
      'outside_shift',
    ]);
  });

  it('measures a discount on an archived SKU against its list price (D-173)', () => {
    // A ৳2,000 shirt, archived, rung up at ৳200 with nothing typed as discount.
    // Before D-173 the archived line had no catalog price and only `sku_unavailable`
    // was raised, so a reviewer with no discount right could post a 90% discount.
    expect(
      saleHoldReasons({
        lines: [priced(20_000, 200_000, 0, false)],
        ceilingBps: 2_000,
        shiftOpen: true,
        shift,
        occurredAt: new Date('2026-09-29T05:00:00Z'),
        now,
      }),
    ).toEqual(['sku_unavailable', 'price_mismatch', 'discount_above_ceiling']);
  });

  it('posts a late sale on its own day inside the window, and today outside it', () => {
    // 23:30 Dhaka on the 28th is 17:30Z; still yesterday at noon on the 29th.
    expect(postingDateFor(new Date('2026-09-28T17:30:00Z'), now)).toBe('2026-09-28');
    expect(postingDateFor(new Date('2026-09-25T05:00:00Z'), now)).toBe('2026-09-29');
  });

  it('posts today, not into a day its branch has already closed (D-174)', () => {
    expect(postingDateFor(new Date('2026-09-28T17:30:00Z'), now, true)).toBe('2026-09-29');
  });
});

describe('outsideShift (D-174)', () => {
  const now = new Date('2026-09-29T06:00:00Z');
  const open = { openedAt: new Date('2026-09-29T03:00:00Z'), closedAt: null };
  const closed = { ...open, closedAt: new Date('2026-09-29T05:00:00Z') };
  const minutes = (n: number) => n * 60_000;

  it('believes a till clock within five minutes of the shift and the server', () => {
    expect(outsideShift(new Date(open.openedAt.getTime() - minutes(4)), open, now)).toBe(false);
    expect(outsideShift(new Date(now.getTime() + minutes(4)), open, now)).toBe(false);
    expect(outsideShift(new Date(closed.closedAt.getTime() + minutes(4)), closed, now)).toBe(false);
  });

  it('does not believe a time before the shift, after its close, or in the future', () => {
    expect(outsideShift(new Date(open.openedAt.getTime() - minutes(6)), open, now)).toBe(true);
    expect(outsideShift(new Date(now.getTime() + minutes(6)), open, now)).toBe(true);
    expect(outsideShift(new Date(closed.closedAt.getTime() + minutes(6)), closed, now)).toBe(true);
    // Yesterday, as an edited payload or a phone set to the wrong day would say.
    expect(outsideShift(new Date('2026-09-28T06:00:00Z'), open, now)).toBe(true);
  });
});

describe('refundProblem (D-175)', () => {
  const line = { qty: 3, netPoisha: poisha(100_000) };
  const none = { qty: 0, refundPoisha: poisha(0) };

  it('accepts the second of two tills that each priced a unit at "none returned yet"', () => {
    // Both tills looked the receipt up before either synced, so both refunded
    // 333.33. The fair second share is 333.34; a poisha short is rounding, not
    // tampering, and used to leave the return held until someone voided it.
    expect(refundProblem(line, none, 1, poisha(33_333))).toBeNull();
    expect(
      refundProblem(line, { qty: 1, refundPoisha: poisha(33_333) }, 1, poisha(33_333)),
    ).toBeNull();
  });

  it('still refuses more than rounding, more units, or more money than the line', () => {
    expect(refundProblem(line, none, 1, poisha(33_335))).toBe('refund differs from the receipt');
    expect(refundProblem(line, { qty: 3, refundPoisha: poisha(100_000) }, 1, poisha(1))).toBe(
      'more units than the receipt still allows',
    );
    // Within a poisha per unit of the fair figure, but past what was paid.
    expect(refundProblem(line, { qty: 2, refundPoisha: poisha(66_667) }, 1, poisha(33_334))).toBe(
      'more refunded than the line was sold for',
    );
  });

  it('never lets a line refund more than its net, whatever order units come back in', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.array(fc.integer({ min: -1, max: 1 }), { minLength: 12, maxLength: 12 }),
        (qty, net, drifts) => {
          const soFar = { qty: 0, refundPoisha: poisha(0) };
          for (let unit = 0; unit < qty; unit += 1) {
            const fair = refundFor({ qty, netPoisha: poisha(net), returnedQty: soFar.qty }, 1);
            const offered = fair + BigInt(drifts[unit] ?? 0);
            if (offered < 0n) continue;
            if (
              refundProblem({ qty, netPoisha: poisha(net) }, soFar, 1, poisha(offered)) === null
            ) {
              soFar.qty += 1;
              soFar.refundPoisha = poisha(soFar.refundPoisha + offered);
            }
          }
          expect(soFar.refundPoisha <= net).toBe(true);
        },
      ),
    );
  });
});

describe('returns', () => {
  it('refunds what was paid, and partial returns sum to the line exactly', () => {
    // Three units for ৳1,000 net: 333.33 + 333.34 + 333.33 in whatever order.
    const lineOf = { qty: 3, netPoisha: poisha(100_000) };
    const first = refundFor({ ...lineOf, returnedQty: 0 }, 1);
    const rest = refundFor({ ...lineOf, returnedQty: 1 }, 2);
    expect(first + rest).toBe(100_000n);
    expect(first).toBe(33_333n);
  });

  it('sums to the line for any sequence of partial returns', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 40 }),
        (qty, net, steps) => {
          let returned = 0;
          let refunded = 0n;
          for (const step of steps) {
            const take = Math.min(step, qty - returned);
            if (take === 0) break;
            refunded += refundFor({ qty, netPoisha: poisha(net), returnedQty: returned }, take);
            returned += take;
          }
          if (returned === qty) expect(refunded).toBe(net);
          else expect(refunded).toBe(cumulativeShare(poisha(net), returned, qty));
        },
      ),
    );
  });

  it('refuses more units back than the receipt sold', () => {
    expect(() => refundFor({ qty: 2, netPoisha: poisha(100), returnedQty: 1 }, 2)).toThrow(
      /More units/,
    );
  });
});

describe('the drawer', () => {
  it('expects float plus cash kept minus cash refunded', () => {
    const expected = expectedDrawerCash({
      openingFloatPoisha: poisha(500_000),
      cashSalesPoisha: poisha(245_000),
      cashRefundsPoisha: poisha(75_000),
    });
    expect(expected).toBe(670_000n);
    expect(drawerVariance(poisha(669_000), expected)).toBe(-1_000n);
  });
});

describe('support', () => {
  it('adds quantities of a SKU that appears on two lines', () => {
    expect(qtyBySku([line(2, 1), line(1, 1, 0, SKU_B), line(3, 1)])).toEqual(
      new Map([
        [SKU_A, 5],
        [SKU_B, 1],
      ]),
    );
  });

  it('spells the same document the same way whatever the key order', () => {
    const a = canonicalJson({ b: 1n, a: [{ y: 'x', x: null }], c: undefined });
    const b = canonicalJson({ a: [{ x: null, y: 'x' }], b: 1n });
    expect(a).toBe(b);
    expect(a).toBe('{"a":[{"x":null,"y":"x"}],"b":"1"}');
  });
});
