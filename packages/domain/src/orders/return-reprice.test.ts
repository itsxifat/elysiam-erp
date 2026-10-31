import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import { repriceReturn } from './return-reprice.js';

const tk = (taka: number) => poisha(BigInt(taka) * 100n);

describe('repriceReturn (M50, D-924)', () => {
  const lines = [
    { qty: 1, unitPricePoisha: tk(1000), lineDiscountPoisha: tk(0), keptQty: 1 },
    { qty: 1, unitPricePoisha: tk(1000), lineDiscountPoisha: tk(0), keptQty: 0 },
  ];

  it('collects the kept goods less the new offer plus the new charge', () => {
    // The order had Tk 200 off (10% over Tk 1,500); the buyer kept one Tk 1,000 piece and now
    // qualifies for 5% (Tk 50); the charge stays Tk 120.
    const result = repriceReturn({
      lines,
      orderDiscountPoisha: tk(200),
      deliveryChargePoisha: tk(120),
      advancePaidPoisha: tk(0),
      offerDiscountPoisha: tk(50),
      typedOrderDiscountPoisha: tk(0),
      newDeliveryChargePoisha: tk(120),
    });
    expect(result.keptNetPoisha).toBe(tk(1000));
    // §7's expectation: half the order discount follows the kept piece.
    expect(result.expectedPoisha).toBe(tk(1020));
    expect(result.collectPoisha).toBe(tk(1070));
  });

  it('applies the advance the way the delivery journal does', () => {
    const result = repriceReturn({
      lines,
      orderDiscountPoisha: tk(0),
      deliveryChargePoisha: tk(120),
      advancePaidPoisha: tk(120),
      offerDiscountPoisha: tk(0),
      typedOrderDiscountPoisha: tk(0),
      newDeliveryChargePoisha: tk(60),
    });
    expect(result.advanceAppliedPoisha).toBe(tk(120));
    expect(result.expectedPoisha).toBe(tk(1000));
    expect(result.collectPoisha).toBe(tk(940));
  });

  it('keeps a line discount with the kept units', () => {
    const result = repriceReturn({
      lines: [{ qty: 3, unitPricePoisha: tk(500), lineDiscountPoisha: tk(90), keptQty: 2 }],
      orderDiscountPoisha: tk(0),
      deliveryChargePoisha: tk(0),
      advancePaidPoisha: tk(0),
      offerDiscountPoisha: tk(0),
      typedOrderDiscountPoisha: tk(0),
      newDeliveryChargePoisha: tk(0),
    });
    expect(result.keptNetPoisha).toBe(tk(940));
    expect(result.collectPoisha).toBe(result.expectedPoisha);
  });

  it('collects nothing when nothing is kept', () => {
    const result = repriceReturn({
      lines: lines.map((line) => ({ ...line, keptQty: 0 })),
      orderDiscountPoisha: tk(200),
      deliveryChargePoisha: tk(120),
      advancePaidPoisha: tk(0),
      offerDiscountPoisha: tk(0),
      typedOrderDiscountPoisha: tk(0),
      newDeliveryChargePoisha: tk(120),
    });
    expect(result.keptUnits).toBe(0);
    expect(result.collectPoisha).toBe(tk(0));
  });

  it('refuses discounts above the kept goods and impossible quantities', () => {
    expect(() =>
      repriceReturn({
        lines,
        orderDiscountPoisha: tk(0),
        deliveryChargePoisha: tk(0),
        advancePaidPoisha: tk(0),
        offerDiscountPoisha: tk(1100),
        typedOrderDiscountPoisha: tk(0),
        newDeliveryChargePoisha: tk(0),
      }),
    ).toThrow();
    expect(() =>
      repriceReturn({
        lines: [{ qty: 1, unitPricePoisha: tk(10), lineDiscountPoisha: tk(0), keptQty: 2 }],
        orderDiscountPoisha: tk(0),
        deliveryChargePoisha: tk(0),
        advancePaidPoisha: tk(0),
        offerDiscountPoisha: tk(0),
        typedOrderDiscountPoisha: tk(0),
        newDeliveryChargePoisha: tk(0),
      }),
    ).toThrow();
  });

  it('keeps the person’s own discount on the kept pieces, so nothing chosen means no difference', () => {
    // Tk 300 typed at the desk on two Tk 1,000 pieces; the buyer keeps one.
    const result = repriceReturn({
      lines,
      orderDiscountPoisha: tk(300),
      deliveryChargePoisha: tk(60),
      advancePaidPoisha: tk(0),
      offerDiscountPoisha: tk(0),
      typedOrderDiscountPoisha: tk(300),
      newDeliveryChargePoisha: tk(60),
    });
    expect(result.keptTypedDiscountPoisha).toBe(tk(150));
    expect(result.expectedPoisha).toBe(tk(910));
    expect(result.collectPoisha).toBe(tk(910));
  });

  it('refuses offers that would eat into the advance', () => {
    expect(() =>
      repriceReturn({
        lines: [{ qty: 1, unitPricePoisha: tk(900), lineDiscountPoisha: tk(0), keptQty: 1 }],
        orderDiscountPoisha: tk(0),
        deliveryChargePoisha: tk(60),
        advancePaidPoisha: tk(1000),
        offerDiscountPoisha: tk(200),
        typedOrderDiscountPoisha: tk(0),
        newDeliveryChargePoisha: tk(60),
      }),
    ).toThrow(/advance/);
  });
});
