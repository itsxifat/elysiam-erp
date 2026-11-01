import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PACKING_CAMERA_MAX_MS,
  PACKING_LABEL_REREAD_MS,
  isLabelReread,
  judgePackLabelScan,
  judgeReturnLabelScan,
  pauseInMs,
  readOrderLabel,
  recordedMs,
  recordingPaused,
  recordingSpans,
  recordingStopAt,
  returnVideoExpiry,
} from './index.js';

/**
 * M51's rules (D-930 to D-935): a recording's stretches between the label scans, the pause after
 * the idle time, and which label starts or stops which lot.
 */

const IDLE = 10_000;

describe('recordingSpans', () => {
  it('keeps one stretch while every scan comes within the idle time', () => {
    const spans = recordingSpans({
      startedMs: 0,
      activityMs: [0, 4_000, 9_000, 15_000],
      stoppedMs: 20_000,
      nowMs: 99_000,
      idleMs: IDLE,
      leadMs: 0,
    });
    expect(spans).toEqual([{ fromMs: 0, toMs: 20_000 }]);
  });

  it('pauses after ten seconds with no scan and resumes at the next', () => {
    const spans = recordingSpans({
      startedMs: 0,
      activityMs: [30_000, 32_000],
      stoppedMs: 60_000,
      nowMs: 99_000,
      idleMs: IDLE,
      leadMs: 0,
    });
    expect(spans).toEqual([
      { fromMs: 0, toMs: 10_000 },
      { fromMs: 30_000, toMs: 42_000 },
      { fromMs: 60_000, toMs: 60_000 },
    ]);
    expect(recordedMs(spans)).toBe(22_000);
  });

  it('reaches two seconds back before each resume for an IP camera', () => {
    const spans = recordingSpans({
      startedMs: 1_000,
      activityMs: [30_000],
      stoppedMs: 35_000,
      nowMs: 99_000,
      idleMs: IDLE,
      leadMs: 2_000,
    });
    expect(spans).toEqual([
      { fromMs: -1_000, toMs: 11_000 },
      { fromMs: 28_000, toMs: 35_000 },
    ]);
  });

  it('runs to now while the recording has not stopped', () => {
    expect(
      recordingSpans({
        startedMs: 0,
        activityMs: [],
        stoppedMs: null,
        nowMs: 4_000,
        idleMs: IDLE,
        leadMs: 0,
      }),
    ).toEqual([{ fromMs: 0, toMs: 4_000 }]);
  });

  it('never overlaps, stays inside the recording and covers every event', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 0, max: 600_000 }), { maxLength: 40 }),
        fc.integer({ min: 0, max: 900_000 }),
        fc.integer({ min: 3_000, max: 60_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        (start, offsets, length, idle, lead) => {
          const stop = start + length;
          const activity = offsets.map((offset) => start + offset).filter((at) => at <= stop);
          const spans = recordingSpans({
            startedMs: start,
            activityMs: activity,
            stoppedMs: stop,
            nowMs: stop + 5_000,
            idleMs: idle,
            leadMs: lead,
          });
          for (const [index, span] of spans.entries()) {
            expect(span.toMs).toBeGreaterThanOrEqual(span.fromMs);
            expect(span.fromMs).toBeGreaterThanOrEqual(start - lead);
            expect(span.toMs).toBeLessThanOrEqual(stop);
            const next = spans[index + 1];
            if (next !== undefined) expect(next.fromMs).toBeGreaterThan(span.toMs);
          }
          for (const at of [start, ...activity, stop]) {
            expect(spans.some((span) => span.fromMs <= at && at <= span.toMs)).toBe(true);
          }
          // Never paused within the idle time after an event (unless the stop came first).
          for (const at of [start, ...activity]) {
            const until = Math.min(at + idle, stop);
            expect(spans.some((span) => span.fromMs <= at && until <= span.toMs)).toBe(true);
          }
        },
      ),
    );
  });
});

