import { describe, expect, it } from 'vitest';

import type { Area } from './api.js';
import {
  addLine,
  deskPhone,
  filterAreas,
  previewTotals,
  previewWithPromo,
  promoLines,
  toAsciiDigits,
} from './desk-logic.js';
import { ordersEn, ordersMessages } from './messages.js';
import { offeredActions } from './order-actions-logic.js';
import { formatShare, monthStartOf, RETURN_REASONS, todayInDhaka } from './returns-logic.js';

/**
 * The order desk's pure pieces, and its catalogue.
 *
 * Each of these fails silently in the browser: a key missing from the catalogue throws at
 * render time, a phone rule that disagrees with the server's saves
 * orders under the wrong buyer, and a preview that adds money in floating point reads a COD
 * to a buyer that the invoice then contradicts.
 */

describe('the orders catalogue', () => {
  it('is English only (D-750), with no empty string', () => {
    expect(Object.keys(ordersMessages)).toEqual(['en']);
    for (const value of Object.values(ordersEn)) {
      expect(value.trim()).not.toBe('');
    }
  });
});

describe('deskPhone', () => {
  it('recognises the spellings an agent pastes', () => {
    for (const typed of [
      '01711223344',
      '+8801711223344',
      '8801711223344',
      '008801711223344',
      '1711223344',
      '01711-223344',
      '+880 1711 223 344',
      '০১৭১১২২৩৩৪৪',
    ]) {
      expect(deskPhone(typed), typed).toBe('01711223344');
    }
  });

  it('waits for a whole, valid mobile number', () => {
    for (const typed of ['', '0171', '01211223344', '0171122334455', 'call me']) {
      expect(deskPhone(typed), typed).toBeNull();
    }
    expect(toAsciiDigits('ফোন ০১৯')).toBe('ফোন 019');
  });
});

describe('filterAreas', () => {
  const area = (thanaEn: string, districtEn: string, thanaBn = '', districtBn = ''): Area => ({
    thanaId: thanaEn.length,
    thanaEn,
    thanaBn,
    districtId: districtEn.length,
    districtEn,
    districtBn,
    zoneId: null,
  });
  const areas = [
    area('Dhamrai', 'Dhaka'),
    area('Savar', 'Dhaka', 'সাভার', 'ঢাকা'),
    area('Kasba', 'Brahmanbaria'),
    area('Nawabganj', 'Dhaka'),
  ];

  it('ranks a thana that starts with the query first', () => {
    expect(filterAreas(areas, 'sav').map((entry) => entry.thanaEn)).toEqual(['Savar']);
    expect(filterAreas(areas, 'dha').map((entry) => entry.thanaEn)).toEqual([
      'Dhamrai',
      'Nawabganj',
      'Savar',
    ]);
  });

  it('matches Bangla names and caps the list', () => {
    expect(filterAreas(areas, 'সাভ').map((entry) => entry.thanaEn)).toEqual(['Savar']);
    expect(filterAreas(areas, 'a', 2)).toHaveLength(2);
    expect(filterAreas(areas, '   ')).toEqual([]);
  });
});

describe('previewTotals', () => {
  const line = (qty: number, price: string) => ({
    skuId: `sku-${price}`,
    skuCode: 'X',
    name: 'X',
    qty,
    unitPricePoisha: price,
    availableQty: null,
  });

  it('works §9’s formula in bigint', () => {
    const totals = previewTotals({
      lines: [line(2, '125000'), line(1, '9007199254740993')],
      discountPoisha: '10000',
      deliveryPoisha: '6000',
    });
    // Past 2^53 on purpose: a Number would lose the last digit here.
    expect(totals.itemsPoisha).toBe('9007199254990993');
    expect(totals.codPoisha).toBe('9007199254986993');
    expect(totals.invalid).toBe(false);
  });

  it('flags a discount larger than the items instead of showing a negative COD', () => {
    const totals = previewTotals({
      lines: [line(1, '100000')],
      discountPoisha: '100001',
      deliveryPoisha: '0',
    });
    expect(totals.invalid).toBe(true);
    expect(totals.codPoisha).toBe('0');
  });

  it('merges a SKU added twice into one line', () => {
    const merged = addLine([line(1, '100')], line(2, '100'));
    expect(merged).toHaveLength(1);
    expect(merged[0]?.qty).toBe(3);
  });
});

