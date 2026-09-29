import type { Logger } from 'pino';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { ReconcileService } from './reconcile.service.js';

/**
 * Wiring the nightly stock reconciliation to its handlers (architecture §8, §20; M07 check 5).
 *
 * `reconcile.service.ts` declared two queues — the 02:00 Dhaka fan-out and one job per org —
 * and nothing anywhere worked either of them. `reconcileOrg` was tested by calling it
 * directly, so the check read green while the job §8 requires ("a nightly job recomputes
 * levels from movements and alerts on any drift") had never run once: no handler, no queue
 * registration in the worker, no cron. Drift would have sat in the database until somebody
 * counted a shelf.
 *
 * A function rather than a lifecycle hook, for the reason `courier.worker.ts` gives: the
 * worker is the one process that runs jobs, and a hook would register these in the API as
 * well — a second pool per instance doing work the worker already does. `main.worker.ts`
 * calls it beside `registerCourierJobs`, with `INVENTORY_QUEUES` added to the runtime's
 * queue list so the cron is created.
 */

/** The actor a reconciliation's outbox rows name. The job has no user behind it. */
export const INVENTORY_SYSTEM_USER = 'system:inventory';

/**
 * The two queues `INVENTORY_QUEUES` defines. Named again rather than looked up by index:
 * `jobs.work` refuses a queue the runtime was not started with, so a rename that missed
 * one side fails at worker boot instead of silently working nothing.
 */
export const RECONCILE_FAN_OUT_QUEUE = 'inventory.reconcile_levels';
export const RECONCILE_ORG_QUEUE = 'inventory.reconcile_org';

export interface InventoryWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly reconcile: ReconcileService;
  readonly report: JobFailureReporter;
  readonly logger: Logger;
}

export async function registerInventoryJobs(deps: InventoryWorkerDependencies): Promise<void> {
  const { jobs, reconcile, report, logger } = deps;

  // The cron fires this once. Global: it decides which tenants exist, and enqueues one
  // tenant job for each, so a slow brand cannot hold up the other four.
  await jobs.work(
    RECONCILE_FAN_OUT_QUEUE,
    async () => {
      const orgs = await reconcile.fanOut();
      logger.info({ orgs }, 'stock reconciliation fanned out');
    },
    report,
  );

  await jobs.work(
    RECONCILE_ORG_QUEUE,
    async (job) => {
      if (job.orgId === null) throw new Error(`${RECONCILE_ORG_QUEUE} is tenant-scoped`);
      const result = await reconcile.reconcileOrg(job.orgId, INVENTORY_SYSTEM_USER);
      if (result.driftCount > 0 || result.costDriftCount > 0) {
        // Counts and the org, never a quantity or a SKU: the details are in the row, behind
        // the reconciliations route's permission check.
        logger.warn(
          {
            orgId: job.orgId,
            driftCount: result.driftCount,
            costDriftCount: result.costDriftCount,
          },
          'stock drift detected',
        );
      }
    },
    report,
  );
}