describe('the pause', () => {
  it('pauses once the idle time has run out, and counts down to it', () => {
    expect(recordingPaused({ lastActivityMs: 0, nowMs: 9_999, idleMs: IDLE })).toBe(false);
    expect(recordingPaused({ lastActivityMs: 0, nowMs: 10_000, idleMs: IDLE })).toBe(true);
    expect(pauseInMs({ lastActivityMs: 0, nowMs: 4_000, idleMs: IDLE })).toBe(6_000);
    expect(pauseInMs({ lastActivityMs: 0, nowMs: 40_000, idleMs: IDLE })).toBe(0);
  });

  it('stops a recording at fifteen minutes at the latest', () => {
    expect(recordingStopAt(0, 60_000)).toBe(60_000);
    expect(recordingStopAt(0, PACKING_CAMERA_MAX_MS + 1)).toBe(PACKING_CAMERA_MAX_MS);
    expect(recordingStopAt(5_000, 1_000)).toBe(5_000);
  });
});

describe('readOrderLabel', () => {
  const order = {
    orderNumber: 'ELY-2610-00042',
    trackingCode: 'SFR123',
    consignmentId: '998877',
  };

  it('reads the whole order from its number, digits or the courier codes', () => {
    for (const code of ['ELY-2610-00042', ' ely-2610-00042 ', '2610000042', 'sfr123', '998877']) {
      expect(readOrderLabel(code, order)).toEqual({ lot: null });
    }
  });

  it('reads a lot from its code in letters or digits', () => {
    expect(readOrderLabel('ELY-2610-00042-L2', order)).toEqual({ lot: 2 });
    expect(readOrderLabel('261000004203', order)).toEqual({ lot: 3 });
  });

  it('is no label of another order or of nothing', () => {
    expect(readOrderLabel('ELY-2610-00043', order)).toBeNull();
    expect(readOrderLabel('261000004302', order)).toBeNull();
    expect(readOrderLabel('8901234567890', order)).toBeNull();
    expect(readOrderLabel('', order)).toBeNull();
  });
});

describe('judgePackLabelScan', () => {
  it('starts the open lot, then stops it', () => {
    expect(
      judgePackLabelScan({ lotCount: 1, closedLots: 0, scannedLot: null, openLotStarted: false }),
    ).toEqual({ kind: 'start', lot: 1 });
    expect(
      judgePackLabelScan({ lotCount: 1, closedLots: 0, scannedLot: null, openLotStarted: true }),
    ).toEqual({ kind: 'stop', lot: 1 });
  });

  it('refuses a lot’s own code on an order now in one lot: an old sticker (D-946)', () => {
    expect(
      judgePackLabelScan({ lotCount: 1, closedLots: 0, scannedLot: 1, openLotStarted: true }),
    ).toEqual({ kind: 'refused', reason: 'old_lot_label', lot: 1, expected: 1 });
    expect(
      judgePackLabelScan({ lotCount: 1, closedLots: 0, scannedLot: 1, openLotStarted: false }),
    ).toMatchObject({ kind: 'refused', reason: 'old_lot_label' });
  });

  it('keeps the lots in order', () => {
    expect(
      judgePackLabelScan({ lotCount: 3, closedLots: 1, scannedLot: 3, openLotStarted: false }),
    ).toEqual({ kind: 'refused', reason: 'other_lot', lot: 3, expected: 2 });
    expect(
      judgePackLabelScan({ lotCount: 3, closedLots: 1, scannedLot: 1, openLotStarted: false }),
    ).toEqual({ kind: 'refused', reason: 'lot_done', lot: 1, expected: 2 });
    expect(
      judgePackLabelScan({ lotCount: 2, closedLots: 0, scannedLot: 4, openLotStarted: false }),
    ).toMatchObject({ kind: 'refused', reason: 'no_such_lot' });
    expect(
      judgePackLabelScan({ lotCount: 2, closedLots: 2, scannedLot: null, openLotStarted: false }),
    ).toMatchObject({ kind: 'refused', reason: 'all_done' });
  });

  it('takes a code of the whole order only when the order is in one lot (D-945)', () => {
    expect(
      judgePackLabelScan({ lotCount: 2, closedLots: 0, scannedLot: null, openLotStarted: false }),
    ).toEqual({ kind: 'refused', reason: 'whole_order', lot: null, expected: 1 });
    expect(
      judgePackLabelScan({ lotCount: 3, closedLots: 1, scannedLot: null, openLotStarted: true }),
    ).toEqual({ kind: 'refused', reason: 'whole_order', lot: null, expected: 2 });
    expect(
      judgePackLabelScan({ lotCount: 1, closedLots: 0, scannedLot: null, openLotStarted: true }),
    ).toEqual({ kind: 'stop', lot: 1 });
  });

  it('only ever starts or stops the open lot', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        fc.option(fc.integer({ min: 0, max: 22 }), { nil: null }),
        fc.boolean(),
        (lotCount, closed, scannedLot, started) => {
          const closedLots = Math.min(closed, lotCount);
          const verdict = judgePackLabelScan({
            lotCount,
            closedLots,
            scannedLot,
            openLotStarted: started,
          });
          if (verdict.kind !== 'refused') {
            expect(verdict.lot).toBe(closedLots + 1);
            expect(verdict.kind).toBe(started ? 'stop' : 'start');
          }
        },
      ),
    );
  });
});

