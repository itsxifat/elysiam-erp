import { describe, expect, it } from 'vitest';

import {
  differenceNote,
  editLines,
  returnOne,
  startingTerms,
  toggleOffer,
  type EditRow,
} from './order-edit-logic.js';

const row = (overrides: Partial<EditRow> = {}): EditRow => ({
  skuId: 'a',
  skuCode: 'A-1',
  name: 'Panjabi',
  variantLabel: 'M',
  imageFileId: null,
  qty: 2,
  unitPricePoisha: '150000',
  lineDiscountPoisha: '10000',
  originalQty: 2,
  available: null,
  ...overrides,
});

describe('the order editor (M50)', () => {
  it('lets one offer that does not combine stand alone', () => {
    const offers = [
      { discountId: 'solo', allowStacking: false },
      { discountId: 's1', allowStacking: true },
      { discountId: 's2', allowStacking: true },
    ];
    expect(toggleOffer([], offers[1]!, offers)).toEqual(['s1']);
    expect(toggleOffer(['s1'], offers[2]!, offers)).toEqual(['s1', 's2']);
    expect(toggleOffer(['s1', 's2'], offers[0]!, offers)).toEqual(['solo']);
    expect(toggleOffer(['solo'], offers[1]!, offers)).toEqual(['s1']);
    expect(toggleOffer(['s1', 's2'], offers[1]!, offers)).toEqual(['s2']);
  });

  it('starts from the discount and charge before the order’s offers', () => {
    const terms = startingTerms({
      amounts: { discountPoisha: '40000', deliveryChargePoisha: '0' },
      lines: [{ discountPoisha: '10000' }],
      appliedOffers: [
        {
          discountId: 'x',
          method: 'code',
          code: 'X',
          title: 'X',
          discountPoisha: '20000',
          deliveryDiscountPoisha: '6000',
        },
      ],
    });
    expect(terms).toEqual({
      typedDiscountPoisha: 10000n,
      baseDeliveryPoisha: 6000n,
      offerIds: ['x'],
    });
  });

  it('keeps an existing line’s price and scales its discount down with its quantity', () => {
    expect(editLines([row()])).toEqual([
      { skuId: 'a', qty: 2, unitPricePoisha: '150000', discountPoisha: '10000' },
    ]);
    expect(editLines([row({ qty: 1 })])[0]?.discountPoisha).toBe('5000');
    expect(editLines([row({ qty: 3 })])[0]?.discountPoisha).toBe('10000');
    expect(editLines([row({ originalQty: null })])).toEqual([{ skuId: 'a', qty: 2 }]);
  });

  it('writes the re-pricing note within the reason’s length', () => {
    expect(differenceNote('Offers {offers}. Fee {fee}.', [], 'none', 'Tk 60.00', '')).toBe(
      'Offers none. Fee Tk 60.00.',
    );
    expect(differenceNote('{offers}', ['A', 'B'], 'none', '', 'x'.repeat(600))).toHaveLength(500);
  });

  it('never returns more pieces than were sent, nor fewer than none', () => {
    expect(returnOne({}, 'a', 2, 1)).toEqual({ a: 1 });
    expect(returnOne({ a: 2 }, 'a', 2, 1)).toEqual({ a: 2 });
    expect(returnOne({ a: 0 }, 'a', 2, -1)).toEqual({ a: 0 });
  });
});
