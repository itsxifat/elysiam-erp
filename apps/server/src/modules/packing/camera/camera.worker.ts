import { Module } from '@nestjs/common';

import { AuditService } from '../../../platform/audit/audit.service.js';
import type { JobFailureReporter, JobsRuntime } from '../../../platform/jobs/jobs.runtime.js';
import { FilesModule } from '../../files/files.module.js';
import { PACKING_QUEUES, type CameraCutPayload } from '../packing.queues.js';
import { CameraProcessService } from './camera-process.service.js';

/**
 * What the camera process builds (M38c): the files module (to keep a cut as a private packing
 * video) and the audit log, nothing else. The packing station, the orders and the catalog stay
 * in the API: this process records, cuts and files, and reads the packing tables directly
 * because they are its own module's (invariant 12).
 */
@Module({
  imports: [FilesModule],
  providers: [AuditService, CameraProcessService],
  exports: [CameraProcessService],
})
export class CameraModule {}

/**
 * The camera process's one queue: cut a packing's video once its window closed (D-672). A
 * failure is retried (five times over about three minutes, the buffer holds half an hour) and
 * then reported like any job.
 */
export async function registerCameraJobs(deps: {
  readonly jobs: JobsRuntime;
  readonly camera: CameraProcessService;
  readonly report: JobFailureReporter;
}): Promise<void> {
  await deps.jobs.work<CameraCutPayload>(
    PACKING_QUEUES.cameraCut.name,
    async (job) => {
      if (job.orgId === null) throw new Error('a camera cut names its brand');
      await deps.camera.cut(job.orgId, job.payload.sessionId);
    },
    deps.report,
  );
}
