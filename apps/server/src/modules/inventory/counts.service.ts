import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { normaliseScannedCode } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { AdjustmentsService, type AdjustmentView } from './adjustments.service.js';
import * as repo from './inventory.repository.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import type { OpenCountInput, RecordCountsInput } from './inventory.schemas.js';
import * as scans from './stock-in-hand.repository.js';
import type { CountScanInput } from './stock-in-hand.schemas.js';

/**
 * Stock counts (architecture §8 "Adjustments and counts").
 *
 * "A count session freezes a snapshot and staff enter counted quantities. The
 * variance becomes adjustment movements, which need approval." The freeze is the
 * part worth being careful about: comparing what staff found against a level that
 * kept moving while they counted produces a variance for every sale that happened
 * during the count, and the people who did the counting are the ones who get asked
 * about it.
 *
 * So `snapshot_qty` is written once, by one statement, and migration 0033 refuses
 * any later change to it. The variance compares the count against that snapshot and
 * not against the live level.
 *
 * Closing a session raises **up to two** approvals: one `stock_write_off` for the
 * lines that came up short and one `stock_gain` for the lines that came up long.
 * Two rather than one net figure because §6 and §7 treat them as different actions
 * with different accounts, and a net of zero across a floor full of miscounts is
 * exactly the case where netting hides the problem.
 */

export interface CountLineView {
  readonly skuId: string;
  readonly skuCode: string;
  readonly snapshotQty: number;
  readonly countedQty: number | null;
  /** counted − snapshot, once counted. Null while the line is uncounted. */
  readonly varianceQty: number | null;
}

export interface CountSessionView {
  readonly id: string;
  readonly locationId: string;
  readonly branchId: string | null;
  readonly status: string;
  readonly memo: string | null;
  readonly createdBy: string;
  readonly lines: readonly CountLineView[];
}

@Injectable()
export class CountsService {
  constructor(
    private readonly adjustments: AdjustmentsService,
    private readonly audit: AuditService,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
  ) {}

