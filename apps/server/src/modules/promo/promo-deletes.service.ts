import { Injectable } from '@nestjs/common';
import type { UsageEntry, UsageReport } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { describeUses, mergeUses } from '../../platform/references/references.js';
import { DiscountReferences } from './ports/discount-references.port.js';
import { PromoError } from './promo.errors.js';
import * as repo from './promo.repository.js';
import * as refs from './references.repository.js';

/**
 * Deleting, archiving and restoring discounts and flash sales (M39a, D-631).
 *
 * A discount nobody redeemed and no order or greeting names is deleted with its tiers; one
 * that was used is archived (it already could be) and keeps the record of what it took off.
 * An archived discount comes back **paused**, never straight to active: somebody looks at
 * it before buyers can use it again. A flash sale that sold nothing is deleted with its
 * items; one that sold is archived (switched off and out of the list), keeping the prices it
 * sold at, and comes back switched off.
 */
@Injectable()
export class PromoDeletesService {
  constructor(
    private readonly references: DiscountReferences,
    private readonly audit: AuditService,
  ) {}

  // --- discounts -----------------------------------------------------------------------------

  async discountUsage(context: ActiveContext, id: string): Promise<UsageReport> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const code = await refs.lockCode(tx, context.orgId, id, false);
      if (code === undefined) throw notFound();
      const uses = await this.discountUses(tx, context.orgId, id);
      const archived = code.status === 'archived';
      return {
        kind: 'discount',
        id,
        label: code.title !== '' ? code.title : (code.code ?? ''),
        archived,
        canDelete: uses.length === 0,
        canEmptyAndDelete: false,
        canArchive: !archived,
        uses,
      };
    });
  }

  async deleteDiscount(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const code = await refs.lockCode(tx, context.orgId, id);
      if (code === undefined) throw notFound();
      const uses = await this.discountUses(tx, context.orgId, id);
      if (uses.length > 0) {
        throw new PromoError(
          'PROMO_IN_USE',
          `This discount was used: ${describeUses(uses)}. Archive it instead, so those orders keep their discount record.`,
        );
      }
      const tiers = await refs.tiersOfCode(tx, context.orgId, id);
      await this.references.release(tx, context.orgId, 'discount', [id]);
      if (!(await refs.deleteCode(tx, context.orgId, id))) throw notFound();
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'promo.code.deleted',
        entityType: 'PromoCode',
        entityId: id,
        before: { ...code, tiers },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { id, deleted: true };
    });
  }

  /** Archived → paused. Never straight to active (D-631). */
  async restoreDiscount(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const code = await refs.lockCode(tx, context.orgId, id);
      if (code === undefined) throw notFound();
      if (code.status !== 'archived') return { id, status: code.status };
      await repo.setCodeStatus(tx, context.orgId, id, 'paused');
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'promo.code.restored',
        entityType: 'PromoCode',
        entityId: id,
        before: { status: 'archived' },
        after: { status: 'paused' },
        requestId: context.requestId,
        request,
      });
      return { id, status: 'paused' };
    });
  }

  // --- flash sales ---------------------------------------------------------------------------

  async flashUsage(context: ActiveContext, id: string): Promise<UsageReport> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const sale = await refs.lockSale(tx, context.orgId, id, false);
      if (sale === undefined) throw flashNotFound();
      const uses = await this.flashUses(tx, context.orgId, id);
      const archived = sale.archived_at !== null;
      return {
        kind: 'flash_sale',
        id,
        label: sale.title,
        archived,
        canDelete: uses.length === 0,
        canEmptyAndDelete: false,
        canArchive: !archived,
        uses,
      };
    });
  }

  async deleteFlashSale(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const sale = await refs.lockSale(tx, context.orgId, id);
      if (sale === undefined) throw flashNotFound();
      const uses = await this.flashUses(tx, context.orgId, id);
      if (uses.length > 0) {
        throw new PromoError(
          'PROMO_IN_USE',
          `This sale sold: ${describeUses(uses)}. Archive it instead, so the prices it sold at stay on record.`,
        );
      }
      const items = await refs.itemsImage(tx, context.orgId, id);
      await this.references.release(tx, context.orgId, 'flash_sale', [id]);
      if (!(await refs.deleteSale(tx, context.orgId, id))) throw flashNotFound();
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'promo.flash_sale.deleted',
        entityType: 'FlashSale',
        entityId: id,
        before: { ...sale, items },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { id, deleted: true };
    });
  }

  async setFlashArchived(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    archived: boolean,
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const sale = await refs.lockSale(tx, context.orgId, id);
      if (sale === undefined) throw flashNotFound();
      if ((sale.archived_at !== null) === archived) return { id, archived };
      await refs.setSaleArchived(tx, context.orgId, id, archived);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: archived ? 'promo.flash_sale.archived' : 'promo.flash_sale.restored',
        entityType: 'FlashSale',
        entityId: id,
        before: { enabled: sale.enabled, archived: sale.archived_at !== null },
        after: { enabled: archived ? false : sale.enabled, archived },
        requestId: context.requestId,
        request,
      });
      return { id, archived };
    });
  }

  // --- internals -----------------------------------------------------------------------------

  private async discountUses(tx: Tx, orgId: string, id: string): Promise<UsageEntry[]> {
    return mergeUses([
      { reason: 'redemptions', count: await refs.redemptionCount(tx, orgId, id) },
      ...(await this.references.references(tx, orgId, 'discount', [id])),
    ]);
  }

  private async flashUses(tx: Tx, orgId: string, id: string): Promise<UsageEntry[]> {
    const sold = await refs.saleSold(tx, orgId, id);
    return mergeUses([
      { reason: 'flash_claims', count: Math.max(sold.claims, sold.unitsSold > 0 ? 1 : 0) },
      ...(await this.references.references(tx, orgId, 'flash_sale', [id])),
    ]);
  }
}

function notFound(): PromoError {
  return new PromoError('PROMO_NOT_FOUND', 'No such discount.');
}

function flashNotFound(): PromoError {
  return new PromoError('FLASH_SALE_NOT_FOUND', 'No such flash sale.');
}
