/**
 * The selling-price importer's rules (M06 acceptance check 4).
 *
 * Pure, and separated from the service that runs it, because the two steps check
 * 4 asks for — a dry run that reports and a commit that applies — must agree
 * about every row. If the dry run and the commit each had their own idea of what
 * a valid row is, the report an operator approved would not be the change they
 * got, which is a worse outcome than either step being wrong on its own.
 *
 * So: one function decides, both steps call it, and the commit refuses to run at
 * all unless the decision came back with zero errors. `allOrNothing` below is
 * that refusal, and it is a function rather than an `if` in the service so the
 * test can state the rule directly.
 *
 * ## What "price" means here, and what it never means
 *
 * The **selling** price, in poisha. Invariant 5 puts purchase cost in supply,
 * inventory and the ledger and nowhere else, and this file is one of the places
 * the distinction is easy to blur: a column headed `cost` in somebody's
 * spreadsheet must be refused, not quietly read as a price. `UNKNOWN_COLUMNS`
 * does that — an unrecognised column is an error, so a file whose author thought
 * they were setting cost is told they were not.
 */

import { poisha, type Poisha } from '../money/index.js';
import { isSkuCode } from './sku-code.js';
import type { CsvRow, CsvTable } from './csv.js';
import { missingColumns } from './csv.js';

/** The columns the file must have. */
export const PRICE_IMPORT_REQUIRED = ['sku', 'price_taka'] as const;

/** Columns the file may have. Anything else is an error, not a hint. */
export const PRICE_IMPORT_OPTIONAL = ['barcode', 'note'] as const;

/** A price ceiling, so a mis-typed `100000` in the taka column is caught here. */
export const MAX_PRICE_POISHA = 100_000_000n;

export interface PriceImportRow {
  readonly line: number;
  readonly sku: string;
  readonly pricePoisha: Poisha;
  /** Empty string means "leave the barcode alone"; a value replaces it. */
  readonly barcode: string | null;
}

export interface ImportProblem {
  /** 1-based line in the file, header included. */
  readonly line: number;
  readonly column: string | null;
  readonly message: string;
}

export interface PriceImportReport {
  readonly rows: readonly PriceImportRow[];
  readonly problems: readonly ImportProblem[];
  /** SKUs in the file that exist, counted for the operator's confirmation. */
  readonly matched: number;
  /** Rows that would change nothing, because the price is already that. */
  readonly unchanged: number;
}

/**
 * Taka with up to two decimals into poisha, without touching a float.
 *
 * `parseFloat('19.99') * 100` is 1998.9999999999998, and `Math.round` of it is
 * right until the day it is not — which is why the `elysium/no-float-money` lint
 * rule bans the function outright (D-090). The string is split on the decimal
 * point and the two halves are read as integers, so `1.005` is refused rather
 * than rounded to a number nobody chose.
 */
export function takaTextToPoisha(text: string): Poisha {
  const trimmed = text.trim().replace(/,/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error('A price is taka with up to two decimal places, such as 1490 or 1490.50.');
  }
  const [whole = '0', fraction = ''] = trimmed.split('.');
  const paddedFraction = fraction.padEnd(2, '0');
  return poisha(BigInt(whole) * 100n + BigInt(paddedFraction));
}

export interface KnownSku {
  readonly code: string;
  readonly pricePoisha: Poisha;
  /** The barcode it carries now: a file may repeat the SKU's own internal number (D-603). */
  readonly barcode?: string | null;
}

/**
 * `2` and twelve digits: the range the ERP numbers its own SKUs in (D-603). A file may not
 * write one onto a SKU that does not already carry it, or a later SKU would be born with
 * the same number.
 */
const INTERNAL_RANGE = /^2\d{12}$/;

/**
 * Judge a parsed file against the SKUs that exist.
 *
 * Every problem is reported, never just the first: an operator fixing a
 * 500-row file one error per round trip is an operator who stops using the
 * importer and edits the database. Problems carry the line and the column so the
 * report can be read beside the spreadsheet.
 */