  async open(
    context: ActiveContext,
    request: AuditableRequest,
    input: OpenCountInput,
  ): Promise<CountSessionView> {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const location = await repo.locationById(tx, context.orgId, input.locationId);
        if (location === undefined) {
          throw new StockError('STOCK_LOCATION_INVALID', 'No such location in this brand.');
        }
        assertInScope(request, { branchId: location.branch_id });

        const id = await repo.insertCountSession(tx, {
          orgId: context.orgId,
          locationId: location.id,
          branchId: location.branch_id,
          memo: input.memo ?? null,
          createdBy: context.userId,
        });
        const frozen = await repo.freezeCountLines(tx, context.orgId, id, location.id);

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: 'inventory.count.opened',
          entityType: 'StockCount',
          entityId: id,
          before: null,
          after: { locationId: location.id, lines: frozen },
          requestId: context.requestId,
          request,
        });

        return this.load(tx, context.orgId, id);
      }),
    );
  }

  async record(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: RecordCountsInput,
  ): Promise<CountSessionView> {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.requireOpen(tx, context, request, sessionId);

        // D-606: a figure typed over one already counted (by scanning or typing) says why,
        // in the count's audit entry. The console asks for it; this is where it is required.
        // The lines locked first: a scan committing between this read and the write below
        // would otherwise be overwritten without the note this check asks for.
        const counted = new Map(
          (await repo.lockCountLines(tx, context.orgId, session.id)).map((line) => [
            line.sku_id,
            line.counted_qty,
          ]),
        );
        const overwrites = input.lines.some((line) => {
          const was = counted.get(line.skuId);
          return was !== undefined && was !== null && was !== line.countedQty;
        });
        if (overwrites && (input.note ?? '').trim() === '') {
          throw new StockError(
            'STOCK_COUNT_INVALID',
            'Changing a figure that was already counted needs a note saying why.',
          );
        }

        for (const line of input.lines) {
          // A SKU with no frozen line was not at this location when the session
          // opened. Refused rather than inserted: a line added mid-count has no
          // snapshot to compare against, so its whole counted quantity would read as
          // a gain — and finding stock on a shelf it was never assigned to is a
          // transfer to record, not a count to fudge.
          if (
            !(await repo.recordCount(tx, {
              orgId: context.orgId,
              sessionId: session.id,
              skuId: line.skuId,
              countedQty: line.countedQty,
              countedBy: context.userId,
            }))
          ) {
            throw new StockError(
              'STOCK_COUNT_INVALID',
              'That SKU is not part of this count; transfer it in before counting it.',
            );
          }
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.count.recorded',
          entityType: 'StockCount',
          entityId: session.id,
          before: null,
          // A manual figure typed over a scanned one carries the person's note (D-606).
          after: { lines: input.lines, note: input.note ?? null },
          requestId: context.requestId,
          request,
        });

        return this.load(tx, context.orgId, session.id);
      }),
    );
  }

  /**
   * One scan on an open count: one more piece of that SKU (M38a, D-606).
   *
   * The scan is resolved by barcode or SKU code, written to `count_scans` under the
   * device's own key and added to the line in the same transaction, so the count is the
   * scans: a retried scan (same key) counts once, two people scanning one shelf from two
   * phones both count, and the line never holds a number no scan explains. A SKU the count
   * did not freeze is refused, as a typed count is: stock found where the brand never had
   * it is a transfer to record, not a count to absorb.
   */
  async scan(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
    input: CountScanInput,
  ): Promise<{
    readonly skuId: string;
    readonly skuCode: string;
    readonly countedQty: number;
    readonly duplicate: boolean;
  }> {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const session = await this.requireOpen(tx, context, request, sessionId);

        const seen = await scans.scanById(tx, context.orgId, input.scanId);
        if (seen !== undefined) {
          if (seen.session_id !== session.id) {
            throw new StockError('IDEMPOTENCY_CONFLICT', 'That scan was counted on another count.');
          }
          const line = await scans.countLine(tx, {
            orgId: context.orgId,
            sessionId: session.id,
            skuId: seen.sku_id,
          });
          const [sku] = await this.catalog.skusByIds(tx, context.orgId, [seen.sku_id]);
          return {
            skuId: seen.sku_id,
            skuCode: sku?.code ?? '',
            countedQty: line?.counted_qty ?? 0,
            duplicate: true,
          };
        }

        const code = normaliseScannedCode(input.code);
        const found = await this.catalog.lookupCode(tx, context.orgId, code);
        if (found === undefined) {
          throw new StockError('STOCK_NOT_FOUND', 'No product in this brand has that barcode.');
        }
        await scans.insertScan(tx, {
          orgId: context.orgId,
          id: input.scanId,
          sessionId: session.id,
          skuId: found.skuId,
          code,
          createdBy: context.userId,
        });
        const counted = await scans.countOneMore(tx, {
          orgId: context.orgId,
          sessionId: session.id,
          skuId: found.skuId,
          countedBy: context.userId,
        });
        if (counted === undefined) {
          throw new StockError(
            'STOCK_COUNT_INVALID',
            'That item was not at this location when the count began; transfer it in before counting it.',
          );
        }
        // The scan row is the append-only record (who, what, when); the audit interceptor adds
        // the request's own entry after commit, as for any mutation.
        return {
          skuId: found.skuId,
          skuCode: found.skuCode,
          countedQty: counted.counted_qty,
          duplicate: false,
        };
      }),
    );
  }

  /**
   * Submit the count: no more counting, and the variance is now fixed.
   *
   * A separate step from closing because the two are different decisions by
   * different people. Submitting says "we have finished counting"; closing raises the
   * approvals that will change stock, and §6 puts that behind a checker.
   */
  async submit(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
  ): Promise<CountSessionView> {
    return mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // `for update`: every scan and figure still being written holds the session `for
        // share`, so the lines read below are the last ones.
        const session = await this.requireOpen(tx, context, request, sessionId, 'update');
        const lines = await repo.countLines(tx, context.orgId, session.id);
        if (lines.every((line) => line.counted_qty === null)) {
          throw new StockError('STOCK_COUNT_INVALID', 'Nothing has been counted yet.');
        }
        await repo.setCountStatus(tx, context.orgId, session.id, 'submitted');

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.count.submitted',
          entityType: 'StockCount',
          entityId: session.id,
          before: { status: 'open' },
          after: { status: 'submitted' },
          requestId: context.requestId,
          request,
        });

        return this.load(tx, context.orgId, session.id);
      }),
    );
  }

  /**
   * Close a submitted count, raising the approvals its variance needs.
   *
   * The session is marked closed in its own transaction **before** the adjustments
   * are raised, because `AdjustmentsService.request` opens its own transaction (it has
   * to: the approval is created in one, and migration 0034 checks the adjustment
   * against it in the next). Closing first means a session cannot be closed twice and
   * raise two sets of approvals for one variance, which is the failure that would
   * double every difference the count found.
   */
  async close(
    context: ActiveContext,
    request: AuditableRequest,
    sessionId: string,
  ): Promise<{ session: CountSessionView; adjustments: AdjustmentView[] }> {
    const prepared = await mapStockErrors(async () =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        // `for update`: two closes at once would otherwise both read "submitted" and raise
        // the variance's adjustments twice (M38a's ledger audit, N-5).
        const session = await repo.countSessionById(tx, context.orgId, sessionId, 'update');
        if (session === undefined) throw new StockError('STOCK_NOT_FOUND', 'No such count.');
        assertInScope(request, { branchId: session.branch_id });
        if (session.status !== 'submitted') {
          throw new StockError(
            'STOCK_COUNT_INVALID',
            `A count is closed after it is submitted; this one is ${session.status}.`,
          );
        }

        const lines = await repo.countLines(tx, context.orgId, session.id);
        const shortages: { skuId: string; qty: number }[] = [];
        const surpluses: { skuId: string; qty: number }[] = [];
        for (const line of lines) {
          if (line.counted_qty === null) continue;
          const variance = line.counted_qty - line.snapshot_qty;
          if (variance < 0) shortages.push({ skuId: line.sku_id, qty: -variance });
          if (variance > 0) surpluses.push({ skuId: line.sku_id, qty: variance });
        }

        await repo.setCountStatus(tx, context.orgId, session.id, 'closed');
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'inventory.count.closed',
          entityType: 'StockCount',
          entityId: session.id,
          before: { status: 'submitted' },
          after: {
            status: 'closed',
            shortageLines: shortages.length,
            surplusLines: surpluses.length,
          },
          requestId: context.requestId,
          request,
        });

        return { session, shortages, surpluses };
      }),
    );

    const adjustments: AdjustmentView[] = [];
    if (prepared.shortages.length > 0) {
      adjustments.push(
        await this.adjustments.request(context, request, {
          locationId: prepared.session.location_id,
          direction: 'loss',
          reason: `Stock count shortage (${sessionId})`,
          countSessionId: sessionId,
          lines: prepared.shortages,
        }),
      );
    }
    if (prepared.surpluses.length > 0) {
      adjustments.push(
        await this.adjustments.request(context, request, {
          locationId: prepared.session.location_id,
          direction: 'gain',
          reason: `Stock count surplus (${sessionId})`,
          countSessionId: sessionId,
          lines: prepared.surpluses,
        }),
      );
    }

    return {
      session: await withOrg({ orgId: context.orgId, userId: context.userId }, (tx) =>
        this.load(tx, context.orgId, sessionId),
      ),
      adjustments,
    };
  }

  async list(context: ActiveContext, request: object): Promise<{ items: CountSessionView[] }> {
    const scope = scopeWhere(request, { branchId: sql`branch_id`, createdBy: sql`created_by` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listCountSessions(tx, context.orgId, scope);
      return { items: await Promise.all(rows.map((row) => this.load(tx, context.orgId, row.id))) };
    });
  }

  async get(context: ActiveContext, request: object, sessionId: string): Promise<CountSessionView> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const session = await repo.countSessionById(tx, context.orgId, sessionId);
      if (session === undefined) throw new StockError('STOCK_NOT_FOUND', 'No such count.');
      assertInScope(request, { branchId: session.branch_id });
      return this.load(tx, context.orgId, sessionId);
    });
  }

  private async requireOpen(
    tx: Parameters<typeof repo.countSessionById>[0],
    context: ActiveContext,
    request: object,
    sessionId: string,
    lock: 'share' | 'update' = 'share',
  ): Promise<repo.CountSessionRow> {
    const session = await repo.countSessionById(tx, context.orgId, sessionId, lock);
    if (session === undefined) throw new StockError('STOCK_NOT_FOUND', 'No such count.');
    assertInScope(request, { branchId: session.branch_id });
    if (session.status !== 'open') {
      throw new StockError('STOCK_COUNT_INVALID', `That count is ${session.status}.`);
    }
    return session;
  }

  private async load(
    tx: Parameters<typeof repo.countSessionById>[0],
    orgId: string,
    id: string,
  ): Promise<CountSessionView> {
    const session = await repo.countSessionById(tx, orgId, id);
    if (session === undefined) throw new StockError('STOCK_NOT_FOUND', 'No such count.');
    const lines = await repo.countLines(tx, orgId, id);
    return {
      id: session.id,
      locationId: session.location_id,
      branchId: session.branch_id,
      status: session.status,
      memo: session.memo,
      createdBy: session.created_by,
      lines: lines.map((line) => ({
        skuId: line.sku_id,
        skuCode: line.sku_code,
        snapshotQty: line.snapshot_qty,
        countedQty: line.counted_qty,
        varianceQty: line.counted_qty === null ? null : line.counted_qty - line.snapshot_qty,
      })),
    };
  }
}
