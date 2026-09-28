import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import {
  businessDate,
  poisha,
  stockAdjustmentDraft,
  stockValuePoisha,
  type AccountSubtype,
  type Poisha,
} from '@elysium/domain';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ApprovalsService, type ApprovalExecutor } from '../approvals/approvals.service.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { MovementsService } from './movements.service.js';
import * as repo from './inventory.repository.js';
import { mapStockErrors, StockError } from './inventory.errors.js';
import type { RequestAdjustmentInput } from './inventory.schemas.js';

/**
 * Stock write-offs and gains: raised by one person, carried out by another
 * (architecture §7's last two rows, §8 "Adjustments and counts"; M07 check 4).
 *
 * A write-off is the one way to make stock disappear without anything leaving the
 * building. It is the entry a thief writes, and that is why §7 requires an approval
 * and §6 routes it to the org admin or to the branch manager whose branch the stock
 * is in. Four properties make that control real rather than decorative:
 *
 * 1. **The value is the server's.** Σ qty × the weighted average, read here. A
 *    client-supplied value would let somebody write off a lakh of stock at a claimed
 *    value of one taka and stay under every threshold. `stock_write_off` and
 *    `stock_gain` are in `SERVER_DERIVED_AMOUNT_TYPES`, so a request raised through
 *    the generic approvals route by a person is held for an org admin (D-072).
 * 2. **Nothing moves before the decision.** The movements and the journal are both
 *    written by the executor below, inside the transaction that approved the
 *    request. A pending write-off has changed no stock and posted no journal.
 * 3. **The terms are frozen.** Migration 0033 refuses any change to a pending
 *    adjustment's location, direction, value or approval; migration 0034 refuses an
 *    adjustment whose approval is for a different branch, type or amount than the
 *    stock it would adjust — which is what stops a request approved by one branch's
 *    manager from emptying another branch's shelf.
 * 4. **The value the checker saw is the value that posts.** The frozen
 *    `unit_cost_poisha` on each line is handed to the movement and the journal,
 *    rather than re-derived: the average moves, and a journal posting today's number
 *    against an approval for last week's would leave the stock ledger and the general
 *    ledger describing one write-off with two figures.
 */

export interface AdjustmentView {
  readonly id: string;
  readonly locationId: string;
  readonly branchId: string | null;
  readonly direction: 'loss' | 'gain';
  readonly status: string;
  readonly countSessionId: string | null;
  /** Integer poisha as a decimal string; stripped for roles without `read:cost`. */
  readonly stockValuePoisha: string;
  readonly reason: string;
  readonly approvalId: string | null;
  readonly journalId: string | null;
  readonly businessDate: string;
  readonly createdBy: string;
}

@Injectable()
export class AdjustmentsService implements OnModuleInit {
  constructor(
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    private readonly approvals: ApprovalsService,
    private readonly movements: MovementsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('stock_write_off', this.execute('loss'));
    this.approvals.registerExecutor('stock_gain', this.execute('gain'));
  }

