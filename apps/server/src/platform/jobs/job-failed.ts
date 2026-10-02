import { withOrg } from '@elysium/db';
import type { Logger } from 'pino';

import { emit } from '../events/outbox.js';
import { reportError } from '../observability/errors.js';
import type { JobFailure, JobFailureReporter } from './jobs.runtime.js';

/**
 * §20: "A job that lands in the dead-letter queue emits `job.failed`."
 *
 * Through the outbox, not through the socket gateway directly, because
 * `.claude/rules` is unambiguous — realtime events go only through the outbox —
 * and because the reason holds here too: the worker that noticed the failure and
 * the API instances holding the sockets are different processes.
 *
 * ## The global-job gap, stated rather than papered over
 *
 * `events.outbox.org_id` is NOT NULL, and rightly so: an event is addressed to
 * the org whose data changed, and the rooms are computed from it. A `global`
 * queue's job — a cron fan-out — has no org, so there is no row to write and no
 * audience to write it for. Choosing an org anyway would put an installation-wide
 * failure in one brand's notifications and hide it from the other four.
 *
 * So a global job's failure is logged at error level and stays visible in
 * `GET /v1/jobs/failed` to super admin, which is the role §5 exception 3 already
 * gives the cross-org view to. A super-admin-only, org-less event is the right
 * long-term answer and it needs the outbox schema to allow a null `org_id`; that
 * is a migration this slice does not own (D-0xx below).
 */
export function reportJobFailedThroughOutbox(logger: Logger): JobFailureReporter {
  return async (failure: JobFailure): Promise<void> => {
    // Pulled out of the object before the closure below: narrowing a property
    // does not survive into a callback, and `orgId!` would be the shape that
    // stops being true the first time someone reorders these two statements.
    const orgId = failure.orgId;

    // To the error tracker as well (§26: alert on job failures). One event per job that
    // spent its retries, named by queue and code; the payload stays in the database.
    reportError(new Error(`job dead-lettered on ${failure.queue}`), {
      kind: 'job',
      queue: failure.queue,
      code: failure.code,
    });

    if (orgId === null) {
      logger.error(
        { queue: failure.queue, ref: failure.ref, code: failure.code },
        'a global job was dead-lettered; no job.failed event, because the outbox has no org-less row',
      );
      return;
    }

    await withOrg({ orgId }, async (tx) => {
      await emit(
        tx,
        'job.failed',
        { queue: failure.queue, ref: failure.ref, code: failure.code },
        { orgId },
      );
    });

    // Logged as well as emitted. The event is a notification, which is read once
    // and by whoever happens to be looking; the log line is what an incident is
    // reconstructed from afterwards.
    logger.error(
      { queue: failure.queue, orgId: failure.orgId, ref: failure.ref, code: failure.code },
      'job dead-lettered',
    );
  };
}
