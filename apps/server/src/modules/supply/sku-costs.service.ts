import { Inject, Injectable } from '@nestjs/common';
import { canReadCost, defineAbilityFor } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  CsvError,
  parseCsv,
  poisha,
  prefillUnitCost,
  reviewStandardCostImport,
  standardCostCsv,
  type StandardCostReport,
} from '@elysium/domain';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import * as repo from './sku-costs.repository.js';
import { mapSupplyErrors, SupplyError } from './supply.errors.js';

const uuid = z.string().uuid('No such record.');
const costSchema = z
  .string()
  .max(16, 'A buying price is integer poisha, sent as a decimal string.')
  .regex(/^[1-9]\d*$/, 'A standard buying price is positive integer poisha.');

/** `GET /v1/supply/sku-costs?skuIds=…&supplierId=…` */
export const skuCostsQuerySchema = z.object({
  skuIds: z
    .string()
    .max(200 * 37)
    .transform((text) => text.split(',').filter((id) => id !== ''))
    .pipe(z.array(uuid).min(1, 'Name at least one variant.').max(200)),
  supplierId: uuid.optional(),
});
export type SkuCostsQuery = z.infer<typeof skuCostsQuerySchema>;

/** `PUT /v1/supply/sku-costs`: set or clear standard buying prices (D-638). */
export const setStandardCostsSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            skuId: uuid,
            /** Null: the standard for any supplier. */
            supplierId: uuid.nullable(),
            /** Null: remove this standard. */
            standardUnitCostPoisha: costSchema.nullable(),
          })
          .strict(),
      )
      .min(1, 'Name at least one variant.')
      .max(500, 'Set at most 500 standard prices at a time.'),
  })
  .strict();
export type SetStandardCostsInput = z.infer<typeof setStandardCostsSchema>;

/** The spreadsheet, as text (like the catalog's own importers). */
export const standardCostImportSchema = z
  .object({
    csv: z
      .string()
      .min(1, 'The file is empty.')
      .max(2_000_000, 'That file is too large to import.'),
  })
  .strict();
export type StandardCostImportInput = z.infer<typeof standardCostImportSchema>;

/** `GET /v1/supply/sku-costs/export?productId=…` */
export const standardCostExportSchema = z.object({ productId: uuid.optional() });

/**
 * Buying prices per variant (M39b, D-637, D-638): what a variant cost last time, what it
 * costs on average, and the brand's standard buying price for it, for any supplier or for one.
 *
 * Purchase cost, so it lives in supply and answers only `read:cost` roles (invariant 5):
 * every route declares `read Cost`, and the service checks `canReadCost` again because a
 * decorator is one refactor from being dropped. A standard price is only ever a **prefill**:
 * the cost that enters inventory and the ledger is the one on a posted receipt, whatever was
 * prefilled, so nothing here touches the weighted average or a journal.
 *
 * The variant names come through `CatalogApi`, the last receipt and the average through
 * `InventoryApi` (invariant 12); the catalog never sees any of it.
 */
@Injectable()
export class SkuCostsService {
  constructor(
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    private readonly audit: AuditService,
  ) {}

