import { addDays, businessDate, type IsoDate } from '../dates/index.js';
import { PACKING_CAMERA_MAX_MS, PACKING_CAMERA_PREROLL_MS } from './camera.js';
import { openLot } from './lots.js';
import { orderScanCode, readLotCode } from './scan-code.js';

/**
 * Label to label (M51, D-930 to D-936): when a lot's video records, pauses and stops, at the
 * packing station and at the return station.
 *
 * The owner's rule (2026-11-01): scanning the parcel's label starts the recording; every piece
 * is scanned; scanning the label again stops it. Ten seconds with no scan pauses the video and
 * the next scan resumes it. An order packed in several lots has one video per lot, all kept
 * under the one order.
 *
 * A recording is therefore a set of **stretches**: from each event at the table (the label, a
 * piece, a refused piece, a piece taken out) until the next one or until the idle time runs
 * out, whichever is first. The browser's recorder pauses and resumes on those edges; an IP
 * camera's video is cut from its buffer along them, each stretch reaching two seconds back
 * (the buffer holds them; a browser's recorder cannot go back, so its lead is nothing).
 *
 * Pure (invariant 11): the station, the camera's cut and the console ask these functions.
 */

/** The pause rule's default: ten seconds with no scan (the owner's number). */
export const PACKING_IDLE_PAUSE_DEFAULT_MS = 10_000;
/** The shortest and longest a brand may set it. */
export const PACKING_IDLE_PAUSE_MIN_MS = 3_000;
export const PACKING_IDLE_PAUSE_MAX_MS = 60_000;

/** How far an IP camera's stretch reaches back before its event (M38c's two seconds). */
export const PACKING_RESUME_LEAD_MS = PACKING_CAMERA_PREROLL_MS;

/**
 * A label read again this soon is the scanner's own repeat, not a person's second scan: it starts
 * or stops nothing. A person cannot put a label down and pick it up in under two seconds.
 */
export const PACKING_LABEL_REREAD_MS = 2_000;

/** How long a return's video is kept after the return was received (D-935, ASSUMED). */
export const PACKING_RETURN_VIDEO_KEEP_DAYS = 30;

export interface RecordingSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * The stretches a recording holds. Each event opens one from `leadMs` before it to the next
 * event or `idleMs` after it, whichever is first; the stop is an event of its own (the closing
 * scan is on the video) and nothing runs past it. Overlapping stretches are one. A recording
 * that has not stopped runs to `nowMs`.
 */
export function recordingSpans(input: {
  readonly startedMs: number;
  /** Every event at the table during the recording; the label scan that started it may be among them. */
  readonly activityMs: readonly number[];
  readonly stoppedMs: number | null;
  readonly nowMs: number;
  readonly idleMs: number;
  readonly leadMs: number;
}): RecordingSpan[] {
  const end = Math.max(input.startedMs, input.stoppedMs ?? input.nowMs);
  const events = [input.startedMs, ...input.activityMs, ...(input.stoppedMs === null ? [] : [end])]
    .filter((at) => Number.isFinite(at) && at >= input.startedMs && at <= end)
    .sort((a, b) => a - b);
  const lead = Math.max(0, input.leadMs);
  const idle = Math.max(0, input.idleMs);
  const spans: { fromMs: number; toMs: number }[] = [];
  for (const [index, at] of events.entries()) {
    const next = events[index + 1];
    const toMs = Math.min(at + idle, next ?? end, end);
    const fromMs = at - lead;
    const last = spans.at(-1);
    if (last !== undefined && fromMs <= last.toMs) {
      last.toMs = Math.max(last.toMs, toMs);
    } else {
      spans.push({ fromMs, toMs });
    }
  }
  return spans;
}

/** How long a recording's stretches run altogether. */
export function recordedMs(spans: readonly RecordingSpan[]): number {
  return spans.reduce((sum, span) => sum + Math.max(0, span.toMs - span.fromMs), 0);
}

/** Whether a running recording is paused now: its idle time has run out since the last event. */
export function recordingPaused(input: {
  readonly lastActivityMs: number;
  readonly nowMs: number;
  readonly idleMs: number;
}): boolean {
  return input.nowMs - input.lastActivityMs >= input.idleMs;
}

/** How long a running recording has left before it pauses (0 once paused). */
export function pauseInMs(input: {
  readonly lastActivityMs: number;
  readonly nowMs: number;
  readonly idleMs: number;
}): number {
  return Math.max(0, input.lastActivityMs + input.idleMs - input.nowMs);
}

/**
 * Where a recording stops when it is stopped at `atMs`: then, but never more than fifteen
 * minutes after it started (D-611) and never before it.
 */
export function recordingStopAt(startedMs: number, atMs: number): number {
  return Math.max(startedMs, Math.min(atMs, startedMs + PACKING_CAMERA_MAX_MS));
}

/** A running recording past its fifteen minutes: where it stops, or null while it may run. */
export function recordingTimedOut(input: {
  readonly startedMs: number;
  readonly nowMs: number;
}): number | null {
  const limit = input.startedMs + PACKING_CAMERA_MAX_MS;
  return input.nowMs >= limit ? limit : null;
}

/**
 * Which lot a scanned code names as this order's label, or null when it is no label of this
 * order: the order number or its ten digits, the courier's tracking code or consignment (the
 * whole order: `lot` null), or a lot's code in letters or twelve digits (that lot).
 */
