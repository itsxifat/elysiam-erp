import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { FILES_QUEUES } from './files.queues.js';
import type { FilesService } from './files.service.js';

/** Storage keys only: `private/<org>/…` or `public/<org>/…`, at most a few per file. */
const removePayload = z
  .object({
    keys: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^(private|public)\/[0-9a-f-]{36}\/[A-Za-z0-9/._-]+$/),
      )
      .min(1)
      .max(20),
  })
  .strict();

export interface FilesWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly files: FilesService;
  readonly report: JobFailureReporter;
}

/** The files module's handlers (M38b): removing the bytes of a deleted file. */
export async function registerFilesJobs(deps: FilesWorkerDependencies): Promise<void> {
  const { jobs, files, report } = deps;
  await jobs.work(
    FILES_QUEUES.removeObject.name,
    async (job) => {
      if (job.orgId === null) {
        throw new Error(`${FILES_QUEUES.removeObject.name} is tenant-scoped`);
      }
      const { keys } = removePayload.parse(job.payload);
      await files.removeStored(job.orgId, keys);
    },
    report,
  );
}
