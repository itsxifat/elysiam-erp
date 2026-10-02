/**
 * The opening-stock importer's rules (M14a; §8).
 *
 * Columns: `sku, location, qty, unit_cost_taka`. `unit_cost_taka` is **purchase cost**
 * (invariant 5): it enters `sku_costs` as the SKU's first weighted average, and every COGS
 * line the brand ever posts for these units comes from it.
 *
 * ## One cost per SKU, and why the check depends on it (D-216)
 *
 * §8's average is org-wide per SKU, so the same shirt opened at ৳500 in the warehouse and
 * ৳520 in a showroom is blended to one figure the moment both movements land — and the
 * blend rounds. The opening journal debits inventory Σ(qty × cost), the inventory module
 * values stock at WAC × on hand, and with two costs those can differ by a poisha per SKU.
 * Check 4 asks for them to agree *to the poisha*. Requiring the brand's one average per
 * SKU makes them agree exactly, and it is also the true statement: a business opening its
 * books has one carrying cost per item, not one per shelf.
 *
 * For the same reason a SKU that already holds stock or a cost basis is refused: blending
 * an opening cost into an existing average is not an opening balance, it is a receipt.
 */

import type { CsvTable } from '../catalog/csv.js';
import { mulQty, sum, ZERO, type Poisha } from '../money/index.js';
import {
  cell,
  checkColumns,
  positiveAmount,
  SeenKeys,
  shapeProblem,
  wholeNumber,
  type ImportProblem,
  type Review,
} from './common.js';

export const OPENING_STOCK_REQUIRED = ['sku', 'location', 'qty', 'unit_cost_taka'] as const;
export const OPENING_STOCK_OPTIONAL = ['note'] as const;

/** A unit cost ceiling: ৳10 lakh a unit is a misplaced decimal point in a clothing brand. */
export const MAX_UNIT_COST_POISHA = 100_000_000n;
export const MAX_OPENING_QTY = 1_000_000;

export interface OpeningStockRow {
  readonly line: number;
  readonly skuId: string;
  readonly skuCode: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly qty: number;
  readonly unitCostPoisha: Poisha;
}

/** What the database knows, resolved by the caller before the review runs. */
export interface OpeningStockRefs {
  /** By upper-case code. `held` is true when the SKU has stock or a cost basis already. */
  readonly skus: ReadonlyMap<string, { readonly id: string; readonly held: boolean }>;
  /** By code, as the location is coded in this brand. */
  readonly locations: ReadonlyMap<string, { readonly id: string }>;
  /** Rows of every other staged opening-stock batch, so two files cannot overlap. */
  readonly staged: readonly OpeningStockRow[];
}

export interface OpeningStockTotals {
  readonly rows: number;
  readonly units: number;
  /** Σ(qty × unit cost), through `mulQty`. Purchase cost. */
  readonly stockValuePoisha: Poisha;
}

export function openingStockTotals(rows: readonly OpeningStockRow[]): OpeningStockTotals {
  return {
    rows: rows.length,
    units: rows.reduce((total, row) => total + row.qty, 0),
    stockValuePoisha:
      rows.length === 0 ? ZERO : sum(rows.map((row) => mulQty(row.unitCostPoisha, row.qty))),
  };
}