describe('the desk preview with a promo code (M16)', () => {
  const line = (qty: number, price: string) => ({
    skuId: `sku-${price}`,
    skuCode: 'X',
    name: 'X',
    qty,
    unitPricePoisha: price,
    availableQty: null,
  });

  it('adds the code to the typed discount and takes its delivery part off the charge', () => {
    // The server's rule (orders.service.ts): order discount = typed + code, delivery =
    // charge - code's delivery discount. A preview that added the delivery discount
    // instead would read a COD to the buyer that the order never asks for.
    const totals = previewWithPromo({
      lines: [line(2, '150000')],
      discountPoisha: '5000',
      deliveryPoisha: '12000',
      promo: { discountPoisha: '30000', deliveryDiscountPoisha: '12000' },
    });
    expect(totals.itemsPoisha).toBe('300000');
    expect(totals.discountPoisha).toBe('35000');
    expect(totals.deliveryPoisha).toBe('0');
    expect(totals.codPoisha).toBe('265000');
  });

  it('is the plain preview when no code applies', () => {
    const input = {
      lines: [line(1, '100000')],
      discountPoisha: '0',
      deliveryPoisha: '6000',
    };
    expect(previewWithPromo({ ...input, promo: null })).toEqual(previewTotals(input));
  });

  it('sends each line as price times quantity, in poisha, past 2^53', () => {
    expect(promoLines([line(3, '3002399751580331')])).toEqual([
      { skuId: 'sku-3002399751580331', qty: 3, netPoisha: '9007199254740993' },
    ]);
  });
});

describe('returns by reason (M17)', () => {
  it('reads the month and the date in Dhaka, not in the browser’s zone', () => {
    // 20:30 UTC on 31 October is 02:30 on 1 November in Dhaka.
    expect(todayInDhaka(new Date('2026-10-31T20:30:00Z'))).toBe('2026-11-01');
    expect(monthStartOf('2026-11-19')).toBe('2026-11-01');
  });

  it('shows basis points as a percentage without floating point', () => {
    expect(formatShare(5556)).toBe('55.56%');
    expect(formatShare(1111)).toBe('11.11%');
    expect(formatShare(10_000)).toBe('100.00%');
    expect(formatShare(5)).toBe('0.05%');
  });

  it('has a label for every reason the server knows', () => {
    for (const reason of RETURN_REASONS) {
      const key = `orders.reason.${reason}` as const;
      expect(ordersEn[key]).toBeTruthy();
    }
  });
});

describe('the order detail offers what §9 allows from the order’s status (D-392)', () => {
  const row = (trigger: string, to = 'confirmed') =>
    ({ trigger, to, requiresReason: false, requiresReturnReason: false }) as never;

  it('shows the server’s moves in working order, and never an exchange', () => {
    const transitions = [row('cancel'), row('ship'), row('hold'), row('pack'), row('exchange')];
    expect(offeredActions(transitions, true)).toEqual(['pack', 'ship', 'hold', 'cancel']);
  });

  it('offers nothing to a caller without update Order', () => {
    expect(offeredActions([row('pack')], false)).toEqual([]);
  });

  it('does not offer cancel on a held order, because the server does not list it', () => {
    // §9 from on_hold: release only, under the domain's own trigger name. The console used to
    // show Cancel here, and for a while named the trigger `release`, which matched nothing.
    expect(offeredActions([row('release_hold')], true)).toEqual(['release_hold']);
  });
});
