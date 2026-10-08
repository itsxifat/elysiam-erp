import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PACKING_CAMERA_CUT_WAIT_MS,
  PACKING_CAMERA_HORIZON_MS,
  PACKING_CAMERA_LIVE_MS,
  PACKING_CAMERA_MAX_MS,
  PACKING_CAMERA_PREROLL_MS,
  PACKING_CAMERA_READY_WITHIN_MS,
  PACKING_CAMERA_TAIL_MS,
  PACK_SCAN_OUTCOMES,
  cameraBufferKeepFromMs,
  cameraParts,
  cameraReconnectDelayMs,
  cameraRecordingFrom,
  cameraRecordingTimedOut,
  cameraRecordingTo,
  cameraState,
  cutDecision,
  cutSpan,
  segmentsForWindow,
  segmentsToForget,
  windowCoverage,
  type CameraSegment,
  type PackScanOutcome,
} from './index.js';

/**
 * The IP camera's recording window and its buffer (M38c, D-668 to D-676), against random scans,
 * random clocks and random streams.
 */

const T0 = Date.UTC(2026, 9, 8, 6, 0, 0);

const outcomeArb = fc.constantFrom<PackScanOutcome>(...PACK_SCAN_OUTCOMES);

/** A packing's scans: an outcome each, a second or more apart. */
const scansArb = fc.array(
  fc.record({ outcome: outcomeArb, gapMs: fc.integer({ min: 200, max: 120_000 }) }),
  { maxLength: 30 },
);

/** Replay scans through the rule as the station does: the window's start, once. */
function replay(
  cameraId: string | null,
  scans: readonly { outcome: PackScanOutcome; gapMs: number }[],
): { from: Date | null; times: number[] } {
  let from: Date | null = null;
  let at = T0;
  const times: number[] = [];
  for (const scan of scans) {
    at += scan.gapMs;
    times.push(at);
    const next = cameraRecordingFrom({
      cameraId,
      recordingFrom: from,
      outcome: scan.outcome,
      scannedAt: new Date(at),
    });
    if (next !== null) {
      expect(from, 'the start is set once').toBeNull();
      from = next;
    }
  }
  return { from, times };
}

describe('the recording window (the owner’s catch: only a correct piece starts it)', () => {
  it('starts exactly two seconds before the first accepted scan, and no refusal ever starts it', () => {
    fc.assert(
      fc.property(scansArb, (scans) => {
        const { from, times } = replay('camera-1', scans);
        const first = scans.findIndex((scan) => scan.outcome === 'accepted');
        if (first === -1) {
          expect(from).toBeNull();
        } else {
          expect(from?.getTime()).toBe((times[first] ?? 0) - PACKING_CAMERA_PREROLL_MS);
        }
      }),
    );
  });

  it('never starts without a camera chosen', () => {
    fc.assert(
      fc.property(scansArb, (scans) => {
        expect(replay(null, scans).from).toBeNull();
      }),
    );
  });

  it('refuses every refusal and removal outright, whatever came before', () => {
    for (const outcome of PACK_SCAN_OUTCOMES.filter((value) => value !== 'accepted')) {
      expect(
        cameraRecordingFrom({
          cameraId: 'camera-1',
          recordingFrom: null,
          outcome,
          scannedAt: new Date(T0),
        }),
      ).toBeNull();
    }
  });

  it('ends at the finish, inside fifteen minutes of its start, and only once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 * 86_400_000 }),
        fc.integer({ min: -60_000, max: 3 * PACKING_CAMERA_MAX_MS }),
        (offset, length) => {
          const from = new Date(T0 + offset);
          const endedAt = new Date(from.getTime() + length);
          const to = cameraRecordingTo({ recordingFrom: from, recordingTo: null, endedAt });
          expect(to).not.toBeNull();
          const toMs = to?.getTime() ?? 0;
          expect(toMs).toBeGreaterThanOrEqual(from.getTime());
          expect(toMs - from.getTime()).toBeLessThanOrEqual(PACKING_CAMERA_MAX_MS);
          if (length >= 0 && length <= PACKING_CAMERA_MAX_MS) expect(toMs).toBe(endedAt.getTime());
          // Set once: an end already there is kept.
          expect(cameraRecordingTo({ recordingFrom: from, recordingTo: to, endedAt })).toBeNull();
          // Nothing to end without a start.
          expect(cameraRecordingTo({ recordingFrom: null, recordingTo: null, endedAt })).toBeNull();
        },
      ),
    );
  });

  it('times out an open recording exactly fifteen minutes after its start, not a moment before', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 * PACKING_CAMERA_MAX_MS }), (elapsed) => {
        const from = new Date(T0);
        const timedOut = cameraRecordingTimedOut({
          recordingFrom: from,
          recordingTo: null,
          now: new Date(T0 + elapsed),
        });
        if (elapsed < PACKING_CAMERA_MAX_MS) expect(timedOut).toBeNull();
        else expect(timedOut?.getTime()).toBe(T0 + PACKING_CAMERA_MAX_MS);
      }),
    );
    expect(
      cameraRecordingTimedOut({
        recordingFrom: new Date(T0),
        recordingTo: new Date(T0 + 1000),
        now: new Date(T0 + 2 * PACKING_CAMERA_MAX_MS),
      }),
    ).toBeNull();
  });
});

