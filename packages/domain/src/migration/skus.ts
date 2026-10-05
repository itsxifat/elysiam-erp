/**
 * The SKU importer's rules (M14a; §8, M06).
 *
 * Columns: `product, sku, price_taka` and, optionally, `category, size, colour, barcode`.
 * Rows sharing a product name become one product, one SKU per row. This is the *opening
 * set* of a brand's catalog, and its rules follow from that (D-219):
 *
 * - **The brand's own codes are kept.** They are printed on labels already on the shelves
 *   and typed into courier sheets; regenerating them would make every existing label wrong.
 *   They must still be codes this system can scan (`isSkuCode`).
 * - **Sizes and colours resolve against the brand's attributes, and are never created
 *   here.** A value is a label on every product page and a segment of future codes, and an
 *   importer that invented `Sky Blue` beside `Sky-Blue` would make two of them silently.
 * - **A code already in the catalog is skipped, and reported.** Re-running an edited file
 *   adds what is new and leaves the rest. But a product partly in the catalog is refused:
 *   completing its matrix is the product page's job, where the existing SKUs are visible.
 *
 * Selling price only. A `cost` column is an unknown column and refused (invariant 5).
 */

import type { CsvTable } from '../catalog/csv.js';
import { MAX_PRICE_POISHA, takaTextToPoisha } from '../catalog/price-import.js';
import { isSkuCode } from '../catalog/sku-code.js';
import type { Poisha } from '../money/index.js';
import { cell, checkColumns, SeenKeys, shapeProblem, type ImportProblem } from './common.js';

export const SKUS_REQUIRED = ['product', 'sku', 'price_taka'] as const;
export const SKUS_OPTIONAL = ['category', 'size', 'colour', 'barcode'] as const;

export interface ImportSku {
  readonly line: number;
  readonly code: string;
  readonly pricePoisha: Poisha;
  readonly barcode: string | null;
  /** Attribute value ids, one per axis the product uses, in axis order (size, colour). */
  readonly valueIds: readonly string[];
}

export interface ImportProduct {
  readonly name: string;
  readonly categoryId: string | null;
  /** Attribute ids of the product's axes, in order. Empty for an unvaried product. */
  readonly axisAttributeIds: readonly string[];
  readonly skus: readonly ImportSku[];
}

/** One variant attribute (size or colour), and its values by lower-cased code and label. */
export interface VariantAttributeRef {
  readonly attributeId: string;
  readonly values: ReadonlyMap<string, string>;
}

export interface SkusRefs {
  readonly existingCodes: ReadonlySet<string>;
  readonly existingBarcodes: ReadonlySet<string>;
  readonly existingProductNames: ReadonlySet<string>;
  /** By lower-cased category code. */
  readonly categories: ReadonlyMap<string, string>;
  readonly size: VariantAttributeRef | null;
  readonly colour: VariantAttributeRef | null;
}

export interface SkusReview {
  readonly products: readonly ImportProduct[];
  readonly skipped: readonly { readonly line: number; readonly code: string }[];
  readonly problems: readonly ImportProblem[];
  readonly skuCount: number;
}

interface ParsedRow {
  readonly line: number;
  readonly product: string;
  readonly code: string;
  readonly pricePoisha: Poisha;
  readonly categoryId: string | null;
  readonly barcode: string | null;
  readonly sizeId: string | null;
  readonly colourId: string | null;
  readonly exists: boolean;
}

function resolveValue(
  text: string,
  attribute: VariantAttributeRef | null,
  what: 'size' | 'colour',
  line: number,
  problems: ImportProblem[],
): string | null {
  if (text === '') return null;
  if (attribute === null) {
    problems.push({
      line,
      column: what,
      message: `This brand has no ${what} attribute yet. Add it under Catalog → Structure first.`,
    });
    return null;
  }
  const id = attribute.values.get(text.toLowerCase());
  if (id === undefined) {
    problems.push({
      line,
      column: what,
      message: `"${text}" is not one of this brand's ${what}s. Add it under Catalog → Structure first; the import never creates one.`,
    });
    return null;
  }
  return id;
}

