import { takaToPoisha, type SettlementFileRow } from '@elysium/domain/courier';
import { poisha } from '@elysium/domain';

import { CourierError } from '../courier.errors.js';

/**
 * Parsing a courier's settlement sheet (architecture §9 "Settlement import").
 *
 * **No Bangladeshi courier documents its statement format.** Steadfast's merchant portal
 * exports a spreadsheet whose columns have changed at least once; the others are worse.
 * So this is a column-mapped CSV parse rather than a format, and the mapping is
 * configuration: an operator who opens their sheet and sees `Consignment ID` where we
 * expected `consignment_id` fixes it by naming the column, not by waiting for a deploy.
 *
 * That is also why it is here and not in the adapter. The parse is identical for every
 * courier; only the column names differ, and pretending otherwise would give us three
 * near-identical parsers to keep in step.
 *
 * ## What it refuses, and why refusing is the point
 *
 * A settlement is the moment somebody else's arithmetic enters our books, so this parser
 * refuses rather than guesses, every time:
 *
 * - a missing required column, naming the ones it did find;
 * - a cell that is not taka with at most two decimals (`takaToPoisha`);
 * - a row with no consignment reference of any kind.
 *
 * The temptation is to skip a bad row and carry on, and it is the wrong instinct: a
 * skipped row is a parcel whose cash silently never arrives, and the totals still add
 * up because the row is not in them either. A refused file is a phone call to the
 * courier; a partially parsed one is a discrepancy discovered at year end.
 */

/** Which column holds what. Every value is matched case- and space-insensitively. */
export interface StatementColumns {
  readonly consignmentNo: readonly string[];
  readonly reference: readonly string[];
  readonly codCollected: readonly string[];
  readonly deliveryCharge: readonly string[];
  readonly returnCharge: readonly string[];
  readonly otherCharge: readonly string[];
  readonly net: readonly string[];
}

/**
 * The names seen on real exports, and the obvious variations.
 *
 * Several candidates per field rather than one, because the same sheet is exported from
 * the portal in English and from a partner's tool in another spelling, and an operator
 * should not have to configure the ordinary case.
 */
export const DEFAULT_STATEMENT_COLUMNS: StatementColumns = {
  consignmentNo: ['consignment_id', 'consignment id', 'consignment', 'cid', 'consignment_no'],
  reference: ['invoice', 'invoice_id', 'invoice id', 'reference', 'order_no', 'order no'],
  codCollected: ['cod_amount', 'cod amount', 'collected_amount', 'collected', 'cod'],
  deliveryCharge: ['delivery_charge', 'delivery charge', 'charge', 'courier_charge'],
  returnCharge: ['return_charge', 'return charge', 'rtn_charge'],
  otherCharge: ['other_charge', 'other charge', 'cod_fee', 'cod charge', 'service_charge'],
  net: ['net_amount', 'net amount', 'payable', 'payable_amount', 'net'],
};

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^"|"$/g, '');
}

/**
 * Split one CSV line, honouring quotes and doubled quotes.
 *
 * Hand-written rather than a dependency, because the whole of RFC 4180 that a courier's
 * export uses is quotes and commas — and a new dependency needs a justification that
 * "the file has commas in an address column" does not quite reach. Embedded newlines
 * inside quotes are the one thing this does not handle, and it refuses such a file
 * loudly (the quote count check) instead of mis-parsing it.
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (quoted) {
    throw new CourierError(
      'SETTLEMENT_FILE_INVALID',
      'A row of that statement has an unclosed quote; export it again as plain CSV.',
    );
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function findColumn(headers: readonly string[], candidates: readonly string[]): number | undefined {
  for (const candidate of candidates) {
    const index = headers.indexOf(normaliseHeader(candidate));
    if (index !== -1) return index;
  }
  return undefined;
}

export interface ParsedStatement {
  readonly rows: readonly SettlementFileRow[];
  /** The headers as they appeared, so a refusal can tell the operator what we saw. */
  readonly headers: readonly string[];
}