/** A camera's buffer: segments one after another, 0.5 to 4 s each, with the odd gap. */
const bufferArb = fc
  .array(
    fc.record({
      durationMs: fc.integer({ min: 500, max: 4_000 }),
      gapMs: fc.oneof(
        { weight: 9, arbitrary: fc.constant(0) },
        { weight: 1, arbitrary: fc.integer({ min: 1, max: 20_000 }) },
      ),
      sizeBytes: fc.integer({ min: 1, max: 2_000_000 }),
    }),
    { minLength: 1, maxLength: 200 },
  )
  .map((pieces) => {
    let at = T0;
    return pieces.map((piece, index): CameraSegment => {
      const startMs = at + piece.gapMs;
      at = startMs + piece.durationMs;
      return { name: `s${String(index)}`, startMs, endMs: at, sizeBytes: piece.sizeBytes };
    });
  });

describe('choosing the segments of a window', () => {
  it('takes every overlapping segment in order, starting no later than the window when the buffer reaches back that far', () => {
    fc.assert(
      fc.property(
        bufferArb,
        fc.integer({ min: -10_000, max: 400_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        (buffer, fromOffset, length) => {
          const span = { fromMs: T0 + fromOffset, toMs: T0 + fromOffset + length };
          const chosen = segmentsForWindow(buffer, span);
          // Every chosen segment overlaps; every overlapping one is chosen.
          const overlapping = buffer.filter(
            (segment) => segment.endMs > span.fromMs && segment.startMs < span.toMs,
          );
          expect(chosen.map((segment) => segment.name)).toEqual(
            overlapping.map((segment) => segment.name),
          );
          // In arrival order.
          for (let index = 1; index < chosen.length; index += 1) {
            expect(chosen[index]?.startMs).toBeGreaterThanOrEqual(chosen[index - 1]?.endMs ?? 0);
          }
          // Never later than the window: a segment holding its start is the first one.
          const holder = buffer.find(
            (segment) => segment.startMs <= span.fromMs && segment.endMs > span.fromMs,
          );
          if (holder !== undefined) {
            expect(chosen[0]?.name).toBe(holder.name);
            expect(windowCoverage(chosen, span).startCovered).toBe(true);
          }
        },
      ),
    );
  });

  it('counts what is missing of the window: nothing when contiguous footage covers it', () => {
    fc.assert(
      fc.property(bufferArb, (buffer) => {
        const contiguous = buffer.every(
          (segment, index) => index === 0 || segment.startMs === buffer[index - 1]?.endMs,
        );
        const first = buffer[0];
        const last = buffer.at(-1);
        if (first === undefined || last === undefined) return;
        const span = { fromMs: first.startMs, toMs: last.endMs };
        const coverage = windowCoverage(segmentsForWindow(buffer, span), span);
        expect(coverage.startCovered && coverage.endCovered).toBe(true);
        if (contiguous) expect(coverage.gapMs).toBe(0);
        else expect(coverage.gapMs).toBeGreaterThan(0);
      }),
    );
    expect(windowCoverage([], { fromMs: 0, toMs: 5000 })).toEqual({
      startCovered: false,
      endCovered: false,
      gapMs: 5000,
    });
  });

  it('takes a second after the finish as well', () => {
    expect(cutSpan({ fromMs: 1000, toMs: 5000 })).toEqual({
      fromMs: 1000,
      toMs: 5000 + PACKING_CAMERA_TAIL_MS,
    });
  });

  it('cuts once the footage reaches the end, waits for it a while, then cuts what it has', () => {
    const span = { fromMs: T0, toMs: T0 + 10_000 };
    const early: CameraSegment = { name: 'a', startMs: T0 - 500, endMs: T0 + 6_000, sizeBytes: 1 };
    const late: CameraSegment = {
      name: 'b',
      startMs: T0 + 6_000,
      endMs: T0 + 11_000,
      sizeBytes: 1,
    };
    expect(cutDecision({ chosen: [early, late], span, nowMs: T0, sinceMs: T0 })).toBe('cut');
    expect(cutDecision({ chosen: [early], span, nowMs: T0 + 1_000, sinceMs: T0 })).toBe('wait');
    expect(
      cutDecision({ chosen: [early], span, nowMs: T0 + PACKING_CAMERA_CUT_WAIT_MS, sinceMs: T0 }),
    ).toBe('cut');
    expect(
      cutDecision({ chosen: [], span, nowMs: T0 + PACKING_CAMERA_CUT_WAIT_MS, sinceMs: T0 }),
    ).toBe('none');
  });

  it('splits a long cut into parts under the ceiling, keeping every segment once and in order', () => {
    fc.assert(
      fc.property(bufferArb, fc.integer({ min: 1, max: 20_000_000 }), (buffer, maxBytes) => {
        const parts = cameraParts(buffer, maxBytes);
        expect(parts.flat().map((segment) => segment.name)).toEqual(
          buffer.map((segment) => segment.name),
        );
        for (const part of parts) {
          expect(part.length).toBeGreaterThan(0);
          const size = part.reduce((sum, segment) => sum + segment.sizeBytes, 0);
          if (part.length > 1) expect(size).toBeLessThanOrEqual(maxBytes);
        }
      }),
    );
  });
});

describe('the camera’s rolling buffer', () => {
  it('never forgets the segment a waiting window starts in, nor the last minute', () => {
    fc.assert(
      fc.property(
        bufferArb,
        fc.array(fc.integer({ min: 0, max: 400_000 }), { maxLength: 5 }),
        fc.integer({ min: 0, max: 3 * PACKING_CAMERA_HORIZON_MS }),
        (buffer, pendingOffsets, nowOffset) => {
          const nowMs = T0 + nowOffset;
          const pendingFromMs = pendingOffsets.map((offset) => T0 + offset);
          const keepFrom = cameraBufferKeepFromMs({ nowMs, pendingFromMs });
          const forgotten = new Set(
            segmentsToForget(buffer, keepFrom).map((segment) => segment.name),
          );
          for (const from of pendingFromMs) {
            if (from < nowMs - PACKING_CAMERA_HORIZON_MS) continue;
            const holder = buffer.find(
              (segment) => segment.startMs <= from && segment.endMs > from,
            );
            if (holder !== undefined) expect(forgotten.has(holder.name)).toBe(false);
          }
          for (const segment of buffer) {
            if (segment.endMs >= nowMs - PACKING_CAMERA_LIVE_MS) {
              expect(forgotten.has(segment.name)).toBe(false);
            }
          }
          // Never more than half an hour back.
          expect(keepFrom).toBeGreaterThanOrEqual(nowMs - PACKING_CAMERA_HORIZON_MS);
          expect(keepFrom).toBeLessThanOrEqual(nowMs - PACKING_CAMERA_LIVE_MS);
        },
      ),
    );
  });

  it('lets an abandoned window’s footage go after half an hour', () => {
    const nowMs = T0 + 2 * PACKING_CAMERA_HORIZON_MS;
    expect(cameraBufferKeepFromMs({ nowMs, pendingFromMs: [T0] })).toBe(
      nowMs - PACKING_CAMERA_LIVE_MS,
    );
  });
});

describe('the camera’s state and reconnection', () => {
  it('is ready only with fresh footage, offline otherwise, off when switched off', () => {
    const now = new Date(T0);
    const fresh = new Date(T0 - PACKING_CAMERA_READY_WITHIN_MS);
    const stale = new Date(T0 - PACKING_CAMERA_READY_WITHIN_MS - 1);
    expect(cameraState({ enabled: true, lastSegmentAt: fresh, now })).toBe('ready');
    expect(cameraState({ enabled: true, lastSegmentAt: stale, now })).toBe('offline');
    expect(cameraState({ enabled: true, lastSegmentAt: null, now })).toBe('offline');
    expect(cameraState({ enabled: false, lastSegmentAt: fresh, now })).toBe('off');
  });

  it('backs off between attempts, never longer than a minute', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (failures) => {
        const delay = cameraReconnectDelayMs(failures);
        expect(delay).toBeGreaterThanOrEqual(1_000);
        expect(delay).toBeLessThanOrEqual(60_000);
        expect(cameraReconnectDelayMs(failures + 1)).toBeGreaterThanOrEqual(delay);
      }),
    );
  });
});