  /**
   * The audit row for a write to the standard buying prices, inside its transaction and with
   * **counts only**: the request body carries the prices (a whole spreadsheet, as text the
   * cost deny-list cannot see into), and the append-only log must not keep them (ledger audit
   * W1). Writing it here stands the interceptor's net down for this request.
   */
  private async auditCounts(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    action: string,
    after: Record<string, number>,
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action,
      entityType: 'SkuPurchasePrice',
      entityId: context.orgId,
      before: null,
      after,
      requestId: context.requestId,
      request,
    });
  }

  /**
   * Per variant: its standard buying prices, the last price it was bought at (when, from
   * whom), its weighted average cost, and what a receipt from `supplierId` would start at.
   */
  async costs(context: ActiveContext, query: SkuCostsQuery) {
    return mapSupplyErrors(async () => {
      this.assertCost(context);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const ids = [...new Set(query.skuIds)];
        const skus = await this.catalog.skusByIds(tx, context.orgId, ids);
        const known = skus.map((sku) => sku.id);
        const [standards, last, wac] = await Promise.all([
          repo.standardsFor(tx, context.orgId, known),
          this.inventory.lastReceiptCosts(tx, context.orgId, known),
          this.inventory.costFor(tx, context.orgId, known),
        ]);
        const supplies = await repo.suppliersOfSupplies(
          tx,
          context.orgId,
          [...last.values()]
            .filter((entry) => entry.refType === 'supply' && entry.refId !== null)
            .map((entry) => entry.refId ?? ''),
        );

        return {
          items: known.map((skuId) => {
            const own = standards.filter((row) => row.sku_id === skuId);
            const any = own.find((row) => row.supplier_id === null);
            const forSupplier =
              query.supplierId === undefined
                ? undefined
                : own.find((row) => row.supplier_id === query.supplierId);
            const received = last.get(skuId);
            const prefill = prefillUnitCost({
              supplierStandard:
                forSupplier === undefined ? null : BigInt(forSupplier.standard_unit_cost_poisha),
              standard: any === undefined ? null : BigInt(any.standard_unit_cost_poisha),
              last: received?.unitCostPoisha ?? null,
            });
            const from =
              received?.refType === 'supply' && received.refId !== null
                ? supplies.get(received.refId)
                : undefined;
            return {
              skuId,
              standardUnitCostPoisha: any?.standard_unit_cost_poisha ?? null,
              standards: own.map((row) => ({
                supplierId: row.supplier_id,
                supplierCode: row.supplier_code,
                supplierName: row.supplier_name,
                standardUnitCostPoisha: row.standard_unit_cost_poisha,
              })),
              lastUnitCostPoisha: received?.unitCostPoisha.toString() ?? null,
              lastReceivedOn: received?.businessDate ?? null,
              lastSupplierName: from?.name ?? null,
              wacPoisha: wac.get(skuId)?.toString() ?? null,
              prefillUnitCostPoisha: prefill.unitCostPoisha?.toString() ?? null,
              prefillSource: prefill.source,
            };
          }),
        };
      });
    });
  }

  /** Set, replace or remove standard buying prices, all or nothing (D-638). */
  async setStandards(
    context: ActiveContext,
    request: AuditableRequest,
    input: SetStandardCostsInput,
  ) {
    return mapSupplyErrors(async () => {
      this.assertCost(context);
      this.assertUpdateSupply(context);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const skuIds = [...new Set(input.entries.map((entry) => entry.skuId))];
        const supplierIds = [
          ...new Set(
            input.entries
              .map((entry) => entry.supplierId)
              .filter((id): id is string => id !== null),
          ),
        ];
        const [skus, suppliers] = await Promise.all([
          this.catalog.skusByIds(tx, context.orgId, skuIds),
          repo.suppliersByIds(tx, context.orgId, supplierIds),
        ]);
        if (skus.length !== skuIds.length || suppliers.length !== supplierIds.length) {
          throw new SupplyError(
            'SUPPLY_NOT_FOUND',
            'One of those variants or suppliers is not in this brand. Nothing was changed.',
          );
        }
        const seen = new Set<string>();
        let set = 0;
        let removed = 0;
        for (const entry of input.entries) {
          const key = `${entry.skuId}|${entry.supplierId ?? ''}`;
          if (seen.has(key)) {
            throw new SupplyError(
              'CONFLICT',
              'The same variant and supplier is named twice. Nothing was changed.',
            );
          }
          seen.add(key);
          if (entry.standardUnitCostPoisha === null) {
            if (await repo.deleteStandard(tx, context.orgId, entry.skuId, entry.supplierId)) {
              removed += 1;
            }
          } else {
            await repo.upsertStandard(tx, context.orgId, {
              skuId: entry.skuId,
              supplierId: entry.supplierId,
              unitCostPoisha: poisha(entry.standardUnitCostPoisha),
              updatedBy: context.userId,
            });
            set += 1;
          }
        }
        await this.auditCounts(tx, context, request, 'supply.standard_costs.set', {
          set,
          removed,
        });
        return { set, removed };
      });
    });
  }

  /**
   * The spreadsheet of standard buying prices (D-638): every active variant, one row per
   * standard it has (any supplier, then each supplier's), and one blank row for a variant
   * with none, so the export is also the template. Never from the catalog's export.
   */
  async exportCsv(context: ActiveContext, productId: string | undefined) {
    return mapSupplyErrors(async () => {
      this.assertCost(context);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const skus = await this.catalog.skuDirectory(tx, context.orgId, {
          productId,
          activeOnly: true,
        });
        const standards = await repo.standardsFor(
          tx,
          context.orgId,
          productId === undefined ? null : skus.map((sku) => sku.id),
        );
        const bySku = new Map<string, repo.StandardRow[]>();
        for (const row of standards) {
          bySku.set(row.sku_id, [...(bySku.get(row.sku_id) ?? []), row]);
        }
        const rows = skus.flatMap((sku) => {
          const own = bySku.get(sku.id) ?? [];
          const line = (supplierCode: string | null, cost: bigint | null) => ({
            sku: sku.code,
            product: sku.productName,
            variant: sku.variantLabel,
            supplierCode,
            unitCostPoisha: cost,
          });
          return own.length === 0
            ? [line(null, null)]
            : own.map((row) => line(row.supplier_code, BigInt(row.standard_unit_cost_poisha)));
        });
        return { filename: 'standard-buying-prices.csv', csv: standardCostCsv(rows) };
      });
    });
  }

  /** Step one: report every problem, change nothing. */
  async dryRun(context: ActiveContext, request: AuditableRequest, input: StandardCostImportInput) {
    return mapSupplyErrors(async () => {
      this.assertCost(context);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { report } = await this.review(tx, context.orgId, input.csv);
        await this.auditCounts(tx, context, request, 'supply.standard_costs.checked', {
          rows: report.rows.length,
          skipped: report.skipped,
          problems: report.problems.length,
        });
        return summary(report);
      });
    });
  }

  /** Step two: every priced row, or none (D-638). */
  async commit(context: ActiveContext, request: AuditableRequest, input: StandardCostImportInput) {
    return mapSupplyErrors(async () => {
      this.assertCost(context);
      this.assertUpdateSupply(context);
      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { report, skuIds, supplierIds } = await this.review(tx, context.orgId, input.csv);
        if (report.problems.length > 0) {
          throw new SupplyError(
            'SUPPLY_IMPORT_REJECTED',
            `The file has ${String(report.problems.length)} problem(s); nothing was imported. Check it again.`,
          );
        }
        for (const row of report.rows) {
          const skuId = skuIds.get(row.sku);
          if (skuId === undefined) continue;
          await repo.upsertStandard(tx, context.orgId, {
            skuId,
            supplierId:
              row.supplierCode === null ? null : (supplierIds.get(row.supplierCode) ?? null),
            unitCostPoisha: row.unitCostPoisha,
            updatedBy: context.userId,
          });
        }
        await this.auditCounts(tx, context, request, 'supply.standard_costs.imported', {
          set: report.rows.length,
          skipped: report.skipped,
        });
        return { set: report.rows.length, skipped: report.skipped };
      });
    });
  }

  private async review(tx: Tx, orgId: string, csv: string) {
    let table;
    try {
      table = parseCsv(csv);
    } catch (error) {
      if (error instanceof CsvError) {
        throw new SupplyError('SUPPLY_IMPORT_REJECTED', error.message);
      }
      throw error;
    }
    const [skus, suppliers] = await Promise.all([
      this.catalog.skuDirectory(tx, orgId, { activeOnly: false }),
      repo.allSupplierCodes(tx, orgId),
    ]);
    const skuIds = new Map(skus.map((sku) => [sku.code, sku.id]));
    const supplierIds = new Map(suppliers.map((supplier) => [supplier.code, supplier.id]));
    const report = reviewStandardCostImport(
      table,
      new Set(skuIds.keys()),
      new Set(supplierIds.keys()),
    );
    return { report, skuIds, supplierIds };
  }

  private assertUpdateSupply(context: ActiveContext): void {
    if (!defineAbilityFor(context).can('update', 'Supply')) {
      throw new SupplyError('FORBIDDEN', 'Setting standard buying prices needs Supply access.');
    }
  }

  private assertCost(context: ActiveContext): void {
    if (!canReadCost(context.roles, context.isSuperAdmin)) {
      throw new SupplyError('FORBIDDEN', 'Buying prices are for roles that may see cost.');
    }
  }
}

function summary(report: StandardCostReport) {
  return {
    willSet: report.rows.length,
    skipped: report.skipped,
    problems: report.problems,
    canCommit: report.problems.length === 0 && report.rows.length > 0,
  };
}