export function reviewPriceImport(table: CsvTable, known: readonly KnownSku[]): PriceImportReport {
  const problems: ImportProblem[] = [];

  const absent = missingColumns(table, PRICE_IMPORT_REQUIRED);
  for (const column of absent) {
    problems.push({ line: 1, column, message: `The file needs a "${column}" column.` });
  }

  const allowed = new Set<string>([...PRICE_IMPORT_REQUIRED, ...PRICE_IMPORT_OPTIONAL]);
  for (const header of table.headers) {
    if (!allowed.has(header)) {
      problems.push({
        line: 1,
        column: header,
        message:
          `"${header}" is not a column this importer writes. ` +
          'The catalog holds selling prices only — purchase cost is entered against a supply.',
      });
    }
  }

  // Without the required columns there is nothing row-level left to say, and
  // reporting "sku is blank" 500 times would bury the one problem that matters.
  if (absent.length > 0) {
    return { rows: [], problems, matched: 0, unchanged: 0 };
  }

  const byCode = new Map(known.map((sku) => [sku.code, sku]));
  const seen = new Map<string, number>();
  const rows: PriceImportRow[] = [];
  let unchanged = 0;

  for (const row of table.rows) {
    const before = problems.length;
    const parsed = reviewRow(row, byCode, seen, problems);
    if (parsed === undefined || problems.length !== before) continue;
    rows.push(parsed);
    if (byCode.get(parsed.sku)?.pricePoisha === parsed.pricePoisha) unchanged += 1;
  }

  return { rows, problems, matched: rows.length, unchanged };
}

function reviewRow(
  row: CsvRow,
  byCode: ReadonlyMap<string, KnownSku>,
  seen: Map<string, number>,
  problems: ImportProblem[],
): PriceImportRow | undefined {
  const { line, values } = row;

  if (values.__fieldCount !== undefined) {
    problems.push({
      line,
      column: null,
      message: `This row has ${values.__fieldCount} fields; the header has a different number. A stray comma or quote shifts every value after it.`,
    });
    return undefined;
  }

  const sku = (values.sku ?? '').trim().toUpperCase();
  if (sku === '') {
    problems.push({ line, column: 'sku', message: 'The SKU is blank.' });
    return undefined;
  }
  if (!isSkuCode(sku)) {
    problems.push({
      line,
      column: 'sku',
      message: 'A SKU code is upper-case letters, digits and dashes.',
    });
    return undefined;
  }
  if (!byCode.has(sku)) {
    problems.push({ line, column: 'sku', message: `No SKU "${sku}" in this brand's catalog.` });
    return undefined;
  }

  const duplicate = seen.get(sku);
  if (duplicate !== undefined) {
    // Refused rather than last-one-wins. Two rows for one SKU means the file was
    // assembled from two sources, and whichever price the importer picked would
    // be a coin toss the operator did not know they were making.
    problems.push({
      line,
      column: 'sku',
      message: `"${sku}" also appears on line ${String(duplicate)}. Each SKU may appear once.`,
    });
    return undefined;
  }
  seen.set(sku, line);

  let pricePoisha: Poisha;
  try {
    pricePoisha = takaTextToPoisha(values.price_taka ?? '');
  } catch (error) {
    problems.push({
      line,
      column: 'price_taka',
      message: error instanceof Error ? error.message : 'That price is not a number.',
    });
    return undefined;
  }
  if (pricePoisha <= 0n) {
    problems.push({ line, column: 'price_taka', message: 'A selling price is more than zero.' });
    return undefined;
  }
  if (pricePoisha > MAX_PRICE_POISHA) {
    problems.push({
      line,
      column: 'price_taka',
      message: "That price is beyond the importer's ceiling. Check for a misplaced decimal point.",
    });
    return undefined;
  }

  const barcodeText = (values.barcode ?? '').trim();
  if (barcodeText !== '' && !/^[\x20-\x7e]{1,48}$/.test(barcodeText)) {
    problems.push({
      line,
      column: 'barcode',
      message: 'A Code 128 barcode holds printable ASCII, up to 48 characters.',
    });
    return undefined;
  }
  if (INTERNAL_RANGE.test(barcodeText) && byCode.get(sku)?.barcode !== barcodeText) {
    problems.push({
      line,
      column: 'barcode',
      message:
        'Thirteen digits starting with 2 are the ERP’s own barcodes; leave the cell empty to keep the SKU’s.',
    });
    return undefined;
  }

  return { line, sku, pricePoisha, barcode: barcodeText === '' ? null : barcodeText };
}

/**
 * May this report be committed?
 *
 * The one rule check 4 states, as a function: **any** problem stops the whole
 * file. Not "problems on rows we skip" — a partial import of a price file leaves
 * some SKUs repriced and nobody able to say which, and the only way to recover
 * is to know the prices from before, which is exactly what the import destroyed.
 */
export function allOrNothing(report: PriceImportReport): { ok: boolean; reason: string | null } {
  if (report.problems.length > 0) {
    return {
      ok: false,
      reason: `${String(report.problems.length)} row${report.problems.length === 1 ? '' : 's'} in that file cannot be applied. Nothing was changed.`,
    };
  }
  if (report.rows.length === 0) {
    return { ok: false, reason: 'That file has no rows to apply.' };
  }
  return { ok: true, reason: null };
}
