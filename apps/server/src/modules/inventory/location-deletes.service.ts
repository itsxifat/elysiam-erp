import { Injectable } from '@nestjs/common';
import type { UsageEntry, UsageReport } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { describeUses, mergeUses } from '../../platform/references/references.js';
import { stockReferenceUses } from './catalog-references.binding.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import * as repo from './inventory.repository.js';
import { LocationReferences } from './ports/location-references.port.js';
import * as refs from './references.repository.js';

/**
 * Deleting, archiving and restoring a stock location (M39a, D-629).
 *
 * A location created by mistake (a typo, a second "Main warehouse") that nothing has ever
 * named is deleted. Anything that ever moved stock there, or that a till, an order, a supply
 * entry, a courier return or the website's stock setting names, keeps it: it is switched off
 * instead ("archived"), which 0033 already enforces — no movement at an inactive location —
 * and which is refused while it still holds stock, reservations or a transfer on its way.
 */
@Injectable()
export class LocationDeletesService {
  constructor(
    private readonly references: LocationReferences,
    private readonly audit: AuditService,
  ) {}

  async usage(context: ActiveContext, request: object, id: string): Promise<UsageReport> {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const location = await refs.lockLocationImage(tx, context.orgId, id, false);
        if (location === undefined) throw notFound();
        assertInScope(request, { branchId: location.branch_id });
        const uses = await this.uses(tx, context.orgId, id);
        return {
          kind: 'location',
          id,
          label: location.name,
          archived: !location.is_active,
          canDelete: uses.length === 0,
          canEmptyAndDelete: false,
          canArchive: location.is_active,
          uses,
        };
      }),
    );
  }

  async delete(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const location = await refs.lockLocationImage(tx, context.orgId, id);
        if (location === undefined) throw notFound();
        assertInScope(request, { branchId: location.branch_id });
        const uses = await this.uses(tx, context.orgId, id);
        if (uses.length > 0) {
          throw new StockError(
            'INVENTORY_IN_USE',
            `${location.name} is used by ${describeUses(uses)}. Switch it off instead; its history stays.`,
          );
        }
        await this.references.release(tx, context.orgId, 'location', [id]);
        if (!(await refs.deleteLocation(tx, context.orgId, id))) throw notFound();
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'inventory.location.deleted',
          entityType: 'Location',
          entityId: id,
          before: { ...location },
          after: null,
          requestId: context.requestId,
          request,
        });
        return { id, deleted: true };
      }),
    );
  }

  /** Switch a location off (archive) or back on (restore), with the existing guard. */
  async setArchived(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    archived: boolean,
  ) {
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const location = await refs.lockLocationImage(tx, context.orgId, id);
        if (location === undefined) throw notFound();
        assertInScope(request, { branchId: location.branch_id });
        if (location.is_active === !archived) return { id, archived };
        if (archived && (await repo.locationInUse(tx, context.orgId, id))) {
          throw new StockError(
            'STOCK_LOCATION_INVALID',
            'This location still holds stock, stock held for orders or a transfer on its way. Move or receive it first; a switched-off location can take no movement.',
          );
        }
        await repo.updateLocation(tx, context.orgId, id, { isActive: !archived });
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: archived ? 'inventory.location.archived' : 'inventory.location.restored',
          entityType: 'Location',
          entityId: id,
          before: { isActive: location.is_active },
          after: { isActive: !archived },
          requestId: context.requestId,
          request,
        });
        return { id, archived };
      }),
    );
  }

  private async uses(tx: Tx, orgId: string, id: string): Promise<UsageEntry[]> {
    return mergeUses([
      ...stockReferenceUses(await refs.locationStockUses(tx, orgId, id)),
      ...(await this.references.references(tx, orgId, 'location', [id])),
    ]);
  }
}

function notFound(): StockError {
  return new StockError('STOCK_NOT_FOUND', 'No such location.');
}
