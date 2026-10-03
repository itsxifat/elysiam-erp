import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './inventory.repository.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import type {
  CreateLocationInput,
  MovementQuery,
  SetReorderLevelInput,
  StockQuery,
  UpdateLocationInput,
} from './inventory.schemas.js';

/**
 * Locations, the stock list and the movement log (architecture §8; M07 check 6).
 *
 * The cost story here is the whole of invariant 5's console-facing half, and it is
 * arranged so that forgetting is impossible rather than unlikely:
 *
 * * the SQL selects `wac_poisha` and `stock_value_poisha` unconditionally — one
 *   query, not one per role;
 * * both names are in `COST_FIELDS`, so `SerializeInterceptor` runs `serializeFor`
 *   against this route's own subject and removes them for any caller without
 *   `read Cost`;
 * * check 6 — "sales sees available quantity with no cost or value fields" — is
 *   therefore a property of the field *names*, and `assertNoCostFields` in the e2e
 *   suite is what fails if a future field is called something else.
 *
 * Branching the SQL on the caller's role instead would put the decision in two
 * places, and the second one is the one that gets it wrong.
 *
 * Branch scope is applied to the **location's** branch. §6 gives every stock-reading
 * role `read Stock` at `org` scope — a showroom needs to see that another branch
 * holds the size before it offers a transfer — so the filter is a no-op for them
 * today. It is still applied, because the day a role gets `branch` stock visibility,
 * `ScopeInterceptor` refuses these responses until somebody maps the column, which
 * is the failure mode the mandatory scope exists for (D-061).
 */

export interface StockRowView {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productId: string;
  readonly productName: string;
  /** The SKU's size, colour… in axis order (`M / Red`); empty for an unvaried SKU. */
  readonly variantLabel: string;
  readonly skuStatus: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly branchId: string | null;
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
  readonly reorderLevel: number;
  /** Cost roles only; removed by `serializeFor` for everyone else. */
  readonly wacPoisha: string;
  readonly stockValuePoisha: string;
}

@Injectable()
export class StockService {
  constructor(private readonly audit: AuditService) {}

  // --- locations --------------------------------------------------------------

  async listLocations(context: ActiveContext, request: object, includeInactive: boolean) {
    const scope = scopeWhere(request, { branchId: sql`l.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listLocations(tx, context.orgId, { scope, includeInactive })).map(
        (row) => ({
          id: row.id,
          branchId: row.branch_id,
          code: row.code,
          name: row.name,
          kind: row.kind,
          isActive: row.is_active,
        }),
      ),
    }));
  }

  async createLocation(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateLocationInput,
  ) {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const branchId = input.branchId ?? null;
        /*
         * A showroom is always a branch's; damaged and in-transit are never one.
         *
         * A showroom with no branch would be invisible on every branch manager's
         * screen, and neither refusal announces itself otherwise — both are valid
         * rows. A warehouse may go either way and the seed makes use of that: the
         * main warehouse is attached to the HQ branch so its stock appears in HQ's
         * figures, while a second regional warehouse serving every brand branch
         * legitimately belongs to none.
         *
         * `damaged` and `in_transit` are org-level because both are holding places
         * the whole org shares. A `damaged` location attached to one showroom would
         * make every other branch's damaged stock unrecordable, and §8 gives a
         * transfer one in-transit location to pass through.
         */
        if (input.kind === 'showroom' && branchId === null) {
          throw new StockError(
            'STOCK_LOCATION_INVALID',
            'A showroom location belongs to a branch; name it.',
          );
        }
        if ((input.kind === 'damaged' || input.kind === 'in_transit') && branchId !== null) {
          throw new StockError(
            'STOCK_LOCATION_INVALID',
            'A damaged or in-transit location is org-level: the whole brand shares it (§8).',
          );
        }
        assertInScope(request, { branchId });

        const existing = await repo.locationByCode(tx, context.orgId, input.code);
        if (existing !== undefined) {
          throw new StockError(
            'STOCK_LOCATION_INVALID',
            `A location with code ${input.code} already exists in this brand.`,
          );
        }

        const id = await repo.insertLocation(tx, {
          orgId: context.orgId,
          branchId,
          code: input.code,
          name: input.name,
          kind: input.kind,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'inventory.location.created',
          entityType: 'Location',
          entityId: id,
          before: null,
          after: { code: input.code, name: input.name, kind: input.kind, branchId },
          requestId: context.requestId,
          request,
        });

        return {
          id,
          code: input.code,
          name: input.name,
          kind: input.kind,
          branchId,
          isActive: true,
        };
      }),
    );
  }

  async updateLocation(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    patch: UpdateLocationInput,
  ) {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await repo.locationById(tx, context.orgId, id);
        if (before === undefined) throw new StockError('STOCK_NOT_FOUND', 'No such location.');
        assertInScope(request, { branchId: before.branch_id });

        await repo.updateLocation(tx, context.orgId, id, patch);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.location.updated',
          entityType: 'Location',
          entityId: id,
          before: { name: before.name, isActive: before.is_active },
          after: patch,
          requestId: context.requestId,
          request,
        });
        return { id };
      }),
    );
  }

  // --- stock views ------------------------------------------------------------

  async listStock(
    context: ActiveContext,
    request: object,
    query: StockQuery,
  ): Promise<{ items: StockRowView[]; page: number; pageSize: number }> {
    const scope = scopeWhere(request, { branchId: sql`l.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listStock(tx, context.orgId, {
        scope,
        locationId: query.locationId,
        skuQuery: query.q,
        productId: query.productId,
        categoryId: query.categoryId,
        lowOnly: query.low === true,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      });
      return {
        page: query.page,
        pageSize: query.pageSize,
        items: rows.map((row) => ({
          skuId: row.sku_id,
          skuCode: row.sku_code,
          productId: row.product_id,
          productName: row.product_name,
          variantLabel: row.variant_label,
          skuStatus: row.sku_status,
          locationId: row.location_id,
          locationCode: row.location_code,
          locationName: row.location_name,
          branchId: row.branch_id,
          onHand: row.on_hand,
          reserved: row.reserved,
          available: row.available,
          reorderLevel: row.reorder_level,
          wacPoisha: row.wac_poisha,
          stockValuePoisha: row.stock_value_poisha,
        })),
      };
    });
  }

