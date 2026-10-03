import type { Poisha } from '../money/index.js';
import { missingColumns, type CsvRow, type CsvTable } from './csv.js';
import { MAX_PRICE_POISHA, takaTextToPoisha, type ImportProblem } from './price-import.js';
import { MAX_VARIANTS_PER_PRODUCT } from './variant-matrix.js';

/**
 * The new-products spreadsheet (D-425).
 *
 * One row per **product**, not per SKU, because that is how an owner thinks about a
 * range: "Linen panjabi, sizes M to XXL, white and cream, ৳2,450". The importer then
 * builds the size × colour matrix the same way the new-product form does, so the SKU
 * codes come out exactly as if each product had been typed in by hand.
 *
 * What it refuses, and why each would otherwise be a quiet mistake:
 *
 * - **A size or colour the brand does not have.** Creating one on the fly would turn
 *   a typo (`Rde`) into a new colour on every label printed from then on. The problem
 *   names the value and the screen points to Catalog setup, where adding it takes a
 *   moment.
 * - **A product name already in the catalog, or twice in the file.** The second copy
 *   would get its own product number and SKU codes, and stock would be split across
 *   two products nobody can tell apart.
 * - **A category nobody can find.** Matched by code or by name, ignoring case.
 *
 * Pure: the caller supplies what the brand already has, and the result is the rows to
 * create plus every problem with its line and column. Nothing is applied unless there
 * are no problems at all (`allOrNothing` in `price-import.ts` states the same rule).
 */

export const PRODUCT_IMPORT_REQUIRED = ['name', 'price_taka'] as const;
export const PRODUCT_IMPORT_OPTIONAL = [
  'category',
  'sizes',
  'colours',
  'status',
  'description',
] as const;
/** `colors` is accepted as the spelling of `colours`; both mean the same column. */
const COLOUR_ALIASES = ['colours', 'colors'] as const;

/** One file's ceiling. A brand's whole range fits; a file of 5,000 products is a migration. */
export const PRODUCT_IMPORT_MAX_ROWS = 500;

/**
 * SKUs one file may make. The import is one transaction holding the brand's SKU counter,
 * so a file of 500 products × 500 variants would block every other product creation in
 * the brand for minutes (ledger audit L4).
 */
export const PRODUCT_IMPORT_MAX_SKUS = 5000;

/** The template the console offers for download. The second line is an example. */
export const PRODUCT_IMPORT_TEMPLATE =
  'name,category,price_taka,sizes,colours,status,description\n' +
  'Linen Panjabi,PNJ,2450,M|L|XL,White|Cream,active,Soft linen for Eid\n';

