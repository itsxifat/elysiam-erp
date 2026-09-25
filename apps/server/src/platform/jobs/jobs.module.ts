import { Module } from '@nestjs/common';

import { FailedJobsController } from './failed-jobs.controller.js';
import { FailedJobsService } from './failed-jobs.service.js';

/**
 * The API's half of background jobs (architecture §20).
 *
 * Read-only, and it holds no pg-boss instance. That is deliberate rather than
 * unfinished: a pg-boss client opens its own connection pool and, with
 * `migrate: false`, refuses to start at all until the worker has installed the
 * schema. Nothing in the API enqueues yet — M04 builds the mechanism, and the
 * first caller is M12's courier booking — so a client here would be a second
 * pool per API instance, and a boot that fails on a fresh database, in exchange
 * for nothing.
 *
 * The module that adds the first `enqueue` call from a request calls
 * `JobsRuntime.start({ role: 'client', … })` in its own lifecycle hook, and
 * `enqueue(tx, …)` finds it through the process-wide runtime. The worker
 * (`main.worker.ts`) already does exactly that with `role: 'worker'`.
 */
@Module({
  controllers: [FailedJobsController],
  providers: [FailedJobsService],
})
export class JobsModule {}
