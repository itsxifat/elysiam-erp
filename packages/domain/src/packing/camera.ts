/**
 * The packing station's IP camera (M38c, D-668 to D-676): when a camera recording starts and
 * ends, which buffered pieces of the camera's stream make it, and what the buffer may forget.
 *
 * The owner's rule (2026-10-08): scanning the order slip makes the camera ready; the first
 * piece scanned **that belongs to the order** starts the recording, two seconds before that
 * scan. A wrong size, a wrong product, a code that is no product or one piece too many never
 * starts it. Finishing the order ends it; a recording never runs past fifteen minutes (D-611).
 *
 * The camera's stream is kept on the server as a rolling buffer of short segments, each named
 * with the wall-clock span it arrived in. A recording is cut from the segments that overlap
 * its window, without re-encoding, so it starts at the segment boundary (a keyframe) at or
 * before the window's start: never later.
 *
 * Pure (invariant 11): the server's station, its cut job and the recorder process ask these
 * functions, and the property tests hold the rules.
 */

import type { PackScanOutcome } from './scan.js';

/** How long before the first accepted scan the recording starts: two seconds. */
export const PACKING_CAMERA_PREROLL_MS = 2_000;

/** The longest a camera recording runs (D-611's fifteen minutes). */
export const PACKING_CAMERA_MAX_MS = 15 * 60_000;

/**
 * How long after the window's end the cut also takes: the camera's picture reaches the server
 * a moment after it was taken, so the last second of the packing is in the next segment.
 */
export const PACKING_CAMERA_TAIL_MS = 1_000;

/** The stream the recorder always keeps, whatever is waiting to be cut: a minute. */
export const PACKING_CAMERA_LIVE_MS = 60_000;

/**
 * The oldest footage the recorder keeps for a window still waiting to be cut: half an hour.
 * A window is at most fifteen minutes and is cut within seconds of its end (or of the
 * fifteen minutes running out), so this is room for a restart, not a store. Footage older
 * than this is gone, and so the disk under the buffer never fills.
 */
export const PACKING_CAMERA_HORIZON_MS = 30 * 60_000;

/** A camera that delivered footage this recently is ready. */
export const PACKING_CAMERA_READY_WITHIN_MS = 15_000;

/** How long a cut waits for the footage to reach the window's end before it cuts what it has. */
export const PACKING_CAMERA_CUT_WAIT_MS = 12_000;

/**
 * Where the recording of a session starts, if this scan starts it: the first scan the station
 * accepts (the piece belongs to the order) on a session whose camera is chosen, two seconds
 * before it. Null when nothing changes: a refused scan, a removal, no camera, or a recording
 * that already started.
 */
export function cameraRecordingFrom(input: {
  readonly cameraId: string | null;
  readonly recordingFrom: Date | null;
  readonly outcome: PackScanOutcome;
  readonly scannedAt: Date;
}): Date | null {
  if (input.cameraId === null || input.recordingFrom !== null) return null;
  if (input.outcome !== 'accepted') return null;
  return new Date(input.scannedAt.getTime() - PACKING_CAMERA_PREROLL_MS);
}

/**
 * Where a started recording ends when its order is finished: the finish, but never more than
 * fifteen minutes after it started (and never before it). Null when there is nothing to end:
 * no recording started, or its end is already set (the fifteen minutes ran out first).
 */
export function cameraRecordingTo(input: {
  readonly recordingFrom: Date | null;
  readonly recordingTo: Date | null;
  readonly endedAt: Date;
}): Date | null {
  if (input.recordingFrom === null || input.recordingTo !== null) return null;
  const from = input.recordingFrom.getTime();
  const capped = Math.min(input.endedAt.getTime(), from + PACKING_CAMERA_MAX_MS);
  return new Date(Math.max(from, capped));
}

/**
 * Where an open session's recording ends because its fifteen minutes ran out (an order left
 * open at the station): `from + 15 min` once that moment has passed, else null.
 */
export function cameraRecordingTimedOut(input: {
  readonly recordingFrom: Date | null;
  readonly recordingTo: Date | null;
  readonly now: Date;
}): Date | null {
  if (input.recordingFrom === null || input.recordingTo !== null) return null;
  const limit = input.recordingFrom.getTime() + PACKING_CAMERA_MAX_MS;
  return input.now.getTime() >= limit ? new Date(limit) : null;
}

/** One buffered piece of a camera's stream: the wall-clock span it arrived in, and its size. */
export interface CameraSegment {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly sizeBytes: number;
}

/** The span a cut takes: the recording's window and the tail after it. */
export function cutSpan(window: { readonly fromMs: number; readonly toMs: number }): {
  readonly fromMs: number;
  readonly toMs: number;
} {
  return { fromMs: window.fromMs, toMs: window.toMs + PACKING_CAMERA_TAIL_MS };
}