  /**
   * Raise an adjustment for approval.
   *
   * The approval is raised **before** the row is written, because the row's
   * `approval_request_id` is NOT NULL for a pending adjustment and migration 0034
   * checks the two against each other on insert. `ApprovalsService.request` opens its
   * own transaction, so the request is committed by the time this one inserts — which
   * also means a rolled-back adjustment leaves an orphan request, and the executor is
   * written to shrug at a request naming no adjustment rather than making somebody's
   * approval undecidable.
   */
  async request(
    context: ActiveContext,
    request: AuditableRequest,
    input: RequestAdjustmentInput,
  ): Promise<AdjustmentView> {
    return mapStockErrors(async () => {
      const prepared = await withOrg(
        { orgId: context.orgId, userId: context.userId },
        async (tx) => {
          const location = await repo.locationById(tx, context.orgId, input.locationId);
          if (location === undefined) {
            throw new StockError('STOCK_LOCATION_INVALID', 'No such location in this brand.');
          }
          // A branch manager may only adjust their own branch's stock. Asserted on
          // the row about to be inserted, which is what `ScopeInterceptor` requires
          // of a create (D-061).
          assertInScope(request, { branchId: location.branch_id });

          const costs = await repo.costsFor(
            tx,
            context.orgId,
            input.lines.map((line) => line.skuId),
          );
          const wac = new Map(costs.map((row) => [row.sku_id, BigInt(row.wac_poisha)]));

          const lines = input.lines.map((line) => {
            const unitCostPoisha = poisha(wac.get(line.skuId) ?? 0n);
            return { ...line, unitCostPoisha };
          });
          const valuePoisha = lines.reduce<Poisha>(
            (total, line) => poisha(total + stockValuePoisha(line.qty, line.unitCostPoisha)),
            poisha(0),
          );

          /*
           * A loss is checked against availability now as well as at execution.
           *
           * Not because it makes the execution safe — the movement's own CHECK does
           * that — but because a request that cannot possibly succeed should be
           * refused in front of the person raising it, rather than accepted, queued
           * for a manager, approved, and then failing inside their approval.
           */
          if (input.direction === 'loss') {
            for (const line of lines) {
              const level = await repo.levelFor(tx, context.orgId, line.skuId, input.locationId);
              const available = (level?.on_hand ?? 0) - (level?.reserved ?? 0);
              if (available < line.qty) {
                throw new StockError(
                  'STOCK_INSUFFICIENT',
                  `Only ${String(available)} of that SKU can be written off at this location.`,
                );
              }
            }
          }

          return { location, lines, valuePoisha };
        },
      );

      const raised = await this.approvals.request(context, {
        type: input.direction === 'loss' ? 'stock_write_off' : 'stock_gain',
        amountPoisha: prepared.valuePoisha,
        // No cost in the payload: the approvals list and the `approval.requested`
        // event both carry it, and a checker without `read:cost` is a real case
        // (D-074). The amount is withheld there by type; the payload must not
        // reintroduce it by the back door.
        payload: {
          locationId: input.locationId,
          direction: input.direction,
          lines: prepared.lines.map((line) => ({ skuId: line.skuId, qty: line.qty })),
          ...(input.countSessionId === undefined ? {} : { countSessionId: input.countSessionId }),
        },
        reason: input.reason,
        ...(prepared.location.branch_id === null ? {} : { branchId: prepared.location.branch_id }),
        // This module read the weighted average and multiplied. Saying so is what
        // lets the org's threshold decide whether a branch manager may sign it off
        // rather than holding every write-off for an org admin (D-072, D-076).
        amountDerivedByServer: true,
        request,
      });

      return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const id = await repo.insertAdjustment(tx, {
          orgId: context.orgId,
          locationId: input.locationId,
          branchId: prepared.location.branch_id,
          direction: input.direction,
          countSessionId: input.countSessionId ?? null,
          valuePoisha: prepared.valuePoisha,
          reason: input.reason,
          approvalRequestId: raised.id,
          businessDate: businessDate(new Date()),
          createdBy: context.userId,
        });

        for (const line of prepared.lines) {
          await repo.insertAdjustmentLine(tx, {
            orgId: context.orgId,
            adjustmentId: id,
            skuId: line.skuId,
            qty: line.qty,
            unitCostPoisha: line.unitCostPoisha,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'create',
          action: `inventory.adjustment.requested:${input.direction}`,
          entityType: 'StockAdjustment',
          entityId: id,
          before: null,
          after: {
            locationId: input.locationId,
            direction: input.direction,
            stockValuePoisha: prepared.valuePoisha.toString(),
            approvalId: raised.id,
            reason: input.reason,
            lines: prepared.lines.map((line) => ({ skuId: line.skuId, qty: line.qty })),
          },
          requestId: context.requestId,
          request,
        });

        const row = await repo.adjustmentById(tx, context.orgId, id);
        if (row === undefined) throw new StockError('STOCK_NOT_FOUND', 'No such adjustment.');
        return this.view(row);
      });
    });
  }

  async list(
    context: ActiveContext,
    request: object,
    filters: { readonly status?: string | undefined },
  ): Promise<{ items: AdjustmentView[] }> {
    const scope = scopeWhere(request, { branchId: sql`a.branch_id`, createdBy: sql`a.created_by` });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listAdjustments(tx, context.orgId, { scope, status: filters.status })).map(
        (row) => this.view(row),
      ),
    }));
  }

  /**
   * Carry out an approved adjustment, inside the approving transaction.
   *
   * Written to be indifferent to a request it does not recognise. Nothing else
   * raises `stock_write_off` or `stock_gain` with an adjustment behind it — the type
   * is server-derived, so a person raising one through the generic route has it held
   * and it names no adjustment — but the alternative to shrugging is an executor that
   * throws on somebody else's request and makes their approval undecidable.
   */
  private execute(direction: 'loss' | 'gain'): ApprovalExecutor {
    return async (tx, { context, approval, request }) => {
      const adjustment = await repo.adjustmentByApproval(tx, context.orgId, approval.id);
      if (adjustment === undefined) return;
      if (adjustment.status !== 'pending_approval') return;
      if (adjustment.direction !== direction) return;

      await mapStockErrors(async () => {
        // The approval's amount, not the row's (D-078). They are held equal by
        // migration 0034 on the way in; this is the check that they still are.
        const value = approval.amountPoisha;
        if (value === null || value !== BigInt(adjustment.value_poisha)) {
          throw new StockError(
            'IDEMPOTENCY_CONFLICT',
            'That approval is for a different value than the adjustment it names.',
          );
        }

        const lines = await repo.adjustmentLines(tx, context.orgId, adjustment.id);
        if (lines.length === 0) {
          throw new StockError('STOCK_MOVEMENT_INVALID', 'That adjustment has no lines.');
        }

        for (const line of lines) {
          await this.movements.apply(
            tx,
            { orgId: context.orgId, userId: context.userId },
            {
              skuId: line.sku_id,
              locationId: adjustment.location_id,
              kind: direction === 'loss' ? 'adjustment_loss' : 'adjustment_gain',
              qty: line.qty,
              // The frozen average the checker judged, not today's.
              unitCostPoisha: poisha(BigInt(line.unit_cost_poisha)),
              refType: 'adjustment',
              refId: adjustment.id,
              dedupeKey: `adjustment:${adjustment.id}:${line.sku_id}`,
              occurredAt: new Date(),
              memo: adjustment.reason,
            },
          );
        }

        const journalId = await this.post(tx, context, direction, adjustment, poisha(value));

        await repo.settleAdjustment(tx, context.orgId, adjustment.id, {
          status: 'posted',
          journalId,
        });

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: `inventory.adjustment.posted:${direction}`,
          entityType: 'StockAdjustment',
          entityId: adjustment.id,
          before: { status: 'pending_approval', journalId: null },
          after: {
            status: 'posted',
            journalId,
            approvalId: approval.id,
            stockValuePoisha: value.toString(),
          },
          requestId: context.requestId,
          ...(request === undefined ? {} : { request }),
        });
      });
    };
  }

  private async post(
    tx: Tx,
    context: ActiveContext,
    direction: 'loss' | 'gain',
    adjustment: repo.AdjustmentRow,
    valuePoisha: Poisha,
  ): Promise<string> {
    const counterSubtype: AccountSubtype =
      direction === 'loss' ? 'inventory_writeoff' : 'inventory_adjustment_gain';
    const [inventory, counter] = await Promise.all([
      this.account(tx, context.orgId, 'inventory'),
      this.account(tx, context.orgId, counterSubtype),
    ]);

    const posted = await this.ledger.post(
      tx,
      { orgId: context.orgId, userId: context.userId },
      stockAdjustmentDraft({
        adjustmentId: adjustment.id,
        // Today's date, not the request's: the journal records when the decision
        // was carried out, and back-dating into a closed period would be refused
        // by the period lock anyway (D-093).
        occurredAt: new Date(),
        direction,
        inventory,
        counterAccount: counter,
        valuePoisha,
        branchId: adjustment.branch_id,
        memo: adjustment.reason,
      }),
    );
    return posted.journalId;
  }

  private async account(
    tx: Tx,
    orgId: string,
    subtype: AccountSubtype,
  ): Promise<{ accountId: string; subtype: AccountSubtype; branchId: string | null }> {
    const row = await repo.accountBySubtype(tx, orgId, subtype);
    if (row === undefined) {
      throw new StockError(
        'LEDGER_ACCOUNT_NOT_FOUND',
        `This organization has no ${subtype} account.`,
      );
    }
    return { accountId: row.id, subtype, branchId: row.branch_id };
  }

  private view(row: repo.AdjustmentRow): AdjustmentView {
    return {
      id: row.id,
      locationId: row.location_id,
      branchId: row.branch_id,
      direction: row.direction as 'loss' | 'gain',
      status: row.status,
      countSessionId: row.count_session_id,
      // Named `stockValuePoisha` on purpose: it is in `COST_FIELDS`, so
      // `serializeFor` removes it for every role without `read:cost` without this
      // module doing anything (invariant 5). A field called `valuePoisha` would
      // have walked straight out to a warehouse packer.
      stockValuePoisha: row.value_poisha,
      reason: row.reason,
      approvalId: row.approval_request_id,
      journalId: row.journal_id,
      businessDate: row.business_date,
      createdBy: row.created_by,
    };
  }
}
