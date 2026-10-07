import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { PACKING_QUEUES } from './packing.queues.js';
import type { PackingVideoService } from './video.service.js';

export interface PackingWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly videos: PackingVideoService;
  readonly report: JobFailureReporter;
}

/** The packing module's handlers (M38b): the nightly retention of packing videos (D-612). */
export async function registerPackingJobs(deps: PackingWorkerDependencies): Promise<void> {
  const { jobs, videos, report } = deps;
  await jobs.work(
    PACKING_QUEUES.purgeVideos.name,
    async () => {
      await videos.purgeAll();
    },
    report,
  );
}
