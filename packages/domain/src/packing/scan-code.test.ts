import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  LOT_COUNT_MAX,
  lotCode,
  lotScanCode,
  orderScanCode,
  parseLotScanCode,
  parseOrderScanCode,
  readLotCode,
  scannedOrderParts,
} from './index.js';

/** D-912: an order's barcodes carry digits alone, and the digits read back to the same order. */

const prefix = fc.stringMatching(/^[A-Z][A-Z0-9]{1,5}$/);
const period = fc
  .tuple(fc.integer({ min: 0, max: 99 }), fc.integer({ min: 1, max: 12 }))
  .map(([year, month]) => `${String(year).padStart(2, '0')}${String(month).padStart(2, '0')}`);
const sequence = fc.integer({ min: 1, max: 999_999 });
const orderNo = fc
  .tuple(prefix, period, sequence)
  .map(([p, m, n]) => `${p}-${m}-${String(n).padStart(5, '0')}`);

describe('an order’s digits-only code', () => {
  it('is ten digits: the month and the counter to six', () => {
    expect(orderScanCode('ELY-2610-00042')).toBe('2610000042');
    expect(orderScanCode('OUR-2601-123456')).toBe('2601123456');
    expect(lotScanCode('ELY-2610-00042', 2)).toBe('261000004202');
    expect(lotScanCode('ELY-2610-00042', 20)).toBe('261000004220');
  });

  it('reads back to the order number’s month and counter, for any prefix', () => {
    fc.assert(
      fc.property(orderNo, (no) => {
        const code = orderScanCode(no);
        expect(code).toMatch(/^\d{10}$/);
        const [, month = '', counter = ''] = /^[A-Z0-9]+-(\d{4})-(\d+)$/.exec(no) ?? [];
        expect(parseOrderScanCode(code ?? '')).toEqual({ period: month, counter });
      }),
    );
  });

  it('reads one lot back, in either form, and never mistakes an order for a lot', () => {
    fc.assert(
      fc.property(orderNo, fc.integer({ min: 1, max: LOT_COUNT_MAX }), (no, lot) => {
        const digits = lotScanCode(no, lot) ?? '';
        expect(digits).toMatch(/^\d{12}$/);
        expect(readLotCode(digits)).toEqual({ orderCode: orderScanCode(no), lot });
        expect(readLotCode(lotCode(no, lot))).toEqual({ orderCode: no, lot });
        expect(readLotCode(orderScanCode(no) ?? '')).toBeNull();
        expect(parseOrderScanCode(digits)).toBeNull();
      }),
    );
  });

  it('has none past a million orders in a month, and refuses what is no order’s code', () => {
    expect(orderScanCode('ELY-2610-1000000')).toBeNull();
    expect(orderScanCode('not an order')).toBeNull();
    for (const code of ['2613000042', '2600000042', '2610000000', '261000004', 'ELY2610000042']) {
      expect(parseOrderScanCode(code), code).toBeNull();
    }
    for (const code of ['261000004200', '261000004221', '261300004202']) {
      expect(parseLotScanCode(code), code).toBeNull();
    }
    expect(() => lotScanCode('ELY-2610-00042', 0)).toThrow(RangeError);
  });

  it('names the order a scan typed into a search box, in every form a barcode carried', () => {
    const order = { period: '2610', counter: '00042' };
    for (const text of ['2610000042', '261000004202', 'ELY-2610-00042-L2', ' ely-2610-00042-l2 ']) {
      expect(scannedOrderParts(text), text).toEqual(order);
    }
    fc.assert(
      fc.property(orderNo, fc.integer({ min: 1, max: LOT_COUNT_MAX }), (no, lot) => {
        const [, month = '', counter = ''] = /^[A-Z0-9]+-(\d{4})-(\d+)$/.exec(no) ?? [];
        const parts = { period: month, counter };
        expect(scannedOrderParts(orderScanCode(no) ?? '')).toEqual(parts);
        expect(scannedOrderParts(lotScanCode(no, lot) ?? '')).toEqual(parts);
        expect(scannedOrderParts(lotCode(no, lot))).toEqual(parts);
      }),
    );
    // The order number itself, a name, a phone, a courier's code: matched as text, as before.
    for (const text of ['ELY-2610-00042', 'Rahim', '01712345678', 'DL121224VS8TJ', 'Rahim-L2']) {
      expect(scannedOrderParts(text), text).toBeNull();
    }
  });
});
