import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';

import type { ActiveContext } from '../../platform/http/context.js';
import {
  allOrNothing,
  parseCsv,
  poisha,
  reviewPriceImport,
  type ImportProblem,
  type PriceImportReport,
} from '@elysium/domain';

import { CatalogError } from './catalog.errors.js';
import * as repo from './catalog.repository.js';
import type { PriceImportInput } from './catalog.schemas.js';

/**
 * The selling-price CSV importer (M06 acceptance check 4).
 *
 * Two endpoints, one decision function. `POST /v1/catalog/imports/prices/dry-run`
 * reports and changes nothing; `POST /v1/catalog/imports/prices` applies the file
 * or applies none of it. Both call `reviewPriceImport` from @elysium/domain, so
 * the report an operator approved is the change they get — a dry run with its own
 * idea of validity is worse than no dry run, because it teaches people to trust
 * it.
 *
 * ## Why the commit re-validates instead of trusting a token
 *
 * The obvious design is for the dry run to stash its result and hand back an id
 * the commit redeems. That is wrong here for a reason that has nothing to do with
 * storage: between the two calls somebody may have archived a SKU or repriced it
 * by hand, so the file that was valid at 10:02 is not necessarily valid at 10:05.
 * Re-reading the catalogue at commit time is the only way the atomic step is
 * atomic against *current* data. The cost is parsing a few kilobytes twice.
 *
 * ## Why all-or-nothing is a transaction and not a loop with a flag
 *
 * Every update runs inside one `withOrg` transaction and the refusal is thrown
 * from inside it, so PostgreSQL rolls the whole thing back. A loop that checked
 * first and wrote second would still be interrupted by a connection drop halfway,
 * and "some of these 400 SKUs are repriced and I do not know which" is
 * unrecoverable without the prices from before — which the import destroyed.
 */

export interface ImportReportView {
  readonly totalRows: number;
  readonly willChange: number;
  readonly unchanged: number;
  readonly problems: readonly ImportProblem[];
  readonly canCommit: boolean;
  readonly reason: string | null;
  /** The first few rows, so the console can show what it is about to do. */
  readonly preview: readonly {
    readonly line: number;
    readonly sku: string;
    readonly fromPricePoisha: string | null;
    readonly toPricePoisha: string;
  }[];
}

@Injectable()
export class CatalogImportService {
  async dryRun(context: ActiveContext, input: PriceImportInput): Promise<ImportReportView> {
    return withOrg(context, async (tx) => {
      const known = await repo.allSkuCodesAndPrices(tx, context.orgId);
      return present(review(input.csv, known), known);
    });
  }

  async commit(context: ActiveContext, input: PriceImportInput) {
    return withOrg(context, async (tx) => {
      const known = await repo.allSkuCodesAndPrices(tx, context.orgId);
      const report = review(input.csv, known);
      const verdict = allOrNothing(report);

      if (!verdict.ok) {
        throw new CatalogError(
          'CATALOG_IMPORT_REJECTED',
          verdict.reason ?? 'That file cannot be applied.',
        );
      }

      await repo.setPriceContext(tx, input.reason ?? 'CSV import');

      let applied = 0;
      for (const row of report.rows) {
        // `setSkuPriceByCode` returns false when the SKU vanished between the
        // review above and this statement — a concurrent archive, in the same
        // transaction's snapshot. Throwing rolls back everything already applied,
        // which is the whole point of check 4.
        const ok = await repo.setSkuPriceByCode(
          tx,
          context.orgId,
          row.sku,
          poisha(row.pricePoisha),
          row.barcode,
        );
        if (!ok) {
          throw new CatalogError(
            'CATALOG_IMPORT_REJECTED',
            `${row.sku} changed while the file was being applied. Nothing was changed; run the dry run again.`,
          );
        }
        applied += 1;
      }

      return { applied, unchanged: report.unchanged };
    });
  }
}

function review(
  csv: string,
  known: readonly { code: string; price_poisha: string; barcode: string | null }[],
): PriceImportReport {
  return reviewPriceImport(
    parseCsv(csv),
    known.map((sku) => ({
      code: sku.code,
      pricePoisha: poisha(sku.price_poisha),
      barcode: sku.barcode,
    })),
  );
}

function present(
  report: PriceImportReport,
  known: readonly { code: string; price_poisha: string }[],
): ImportReportView {
  const before = new Map(known.map((sku) => [sku.code, sku.price_poisha]));
  const verdict = allOrNothing(report);

  return {
    totalRows: report.rows.length + report.problems.length,
    willChange: report.rows.length - report.unchanged,
    unchanged: report.unchanged,
    problems: report.problems,
    canCommit: verdict.ok,
    reason: verdict.reason,
    preview: report.rows.slice(0, 20).map((row) => ({
      line: row.line,
      sku: row.sku,
      fromPricePoisha: before.get(row.sku) ?? null,
      toPricePoisha: row.pricePoisha.toString(),
    })),
  };
}
