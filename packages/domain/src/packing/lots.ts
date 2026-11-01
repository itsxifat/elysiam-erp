/**
 * Lots (M46, D-805 to D-808): one order packed in several bags. A gift order of four boxes is
 * one order with one consignment and four lots, each with its own slip and label ("Lot 2 of
 * 4") and its own barcode. An order starts as one lot; above the brand's limit the person who
 * confirms it says how many (M52, D-941); the label printer or the packer may change it after.
 *
 * The rules, pure, for the server to judge by and the console to show with:
 *
 * - **The count** is 1 to 20 and never more than the order's pieces can fill, set while the order
 *   is confirmed and fixed once it is packed (D-944). While it is being packed it never drops below
 *   the lots already closed.
 * - **Packing** fills lot 1, then lot 2, …: each scan goes into the open lot. A lot closes
 *   with at least one piece in it and only if enough pieces are left for the lots after it to
 *   have one each. The last lot closes with Finish, which M38b's rule still decides (every piece
 *   of the order in, nothing extra). So the order is packed only when every lot is closed.
 * - **The handover** scans every lot's label; the order goes to the courier only when each of
 *   its lots has been scanned once.
 */

/** The most bags one order goes in. */
export const LOT_COUNT_MAX = 20;

/** The orders a lot count may be set on: confirmed, not yet packed (M52, D-944). */
const LOT_OPEN_STATUSES: readonly string[] = ['confirmed'];

/**
 * A lot's barcode value (D-806): the order number and the lot, `ELY-2610-00042-L2`. An order
 * number never ends in `-L<digits>` (its last part is the five-digit sequence), so the code
 * reads back to exactly one order and one lot.
 */
export function lotCode(orderNo: string, lot: number): string {
  if (!Number.isInteger(lot) || lot < 1 || lot > LOT_COUNT_MAX) {
    throw new RangeError(`A lot is 1 to ${String(LOT_COUNT_MAX)}.`);
  }
  return `${orderNo}-L${String(lot)}`;
}

const LOT_SUFFIX = /^(.+)-L([1-9]\d?)$/i;

/** The order code and lot a scanned lot code names, or null for any other code. */
export function parseLotCode(
  code: string,
): { readonly orderCode: string; readonly lot: number } | null {
  const match = LOT_SUFFIX.exec(code.trim());
  if (match === null) return null;
  const lot = Number(match[2]);
  const orderCode = match[1] ?? '';
  if (lot > LOT_COUNT_MAX || orderCode === '') return null;
  return { orderCode, lot };
}

export type LotCountRefusal = 'out_of_range' | 'not_open' | 'below_closed' | 'more_than_pieces';

/**
 * The most lots an order of so many pieces can go in: every lot holds a piece (D-807), so a count
 * above this could never be packed. A closed bag keeps what is in it, so only the pieces left can
 * fill the lots after it (M52, D-943).
 */
export function lotCountLimit(
  pieces: number,
  closed: { readonly lots: number; readonly pieces: number } = { lots: 0, pieces: 0 },
): number {
  return Math.max(1, Math.min(LOT_COUNT_MAX, closed.lots + pieces - closed.pieces));
}

export type ConfirmLotsVerdict = 'one_lot' | 'ask' | 'answered' | 'out_of_range';

/**
 * A person confirming an order (M52, D-941). With no answer the order is one lot, unless it has
 * more pieces than the brand's limit, when the person is asked; no limit asks nobody. An answer
 * is taken at any size, as long as it could be packed.
 */
export function judgeConfirmLots(input: {
  readonly pieces: number;
  /** The brand's limit; null asks nobody. */
  readonly askAbovePieces: number | null;
  /** What the person answered, if they were asked. */
  readonly lots: number | undefined;
}): ConfirmLotsVerdict {
  if (input.lots === undefined) {
    return input.askAbovePieces !== null && input.pieces > input.askAbovePieces ? 'ask' : 'one_lot';
  }
  if (!Number.isInteger(input.lots) || input.lots < 1 || input.lots > lotCountLimit(input.pieces)) {
    return 'out_of_range';
  }
  return 'answered';
}

/**
 * Whether an order's lot count may become `count` now. While it is being packed the count must
 * leave a lot open after the closed ones (a scan always has a bag to go in). Once it is packed it
 * is fixed: nothing checks the labels again after Pack, so a later change would send an order with
 * labels for the wrong count, or with bags left at the hub (M52, D-944). It is never more than the
 * order's pieces can fill, whoever says so (M52, D-943).
 */
