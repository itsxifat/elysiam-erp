import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { PACKING_QUEUES } from './packing.queues.js';
import type { PackingVideoService } from './video.service.js';

export interface PackingWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly videos: PackingVideoService;
  readonly report: JobFailureReporter;
}

/**
 * The packing module's handlers (M38b): the nightly retention of packing videos (D-612) and
 * the sweep of uploads no part took. A video or brand that fails does not stop the others;
 * the run then fails as a whole, so it is reported and tried again (every step is idempotent).
 */
export async function registerPackingJobs(deps: PackingWorkerDependencies): Promise<void> {
  const { jobs, videos, report } = deps;
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
}
