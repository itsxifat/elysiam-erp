import { Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  CsvError,
  parseCsv,
  reviewProductImport,
  type ImportProblem,
  type KnownAxis,
  type ProductImportReport,
} from '@elysium/domain';

import type { ActiveContext } from '../../platform/http/context.js';
import { CatalogError } from './catalog.errors.js';
import * as repo from './catalog.repository.js';
import type { ProductImportInput } from './catalog.schemas.js';
import { CatalogService } from './catalog.service.js';

/**
 * The new-products spreadsheet (D-425): check the file, then create every product in it
 * or none.
 *
 * The review is `reviewProductImport` in @elysium/domain, against what the brand has
 * now: its categories, its size and colour lists and the names already in the catalog.
 * The commit runs the same review again inside its own transaction — the file the
 * operator checked a minute ago is not evidence about the catalog now — and creates
 * each product through `CatalogService.createProductIn`, the path the new-product form
 * uses, so codes, sequences and variant keys come out exactly as if typed.
 *
 * No cost column exists here and the review refuses one by name: purchase cost enters
 * when stock is received from a supplier (invariant 5).
 */

export interface ProductImportView {
  readonly totalRows: number;
  /** Products the file would create, when it can be imported. */
  readonly willCreate: number;
  /** SKUs those products would have. */
  readonly skuCount: number;
  readonly problems: readonly ImportProblem[];
  readonly canCommit: boolean;
  readonly reason: string | null;
  readonly preview: readonly {
    readonly line: number;
    readonly name: string;
    readonly categoryName: string | null;
    readonly pricePoisha: string;
    readonly status: 'draft' | 'active';
    readonly sizes: readonly string[];
    readonly colours: readonly string[];
    readonly variantCount: number;
  }[];
}

interface Known {
  readonly categories: readonly repo.CategoryRow[];
  readonly sizes: KnownAxis | null;
  readonly colours: KnownAxis | null;
  readonly names: readonly string[];
}

@Injectable()
export class ProductImportService {
  constructor(private readonly catalog: CatalogService) {}

  async dryRun(context: ActiveContext, input: ProductImportInput): Promise<ProductImportView> {
    return withOrg(context, async (tx) => {
      const known = await this.known(tx, context.orgId);
      let report: ProductImportReport;
      try {
        report = review(input.csv, known);
      } catch (error) {
        if (!(error instanceof CsvError)) throw error;
        report = {
          rows: [],
          problems: [{ line: error.line, column: null, message: error.message }],
        };
      }
      return present(report, known);
    });
  }

  async commit(context: ActiveContext, input: ProductImportInput) {
    return withOrg(context, async (tx) => {
      const known = await this.known(tx, context.orgId);
      const report = review(input.csv, known);
      const verdict = decide(report);
      if (!verdict.ok) {
        throw new CatalogError('CATALOG_IMPORT_REJECTED', verdict.reason);
      }

      const created: { id: string; name: string; skuCount: number }[] = [];
      for (const row of report.rows) {
        // Its web address is its parent SKU in lower case (D-661), as every new product's.
        const product = await this.catalog.createProductIn(tx, context, {
          name: row.name,
          categoryId: row.categoryId,
          description: row.description ?? undefined,
          status: row.status,
          pricePoisha: row.pricePoisha.toString(),
          axes: row.axes.map((axis) => ({
            attributeId: axis.attributeId,
            valueIds: [...axis.valueIds],
          })),
          generateSkus: true,
        });
        created.push({ id: product.id, name: product.name, skuCount: product.skus.length });
      }

      return {
        created: created.length,
        skuCount: created.reduce((total, product) => total + product.skuCount, 0),
        products: created,
      };
    });
  }

  /** What the brand has now: categories, its size and colour lists, its product names. */
  private async known(tx: Tx, orgId: string): Promise<Known> {
    const [categories, attributes, existing] = await Promise.all([
      repo.listCategories(tx, orgId),
      repo.listAttributes(tx, orgId),
      repo.productNamesAndSlugs(tx, orgId),
    ]);
    const values = await repo.listAttributeValues(tx, orgId);

    /*
     * The brand's size list is its first variant attribute of kind `size` (by position),
     * and the same for colour. A brand with two size lists (tops and shoes) imports
     * against the first; the second is still there for the form, which names its axes.
     */
    const axisOf = (kind: 'size' | 'colour'): KnownAxis | null => {
      const attribute = attributes.find((row) => row.kind === kind && row.is_variant);
      if (attribute === undefined) return null;
      return {
        attributeId: attribute.id,
        name: attribute.name,
        values: values
          .filter((value) => value.attribute_id === attribute.id)
          .map((value) => ({ id: value.id, code: value.code, label: value.label })),
      };
    };

    return {
      categories: categories.filter((category) => category.is_active),
      sizes: axisOf('size'),
      colours: axisOf('colour'),
      names: existing.map((row) => row.name),
    };
  }
}

function review(csv: string, known: Known): ProductImportReport {
  return reviewProductImport(parseCsv(csv), {
    categories: known.categories.map((category) => ({
      id: category.id,
      code: category.code,
      name: category.name,
    })),
    sizes: known.sizes,
    colours: known.colours,
    existingNames: known.names,
  });
}

function decide(report: ProductImportReport): { ok: true } | { ok: false; reason: string } {
  if (report.problems.length > 0) {
    const count = report.problems.length;
    return {
      ok: false,
      reason: `${String(count)} problem${count === 1 ? '' : 's'} in that file. Nothing was imported.`,
    };
  }
  if (report.rows.length === 0)
    return { ok: false, reason: 'That file has no products to import.' };
  return { ok: true };
}

function present(report: ProductImportReport, known: Known): ProductImportView {
  const verdict = decide(report);
  const categoryName = new Map(known.categories.map((category) => [category.id, category.name]));
  const label = (axis: KnownAxis | null, ids: readonly string[] | undefined) =>
    (ids ?? []).map((id) => axis?.values.find((value) => value.id === id)?.label ?? id);

  return {
    totalRows:
      report.rows.length +
      new Set(report.problems.filter((p) => p.line > 1).map((p) => p.line)).size,
    willCreate: verdict.ok ? report.rows.length : 0,
    skuCount: report.rows.reduce((total, row) => total + row.variantCount, 0),
    problems: report.problems,
    canCommit: verdict.ok,
    reason: verdict.ok ? null : verdict.reason,
    preview: report.rows.slice(0, 50).map((row) => ({
      line: row.line,
      name: row.name,
      categoryName: row.categoryId === null ? null : (categoryName.get(row.categoryId) ?? null),
      pricePoisha: row.pricePoisha.toString(),
      status: row.status,
      sizes: label(
        known.sizes,
        row.axes.find((axis) => axis.attributeId === known.sizes?.attributeId)?.valueIds,
      ),
      colours: label(
        known.colours,
        row.axes.find((axis) => axis.attributeId === known.colours?.attributeId)?.valueIds,
      ),
      variantCount: row.variantCount,
    })),
  };
}
