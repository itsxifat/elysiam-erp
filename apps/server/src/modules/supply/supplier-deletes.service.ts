import { Injectable } from '@nestjs/common';
import type { UsageEntry, UsageReport } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { describeUses, mergeUses } from '../../platform/references/references.js';
import * as refs from './references.repository.js';
import { mapSupplyErrors, SupplyError } from './supply.errors.js';

/**
 * Deleting a supplier nothing names (M39a, D-630): a duplicate typed by mistake. Its
 * contacts and documents go with it (the files stay in storage); a single entry (draft or
 * received), return, payment, advance or note keeps it, and it is deactivated instead,
 * which the supplier screen already does.
 */
@Injectable()
export class SupplierDeletesService {
  constructor(private readonly audit: AuditService) {}

  async usage(context: ActiveContext, id: string): Promise<UsageReport> {
    return mapSupplyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const supplier = await refs.lockSupplier(tx, context.orgId, id, false);
        if (supplier === undefined) throw notFound();
        const uses = await this.uses(tx, context.orgId, id);
        return {
          kind: 'supplier',
          id,
          label: supplier.name,
          archived: !supplier.is_active,
          canDelete: uses.length === 0,
          canEmptyAndDelete: false,
          canArchive: supplier.is_active,
          uses,
        };
      }),
    );
  }

  async delete(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapSupplyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const supplier = await refs.lockSupplier(tx, context.orgId, id);
        if (supplier === undefined) throw notFound();
        const uses = await this.uses(tx, context.orgId, id);
        if (uses.length > 0) {
          throw new SupplyError(
            'SUPPLY_IN_USE',
            `${supplier.name} has ${describeUses(uses)}. Deactivate the supplier instead; its history stays.`,
          );
        }
        const attachments = await refs.supplierAttachments(tx, context.orgId, id);
        if (!(await refs.deleteSupplier(tx, context.orgId, id))) throw notFound();
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'supply.supplier.deleted',
          entityType: 'Supplier',
          entityId: id,
          before: { ...supplier, ...attachments },
          after: null,
          requestId: context.requestId,
          request,
        });
        return { id, deleted: true };
      }),
    );
  }

  private async uses(tx: Tx, orgId: string, id: string): Promise<UsageEntry[]> {
    const uses = await refs.supplierUses(tx, orgId, id);
    return mergeUses([
      { reason: 'supply_entries', count: uses.entries },
      { reason: 'supplier_payments', count: uses.payments },
      { reason: 'supplier_notes', count: uses.notes },
    ]);
  }
}

function notFound(): SupplyError {
  return new SupplyError('SUPPLY_NOT_FOUND', 'No such supplier.');
}
