import { createHash } from 'node:crypto';

import { HttpException, Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, poisha, withinPostingWindow } from '@elysium/domain';
import {
  canonicalJson,
  discountCeilingBps,
  PosError,
  priceLines,
  saleHoldReasons,
  settleTenders,
  type HoldReason,
  type Tender,
} from '@elysium/domain/pos';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { posHttpError, toPosHttpError } from './pos.errors.js';
import * as repo from './pos.repository.js';
import type { ReturnDocument, SaleDocument } from './pos.schemas.js';
import { PosPostingService, type PostOutcome } from './posting.service.js';

/**
 * The till's queue, delivered (architecture §14 "Offline"; M23 checks 1–3).
 *
 * Three promises, in the order they matter:
 *
 * 1. **Exactly once.** A document is identified by the till's own UUID. The first
 *    delivery inserts it with `on conflict do nothing` and is the only one that
 *    goes on to move stock and post; a later or concurrent delivery finds the row,
 *    compares the payload hash, and answers with what the first recorded. The
 *    journal's key is derived from the same id, so even a path that reached the
 *    ledger twice would get one journal back (invariant 2).
 * 2. **Never negative, never dropped.** A sale whose units the shelf cannot give
 *    becomes a held sale with an open review item — recorded, visible to the
 *    branch manager, and posted or voided by a person (`ReviewsService`). The same
 *    for a stale price, a discount above the seller's ceiling, a closed shift or a
 *    date outside the posting window.
 * 3. **The server's arithmetic.** Totals are recomputed from the lines, the change
 *    from the tenders, and a payload whose own figures disagree is refused whole:
 *    that is a bug or a tamper, not a sale, and the till keeps it visible as failed
 *    rather than the server guessing which figure was meant.
 *
 * Each document gets its own transaction, so one bad document cannot roll back the
 * sales queued behind it, and a request cut off half way leaves every document it
 * finished committed — the till's next sync gets those back as replays.
 */

export type DocumentOutcome = 'posted' | 'held' | 'voided' | 'rejected' | 'conflict';