export function reviewOpeningStock(
  table: CsvTable,
  refs: OpeningStockRefs,
): Review<OpeningStockRow> & { readonly totals: OpeningStockTotals } {
  const problems: ImportProblem[] = [];
  if (!checkColumns(table, OPENING_STOCK_REQUIRED, OPENING_STOCK_OPTIONAL, problems)) {
    return { rows: [], problems, totals: openingStockTotals([]) };
  }

  // The cost each SKU already carries in another staged file, so a second file cannot
  // give it a second one.
  const stagedCost = new Map<string, Poisha>();
  const stagedPairs = new Set<string>();
  for (const row of refs.staged) {
    stagedCost.set(row.skuId, row.unitCostPoisha);
    stagedPairs.add(`${row.skuId}|${row.locationId}`);
  }

  const seen = new SeenKeys();
  const fileCost = new Map<string, { cost: Poisha; line: number }>();
  const rows: OpeningStockRow[] = [];

  for (const row of table.rows) {
    const shape = shapeProblem(row);
    if (shape !== null) {
      problems.push(shape);
      continue;
    }
    const { line } = row;
    const before = problems.length;

    const skuCode = cell(row, 'sku').toUpperCase();
    const sku = refs.skus.get(skuCode);
    if (skuCode === '') problems.push({ line, column: 'sku', message: 'The SKU is blank.' });
    else if (sku === undefined) {
      problems.push({
        line,
        column: 'sku',
        message: `No SKU "${skuCode}" in this brand's catalog.`,
      });
    } else if (sku.held) {
      problems.push({
        line,
        column: 'sku',
        message: `"${skuCode}" already holds stock or a cost. Opening stock is a SKU's first units; anything after that is a supply receipt.`,
      });
    }

    const locationCode = cell(row, 'location');
    const location = refs.locations.get(locationCode);
    if (locationCode === '') {
      problems.push({ line, column: 'location', message: 'The location is blank.' });
    } else if (location === undefined) {
      problems.push({
        line,
        column: 'location',
        message: `No stock location "${locationCode}" in this brand.`,
      });
    }

    const qty = wholeNumber(cell(row, 'qty'), 'quantity', { min: 1, max: MAX_OPENING_QTY });
    if (!qty.ok) problems.push({ line, column: 'qty', message: qty.message });

    const cost = positiveAmount(cell(row, 'unit_cost_taka'), 'unit cost', MAX_UNIT_COST_POISHA);
    if (!cost.ok) problems.push({ line, column: 'unit_cost_taka', message: cost.message });

    if (problems.length !== before || sku === undefined || location === undefined) continue;
    if (!qty.ok || !cost.ok) continue;

    const pair = `${sku.id}|${location.id}`;
    const first = seen.claim(pair, line);
    if (first !== undefined) {
      problems.push({
        line,
        column: 'sku',
        message: `"${skuCode}" at "${locationCode}" also appears on line ${String(first)}. One row per SKU and location.`,
      });
      continue;
    }
    if (stagedPairs.has(pair)) {
      problems.push({
        line,
        column: 'sku',
        message: `"${skuCode}" at "${locationCode}" is already in a staged stock file. Discard that file first to replace it.`,
      });
      continue;
    }

    const already = stagedCost.get(sku.id);
    if (already !== undefined && already !== cost.value) {
      problems.push({
        line,
        column: 'unit_cost_taka',
        message: `"${skuCode}" is staged at another cost in an earlier file. A SKU opens at one cost, its average across every location.`,
      });
      continue;
    }
    const inFile = fileCost.get(sku.id);
    if (inFile !== undefined && inFile.cost !== cost.value) {
      problems.push({
        line,
        column: 'unit_cost_taka',
        message: `"${skuCode}" has a different cost on line ${String(inFile.line)}. A SKU opens at one cost, its average across every location.`,
      });
      continue;
    }
    if (inFile === undefined) fileCost.set(sku.id, { cost: cost.value, line });

    rows.push({
      line,
      skuId: sku.id,
      skuCode,
      locationId: location.id,
      locationCode,
      qty: qty.value,
      unitCostPoisha: cost.value,
    });
  }

  return { rows, problems, totals: openingStockTotals(rows) };
}

/**
 * The SKU codes whose staged rows break D-216 together: two costs for one SKU, or one SKU
 * and location twice. Empty when the rows can open as one position.
 *
 * Each file is reviewed against the files staged before it, so this is empty unless two
 * files were staged at once past that review. The posting checks it anyway, because what
 * it guards — the journal and the valuation agreeing to the poisha — is checked nowhere
 * after the stock is in.
 */
export function stagedStockConflicts(rows: readonly OpeningStockRow[]): string[] {
  const costs = new Map<string, Poisha>();
  const pairs = new Set<string>();
  const conflicts = new Set<string>();
  for (const row of rows) {
    const cost = costs.get(row.skuId);
    if (cost !== undefined && cost !== row.unitCostPoisha) conflicts.add(row.skuCode);
    costs.set(row.skuId, cost ?? row.unitCostPoisha);
    const pair = `${row.skuId}|${row.locationId}`;
    if (pairs.has(pair)) conflicts.add(row.skuCode);
    pairs.add(pair);
  }
  return [...conflicts].sort();
}