export function reviewSkus(table: CsvTable, refs: SkusRefs): SkusReview {
  const problems: ImportProblem[] = [];
  if (!checkColumns(table, SKUS_REQUIRED, SKUS_OPTIONAL, problems)) {
    return { products: [], skipped: [], problems, skuCount: 0 };
  }

  const codes = new SeenKeys();
  const barcodes = new SeenKeys();
  const parsed: ParsedRow[] = [];

  for (const row of table.rows) {
    const shape = shapeProblem(row);
    if (shape !== null) {
      problems.push(shape);
      continue;
    }
    const { line } = row;
    const before = problems.length;

    const product = cell(row, 'product');
    if (product === '' || product.length > 160) {
      problems.push({ line, column: 'product', message: 'A product name is 1 to 160 characters.' });
    }

    const code = cell(row, 'sku').toUpperCase();
    if (!isSkuCode(code)) {
      problems.push({
        line,
        column: 'sku',
        message: 'A SKU code is upper-case letters, digits and dashes, up to 64 characters.',
      });
    } else {
      const first = codes.claim(code, line);
      if (first !== undefined) {
        problems.push({
          line,
          column: 'sku',
          message: `"${code}" also appears on line ${String(first)}. Each SKU may appear once.`,
        });
      }
    }

    let pricePoisha: Poisha | null = null;
    try {
      pricePoisha = takaTextToPoisha(cell(row, 'price_taka'));
      if (pricePoisha <= 0n || pricePoisha > MAX_PRICE_POISHA) {
        problems.push({
          line,
          column: 'price_taka',
          message: 'A selling price is more than zero and within the catalog ceiling.',
        });
      }
    } catch (error) {
      problems.push({
        line,
        column: 'price_taka',
        message: error instanceof Error ? error.message : 'That price is not a number.',
      });
    }

    const categoryText = cell(row, 'category');
    const categoryId =
      categoryText === '' ? null : (refs.categories.get(categoryText.toLowerCase()) ?? null);
    if (categoryText !== '' && categoryId === null) {
      problems.push({
        line,
        column: 'category',
        message: `No category "${categoryText}" in this brand.`,
      });
    }

    const barcodeText = cell(row, 'barcode');
    if (barcodeText !== '') {
      if (!/^[\x20-\x7e]{1,48}$/.test(barcodeText)) {
        problems.push({
          line,
          column: 'barcode',
          message: 'A Code 128 barcode holds printable ASCII, up to 48 characters.',
        });
      } else if (/^2\d{12}$/.test(barcodeText)) {
        // The ERP numbers its own SKUs in this range (D-603): an imported one could equal a
        // number this same import hands another SKU, or one handed out later.
        problems.push({
          line,
          column: 'barcode',
          message:
            'Thirteen digits starting with 2 are the ERP’s own barcodes; leave the cell empty and the ERP gives the SKU one.',
        });
      } else {
        const first = barcodes.claim(barcodeText, line);
        if (first !== undefined) {
          problems.push({
            line,
            column: 'barcode',
            message: `That barcode is also on line ${String(first)}.`,
          });
        }
      }
    }

    const sizeId = resolveValue(cell(row, 'size'), refs.size, 'size', line, problems);
    const colourId = resolveValue(cell(row, 'colour'), refs.colour, 'colour', line, problems);

    if (problems.length !== before || pricePoisha === null) continue;

    const exists = refs.existingCodes.has(code);
    if (!exists && barcodeText !== '' && refs.existingBarcodes.has(barcodeText)) {
      problems.push({
        line,
        column: 'barcode',
        message: 'That barcode is already on another SKU in this brand.',
      });
      continue;
    }

    parsed.push({
      line,
      product,
      code,
      pricePoisha,
      categoryId,
      barcode: barcodeText === '' ? null : barcodeText,
      sizeId,
      colourId,
      exists,
    });
  }

  // Group by product name, keeping file order.
  const groups = new Map<string, ParsedRow[]>();
  for (const row of parsed) {
    const group = groups.get(row.product) ?? [];
    group.push(row);
    groups.set(row.product, group);
  }

  const products: ImportProduct[] = [];
  const skipped: { line: number; code: string }[] = [];

  for (const [name, rows] of groups) {
    const head = rows[0];
    if (head === undefined) continue;
    const fresh = rows.filter((row) => !row.exists);

    if (fresh.length === 0) {
      for (const row of rows) skipped.push({ line: row.line, code: row.code });
      continue;
    }
    if (fresh.length !== rows.length) {
      const existing = rows.find((row) => row.exists);
      for (const row of fresh) {
        problems.push({
          line: row.line,
          column: 'product',
          message: `"${name}" is partly in the catalog already (${existing?.code ?? ''} exists). Add its other variants from the product's page.`,
        });
      }
      continue;
    }
    if (refs.existingProductNames.has(name)) {
      for (const row of rows) {
        problems.push({
          line: row.line,
          column: 'product',
          message: `A product named "${name}" is already in the catalog. Add these SKUs from its page, or name the new product differently.`,
        });
      }
      continue;
    }

    const before = problems.length;
    const hasSize = head.sizeId !== null;
    const hasColour = head.colourId !== null;
    const combos = new SeenKeys();
    for (const row of rows) {
      if (row.categoryId !== head.categoryId) {
        problems.push({
          line: row.line,
          column: 'category',
          message: `Every row of "${name}" names the same category as line ${String(head.line)}.`,
        });
      }
      if ((row.sizeId !== null) !== hasSize || (row.colourId !== null) !== hasColour) {
        problems.push({
          line: row.line,
          column: hasSize ? 'size' : 'colour',
          message: `Every row of "${name}" fills the same variant columns as line ${String(head.line)}.`,
        });
        continue;
      }
      const combo = `${row.sizeId ?? ''}|${row.colourId ?? ''}`;
      const first = combos.claim(combo, row.line);
      if (first !== undefined) {
        problems.push({
          line: row.line,
          column: hasSize ? 'size' : 'sku',
          message: `"${name}" already has this variant on line ${String(first)}.`,
        });
      }
    }
    if (rows.length > 1 && !hasSize && !hasColour) {
      for (const row of rows.slice(1)) {
        problems.push({
          line: row.line,
          column: 'size',
          message: `"${name}" has several SKUs, so each needs a size or a colour to tell them apart.`,
        });
      }
    }
    if (problems.length !== before) continue;

    const axisAttributeIds = [
      ...(hasSize && refs.size !== null ? [refs.size.attributeId] : []),
      ...(hasColour && refs.colour !== null ? [refs.colour.attributeId] : []),
    ];

    products.push({
      name,
      categoryId: head.categoryId,
      axisAttributeIds,
      skus: rows.map((row) => ({
        line: row.line,
        code: row.code,
        pricePoisha: row.pricePoisha,
        barcode: row.barcode,
        valueIds: [
          ...(row.sizeId !== null ? [row.sizeId] : []),
          ...(row.colourId !== null ? [row.colourId] : []),
        ],
      })),
    });
  }

  return {
    products: problems.length === 0 ? products : [],
    skipped,
    problems,
    skuCount: problems.length === 0 ? products.reduce((n, p) => n + p.skus.length, 0) : 0,
  };
}

/**
 * The slug an imported product gets: its name in the catalog's slug shape, made unique.
 *
 * The console's `slugify` falls back to a timestamp for a name with no ASCII; an import
 * has to be deterministic instead (a re-run of the same file must produce the same rows),
 * so a Bangla-only name falls back to `product-<sequence>`, and a slug already taken —
 * in the catalog or earlier in the same file — gets the product's sequence appended.
 * The sequence is unique per org, so the fallback cannot collide with another import.
 */
export function importSlug(name: string, sequence: number, taken: ReadonlySet<string>): string {
  const base = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  const stem = base === '' ? 'product' : base;
  if (base !== '' && !taken.has(stem)) return stem;
  let candidate = `${stem}-${String(sequence)}`;
  for (let n = 2; taken.has(candidate); n += 1)
    candidate = `${stem}-${String(sequence)}-${String(n)}`;
  return candidate;
}