/**
 * The segments a recording is cut from: every buffered segment that overlaps the span, in
 * the order they arrived. The first one is the segment the span's start falls in, so the cut
 * starts at or before it.
 */
export function segmentsForWindow(
  segments: readonly CameraSegment[],
  span: { readonly fromMs: number; readonly toMs: number },
): CameraSegment[] {
  return segments
    .filter((segment) => segment.endMs > span.fromMs && segment.startMs < span.toMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Whether the chosen segments reach the span's start and end, and how much is missing between. */
export function windowCoverage(
  chosen: readonly CameraSegment[],
  span: { readonly fromMs: number; readonly toMs: number },
): { readonly startCovered: boolean; readonly endCovered: boolean; readonly gapMs: number } {
  const first = chosen[0];
  const last = chosen.at(-1);
  if (first === undefined || last === undefined) {
    return { startCovered: false, endCovered: false, gapMs: span.toMs - span.fromMs };
  }
  let gapMs = Math.max(0, first.startMs - span.fromMs) + Math.max(0, span.toMs - last.endMs);
  let reached = first.endMs;
  for (const segment of chosen.slice(1)) {
    if (segment.startMs > reached) gapMs += segment.startMs - reached;
    reached = Math.max(reached, segment.endMs);
  }
  return { startCovered: first.startMs <= span.fromMs, endCovered: last.endMs >= span.toMs, gapMs };
}

/**
 * What a cut does now: `cut` once the buffer reaches the span's end, `wait` while it may still
 * arrive, and `cut` anyway once the wait is over (a camera that dropped mid-packing still gives
 * what it filmed). `none` when the buffer holds nothing of the span at all.
 */
export function cutDecision(input: {
  readonly chosen: readonly CameraSegment[];
  readonly span: { readonly fromMs: number; readonly toMs: number };
  readonly nowMs: number;
  /** When the cut began waiting. */
  readonly sinceMs: number;
}): 'cut' | 'wait' | 'none' {
  const coverage = windowCoverage(input.chosen, input.span);
  if (coverage.endCovered) return 'cut';
  const waited = input.nowMs - input.sinceMs >= PACKING_CAMERA_CUT_WAIT_MS;
  if (!waited) return 'wait';
  return input.chosen.length === 0 ? 'none' : 'cut';
}

/**
 * The cut in parts no larger than `maxBytes` each (the files module's ceiling for a packing
 * video), segments kept whole and in order. A single segment larger than the ceiling is a
 * part of its own (the files module then refuses it).
 */
export function cameraParts(chosen: readonly CameraSegment[], maxBytes: number): CameraSegment[][] {
  const parts: CameraSegment[][] = [];
  let current: CameraSegment[] = [];
  let size = 0;
  for (const segment of chosen) {
    if (current.length > 0 && size + segment.sizeBytes > maxBytes) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(segment);
    size += segment.sizeBytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * The earliest moment the camera's buffer must still hold: the last minute always, and every
 * window waiting to be cut back to its start, but never more than half an hour back. A segment
 * that ended before this moment may go; the segment a waiting window starts in ends after its
 * start, so it stays.
 */
export function cameraBufferKeepFromMs(input: {
  readonly nowMs: number;
  /** The starts of the windows of this camera still waiting to be cut. */
  readonly pendingFromMs: readonly number[];
}): number {
  const horizon = input.nowMs - PACKING_CAMERA_HORIZON_MS;
  let keepFrom = input.nowMs - PACKING_CAMERA_LIVE_MS;
  for (const from of input.pendingFromMs) {
    if (from >= horizon && from < keepFrom) keepFrom = from;
  }
  return Math.max(horizon, keepFrom);
}

/** The segments the buffer may forget: those that ended before `keepFromMs`. */
export function segmentsToForget(
  segments: readonly CameraSegment[],
  keepFromMs: number,
): CameraSegment[] {
  return segments.filter((segment) => segment.endMs < keepFromMs);
}

export type CameraState = 'off' | 'ready' | 'offline';

/** How a camera reads at the station and in the settings: off, ready, or offline. */
export function cameraState(input: {
  readonly enabled: boolean;
  readonly lastSegmentAt: Date | null;
  readonly now: Date;
}): CameraState {
  if (!input.enabled) return 'off';
  if (input.lastSegmentAt === null) return 'offline';
  return input.now.getTime() - input.lastSegmentAt.getTime() <= PACKING_CAMERA_READY_WITHIN_MS
    ? 'ready'
    : 'offline';
}

/** How long the recorder waits before connecting again after its `failures`-th failure. */
export function cameraReconnectDelayMs(failures: number): number {
  const steps = [1_000, 2_000, 5_000, 10_000, 30_000];
  return steps[Math.max(0, failures - 1)] ?? 60_000;
}
