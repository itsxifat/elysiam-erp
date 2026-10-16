/**
 * The print queue (M46, D-813 to D-819): which terminal prints an order, a job's states, when
 * a printer counts as online, and what the log says about an order's prints. Pure: the server
 * judges by these and the console shows with them.
 */

export const PRINT_JOB_STATES = ['queued', 'sending', 'printed', 'failed', 'cancelled'] as const;
export type PrintJobState = (typeof PRINT_JOB_STATES)[number];

/** A network print is tried three times: now, after 15 seconds, after a further 30 (D-813). */
export const PRINT_MAX_ATTEMPTS = 3;

/** A job left `sending` this long ago belongs to a worker that died; it may be sent again. */
export const PRINT_SENDING_STALE_MS = 2 * 60_000;

/** A network printer's last probe counts this long (the probe runs every minute, D-815). */
export const PRINTER_STATUS_FRESH_MS = 3 * 60_000;

/** A browser print station or a bound computer is "here" this long after its last check-in. */
export const STATION_SEEN_MS = 90_000;

export type PrintJobEvent = 'send' | 'printed' | 'failed' | 'retry' | 'cancel' | 'requeue';

/**
 * A job's next state, or null when the event does not apply (D-813): queued → sending →
 * printed or failed; a failed attempt with tries left goes back to queued (`requeue`); a
 * failed or queued job can be cancelled; a failed one retried by hand.
 */
export function printJobAfter(state: PrintJobState, event: PrintJobEvent): PrintJobState | null {
  switch (event) {
    case 'send':
      return state === 'queued' || state === 'sending' ? 'sending' : null;
    case 'printed':
      return state === 'sending' || state === 'queued' ? 'printed' : null;
    case 'failed':
      return state === 'sending' || state === 'queued' ? 'failed' : null;
    case 'requeue':
      return state === 'sending' ? 'queued' : null;
    case 'retry':
      return state === 'failed' ? 'queued' : null;
    case 'cancel':
      return state === 'queued' || state === 'failed' ? 'cancelled' : null;
  }
}

/** Whether a job can still print: what the queue shows. */
export function isOpenPrintJob(state: PrintJobState): boolean {
  return state === 'queued' || state === 'sending';
}

export interface TerminalCandidate {
  readonly id: string;
  readonly name: string;
  /** A printer for the document is online there. */
  readonly online: boolean;
  /** Jobs queued or sending on it now. */
  readonly queued: number;
}

/**
 * The label terminal that prints an order (D-817): of the ones serving its location with a
 * printer for the document, an online one with the shortest queue; with none online, the
 * shortest queue all the same (the job waits for the printer). Ties go by name, then id, so
 * two jobs judged together land on the same terminal.
 */
export function pickTerminal(candidates: readonly TerminalCandidate[]): TerminalCandidate | null {
  const online = candidates.filter((candidate) => candidate.online);
  const pool = online.length > 0 ? online : candidates;
  let best: TerminalCandidate | null = null;
  for (const candidate of pool) {
    if (
      best === null ||
      candidate.queued < best.queued ||
      (candidate.queued === best.queued &&
        (candidate.name < best.name || (candidate.name === best.name && candidate.id < best.id)))
    ) {
      best = candidate;
    }
  }
  return best;
}

/** The brand's auto-print rule (D-817, ASSUMED): its own switch, or on once a printer exists. */
export function autoPrintOn(setting: boolean | null, printers: number): boolean {
  return setting ?? printers > 0;
}

export type PrinterState = 'online' | 'offline' | 'error' | 'unknown';

/** Whether a printer can take a job now, from its last probe or its station's check-in. */
export function printerOnline(input: {
  readonly connection: 'ipp' | 'ipps' | 'raw' | 'browser';
  readonly enabled: boolean;
  readonly status: PrinterState;
  readonly statusAt: Date | null;
  readonly stationSeenAt: Date | null;
  readonly now: Date;
}): boolean {
  if (!input.enabled) return false;
  if (input.connection === 'browser') {
    return (
      input.stationSeenAt !== null &&
      input.now.getTime() - input.stationSeenAt.getTime() <= STATION_SEEN_MS
    );
  }
  return (
    input.status === 'online' &&
    input.statusAt !== null &&
    input.now.getTime() - input.statusAt.getTime() <= PRINTER_STATUS_FRESH_MS
  );
}

/** A printer's state as the screens show it: a browser station is online while it checks in. */
export function printerShownState(input: {
  readonly connection: 'ipp' | 'ipps' | 'raw' | 'browser';
  readonly enabled: boolean;
  readonly status: PrinterState;
  readonly statusAt: Date | null;
  readonly stationSeenAt: Date | null;
  readonly now: Date;
}): PrinterState | 'off' {
  if (!input.enabled) return 'off';
  if (printerOnline(input)) return 'online';
  if (input.connection === 'browser') return input.stationSeenAt === null ? 'unknown' : 'offline';
  if (input.statusAt === null) return 'unknown';
  if (input.now.getTime() - input.statusAt.getTime() > PRINTER_STATUS_FRESH_MS) return 'unknown';
  return input.status === 'online' ? 'unknown' : input.status;
}

export interface PrintRecord {
  readonly state: PrintJobState;
  readonly at: Date;
  /** Who asked, or null for the automatic rule. */
  readonly byName: string | null;
  readonly auto: boolean;
  readonly terminalName: string | null;
}

/**
 * "Printed 3 times, last 17 Oct 14:02 by Rahim at Label 1" (D-818): the printed jobs only,
 * newest last.
 */
export function printSummary(records: readonly PrintRecord[]): {
  readonly count: number;
  readonly last: PrintRecord | null;
} {
  let count = 0;
  let last: PrintRecord | null = null;
  for (const record of records) {
    if (record.state !== 'printed') continue;
    count += 1;
    if (last === null || record.at.getTime() >= last.at.getTime()) last = record;
  }
  return { count, last };
}

/** Whether printing this document for this lot again is a reprint, which needs a reason. */
export function isReprint(printedBefore: number): boolean {
  return printedBefore > 0;
}

/**
 * Orders packed per hour today at a terminal (D-823): completed packings since Dhaka midnight
 * over the hours since then, at least one hour, to one decimal.
 */
export function ordersPerHour(input: {
  readonly completed: number;
  readonly since: Date;
  readonly now: Date;
}): number {
  const hours = Math.max(1, (input.now.getTime() - input.since.getTime()) / 3_600_000);
  return Math.round((input.completed / hours) * 10) / 10;
}
