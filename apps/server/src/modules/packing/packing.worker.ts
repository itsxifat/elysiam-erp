import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { createLogger } from '../../platform/logging/logger.js';
import { PACKING_QUEUES, type SendPrintPayload } from './packing.queues.js';
import type { PrintingService } from './printing.service.js';
import type { PackingVideoService } from './video.service.js';

export interface PackingWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly videos: PackingVideoService;
  /** M46: the print queue (D-813, D-815). */
  readonly printing?: PrintingService;
  readonly report: JobFailureReporter;
}

/**
 * The packing module's handlers (M38b): the nightly retention of packing videos (D-612) and
 * the sweep of uploads no part took. A video or brand that fails does not stop the others;
 * the run then fails as a whole, so it is reported and tried again (every step is idempotent).
 */
export async function registerPackingJobs(deps: PackingWorkerDependencies): Promise<void> {
  const { jobs, videos, printing, report } = deps;
  await jobs.work(
    PACKING_QUEUES.purgeVideos.name,
    async () => {
      const result = await videos.purgeAll();
      if (result.failed > 0) {
        throw new Error(
          `packing video retention: ${String(result.failed)} failed, ${String(result.deleted)} deleted, ${String(result.swept)} uploads swept`,
        );
      }
    },
    report,
  );
  // D-917: nothing prints by itself any more and nothing enqueues `labels.auto_print`. A job
  // still sitting in it from before the deploy is completed here without printing: the order is
  // in "Ready for label" already, where a person prints it. (The worker's Nest context has no
  // logger, so the line goes through the platform's own.)
  let retired: ReturnType<typeof createLogger> | undefined;
  await jobs.work(
    PACKING_QUEUES.autoPrint.name,
    (job) => {
      retired ??= createLogger('packing');
      retired.info(
        { queue: job.queue, jobId: job.jobId, orgId: job.orgId, orderId: job.ref },
        'labels.auto_print job completed without printing: automatic printing is retired (D-917)',
      );
      return Promise.resolve();
    },
    report,
  );
  if (printing === undefined) return;
  // M46 (D-813): render and send one job to a network printer, no transaction open.
  await jobs.work<SendPrintPayload>(
    PACKING_QUEUES.send.name,
    async (job) => {
      if (job.orgId === null) throw new Error('a print job names its brand');
      await printing.send(job.orgId, job.payload);
    },
    report,
  );
  // M46 (D-815): every minute, how each network printer is.
  await jobs.work(PACKING_QUEUES.printerStatus.name, async () => printing.probeAll(), report);
}