export function judgeLotCount(input: {
  readonly count: number;
  readonly orderStatus: string;
  /** Lots closed at the packing station. */
  readonly closedLots: number;
  /** The order's pieces. */
  readonly pieces: number;
  /** The pieces sealed in those closed lots. */
  readonly piecesInClosedLots: number;
}): LotCountRefusal | 'ok' {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > LOT_COUNT_MAX) {
    return 'out_of_range';
  }
  if (!LOT_OPEN_STATUSES.includes(input.orderStatus)) return 'not_open';
  if (input.closedLots > 0 && input.count <= input.closedLots) return 'below_closed';
  const closed = { lots: input.closedLots, pieces: input.piecesInClosedLots };
  if (input.count > lotCountLimit(input.pieces, closed)) return 'more_than_pieces';
  return 'ok';
}

/** The lot being filled at the station: the one after the closed ones, or null when all are. */
export function openLot(lotCount: number, closedLots: number): number | null {
  return closedLots >= lotCount ? null : closedLots + 1;
}

export type LotCloseRefusal = 'all_closed' | 'last_lot' | 'empty' | 'too_few_left';

/**
 * Whether the open lot may be closed (so the packer starts the next bag). The last lot is not
 * closed this way: Finish closes it, under M38b's whole-order rule.
 */
export function judgeLotClose(input: {
  readonly lotCount: number;
  readonly closedLots: number;
  /** Pieces in the open lot now (accepted less taken out). */
  readonly piecesInLot: number;
  readonly unitsRequired: number;
  /** Pieces in the box across every lot. */
  readonly unitsPacked: number;
}): LotCloseRefusal | 'ok' {
  if (input.closedLots >= input.lotCount) return 'all_closed';
  if (input.closedLots === input.lotCount - 1) return 'last_lot';
  if (input.piecesInLot < 1) return 'empty';
  // Every lot still to fill needs a piece of its own.
  const lotsAfter = input.lotCount - input.closedLots - 1;
  if (input.unitsRequired - input.unitsPacked < lotsAfter) return 'too_few_left';
  return 'ok';
}

export type LotFinishRefusal = 'lots_open' | 'empty';

/**
 * Whether Finish may close the last lot (D-807). One lot is M38b's order and has no rule of
 * its own; with several, every lot but the last must be closed and the last must hold a piece.
 */
export function judgeLotFinish(input: {
  readonly lotCount: number;
  readonly closedLots: number;
  readonly piecesInLot: number;
}): LotFinishRefusal | 'ok' {
  if (input.lotCount <= 1) return 'ok';
  if (input.closedLots < input.lotCount - 1) return 'lots_open';
  if (input.piecesInLot < 1) return 'empty';
  return 'ok';
}

/** Pieces per lot from the station's scans (accepted adds one, removed takes one away). */
export function piecesByLot(
  scans: readonly { readonly lot: number; readonly outcome: string }[],
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const scan of scans) {
    if (scan.outcome === 'accepted') counts.set(scan.lot, (counts.get(scan.lot) ?? 0) + 1);
    if (scan.outcome === 'removed') counts.set(scan.lot, (counts.get(scan.lot) ?? 0) - 1);
  }
  return counts;
}

export type HandoverScanOutcome = 'accepted' | 'already' | 'no_such_lot';

/** One label scanned at the handover. */
export function judgeHandoverScan(input: {
  readonly lotCount: number;
  readonly scanned: ReadonlySet<number>;
  readonly lot: number;
}): HandoverScanOutcome {
  if (!Number.isInteger(input.lot) || input.lot < 1 || input.lot > input.lotCount) {
    return 'no_such_lot';
  }
  return input.scanned.has(input.lot) ? 'already' : 'accepted';
}

/** The lots not scanned yet, in order. Empty means the order may go. */
export function handoverMissing(input: {
  readonly lotCount: number;
  readonly scanned: ReadonlySet<number>;
}): number[] {
  const missing: number[] = [];
  for (let lot = 1; lot <= input.lotCount; lot += 1) {
    if (!input.scanned.has(lot)) missing.push(lot);
  }
  return missing;
}

export function handoverComplete(input: {
  readonly lotCount: number;
  readonly scanned: ReadonlySet<number>;
}): boolean {
  return handoverMissing(input).length === 0;
}
