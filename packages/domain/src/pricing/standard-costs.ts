import { missingColumns, type CsvTable } from '../catalog/csv.js';
import { takaTextToPoisha } from '../catalog/price-import.js';
import type { Poisha } from '../money/index.js';

/**
 * The standard buying price spreadsheet (M39b, D-638): the supply module's import and export
 * of each variant's standard buying price, optionally per supplier.
 *
 * Purchase cost, so it belongs to supply (invariant 5): the catalog's own price importer
 * refuses any cost column by design, and this file is never read or written by the catalog.
 *
 * One row per variant and supplier: `sku` (the SKU code), `supplier` (a supplier's code, or
 * blank for any supplier), `standard_cost_taka`. `product` and `variant` are there for the
 * person reading the export and are ignored on the way back in. A blank cost leaves that
 * variant as it is, so the export, with gaps, re-imports cleanly.
 */

export const STANDARD_COST_REQUIRED = ['sku', 'standard_cost_taka'] as const;
export const STANDARD_COST_OPTIONAL = ['supplier', 'product', 'variant'] as const;
export const STANDARD_COST_HEADERS = [
  'sku',
  'product',
  'variant',
  'supplier',
  'standard_cost_taka',
] as const;

/** At most this many priced rows in one file. */
export const STANDARD_COST_MAX_ROWS = 5000;

export interface StandardCostRow {
  readonly line: number;
  readonly sku: string;
  /** A supplier's code, or null for "any supplier". */
  readonly supplierCode: string | null;
  readonly unitCostPoisha: Poisha;
}

export interface StandardCostProblem {
  readonly line: number;
  readonly column: string | null;
  readonly message: string;
}

export interface StandardCostReport {
  readonly rows: readonly StandardCostRow[];
  readonly problems: readonly StandardCostProblem[];
  /** Rows left blank on purpose (no cost typed). */
  readonly skipped: number;
}

/**
 * Judge a parsed file against the SKU codes and supplier codes the brand has. Every problem is
 * reported, never just the first; a SKU named twice for the same supplier is refused, because
 * one of the two figures would win and nobody chose which.
 */
export function reviewStandardCostImport(
  table: CsvTable,
  skuCodes: ReadonlySet<string>,
  supplierCodes: ReadonlySet<string>,
): StandardCostReport {
  const problems: StandardCostProblem[] = [];
  const absent = missingColumns(table, STANDARD_COST_REQUIRED);
  for (const column of absent) {
    problems.push({ line: 1, column, message: `The file needs a "${column}" column.` });
  }
  const allowed = new Set<string>([...STANDARD_COST_REQUIRED, ...STANDARD_COST_OPTIONAL]);
  for (const header of table.headers) {
    if (!allowed.has(header)) {
      problems.push({
        line: 1,
        column: header,
        message: `"${header}" is not a column this importer reads.`,
      });
    }
  }
  if (absent.length > 0) return { rows: [], problems, skipped: 0 };

  const rows: StandardCostRow[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  for (const row of table.rows) {
    if (row.values.__fieldCount !== undefined) {
      problems.push({
        line: row.line,
        column: null,
        message: `This row has ${row.values.__fieldCount} fields; the header has ${String(table.headers.length)}.`,
      });
      continue;
    }
    const sku = (row.values.sku ?? '').trim().toUpperCase();
    const supplier = (row.values.supplier ?? '').trim().toUpperCase();
    const text = (row.values.standard_cost_taka ?? '').trim();
    if (text === '') {
      skipped += 1;
      continue;
    }
    let ok = true;
    if (sku === '') {
      problems.push({ line: row.line, column: 'sku', message: 'The SKU code is blank.' });
      ok = false;
    } else if (!skuCodes.has(sku)) {
      problems.push({ line: row.line, column: 'sku', message: `No SKU "${sku}" in this brand.` });
      ok = false;
    }
    if (supplier !== '' && !supplierCodes.has(supplier)) {
      problems.push({
        line: row.line,
        column: 'supplier',
        message: `No supplier with the code "${supplier}".`,
      });
      ok = false;
    }
    let cost: Poisha | null = null;
    try {
      cost = takaTextToPoisha(text);
    } catch {
      problems.push({
        line: row.line,
        column: 'standard_cost_taka',
        message: 'A buying price is taka with up to two decimal places, such as 820 or 820.50.',
      });
      ok = false;
    }
    if (cost !== null && cost <= 0n) {
      problems.push({
        line: row.line,
        column: 'standard_cost_taka',
        message: 'A standard buying price is above zero. Leave it blank to keep the one there.',
      });
      ok = false;
    }
    const key = `${sku}|${supplier}`;
    const earlier = seen.get(key);
    if (sku !== '' && earlier !== undefined) {
      problems.push({
        line: row.line,
        column: 'sku',
        message: `"${sku}" is already on line ${String(earlier)} for the same supplier.`,
      });
      ok = false;
    } else if (sku !== '') {
      seen.set(key, row.line);
    }
    if (ok && cost !== null) {
      rows.push({
        line: row.line,
        sku,
        supplierCode: supplier === '' ? null : supplier,
        unitCostPoisha: cost,
      });
    }
  }
  if (rows.length > STANDARD_COST_MAX_ROWS) {
    problems.push({
      line: 1,
      column: null,
      message: `That file prices ${String(rows.length)} rows; the importer takes ${String(STANDARD_COST_MAX_ROWS)} at a time.`,
    });
  }
  return { rows, problems, skipped };
}

/** One line of the export. */
export interface StandardCostExportRow {
  readonly sku: string;
  readonly product: string;
  readonly variant: string;
  readonly supplierCode: string | null;
  readonly unitCostPoisha: bigint | null;
}

/**
 * A cell a spreadsheet will not run: text starting with `=`, `+`, `-`, `@` or a control
 * character is a formula to Excel, so it is led with an apostrophe (a product named
 * `=HYPERLINK(…)` stays text).
 */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Poisha as plain taka, `82050n` → `"820.50"`. */
function takaPlain(amount: bigint): string {
  const whole = amount / 100n;
  const rest = amount % 100n;
  return `${whole.toString()}.${rest.toString().padStart(2, '0')}`;
}

/** The export: the header and one line per row, `\n` endings, re-importable as it is. */
export function standardCostCsv(rows: readonly StandardCostExportRow[]): string {
  const lines = [STANDARD_COST_HEADERS.join(',')];
  for (const row of rows) {
    lines.push(
      [
        cell(row.sku),
        cell(row.product),
        cell(row.variant),
        cell(row.supplierCode ?? ''),
        row.unitCostPoisha === null ? '' : takaPlain(row.unitCostPoisha),
      ].join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}