describe('judgeReturnLabelScan', () => {
  it('opens the bags in any order, one at a time', () => {
    const none = new Set<number>();
    expect(
      judgeReturnLabelScan({ lotCount: 3, scannedLot: 3, recordingLot: null, doneLots: none }),
    ).toEqual({ kind: 'start', lot: 3 });
    expect(
      judgeReturnLabelScan({ lotCount: 3, scannedLot: null, recordingLot: 3, doneLots: none }),
    ).toEqual({ kind: 'stop', lot: 3 });
    expect(
      judgeReturnLabelScan({ lotCount: 3, scannedLot: 1, recordingLot: 3, doneLots: none }),
    ).toEqual({ kind: 'refused', reason: 'other_lot', lot: 1, expected: 3 });
  });

  it('reopens a done bag by its own label, so a bag stopped by mistake strands nothing', () => {
    expect(
      judgeReturnLabelScan({
        lotCount: 2,
        scannedLot: 2,
        recordingLot: null,
        doneLots: new Set([2]),
      }),
    ).toEqual({ kind: 'start', lot: 2 });
    expect(
      judgeReturnLabelScan({
        lotCount: 1,
        scannedLot: null,
        recordingLot: null,
        doneLots: new Set([1]),
      }),
    ).toEqual({ kind: 'start', lot: 1 });
  });

  it('takes the first bag not opened for a code of the whole order', () => {
    expect(
      judgeReturnLabelScan({
        lotCount: 3,
        scannedLot: null,
        recordingLot: null,
        doneLots: new Set([1, 3]),
      }),
    ).toEqual({ kind: 'start', lot: 2 });
    // Every bag done: a code of the whole order names none of several.
    expect(
      judgeReturnLabelScan({
        lotCount: 2,
        scannedLot: null,
        recordingLot: null,
        doneLots: new Set([1, 2]),
      }),
    ).toMatchObject({ kind: 'refused', reason: 'all_done' });
  });
});

describe('isLabelReread', () => {
  const last = { code: 'ELY-2611-00042', atMs: 10_000 };

  it('ignores the same label read again at once, and only that', () => {
    const soon = 10_000 + PACKING_LABEL_REREAD_MS - 1;
    expect(isLabelReread({ code: last.code, last, nowMs: soon })).toBe(true);
    expect(isLabelReread({ code: last.code, last, nowMs: 10_000 + PACKING_LABEL_REREAD_MS })).toBe(
      false,
    );
    expect(isLabelReread({ code: 'ELY-2611-00042-L2', last, nowMs: soon })).toBe(false);
    expect(isLabelReread({ code: last.code, last: null, nowMs: soon })).toBe(false);
  });
});

describe('returnVideoExpiry', () => {
  it('keeps a return’s video thirty Dhaka days after it was received', () => {
    expect(returnVideoExpiry(new Date('2026-11-01T10:00:00Z'))).toEqual({
      keepThrough: '2026-12-01',
      deleteFrom: '2026-12-02',
    });
    expect(returnVideoExpiry(null)).toBeNull();
  });
});