  /**
   * Stock valuation: units and value (§7's report list, cost roles only).
   *
   * The route declares `read Cost`, so a caller without it never reaches this — and
   * the `stockValuePoisha` name means that even if the ability were widened by
   * mistake, `serializeFor` would empty the number rather than publish it. Two
   * independent controls for one figure, because this is the number that tells a
   * reseller what a brand's margin is.
   */
  async valuation(context: ActiveContext, request: object, locationId?: string) {
    const scope = scopeWhere(request, { branchId: sql`l.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const totals = await repo.stockValuation(tx, context.orgId, { scope, locationId });
      return { units: totals.units, stockValuePoisha: totals.stockValuePoisha };
    });
  }

  async listMovements(context: ActiveContext, request: object, query: MovementQuery) {
    const scope = scopeWhere(request, { branchId: sql`l.branch_id`, createdBy: sql`m.created_by` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      page: query.page,
      pageSize: query.pageSize,
      items: (
        await repo.listMovements(tx, context.orgId, {
          scope,
          skuId: query.skuId,
          productId: query.productId,
          locationId: query.locationId,
          from: query.from,
          to: query.to,
          limit: query.pageSize,
          offset: (query.page - 1) * query.pageSize,
        })
      ).map((row) => ({
        id: row.id,
        skuId: row.sku_id,
        skuCode: row.sku_code,
        locationId: row.location_id,
        locationCode: row.location_code,
        locationName: row.location_name,
        kind: row.kind,
        qtyDelta: row.qty_delta,
        // Cost, and named so `serializeFor` removes it for a warehouse packer.
        unitCostPoisha: row.unit_cost_poisha,
        refType: row.ref_type,
        refId: row.ref_id,
        businessDate: row.business_date,
        memo: row.memo,
        createdBy: row.created_by,
        createdAt: row.created_at,
      })),
    }));
  }

  /**
   * Set a SKU's reorder level at a location (§8 "Low stock").
   *
   * Creates the level row at zero on-hand if the SKU has never been at this
   * location, which is the one legitimate way a level row appears without a
   * movement — and migration 0033's trigger allows exactly that case, because a
   * reorder level is configuration rather than stock.
   */
  async setReorderLevel(
    context: ActiveContext,
    request: AuditableRequest,
    input: SetReorderLevelInput,
  ) {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const location = await repo.locationById(tx, context.orgId, input.locationId);
        if (location === undefined) {
          throw new StockError('STOCK_LOCATION_INVALID', 'No such location in this brand.');
        }
        assertInScope(request, { branchId: location.branch_id });
        if (!(await repo.skuExists(tx, context.orgId, input.skuId))) {
          throw new StockError('STOCK_NOT_FOUND', 'No such SKU in this brand.');
        }

        await repo.setReorderLevel(tx, {
          orgId: context.orgId,
          skuId: input.skuId,
          locationId: input.locationId,
          reorderLevel: input.reorderLevel,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.reorder_level.set',
          entityType: 'StockLevel',
          entityId: `${input.skuId}:${input.locationId}`,
          before: null,
          after: { reorderLevel: input.reorderLevel },
          requestId: context.requestId,
          request,
        });

        return {
          skuId: input.skuId,
          locationId: input.locationId,
          reorderLevel: input.reorderLevel,
        };
      }),
    );
  }
}
