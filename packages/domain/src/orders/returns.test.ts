import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isReturnReasonCode,
  RETURN_REASON_CODES,
  sharesBps,
  summarizeReturnReasons,
  type ReturnReasonCount,
} from './returns.js';
import { transition, TRANSITIONS } from './state.js';

/** Return reasons (M17 check 3, D-234): the list, the machine's rule, and the report. */

const AT = new Date('2026-10-02T06:00:00Z');

describe('a return reason is required on every return and every exchange', () => {
  it('declares `record_return_reason` on exactly the rows that bring goods back', () => {
    const recording = TRANSITIONS.filter((row) => row.effects.includes('record_return_reason'));
    expect(recording.map((row) => `${row.from}->${row.to}`).sort()).toEqual([
      'delivered->exchange',
      'partially_delivered->returned',
      'return_in_transit->returned',
    ]);
  });

  it.each([
    ['return_in_transit', 'receive_return'],
    ['partially_delivered', 'receive_return'],
    ['delivered', 'exchange'],
  ] as const)('refuses %s → %s without a code from the list', (from, trigger) => {
    for (const returnReason of [undefined, null, '', 'buyer was rude', 'CUSTOMER_REFUSED']) {
      expect(() =>
        transition({ from, trigger, at: AT, reason: 'came back', returnReason }),
      ).toThrowError(/return reason/);
    }
    const moved = transition({
      from,
      trigger,
      at: AT,
      reason: 'came back',
      returnReason: 'size_issue',
    });
    expect(moved.returnReason).toBe('size_issue');
    expect(moved.effects).toContain('record_return_reason');
  });

  it('ignores a return reason on a move that brings nothing back', () => {
    const moved = transition({
      from: 'shipped',
      trigger: 'deliver',
      at: AT,
      returnReason: 'size_issue',
    });
    expect(moved.returnReason).toBeNull();
  });

  it('knows its own list and nothing else', () => {
    for (const code of RETURN_REASON_CODES) expect(isReturnReasonCode(code)).toBe(true);
    expect(isReturnReasonCode('fake_order')).toBe(false);
    expect(isReturnReasonCode(7)).toBe(false);
    expect(new Set(RETURN_REASON_CODES).size).toBe(RETURN_REASON_CODES.length);
  });
});

describe('the report by reason', () => {
  it('counts by reason and kind, most common first, with shares that sum to 100%', () => {
    const rows: ReturnReasonCount[] = [
      { reason: 'customer_refused', kind: 'return', count: 5 },
      { reason: 'size_issue', kind: 'exchange', count: 2 },
      { reason: 'size_issue', kind: 'return', count: 1 },
      { reason: 'other', kind: 'return', count: 1 },
    ];
    const report = summarizeReturnReasons(rows);
    expect(report).toEqual({
      total: 9,
      returns: 7,
      exchanges: 2,
      reasons: [
        { reason: 'customer_refused', returns: 5, exchanges: 0, total: 5, shareBps: 5556 },
        { reason: 'size_issue', returns: 1, exchanges: 2, total: 3, shareBps: 3333 },
        { reason: 'other', returns: 1, exchanges: 0, total: 1, shareBps: 1111 },
      ],
    });
  });

  it('keeps the list’s order on a tie, and is empty with no returns', () => {
    const report = summarizeReturnReasons([
      { reason: 'wrong_item', kind: 'return', count: 1 },
      { reason: 'customer_refused', kind: 'return', count: 1 },
      { reason: 'wrong_address', kind: 'return', count: 1 },
    ]);
    expect(report.reasons.map((line) => line.reason)).toEqual([
      'customer_refused',
      'wrong_address',
      'wrong_item',
    ]);
    expect(report.reasons.map((line) => line.shareBps)).toEqual([3334, 3333, 3333]);
    expect(summarizeReturnReasons([])).toEqual({ total: 0, returns: 0, exchanges: 0, reasons: [] });
  });

  it('refuses a count or a reason it cannot report', () => {
    expect(() =>
      summarizeReturnReasons([{ reason: 'size_issue', kind: 'return', count: -1 }]),
    ).toThrow(RangeError);
    expect(() =>
      summarizeReturnReasons([
        { reason: 'nope' as ReturnReasonCount['reason'], kind: 'return', count: 1 },
      ]),
    ).toThrow(RangeError);
  });

  it('shares always sum to exactly 10,000 and never go negative', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 1_000_000 }), { maxLength: 12 }), (counts) => {
        const shares = sharesBps(counts);
        const total = counts.reduce((acc, count) => acc + count, 0);
        expect(shares.reduce((acc, share) => acc + share, 0)).toBe(total === 0 ? 0 : 10_000);
        for (const [index, share] of shares.entries()) {
          expect(share).toBeGreaterThanOrEqual(0);
          if ((counts[index] ?? 0) === 0) expect(share).toBe(0);
        }
      }),
    );
  });

  it('adds up: every row counted once, in its kind', () => {
    const row = fc.record({
      reason: fc.constantFrom(...RETURN_REASON_CODES),
      kind: fc.constantFrom('return' as const, 'exchange' as const),
      count: fc.nat({ max: 10_000 }),
    });
    fc.assert(
      fc.property(fc.array(row, { maxLength: 30 }), (rows) => {
        const report = summarizeReturnReasons(rows);
        const total = rows.reduce((acc, entry) => acc + entry.count, 0);
        expect(report.total).toBe(total);
        expect(report.returns + report.exchanges).toBe(total);
        expect(report.reasons.reduce((acc, line) => acc + line.total, 0)).toBe(total);
      }),
    );
  });
});
