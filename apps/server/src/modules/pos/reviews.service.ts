import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { poisha } from '@elysium/domain';
import {
  discountCeilingBps,
  linesAboveCeiling,
  priceLines,
  refundFor,
  type HoldReason,
} from '@elysium/domain/pos';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { posHttpError } from './pos.errors.js';
import * as repo from './pos.repository.js';
import type { ResolveReviewInput } from './pos.schemas.js';
import { PosPostingService } from './posting.service.js';

/**
 * The manager's side of the offline queue (§14: "the conflict becomes a manager
 * review item"), and receipt lookup for returns.
 *
 * Resolving is **post** or **void**, and two rules make it a real control rather
 * than a button:
 *
 * * **Not the seller.** A cashier resolving their own held sale is the till
 *   approving itself. The person who rang the sale (or took the return) may never
 *   resolve it — the POS's version of the database rule that no requester approves
 *   their own request.
 * * **Within the resolver's own ceiling.** Posting a sale held for its discount
 *   means *this* person grants that discount, so their ceiling at this branch has to
 *   cover it — including a price below the catalog's, which is a discount by
 *   another name. A branch manager cannot launder a 60% discount through the review
 *   queue.
 *
 * Posting goes through the same `PosPostingService` the sync uses, so a sale
 * posted from here has the same movements and the same journal, keyed the same
 * way. A shortfall that has not been fixed yet leaves the item open with its
 * evidence refreshed; the fix is a stock count or a transfer through inventory's
 * own approved flows (M07), after which the manager tries again.
 */
@Injectable()
export class ReviewsService {
  constructor(
    private readonly posting: PosPostingService,
    private readonly audit: AuditService,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
  ) {}