/**
 * Parse a statement.
 *
 * `columns` defaults to the names seen on real exports; an account can override them.
 * Only `consignmentNo` (or `reference`) and `codCollected` are required — a statement
 * that itemises no charges is a courier that charges none, and demanding the column
 * would refuse a legitimate file.
 */
export function parseCsvStatement(
  file: Buffer | string,
  columns: StatementColumns = DEFAULT_STATEMENT_COLUMNS,
): ParsedStatement {
  const text = typeof file === 'string' ? file : file.toString('utf8');
  // A portal export routinely carries a UTF-8 BOM, and a BOM on the first header makes
  // `consignment_id` fail to match `consignment_id` — an hour of somebody's life, every
  // time it is not stripped here.
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

  if (lines.length < 2) {
    throw new CourierError(
      'SETTLEMENT_FILE_INVALID',
      'That statement has no rows under its header.',
    );
  }

  const headers = splitCsvLine(lines[0] ?? '').map(normaliseHeader);
  const at = {
    consignmentNo: findColumn(headers, columns.consignmentNo),
    reference: findColumn(headers, columns.reference),
    codCollected: findColumn(headers, columns.codCollected),
    deliveryCharge: findColumn(headers, columns.deliveryCharge),
    returnCharge: findColumn(headers, columns.returnCharge),
    otherCharge: findColumn(headers, columns.otherCharge),
    net: findColumn(headers, columns.net),
  };

  if (at.consignmentNo === undefined && at.reference === undefined) {
    throw new CourierError(
      'SETTLEMENT_FILE_INVALID',
      `That statement has no consignment or invoice column. Columns found: ${headers.join(', ')}.`,
    );
  }
  if (at.codCollected === undefined) {
    throw new CourierError(
      'SETTLEMENT_FILE_INVALID',
      `That statement has no collected-amount column. Columns found: ${headers.join(', ')}.`,
    );
  }

  const cell = (cells: readonly string[], index: number | undefined): string | null => {
    if (index === undefined) return null;
    const value = cells[index];
    return value === undefined || value === '' ? null : value;
  };

  const amount = (cells: readonly string[], index: number | undefined, rowNo: number): bigint => {
    const raw = cell(cells, index);
    // An absent or empty cell is zero; a cell with something unparseable in it is a
    // refusal. Treating "-" or "n/a" as zero would turn a courier's placeholder into a
    // charge we agreed to forget about.
    if (raw === null) return 0n;
    try {
      return takaToPoisha(raw);
    } catch {
      throw new CourierError(
        'SETTLEMENT_FILE_INVALID',
        `Row ${String(rowNo)} of that statement has "${raw}" where an amount in taka was expected.`,
      );
    }
  };

  const rows: SettlementFileRow[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const cells = splitCsvLine(lines[index] ?? '');
    const rowNo = index;

    const consignmentNo = cell(cells, at.consignmentNo);
    const reference = cell(cells, at.reference);
    if (consignmentNo === null && reference === null) {
      throw new CourierError(
        'SETTLEMENT_FILE_INVALID',
        `Row ${String(rowNo)} of that statement names no consignment and no invoice.`,
      );
    }

    const stated = cell(cells, at.net);
    rows.push({
      rowNo,
      // The courier's own id when it has one, our reference otherwise. The matcher tries
      // both, so an unnumbered row still finds its consignment.
      consignmentNo: consignmentNo ?? reference ?? '',
      reference,
      codCollectedPoisha: poisha(amount(cells, at.codCollected, rowNo)),
      deliveryChargePoisha: poisha(amount(cells, at.deliveryCharge, rowNo)),
      returnChargePoisha: poisha(amount(cells, at.returnCharge, rowNo)),
      otherChargePoisha: poisha(amount(cells, at.otherCharge, rowNo)),
      netPoisha: stated === null ? null : poisha(amount(cells, at.net, rowNo)),
    });
  }

  return { rows, headers };
}
