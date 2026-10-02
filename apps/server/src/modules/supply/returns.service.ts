import { Inject, Injectable } from '@nestjs/common';
import { canReadCost } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { businessDate, poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { postingInstant } from './posting-date.js';
import * as repo from './supply.repository.js';
import { mapSupplyErrors, SupplyError } from './supply.errors.js';
import type { SupplyReturnInput } from './supply.schemas.js';

/**
 * Returning stock to a supplier (architecture §7, §8; M09 check 3).
 *
 * The three-way posting is M07's `supplierReturnDraft` and the movements are M07's too,
 * both reached through `INVENTORY_API.returnToSupplier` in one call, because the two
 * costs the journal needs come from two different places: the supplier is credited what
 * they charged, which arrives in the request, and inventory is relieved at what the
 * units are carried at, which is captured **under the cost row's lock** as the movement
 * is written. Reading the average separately would let a concurrent receipt blend a new
 * one in between, and the journal would then relieve inventory at a figure no movement
 * records.
 *
 * So this service's whole job is the paperwork around that call: the header, the lines,
 * the audit row, and refusing a caller who may not see purchase cost. The original unit
 * cost is a cost field (§6, invariant 5) and it is an *input* here — a role that may not
 * read cost must not be able to assert one either, or the purchase price variance
 * becomes a number anybody can steer.
 *
 * §8's worked example is the acceptance check: 3 units credited at ৳540.00 while carried
 * at ৳530.00 leaves 3,000 poisha on the credit side of purchase price variance. The
 * integration suite drives exactly that through this endpoint.
 */
@Injectable()
export class ReturnsService {
  constructor(
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    private readonly audit: AuditService,
  ) {}

  async list(context: ActiveContext, request: object, supplierId: string | undefined) {
    const scope = scopeWhere(request, { branchId: sql`r.branch_id` });
    const withCost = canReadCost(context.roles, context.isSuperAdmin);

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.listReturns(tx, context.orgId, { scope, supplierId });
        return {
          costWithheld: !withCost,
          items: rows.map((row) => ({
            id: row.id,
            supplierId: row.supplier_id,
            supplierName: row.supplier_name,
            supplyId: row.supply_id,
            locationId: row.location_id,
            businessDate: row.business_date,
            reason: row.reason,
            journalId: row.journal_id,
            ...(withCost
              ? {
                  creditPoisha: row.credit_poisha,
                  reliefPoisha: row.relief_poisha,
                  variancePoisha: row.variance_poisha,
                }
              : {}),
          })),
        };
      }),
    );
  }

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: SupplyReturnInput,
    now: Date = new Date(),
  ) {
    if (!canReadCost(context.roles, context.isSuperAdmin)) {
      throw new SupplyError(
        'FORBIDDEN',
        'A supplier return states what the supplier charged, which is purchase cost.',
      );
    }

    return mapSupplyErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // A retried submit answers from the row that exists. The journal is idempotent
        // too, so posting again would be harmless — but the movements are not, and a
        // second set would take the units off the shelf twice.
        const existing = await repo.listReturns(tx, context.orgId, {
          scope: sql`r.id = ${input.returnId}`,
          supplierId: undefined,
        });
        const already = existing[0];
        if (already !== undefined) {
          return {
            id: already.id,
            journalId: already.journal_id,
            businessDate: already.business_date,
            creditPoisha: already.credit_poisha,
            created: false,
          };
        }

        const place = await repo.locationBranch(tx, context.orgId, input.locationId);
        if (place === undefined) {
          throw new SupplyError('STOCK_LOCATION_INVALID', 'No such location.');
        }
        assertInScope(request, { branchId: place.branch_id });

        // After the replay above (C6, D-414).
        const occurredAt = postingInstant(input.occurredAt, now);
        const lines = input.lines.map((line) => ({
          skuId: line.skuId,
          qty: line.qty,
          originalUnitCostPoisha: poisha(line.originalUnitCostPoisha),
        }));

        const posted = await this.inventory.returnToSupplier(
          tx,
          { orgId: context.orgId, userId: context.userId },
          {
            returnId: input.returnId,
            supplierId: input.supplierId,
            locationId: input.locationId,
            branchId: place.branch_id,
            occurredAt,
            lines,
            memo: input.reason,
          },
        );

        const date = businessDate(occurredAt);
        await repo.insertReturn(tx, {
          orgId: context.orgId,
          id: input.returnId,
          supplierId: input.supplierId,
          supplyId: input.supplyId ?? null,
          locationId: input.locationId,
          occurredAt,
          businessDate: date,
          reason: input.reason,
          journalId: posted.journalId,
          createdBy: context.userId,
        });
        for (const line of lines) {
          await repo.insertReturnLine(tx, {
            orgId: context.orgId,
            returnId: input.returnId,
            skuId: line.skuId,
            qty: line.qty,
            originalUnitCostPoisha: line.originalUnitCostPoisha,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'supply.returned',
          entityType: 'SupplyReturn',
          entityId: input.returnId,
          before: null,
          after: {
            supplierId: input.supplierId,
            journalId: posted.journalId,
            businessDate: date,
            creditPoisha: posted.valuePoisha,
          },
          requestId: context.requestId,
          request,
        });

        return {
          id: input.returnId,
          journalId: posted.journalId,
          businessDate: date,
          creditPoisha: posted.valuePoisha,
          movementIds: posted.movementIds,
          created: true,
        };
      }),
    );
  }
}
