import { Injectable } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import { businessDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';

import { emit } from '../../platform/events/outbox.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { DHAKA_TZ, type QueueDefinition } from '../../platform/jobs/queues.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './inventory.repository.js';

/**
 * The nightly reconciliation (architecture §8, §20, §26).
 *
 * §8: "A nightly job recomputes levels from movements and alerts on any drift."
 * `stock_levels` is a cache, and the reason to rebuild it from the log is not that
 * the code is expected to be wrong — it is that the failure this catches is silent
 * by construction. Every screen reads the level, so a level that disagrees with its
 * movements looks perfectly normal until somebody counts a shelf.
 *
 * Two kinds of drift are checked, and the second is the one that compounds:
 *
 * * **Level drift**: `on_hand` ≠ Σ `qty_delta`. Visible immediately as wrong
 *   availability, and fixed by a `count_correction` once a person has looked.
 * * **Cost basis drift**: `sku_costs.qty_basis` ≠ Σ on-hand for the SKU. This one
 *   shows nothing at all — the average on every screen is the one it always was —
 *   and then the *next* receipt blends against the wrong denominator and the error
 *   grows with every purchase after it.
 *
 * A row is written whether or not anything was wrong, because "no drift reported"
 * and "the job stopped running on Tuesday" are the same silence otherwise, and the
 * second one is the emergency. The row is append-only (migration 0032).
 *
 * Nothing is repaired automatically. A drift means a write that should have been
 * impossible happened, and overwriting the evidence with a computed number would
 * destroy the only record of what the system thought before somebody investigates.
 */

/** Queues this module registers (§20 names them `module.action`). */
export const INVENTORY_QUEUES: readonly QueueDefinition[] = [
  {
    /**
     * The fan-out. Global, because a cron fires once rather than once per tenant.
     *
     * 02:00 in Asia/Dhaka, which is why `DHAKA_TZ` exists: pg-boss reads a cron in
     * UTC unless told otherwise, and `0 2 * * *` in UTC is 08:00 in Dhaka — the
     * reconciliation would run in the middle of the working day against stock that
     * is moving, and report every in-flight transaction as drift.
     */
    name: 'inventory.reconcile_levels',
    scope: 'global',
    cron: '0 2 * * *',
  },
  {
    /** One per org, enqueued by the fan-out. */
    name: 'inventory.reconcile_org',
    scope: 'org',
  },
];

export interface DriftDetail {
  readonly kind: 'level' | 'cost_basis';
  readonly skuId: string;
  readonly locationId?: string;
  readonly expected: number;
  readonly found: number;
}

export interface ReconcileResult {
  readonly reconciliationId: string;
  readonly businessDate: string;
  readonly levelsChecked: number;
  readonly driftCount: number;
  readonly costDriftCount: number;
  readonly details: readonly DriftDetail[];
}

@Injectable()
export class ReconcileService {
  /**
   * Fan out one tenant job per active org.
   *
   * `withGlobal` rather than `withOrg`: the org list is global by design (§5
   * exception 5) and there is no tenant to be inside while deciding which tenants
   * exist. Each enqueue carries its org id, and the handler runs inside `withOrg`
   * for that org, so nothing here reads tenant data.
   */
  async fanOut(): Promise<number> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.organizations where is_active order by slug
      `);
      return rows.map((row) => row.id);
    });

    for (const orgId of orgIds) {
      await withGlobal(async (tx) => {
        await enqueue(
          tx,
          'inventory.reconcile_org',
          {},
          {
            orgId,
            // One reconciliation per org per night. A second fan-out — a redeploy at
            // 02:00, a manual trigger — would otherwise write two rows for one date
            // and double the alert.
            singletonKey: `inventory.reconcile:${orgId}:${businessDate(new Date())}`,
          },
        );
      });
    }
    return orgIds.length;
  }

  /**
   * Reconcile one org, record what was found, and alert if anything drifted.
   *
   * `userId` is the actor recorded on the outbox row's context; the job has no user,
   * so the caller passes a system identity. Nothing here writes a movement or a
   * level, so there is no business actor to attribute.
   */
  async reconcileOrg(orgId: string, userId: string): Promise<ReconcileResult> {
    return withOrg({ orgId, userId }, async (tx) => {
      const [levelsChecked, levelDrift, costDrift] = await Promise.all([
        repo.countLevels(tx, orgId),
        repo.findLevelDrift(tx, orgId),
        repo.findCostDrift(tx, orgId),
      ]);

      const details: DriftDetail[] = [
        ...levelDrift.map((row) => ({
          kind: 'level' as const,
          skuId: row.sku_id,
          locationId: row.location_id,
          expected: row.movement_sum,
          found: row.level_on_hand,
        })),
        ...costDrift.map((row) => ({
          kind: 'cost_basis' as const,
          skuId: row.sku_id,
          expected: row.level_total,
          found: row.qty_basis,
        })),
      ];

      const businessDateValue = businessDate(new Date());
      const reconciliationId = await repo.insertReconciliation(tx, {
        orgId,
        businessDate: businessDateValue,
        levelsChecked,
        driftCount: levelDrift.length,
        costDriftCount: costDrift.length,
        // Quantities and ids, never a value: whoever investigates opens the row,
        // and a stock valuation reachable through a reconciliation detail would be
        // a cost report with no permission check in front of it.
        details,
      });

      if (details.length > 0) {
        await emit(
          tx,
          'stock.drift_detected',
          {
            reconciliationId,
            businessDate: businessDateValue,
            levelsChecked,
            driftCount: levelDrift.length,
            costDriftCount: costDrift.length,
          },
          { orgId },
        );
      }

      return {
        reconciliationId,
        businessDate: businessDateValue,
        levelsChecked,
        driftCount: levelDrift.length,
        costDriftCount: costDrift.length,
        details,
      };
    });
  }

  /**
   * Adjustments whose approval was rejected, brought into line.
   *
   * The approvals module runs an executor when a request is approved and nothing
   * when it is rejected, so a refused write-off would otherwise sit
   * `pending_approval` forever — reading, on every screen, as though a manager had
   * not looked at it yet. Swept nightly rather than mirrored at the moment of
   * rejection because that would mean the approvals module calling into this one on
   * a path it has no hook for, and a nightly sweep is honest about the delay
   * (D-145).
   *
   * A direct read of `approvals.approval_requests`, which is the same narrow
   * exception to invariant 12 that reading `ledger.accounts` is (D-121): one SELECT
   * of the decision, scoped by org like everything else.
   */
  async settleRejectedAdjustments(orgId: string, userId: string): Promise<number> {
    return withOrg({ orgId, userId }, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select a.id
        from inventory.adjustments a
        join approvals.approval_requests r on r.org_id = a.org_id and r.id = a.approval_request_id
        where a.org_id = ${orgId}
          and a.status = 'pending_approval'
          and r.status in ('rejected', 'cancelled')
      `);
      for (const row of rows) {
        await repo.settleAdjustment(tx, orgId, row.id, { status: 'rejected', journalId: null });
      }
      return rows.length;
    });
  }

  /** The last few nights' results, for the console and for an operator at 3am. */
  async history(
    context: ActiveContext,
    request: object,
    limit: number,
  ): Promise<{ items: unknown[] }> {
    // No branch column to scope by: a reconciliation is an org-wide sweep, and the
    // ability behind the route (`read StockAdjustment`) is what bounds who sees it.
    // `scopeWhere` is still called so `ScopeInterceptor` can see that this handler
    // considered the caller's scope rather than forgetting it.
    scopeWhere(request, {});
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.latestReconciliations(tx, context.orgId, limit)).map((row) => ({
        id: row.id,
        businessDate: row.business_date,
        levelsChecked: row.levels_checked,
        driftCount: row.drift_count,
        costDriftCount: row.cost_drift_count,
        details: row.details,
        ranAt: row.ran_at,
      })),
    }));
  }
}

/** Re-exported so the worker entrypoint does not have to import the queues file too. */
export { DHAKA_TZ };
