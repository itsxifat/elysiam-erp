import { describe, expect, it } from 'vitest';

import { daysBefore, percentOfBps, quantity, receiptProblem, todayInDhaka } from './courier-ui.js';
import { courierEn, courierMessages } from './messages.js';

/**
 * The courier screens' pure pieces (M15).
 *
 * The screens themselves are React over endpoints the server suites cover. These are the
 * parts that can be wrong on their own, each with a failure a click-through would miss:
 *
 * - a key missing from the catalogue throws at render time;
 * - a rate rendered through a float shows 66.66999999999999%;
 * - a "today" computed in UTC is yesterday in Dhaka for six hours of every night;
 * - a return inspection that lets more units back than left puts phantom stock on a shelf.
 */

describe('the courier catalogue', () => {
  it('is English only (D-750)', () => {
    expect(Object.keys(courierMessages)).toEqual(['en']);
    expect(Object.keys(courierEn).length).toBeGreaterThan(10);
  });

  it('has a non-empty value for every key', () => {
    const empty: string[] = [];
    for (const [locale, catalogue] of Object.entries(courierMessages)) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (value.trim() === '') empty.push(`${locale}:${key}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('translates every status and reason the server can send', () => {
    for (const status of [
      'booked',
      'pickup_pending',
      'picked_up',
      'in_transit',
      'out_for_delivery',
      'hold',
      'delivered',
      'partial_delivered',
      'return_in_transit',
      'returned_to_merchant',
      'cancelled',
      'unknown',
    ]) {
      expect(Object.hasOwn(courierEn, `courier.status.${status}`), status).toBe(true);
    }
    for (const reason of [
      'no_status_change',
      'unknown_status',
      'booking_failed',
      'unposted_delivery',
      'return_not_received',
      'not_received',
    ]) {
      expect(Object.hasOwn(courierEn, `courier.stuck.reason.${reason}`), reason).toBe(true);
    }
  });
});

describe('courier screen helpers', () => {
  it('renders basis points as a percentage without a float', () => {
    expect(percentOfBps(6667)).toBe('66.67%');
    expect(percentOfBps(10000)).toBe('100.00%');
    expect(percentOfBps(5)).toBe('0.05%');
    expect(percentOfBps(null)).toBe('—');
  });

  it('computes today in Dhaka, not in UTC', () => {
    // 20:00 UTC on the 1st is 02:00 on the 2nd in Dhaka.
    expect(todayInDhaka(new Date('2026-03-01T20:00:00Z'))).toBe('2026-03-02');
    expect(daysBefore('2026-03-02', 29)).toBe('2026-02-01');
  });

  it('refuses an inspection that is empty, too large, or damaged with nowhere to go', () => {
    const lines = [
      { skuId: 'a', outstandingQty: 2 },
      { skuId: 'b', outstandingQty: 1 },
    ];
    expect(receiptProblem(lines, {}, '')).toBe('nothing');
    expect(receiptProblem(lines, { a: { sellableQty: 2, damagedQty: 1 } }, 'loc')).toBe('too_many');
    expect(receiptProblem(lines, { b: { sellableQty: 0, damagedQty: 1 } }, '')).toBe(
      'needs_damaged_location',
    );
    expect(
      receiptProblem(
        lines,
        { a: { sellableQty: 2, damagedQty: 0 }, b: { sellableQty: 0, damagedQty: 1 } },
        'loc',
      ),
    ).toBeNull();
  });

  it('reads a quantity field strictly', () => {
    expect(quantity('3')).toBe(3);
    expect(quantity(' 12 ')).toBe(12);
    expect(quantity('-1')).toBe(0);
    expect(quantity('1.5')).toBe(0);
    expect(quantity('')).toBe(0);
  });
});
