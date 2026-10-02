/**
 * What every M14a importer shares: the kinds, the column check, and the parsers.
 *
 * The importers follow M06's price importer (`../catalog/price-import.ts`) on purpose:
 * one pure function decides every row, the dry run and the commit both call it, and any
 * problem at all stops the whole file. A brand's opening position is imported once, so
 * an importer that guessed — read `1,200` as twelve hundred in one column and as two
 * fields in another, or took a blank cost as zero — would be wrong once, permanently.
 */

import { missingColumns, type CsvRow, type CsvTable } from '../catalog/csv.js';
import { takaTextToPoisha, type ImportProblem } from '../catalog/price-import.js';
import { MAX_POISHA, type Poisha } from '../money/index.js';

export type { ImportProblem };

/** The six importers, in the order a brand runs them. */
export const MIGRATION_KINDS = [
  'skus',
  'opening_stock',
  'supplier_balances',
  'wallet_balances',
  'courier_cod',
  'customers',
] as const;

export type MigrationKind = (typeof MIGRATION_KINDS)[number];

/**
 * The kinds that carry an opening *balance*, and so wait for the opening post (D-215).
 *
 * A committed batch of one of these is staged: its rows are kept, and nothing reaches
 * stock or the ledger until `POST /v1/migration/opening` posts every staged batch in one
 * transaction with the one opening journal (D-213). SKUs and customers are not balances,
 * so they apply on commit.
 */
export const STAGED_KINDS: readonly MigrationKind[] = [
  'opening_stock',
  'supplier_balances',
  'wallet_balances',
  'courier_cod',
];

export function isMigrationKind(value: string): value is MigrationKind {
  return (MIGRATION_KINDS as readonly string[]).includes(value);
}

export function isStagedKind(kind: MigrationKind): boolean {
  return STAGED_KINDS.includes(kind);
}

/** One importer's verdict on a file. `rows` is only ever applied when `problems` is empty. */
export interface Review<Row> {
  readonly rows: readonly Row[];
  readonly problems: readonly ImportProblem[];
}

/**
 * The column check every importer starts with.
 *
 * A missing column is reported once, not once per row; an unknown column is refused rather
 * than ignored, because a column the importer does not read is a fact the operator thinks
 * they imported. Returns `false` when the required columns are missing, so the caller
 * stops before reporting the same absence on every line.
 */
export function checkColumns(
  table: CsvTable,
  required: readonly string[],
  optional: readonly string[],
  problems: ImportProblem[],
): boolean {
  const absent = missingColumns(table, required);
  for (const column of absent) {
    problems.push({ line: 1, column, message: `The file needs a "${column}" column.` });
  }
  const allowed = new Set([...required, ...optional]);
  for (const header of table.headers) {
    if (!allowed.has(header)) {
      problems.push({
        line: 1,
        column: header,
        message: `"${header}" is not a column this importer reads. The columns are: ${[...required, ...optional].join(', ')}.`,
      });
    }
  }
  return absent.length === 0;
}

/** A row whose field count differs from the header's, reported once for the row. */
export function shapeProblem(row: CsvRow): ImportProblem | null {
  if (row.values.__fieldCount === undefined) return null;
  return {
    line: row.line,
    column: null,
    message: `This row has ${row.values.__fieldCount} fields; the header has a different number. A stray comma or quote shifts every value after it.`,
  };
}

export function cell(row: CsvRow, column: string): string {
  return (row.values[column] ?? '').trim();
}

/** The most one opening line may carry: well inside `poisha()`'s ±9e15 bound. */
export const MAX_OPENING_AMOUNT_POISHA = 100_000_000_000n; // ৳100 crore

/**
 * A positive taka amount, as poisha, or the reason it is not one.
 *
 * Through `takaTextToPoisha`, which reads the digits as integers and refuses a third
 * decimal place rather than rounding it — an opening balance nobody typed is worse than
 * a refused row.
 */
export function positiveAmount(
  text: string,
  what: string,
  ceiling: bigint = MAX_OPENING_AMOUNT_POISHA,
): { ok: true; value: Poisha } | { ok: false; message: string } {
  if (text === '') return { ok: false, message: `The ${what} is blank.` };
  if (text.startsWith('-')) {
    return { ok: false, message: `A ${what} is more than zero; a negative balance is refused.` };
  }
  let value: Poisha;
  try {
    value = takaTextToPoisha(text);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Not an amount.' };
  }
  if (value <= 0n) {
    return { ok: false, message: `A ${what} is more than zero. Leave a zero balance out.` };
  }
  if (value > ceiling || value > MAX_POISHA) {
    return {
      ok: false,
      message: `That ${what} is beyond the importer's ceiling. Check for a misplaced decimal point.`,
    };
  }
  return { ok: true, value };
}

/** A whole number within `[min, max]`; blank reads as `blank` when one is given. */
export function wholeNumber(
  text: string,
  what: string,
  bounds: { readonly min: number; readonly max: number; readonly blank?: number },
): { ok: true; value: number } | { ok: false; message: string } {
  if (text === '') {
    if (bounds.blank !== undefined) return { ok: true, value: bounds.blank };
    return { ok: false, message: `The ${what} is blank.` };
  }
  if (!/^\d{1,9}$/.test(text)) {
    return { ok: false, message: `A ${what} is a whole number, such as 12.` };
  }
  const value = Number(text);
  if (value < bounds.min || value > bounds.max) {
    return {
      ok: false,
      message: `A ${what} is between ${String(bounds.min)} and ${String(bounds.max)}.`,
    };
  }
  return { ok: true, value };
}

/** Line numbers already holding a key, so a second occurrence names the first. */
export class SeenKeys {
  private readonly lines = new Map<string, number>();

  /** The line the key was first seen on, or `undefined` (and the key is now recorded). */
  claim(key: string, line: number): number | undefined {
    const first = this.lines.get(key);
    if (first !== undefined) return first;
    this.lines.set(key, line);
    return undefined;
  }
}

/**
 * May this review be committed? Any problem stops the whole file (check 2).
 *
 * The same rule as M06's `allOrNothing`, for the same reason: a partial opening import
 * leaves a brand with some balances in and no way to say which.
 */
export function canCommit(review: { readonly problems: readonly ImportProblem[] }, rows: number) {
  if (review.problems.length > 0) {
    return {
      ok: false,
      reason: `${String(review.problems.length)} problem${review.problems.length === 1 ? '' : 's'} in that file. Nothing was changed.`,
    } as const;
  }
  if (rows === 0) return { ok: false, reason: 'That file has nothing new to import.' } as const;
  return { ok: true, reason: null } as const;
}