  async list(
    context: ActiveContext,
    request: object,
    filter: { branchId?: string | undefined; status?: string | undefined },
  ) {
    const scope = scopeWhere(request, { branchId: sql`v.branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.reviews(tx, context.orgId, { scope, ...filter })).map(reviewView),
    }));
  }

  async resolve(
    context: ActiveContext,
    request: AuditableRequest,
    reviewId: string,
    input: ResolveReviewInput,
    now: Date = new Date(),
  ) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const review = await repo.reviewById(tx, context.orgId, reviewId, true);
      if (review === undefined) throw posHttpError('POS_REVIEW_NOT_FOUND', 'No such review item.');
      try {
        assertInScope(request, { branchId: review.branch_id });
      } catch {
        throw posHttpError('POS_REVIEW_NOT_FOUND', 'No such review item.');
      }
      if (review.status !== 'open') {
        throw posHttpError('POS_REVIEW_RESOLVED', 'That review item is already resolved.');
      }
      if (review.seller_id === context.userId) {
        throw posHttpError(
          'POS_REVIEW_SELF_RESOLVE',
          'The person who rang this up cannot resolve it; ask another manager.',
        );
      }

      const table = review.kind === 'sale' ? 'sales' : 'returns';
      const documentId = (review.kind === 'sale' ? review.sale_id : review.return_id) ?? '';

      if (input.action === 'void') {
        await repo.markVoided(tx, table, context.orgId, documentId, {
          reason: input.note,
          by: context.userId,
        });
        await repo.resolveReview(tx, context.orgId, review.id, {
          status: 'voided',
          by: context.userId,
          note: input.note,
        });
        await this.record(tx, context, request, review, 'voided', null);
        return { outcome: 'voided' as const, reasons: [], journalId: null };
      }

      const outcome =
        review.kind === 'sale'
          ? await this.postSale(tx, context, documentId, now)
          : await this.postReturn(tx, context, documentId, now);

      if (outcome.kind === 'held') {
        await repo.refreshReview(tx, context.orgId, review.id, outcome.reasons, outcome.detail);
        await this.record(tx, context, request, review, 'held', null);
        return { outcome: 'held' as const, reasons: outcome.reasons, journalId: null };
      }
      await repo.resolveReview(tx, context.orgId, review.id, {
        status: 'posted',
        by: context.userId,
        note: input.note,
      });
      await this.record(tx, context, request, review, 'posted', outcome.journalId);
      return { outcome: 'posted' as const, reasons: [], journalId: outcome.journalId };
    });
  }

  private async postSale(tx: Tx, context: ActiveContext, saleId: string, now: Date) {
    const sale = await repo.saleById(tx, context.orgId, saleId, true);
    if (sale?.status !== 'held') {
      throw posHttpError('POS_REVIEW_RESOLVED', 'That sale is no longer waiting for review.');
    }
    const lines = await repo.saleLines(tx, context.orgId, sale.id);
    const priced = priceLines(
      lines.map((line) => ({
        skuId: line.sku_id,
        qty: line.qty,
        unitPricePoisha: poisha(line.unit_price_poisha),
        discountPoisha: poisha(line.discount_poisha),
      })),
    ).lines;
    const ceiling = discountCeilingBps(context, sale.branch_id);
    // A line recorded before D-173 may carry no catalog price, so its discount cannot
    // be measured. Only someone whose ceiling is everything may post it.
    if (ceiling < 10_000 && lines.some((line) => line.catalog_price_poisha === null)) {
      throw posHttpError(
        'POS_DISCOUNT_ABOVE_CEILING',
        'A line on this sale has no catalog price to measure its discount against; an org admin must post it.',
      );
    }
    const above = linesAboveCeiling(
      priced,
      lines.map((line) =>
        line.catalog_price_poisha === null ? null : poisha(line.catalog_price_poisha),
      ),
      ceiling,
    );
    if (above.length > 0) {
      throw posHttpError(
        'POS_DISCOUNT_ABOVE_CEILING',
        'This sale’s discount is above your own ceiling at this branch; ask someone whose ceiling covers it.',
      );
    }
    return this.posting.postSale(tx, context, sale, now);
  }

  private async postReturn(tx: Tx, context: ActiveContext, returnId: string, now: Date) {
    const ret = await repo.returnById(tx, context.orgId, returnId, true);
    if (ret?.status !== 'held') {
      throw posHttpError('POS_REVIEW_RESOLVED', 'That return is no longer waiting for review.');
    }
    return this.posting.postReturn(tx, context, ret, now);
  }

  /**
   * Receipt lookup for a return or an exchange (§14: "returns and exchanges by
   * receipt lookup"). Each line carries what is still returnable and what returning
   * one more unit would refund, computed here with the same cumulative rule the
   * sync checks against — so the till never has to do that arithmetic itself.
   */
  async receipt(context: ActiveContext, request: object, receiptNo: string) {
    const scope = scopeWhere(request, { branchId: sql`branch_id` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const sales = await repo.salesByReceipt(tx, context.orgId, receiptNo, scope);
      return {
        items: await Promise.all(sales.map((sale) => this.saleDetail(tx, context.orgId, sale))),
      };
    });
  }

  async sale(context: ActiveContext, request: object, saleId: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const sale = await repo.saleById(tx, context.orgId, saleId);
      if (sale === undefined) throw posHttpError('POS_SALE_NOT_FOUND', 'No such sale.');
      try {
        assertInScope(request, { branchId: sale.branch_id });
      } catch {
        throw posHttpError('POS_SALE_NOT_FOUND', 'No such sale.');
      }
      return this.saleDetail(tx, context.orgId, sale);
    });
  }

  private async saleDetail(tx: Tx, orgId: string, sale: repo.SaleRow) {
    const lines = await repo.saleLines(tx, orgId, sale.id);
    const tenders = await repo.saleTenders(tx, orgId, sale.id);
    const returned = await repo.returnedQty(tx, orgId, sale.id, null);
    const labels = new Map(
      (
        await this.catalog.skusByIds(
          tx,
          orgId,
          lines.map((line) => line.sku_id),
        )
      ).map((sku) => [sku.id, sku]),
    );
    return {
      id: sale.id,
      receiptNo: sale.receipt_no,
      registerId: sale.register_id,
      shiftId: sale.shift_id,
      branchId: sale.branch_id,
      sellerId: sale.seller_id,
      occurredAt: sale.occurred_at,
      businessDate: sale.business_date,
      status: sale.status,
      grossPoisha: sale.gross_poisha,
      discountPoisha: sale.discount_poisha,
      netPoisha: sale.net_poisha,
      cashReceivedPoisha: sale.cash_received_poisha,
      changePoisha: sale.change_poisha,
      // Never the unit cost: a receipt is read at the counter by roles without
      // `read:cost`, and `serializeFor` would strip it anyway (invariant 5).
      lines: lines.map((line) => {
        const returnedQty = returned.get(line.line_no) ?? 0;
        const returnable = line.qty - returnedQty;
        return {
          lineNo: line.line_no,
          skuId: line.sku_id,
          skuCode: labels.get(line.sku_id)?.code ?? '',
          name: labels.get(line.sku_id)?.productName ?? '',
          qty: line.qty,
          unitPricePoisha: line.unit_price_poisha,
          discountPoisha: line.discount_poisha,
          netPoisha: line.net_poisha,
          returnedQty,
          returnableQty: sale.status === 'voided' ? 0 : returnable,
          /** What returning one more unit refunds, or null when none is left. */
          nextUnitRefundPoisha:
            returnable > 0
              ? refundFor(
                  { qty: line.qty, netPoisha: poisha(line.net_poisha), returnedQty },
                  1,
                ).toString()
              : null,
        };
      }),
      tenders: tenders.map((tender) => ({
        tender: tender.tender,
        amountPoisha: tender.amount_poisha,
        reference: tender.reference,
      })),
    };
  }

  private async record(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    review: repo.ReviewRow,
    outcome: 'posted' | 'voided' | 'held',
    journalId: string | null,
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'update',
      action: `pos.review.${outcome}`,
      entityType: 'PosReviewItem',
      entityId: review.id,
      before: { status: 'open', reasons: review.reasons },
      after: { status: outcome === 'held' ? 'open' : outcome, journalId },
      requestId: context.requestId,
      request,
    });
  }
}

export function reviewView(row: repo.ReviewRow) {
  return {
    id: row.id,
    branchId: row.branch_id,
    kind: row.kind,
    saleId: row.sale_id,
    returnId: row.return_id,
    receiptNo: row.receipt_no,
    amountPoisha: row.amount_poisha,
    occurredAt: row.occurred_at,
    sellerId: row.seller_id,
    reasons: row.reasons as HoldReason[],
    detail: row.detail,
    status: row.status,
    attempts: row.attempts,
    raisedAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
  };
}
