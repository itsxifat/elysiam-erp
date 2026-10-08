import { randomBytes } from 'node:crypto';

import { Module } from '@nestjs/common';

import { AuditService } from '../../../platform/audit/audit.service.js';
import type { JobFailureReporter, JobsRuntime } from '../../../platform/jobs/jobs.runtime.js';
import { FILES_API, FilesApiService } from '../../files/files.api.js';
import { createStorageDriver, filesEnv } from '../../files/files.config.js';
import { FilesService } from '../../files/files.service.js';
import { PACKING_QUEUES, type CameraCutPayload } from '../packing.queues.js';
import { CameraProcessService } from './camera-process.service.js';

/**
 * What the camera process builds (M38c): the files service (to keep a cut as a private packing
 * video) and the audit log, nothing else. The packing station, the orders and the catalog stay
 * in the API: this process records, cuts and files, and reads the packing tables directly
 * because they are its own module's (invariant 12).
 *
 * The files service is built here rather than through `FilesModule`, whose factory reads the
 * whole server configuration (ledger audit W5): this process holds no auth secret. It only
 * writes files (`storeProduced`) and forgets them, never signs a download, so the local
 * driver's signing key is a random one of its own that signs nothing the API would accept.
 */
@Module({
  providers: [
    AuditService,
    CameraProcessService,
    {
      provide: FilesService,
      useFactory: () => {
        const env = filesEnv();
        return new FilesService(
          createStorageDriver({
            env,
            apiPublicUrl: 'http://camera.invalid',
            authSecret: randomBytes(32).toString('hex'),
          }),
          env.FILE_URL_TTL_SECONDS,
          env.FILE_UPLOAD_TTL_SECONDS,
        );
      },
    },
    { provide: FILES_API, useClass: FilesApiService },
  ],
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