export function readOrderLabel(
  code: string,
  order: {
    readonly orderNumber: string;
    readonly trackingCode: string | null;
    readonly consignmentId: string | null;
  },
): { readonly lot: number | null } | null {
  const typed = normalised(code);
  if (typed === '') return null;
  const own = [order.orderNumber, orderScanCode(order.orderNumber) ?? '']
    .map(normalised)
    .filter((value) => value !== '');
  const courier = [order.trackingCode ?? '', order.consignmentId ?? '']
    .map(normalised)
    .filter((value) => value !== '');
  if (own.includes(typed) || courier.includes(typed)) return { lot: null };
  const lotted = readLotCode(typed);
  if (lotted !== null && own.includes(normalised(lotted.orderCode))) return { lot: lotted.lot };
  return null;
}

function normalised(value: string): string {
  return value.trim().toUpperCase();
}

/** Whether this label is the scanner repeating the session's last label scan (D-934). */
export function isLabelReread(input: {
  readonly code: string;
  readonly last: { readonly code: string; readonly atMs: number } | null;
  readonly nowMs: number;
}): boolean {
  if (input.last?.code !== input.code) return false;
  return input.nowMs - input.last.atMs < PACKING_LABEL_REREAD_MS;
}

export type LabelRefusal = 'no_such_lot' | 'lot_done' | 'other_lot' | 'all_done' | 'whole_order';

export type LabelVerdict =
  | { readonly kind: 'start'; readonly lot: number }
  | { readonly kind: 'stop'; readonly lot: number }
  | {
      readonly kind: 'refused';
      readonly reason: LabelRefusal;
      /** The lot the scan named (or would have). */
      readonly lot: number | null;
      /** The lot to scan instead, when there is one. */
      readonly expected: number | null;
    };

/**
 * A label scanned at the packing station (D-930). Lots are packed in order (D-807): the open
 * lot's own label starts it, or stops it once started. A closed lot's label, a later lot's or a lot
 * the order does not have is refused. A code of the whole order means the one lot of an order in
 * one lot; with several it names no bag (as at the handover, D-808), and it is what an old label
 * carries after the count was revised (M52, D-945), so it is refused too.
 */
export function judgePackLabelScan(input: {
  readonly lotCount: number;
  readonly closedLots: number;
  readonly scannedLot: number | null;
  /** Whether the open lot's label was already scanned (its recording started). */
  readonly openLotStarted: boolean;
}): LabelVerdict {
  const open = openLot(input.lotCount, input.closedLots);
  const named = input.scannedLot;
  if (named !== null && (named < 1 || named > input.lotCount)) {
    return { kind: 'refused', reason: 'no_such_lot', lot: named, expected: open };
  }
  if (open === null) {
    return { kind: 'refused', reason: 'all_done', lot: named, expected: null };
  }
  if (named === null && input.lotCount > 1) {
    return { kind: 'refused', reason: 'whole_order', lot: null, expected: open };
  }
  const lot = named ?? open;
  if (lot < open) return { kind: 'refused', reason: 'lot_done', lot, expected: open };
  if (lot > open) return { kind: 'refused', reason: 'other_lot', lot, expected: open };
  return input.openLotStarted ? { kind: 'stop', lot } : { kind: 'start', lot };
}

/**
 * A label scanned at the return station (D-934). A returned parcel's bags come back in any
 * order: one lot is opened at a time, its label again stops it, and a code of the whole order
 * means the lot being opened, else the first not yet opened. A done bag's own label reopens it
 * (a parcel has one receipt, so a bag stopped by mistake must not strand its pieces); a code of
 * the whole order reopens only a parcel of one bag, since with several it names none of them.
 */
export function judgeReturnLabelScan(input: {
  readonly lotCount: number;
  readonly scannedLot: number | null;
  /** The lot whose recording runs now, if any. */
  readonly recordingLot: number | null;
  /** Lots already opened and stopped. */
  readonly doneLots: ReadonlySet<number>;
}): LabelVerdict {
  const named = input.scannedLot;
  if (named !== null && (named < 1 || named > input.lotCount)) {
    return { kind: 'refused', reason: 'no_such_lot', lot: named, expected: input.recordingLot };
  }
  if (input.recordingLot !== null) {
    const lot = named ?? input.recordingLot;
    return lot === input.recordingLot
      ? { kind: 'stop', lot }
      : { kind: 'refused', reason: 'other_lot', lot, expected: input.recordingLot };
  }
  let firstOpen: number | null = null;
  for (let lot = 1; lot <= input.lotCount; lot += 1) {
    if (!input.doneLots.has(lot)) {
      firstOpen = lot;
      break;
    }
  }
  const lot = named ?? firstOpen ?? (input.lotCount === 1 ? 1 : null);
  if (lot === null) return { kind: 'refused', reason: 'all_done', lot: null, expected: null };
  return { kind: 'start', lot };
}

/**
 * When a return's video may go (D-935): thirty Asia/Dhaka days after the day the return was
 * received, so a claim against the courier has its evidence. Null while it is not received.
 */
export function returnVideoExpiry(receivedAt: Date | null): {
  readonly keepThrough: IsoDate;
  readonly deleteFrom: IsoDate;
} | null {
  if (receivedAt === null || Number.isNaN(receivedAt.getTime())) return null;
  const keepThrough = addDays(businessDate(receivedAt), PACKING_RETURN_VIDEO_KEEP_DAYS);
  return { keepThrough, deleteFrom: addDays(keepThrough, 1) };
}