export interface KnownCategory {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface KnownAxis {
  readonly attributeId: string;
  readonly name: string;
  readonly values: readonly {
    readonly id: string;
    readonly code: string;
    readonly label: string;
  }[];
}

export interface ProductImportContext {
  readonly categories: readonly KnownCategory[];
  /** The brand's size list, or null when it has none. */
  readonly sizes: KnownAxis | null;
  /** The brand's colour list, or null when it has none. */
  readonly colours: KnownAxis | null;
  /** Names already in the catalog, any status. */
  readonly existingNames: readonly string[];
}

export interface ProductImportRow {
  readonly line: number;
  readonly name: string;
  readonly categoryId: string | null;
  readonly pricePoisha: Poisha;
  readonly status: 'draft' | 'active';
  readonly description: string | null;
  /** Size first, then colour: the order the SKU code segments come out in. */
  readonly axes: readonly { readonly attributeId: string; readonly valueIds: readonly string[] }[];
  /** How many SKUs this row will make. */
  readonly variantCount: number;
}

export interface ProductImportReport {
  readonly rows: readonly ProductImportRow[];
  readonly problems: readonly ImportProblem[];
}

/**
 * Split `S|M|L`, `S; M; L` or (inside quotes) `S, M, L` into values. Not on `/`: a
 * two-tone colour such as `Black/White` is one value, and splitting it would quietly
 * build two other colours (ledger audit L5).
 */
export function splitValueList(text: string): string[] {
  return text
    .split(/[|;,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function normal(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function reviewProductImport(
  table: CsvTable,
  context: ProductImportContext,
): ProductImportReport {
  const problems: ImportProblem[] = [];

  const absent = missingColumns(table, PRODUCT_IMPORT_REQUIRED);
  for (const column of absent) {
    problems.push({ line: 1, column, message: `The file needs a "${column}" column.` });
  }
  const allowed = new Set<string>([
    ...PRODUCT_IMPORT_REQUIRED,
    ...PRODUCT_IMPORT_OPTIONAL,
    ...COLOUR_ALIASES,
  ]);
  for (const header of table.headers) {
    if (!allowed.has(header)) {
      problems.push({
        line: 1,
        column: header,
        message:
          `"${header}" is not a column this importer reads. ` +
          'Use the template; purchase cost is entered when stock is received.',
      });
    }
  }
  if (table.rows.length > PRODUCT_IMPORT_MAX_ROWS) {
    problems.push({
      line: 1,
      column: null,
      message: `That file has ${String(table.rows.length)} products; import at most ${String(PRODUCT_IMPORT_MAX_ROWS)} at a time.`,
    });
  }
  if (problems.length > 0) return { rows: [], problems };
  if (table.rows.length === 0) {
    return { rows: [], problems: [{ line: 1, column: null, message: 'The file has no rows.' }] };
  }

  const categoriesByKey = new Map<string, KnownCategory>();
  for (const category of context.categories) {
    categoriesByKey.set(normal(category.code), category);
    categoriesByKey.set(normal(category.name), category);
  }
  const existing = new Set(context.existingNames.map(normal));
  const seen = new Map<string, number>();
  const colourColumn = table.headers.includes('colours') ? 'colours' : 'colors';

  const rows: ProductImportRow[] = [];
  for (const row of table.rows) {
    const before = problems.length;
    const parsed = reviewRow(row, {
      context,
      categoriesByKey,
      existing,
      seen,
      colourColumn,
      problems,
    });
    if (parsed !== undefined && problems.length === before) rows.push(parsed);
  }

  const skus = rows.reduce((total, row) => total + row.variantCount, 0);
  if (skus > PRODUCT_IMPORT_MAX_SKUS) {
    problems.push({
      line: 1,
      column: null,
      message: `That file makes ${String(skus)} SKUs; import at most ${String(PRODUCT_IMPORT_MAX_SKUS)} at a time. Split it into smaller files.`,
    });
  }
  return { rows, problems };
}

interface RowState {
  readonly context: ProductImportContext;
  readonly categoriesByKey: ReadonlyMap<string, KnownCategory>;
  readonly existing: ReadonlySet<string>;
  readonly seen: Map<string, number>;
  readonly colourColumn: string;
  readonly problems: ImportProblem[];
}

function reviewRow(row: CsvRow, state: RowState): ProductImportRow | undefined {
  const { line, values } = row;
  const { problems } = state;

  if (values.__fieldCount !== undefined) {
    problems.push({
      line,
      column: null,
      message: `This row has ${values.__fieldCount} fields; the header has a different number. A stray comma shifts every value after it — put lists in quotes or separate them with |.`,
    });
    return undefined;
  }

  const name = (values.name ?? '').trim().replace(/\s+/g, ' ');
  if (name === '') {
    problems.push({ line, column: 'name', message: 'The product name is blank.' });
  } else if (name.length > 200) {
    problems.push({ line, column: 'name', message: 'A product name is at most 200 characters.' });
  } else if (state.existing.has(normal(name))) {
    problems.push({
      line,
      column: 'name',
      message: `"${name}" is already in the catalog. Add sizes or colours to it on its product page instead.`,
    });
  } else {
    const earlier = state.seen.get(normal(name));
    if (earlier !== undefined) {
      problems.push({
        line,
        column: 'name',
        message: `"${name}" is also on line ${String(earlier)}. Each product appears once; list its sizes and colours on one row.`,
      });
    } else {
      state.seen.set(normal(name), line);
    }
  }

  let pricePoisha: Poisha | undefined;
  try {
    pricePoisha = takaTextToPoisha(values.price_taka ?? '');
    if (pricePoisha <= 0n) {
      problems.push({ line, column: 'price_taka', message: 'A selling price is more than zero.' });
    } else if (pricePoisha > MAX_PRICE_POISHA) {
      problems.push({
        line,
        column: 'price_taka',
        message:
          'That price is beyond the importer’s ceiling. Check for a misplaced decimal point.',
      });
    }
  } catch (error) {
    problems.push({
      line,
      column: 'price_taka',
      message: error instanceof Error ? error.message : 'That price is not a number.',
    });
  }

  let categoryId: string | null = null;
  const categoryText = (values.category ?? '').trim();
  if (categoryText !== '') {
    const category = state.categoriesByKey.get(normal(categoryText));
    if (category === undefined) {
      problems.push({
        line,
        column: 'category',
        message: `No category "${categoryText}". Use a category's code or name from Catalog setup, or leave it blank.`,
      });
    } else {
      categoryId = category.id;
    }
  }

  const statusText = normal(values.status ?? '');
  let status: 'draft' | 'active' = 'active';
  if (statusText === 'draft') status = 'draft';
  else if (statusText !== '' && statusText !== 'active') {
    problems.push({ line, column: 'status', message: 'Status is "active", "draft" or blank.' });
  }

  const description = (values.description ?? '').trim();
  if (description.length > 4000) {
    problems.push({
      line,
      column: 'description',
      message: 'A description is at most 4,000 characters.',
    });
  }

  const axes: { attributeId: string; valueIds: string[] }[] = [];
  for (const [column, axis, noun] of [
    ['sizes', state.context.sizes, 'size'],
    [state.colourColumn, state.context.colours, 'colour'],
  ] as const) {
    const listed = splitValueList(values[column] ?? '');
    if (listed.length === 0) continue;
    if (axis === null) {
      problems.push({
        line,
        column,
        message: `This brand has no ${noun} list yet. Add one in Catalog setup first.`,
      });
      continue;
    }
    const ids: string[] = [];
    for (const text of listed) {
      const key = normal(text);
      const matches = axis.values.filter(
        (candidate) => normal(candidate.code) === key || normal(candidate.label) === key,
      );
      // One value's code can be another's label; guessing would build the wrong variant.
      if (matches.length > 1) {
        problems.push({
          line,
          column,
          message: `"${text}" matches more than one value in the ${axis.name} list. Use the value's code.`,
        });
        continue;
      }
      const value = matches[0];
      if (value === undefined) {
        problems.push({
          line,
          column,
          message: `"${text}" is not in the ${axis.name} list. Add it in Catalog setup, or fix the spelling.`,
        });
      } else if (ids.includes(value.id)) {
        problems.push({ line, column, message: `"${text}" is listed twice.` });
      } else {
        ids.push(value.id);
      }
    }
    if (ids.length > 0) axes.push({ attributeId: axis.attributeId, valueIds: ids });
  }

  const variantCount = axes.reduce((count, axis) => count * axis.valueIds.length, 1);
  if (variantCount > MAX_VARIANTS_PER_PRODUCT) {
    problems.push({
      line,
      column: null,
      message: `That is ${String(variantCount)} variants; one product holds at most ${String(MAX_VARIANTS_PER_PRODUCT)}.`,
    });
  }

  if (pricePoisha === undefined) return undefined;
  return {
    line,
    name,
    categoryId,
    pricePoisha,
    status,
    description: description === '' ? null : description,
    axes,
    variantCount,
  };
}

/** A product name into the slug shape the catalog stores; mirrors the console's. */
export function productSlug(name: string, fallbackSeed: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  return slug === '' ? `p-${fallbackSeed}` : slug;
}

/** The first of `base`, `base-2`, `base-3`… nobody has taken, which it then takes. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  for (let suffix = 2; taken.has(slug); suffix += 1) {
    slug = `${base.slice(0, 110)}-${String(suffix)}`;
  }
  taken.add(slug);
  return slug;
}