export interface DocumentResult {
  readonly id: string;
  readonly kind: 'sale' | 'return';
  readonly outcome: DocumentOutcome;
  /** True when the server already held this document and wrote nothing now. */
  readonly replayed: boolean;
  readonly reviewItemId: string | null;
  readonly reasons: readonly string[];
  readonly journalId: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly posting: PosPostingService,
    private readonly audit: AuditService,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
  ) {}

  async sync(
    context: ActiveContext,
    request: AuditableRequest,
    documents: readonly (SaleDocument | ReturnDocument)[],
    now: () => Date = () => new Date(),
  ): Promise<{ results: DocumentResult[] }> {
    const results: DocumentResult[] = [];
    for (const document of documents) {
      results.push(await this.one(context, request, document, now()));
    }
    return { results };
  }

  private async one(
    context: ActiveContext,
    request: AuditableRequest,
    document: SaleDocument | ReturnDocument,
    now: Date,
  ): Promise<DocumentResult> {
    try {
      return await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        document.kind === 'sale'
          ? this.sale(tx, context, request, document, now)
          : this.return(tx, context, request, document, now),
      );
    } catch (error) {
      const mapped = toPosHttpError(error);
      if (mapped instanceof HttpException && mapped.getStatus() < 500) {
        /*
         * Refused as a document, not as a request: the rest of the queue still
         * goes through, and the till keeps this one, marked, for a person to see.
         * It is never removed from the till by a refusal — only by `posted`,
         * `held` or `voided`, which mean the server has it.
         */
        const body = mapped.getResponse() as { code?: string; message?: string };
        return {
          id: document.id,
          kind: document.kind,
          outcome: body.code === 'IDEMPOTENCY_CONFLICT' ? 'conflict' : 'rejected',
          replayed: false,
          reviewItemId: null,
          reasons: [],
          journalId: null,
          error: {
            code: body.code ?? 'VALIDATION_FAILED',
            message: body.message ?? mapped.message,
          },
        };
      }
      // A fault nobody anticipated: the request fails and the till retries later.
      throw mapped;
    }
  }

  // --- sales ------------------------------------------------------------------

  private async sale(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    document: SaleDocument,
    now: Date,
  ): Promise<DocumentResult> {
    const payloadHash = hashOf(document);
    const { register, shift } = await this.placement(tx, context, request, document);

    const occurredAt = new Date(document.occurredAt);
    const totals = priceLines(
      document.lines.map((line) => ({
        skuId: line.skuId,
        qty: line.qty,
        unitPricePoisha: poisha(line.unitPricePoisha),
        discountPoisha: poisha(line.discountPoisha),
      })),
    );
    if (
      totals.grossPoisha !== BigInt(document.totals.grossPoisha) ||
      totals.discountPoisha !== BigInt(document.totals.discountPoisha) ||
      totals.netPoisha !== BigInt(document.totals.netPoisha)
    ) {
      throw new PosError(
        'POS_SALE_INVALID',
        'The receipt’s totals do not match its lines. Nothing was recorded.',
      );
    }
    if (new Set(document.lines.map((line) => line.lineNo)).size !== document.lines.length) {
      throw new PosError('POS_SALE_INVALID', 'Each line on a receipt has its own number.');
    }
    const settled = settleTenders(
      totals.netPoisha,
      document.tenders.map((tender) => ({
        tender: tender.tender,
        amountPoisha: poisha(tender.amountPoisha),
      })),
      document.cashReceivedPoisha === undefined ? null : poisha(document.cashReceivedPoisha),
    );
    const tenders = document.tenders.map((tender) => ({
      tender: tender.tender,
      amountPoisha: BigInt(tender.amountPoisha),
      walletId: walletFor(register, tender.tender),
      reference: tender.reference ?? null,
    }));

    // Before the insert: a SKU the catalog has never heard of cannot be a line at
    // all (the foreign key would abort the transaction), and it is a bad payload
    // rather than a sale anybody could post later.
    const catalog = new Map(
      (
        await this.catalog.skusByIds(tx, context.orgId, [
          ...new Set(document.lines.map((line) => line.skuId)),
        ])
      ).map((sku) => [sku.id, sku]),
    );
    if (document.lines.some((line) => !catalog.has(line.skuId))) {
      throw new PosError('POS_SALE_INVALID', 'A line names a SKU this brand does not have.');
    }

    const inserted = await repo.insertHeldSale(tx, {
      orgId: context.orgId,
      id: document.id,
      registerId: register.id,
      shiftId: shift.id,
      branchId: register.branch_id,
      locationId: register.location_id,
      receiptNo: document.receiptNo,
      sellerId: context.userId,
      occurredAt,
      businessDate: businessDate(occurredAt),
      grossPoisha: totals.grossPoisha,
      discountPoisha: totals.discountPoisha,
      netPoisha: totals.netPoisha,
      cashReceivedPoisha: settled.cashReceivedPoisha,
      changePoisha: settled.changePoisha,
      payloadHash,
      exchangeReturnId: document.exchangeReturnId ?? null,
    });
    if (!inserted) return this.replay(tx, context.orgId, 'sale', document.id, payloadHash);

    const checked = totals.lines.map((line, index) => {
      const sku = catalog.get(line.skuId);
      return {
        ...line,
        lineNo: document.lines[index]?.lineNo ?? index + 1,
        catalogPricePoisha:
          sku?.status === 'active' ? poisha(sku.pricePoisha) : null,
      };
    });
    await repo.insertSaleLines(
      tx,
      context.orgId,
      document.id,
      checked.map((line) => ({
        lineNo: line.lineNo,
        skuId: line.skuId,
        qty: line.qty,
        unitPricePoisha: line.unitPricePoisha,
        discountPoisha: line.discountPoisha,
        netPoisha: line.netPoisha,
        catalogPricePoisha: line.catalogPricePoisha,
      })),
    );
    await repo.insertSaleTenders(tx, context.orgId, document.id, tenders);

    const ceilingBps = discountCeilingBps(context, register.branch_id);
    const reasons = saleHoldReasons({
      lines: checked,
      ceilingBps,
      shiftOpen: shift.status === 'open',
      occurredAt,
      now,
    });

    let outcome: PostOutcome;
    if (reasons.length > 0) {
      outcome = {
        kind: 'held',
        reasons,
        detail: {
          ceilingBps,
          lines: checked.map((line) => ({
            lineNo: line.lineNo,
            skuId: line.skuId,
            unitPricePoisha: line.unitPricePoisha.toString(),
            discountPoisha: line.discountPoisha.toString(),
            catalogPricePoisha: line.catalogPricePoisha?.toString() ?? null,
          })),
        },
      };
    } else {
      const sale = await repo.saleById(tx, context.orgId, document.id);
      if (sale === undefined) throw new Error('a sale inserted in this transaction is not visible');
      outcome = await this.posting.postSale(tx, context, sale, now);
    }

    const reviewItemId =
      outcome.kind === 'held'
        ? await repo.insertReview(tx, {
            orgId: context.orgId,
            branchId: register.branch_id,
            kind: 'sale',
            documentId: document.id,
            reasons: outcome.reasons,
            detail: outcome.detail,
          })
        : null;

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'create',
      action: outcome.kind === 'posted' ? 'pos.sale.posted' : 'pos.sale.held',
      entityType: 'PosSale',
      entityId: document.id,
      before: null,
      after: {
        receiptNo: document.receiptNo,
        registerId: register.id,
        shiftId: shift.id,
        netPoisha: totals.netPoisha.toString(),
        status: outcome.kind,
        reasons: outcome.kind === 'held' ? outcome.reasons : [],
        journalId: outcome.kind === 'posted' ? outcome.journalId : null,
      },
      requestId: context.requestId,
      request,
    });

    return result('sale', document.id, outcome, reviewItemId);
  }

  // --- returns ----------------------------------------------------------------

  private async return(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    document: ReturnDocument,
    now: Date,
  ): Promise<DocumentResult> {
    const payloadHash = hashOf(document);
    const { register, shift } = await this.placement(tx, context, request, document);
    const occurredAt = new Date(document.occurredAt);

    const sale = await repo.saleById(tx, context.orgId, document.saleId);
    if (sale?.branch_id !== register.branch_id) {
      // A receipt of another branch answers exactly as a missing one: returns are
      // taken where the goods were sold (decision row), and anything else would let
      // a till probe another showroom's sales by id.
      throw new PosError('POS_SALE_NOT_FOUND', 'No such receipt at this branch.');
    }

    const refund = BigInt(document.refundPoisha);
    const lineSum = document.lines.reduce((total, line) => total + BigInt(line.refundPoisha), 0n);
    const tenderSum = document.tenders.reduce((total, t) => total + BigInt(t.amountPoisha), 0n);
    if (lineSum !== refund || tenderSum !== refund) {
      throw new PosError('POS_RETURN_INVALID', 'The refund, its lines and its tenders disagree.');
    }
    if (new Set(document.tenders.map((t) => t.tender)).size !== document.tenders.length) {
      throw new PosError('POS_RETURN_INVALID', 'Each tender appears once on a refund.');
    }
    if (new Set(document.lines.map((line) => line.lineNo)).size !== document.lines.length) {
      throw new PosError('POS_RETURN_INVALID', 'Each line on a return slip has its own number.');
    }

    const saleLines = new Map(
      (await repo.saleLines(tx, context.orgId, sale.id)).map((line) => [line.line_no, line]),
    );
    const lines = document.lines.map((line) => {
      const sold = saleLines.get(line.saleLineNo);
      if (sold === undefined) {
        throw new PosError(
          'POS_RETURN_INVALID',
          `The receipt has no line ${String(line.saleLineNo)}.`,
        );
      }
      return {
        lineNo: line.lineNo,
        saleLineNo: line.saleLineNo,
        skuId: sold.sku_id,
        qty: line.qty,
        refundPoisha: BigInt(line.refundPoisha),
      };
    });

    const inserted = await repo.insertHeldReturn(tx, {
      orgId: context.orgId,
      id: document.id,
      registerId: register.id,
      shiftId: shift.id,
      branchId: register.branch_id,
      locationId: register.location_id,
      saleId: sale.id,
      receiptNo: document.receiptNo,
      createdBy: context.userId,
      occurredAt,
      businessDate: businessDate(occurredAt),
      refundPoisha: refund,
      reason: document.reason ?? null,
      payloadHash,
    });
    if (!inserted) return this.replay(tx, context.orgId, 'return', document.id, payloadHash);

    await repo.insertReturnLines(tx, context.orgId, document.id, sale.id, lines);
    await repo.insertReturnTenders(
      tx,
      context.orgId,
      document.id,
      document.tenders.map((tender) => ({
        tender: tender.tender,
        amountPoisha: BigInt(tender.amountPoisha),
        walletId: walletFor(register, tender.tender),
      })),
    );

    const reasons: HoldReason[] = [];
    if (shift.status !== 'open') reasons.push('shift_closed');
    if (!withinPostingWindow(occurredAt, now)) reasons.push('outside_posting_window');

    let outcome: PostOutcome;
    if (reasons.length > 0) {
      outcome = { kind: 'held', reasons, detail: {} };
    } else {
      const row = await repo.returnById(tx, context.orgId, document.id);
      if (row === undefined)
        throw new Error('a return inserted in this transaction is not visible');
      outcome = await this.posting.postReturn(tx, context, row, now);
    }

    const reviewItemId =
      outcome.kind === 'held'
        ? await repo.insertReview(tx, {
            orgId: context.orgId,
            branchId: register.branch_id,
            kind: 'return',
            documentId: document.id,
            reasons: outcome.reasons,
            detail: outcome.detail,
          })
        : null;

    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation: 'create',
      action: outcome.kind === 'posted' ? 'pos.return.posted' : 'pos.return.held',
      entityType: 'PosReturn',
      entityId: document.id,
      before: null,
      after: {
        receiptNo: document.receiptNo,
        saleId: sale.id,
        refundPoisha: refund.toString(),
        status: outcome.kind,
        reasons: outcome.kind === 'held' ? outcome.reasons : [],
      },
      requestId: context.requestId,
      request,
    });

    return result('return', document.id, outcome, reviewItemId);
  }

  // --- shared -----------------------------------------------------------------

  /**
   * The register and shift a document was rung on, and the checks that make the
   * syncing user its rightful sender: the register is in their branch scope, and
   * the shift is theirs. A sale synced by someone other than the cashier whose
   * shift it is would put one person's takings into another person's count.
   */
  private async placement(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    document: { registerId: string; shiftId: string },
  ): Promise<{ register: repo.RegisterRow; shift: repo.ShiftRow }> {
    const register = await repo.registerById(tx, context.orgId, document.registerId);
    if (register === undefined) {
      throw new PosError('POS_REGISTER_NOT_FOUND', 'No such register.');
    }
    try {
      assertInScope(request, { branchId: register.branch_id });
    } catch {
      throw new PosError('POS_REGISTER_NOT_FOUND', 'No such register.');
    }
    const shift = await repo.shiftById(tx, context.orgId, document.shiftId);
    if (shift?.register_id !== register.id) {
      throw new PosError('POS_SHIFT_MISMATCH', 'That shift is not on this register.');
    }
    if (shift.opened_by !== context.userId) {
      throw new PosError(
        'POS_SHIFT_MISMATCH',
        'Only the cashier whose shift it is may send its sales.',
      );
    }
    return { register, shift };
  }

  /**
   * A document the server already holds.
   *
   * Same payload: answer with what was recorded the first time, writing nothing.
   * Different payload under the same id: refuse — posting either would make the
   * books disagree with one of two receipts carrying the same number.
   */
  private async replay(
    tx: Tx,
    orgId: string,
    kind: 'sale' | 'return',
    id: string,
    payloadHash: string,
  ): Promise<DocumentResult> {
    const existing =
      kind === 'sale' ? await repo.saleById(tx, orgId, id) : await repo.returnById(tx, orgId, id);
    if (existing?.payload_hash !== payloadHash) {
      throw posHttpError(
        'IDEMPOTENCY_CONFLICT',
        'A different document was already recorded under this id.',
      );
    }
    const review = await repo.latestReviewFor(tx, orgId, kind, id);
    return {
      id,
      kind,
      outcome: existing.status,
      replayed: true,
      reviewItemId: review?.id ?? null,
      reasons: existing.status === 'held' ? (review?.reasons ?? []) : [],
      journalId: existing.journal_id,
      error: null,
    };
  }
}

function result(
  kind: 'sale' | 'return',
  id: string,
  outcome: PostOutcome,
  reviewItemId: string | null,
): DocumentResult {
  return {
    id,
    kind,
    outcome: outcome.kind,
    replayed: false,
    reviewItemId,
    reasons: outcome.kind === 'held' ? outcome.reasons : [],
    journalId: outcome.kind === 'posted' ? outcome.journalId : null,
    error: null,
  };
}

/** The wallet the register takes this tender into, or a refusal. */
export function walletFor(register: repo.RegisterRow, tender: Tender): string {
  const wallet =
    tender === 'cash'
      ? register.cash_wallet_id
      : tender === 'bkash'
        ? register.bkash_wallet_id
        : register.card_wallet_id;
  if (wallet === null) {
    throw new PosError('POS_REGISTER_INVALID', `This register does not take ${tender}.`);
  }
  return wallet;
}

function hashOf(document: object): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}
