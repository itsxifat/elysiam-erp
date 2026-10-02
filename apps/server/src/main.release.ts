/**
 * The release step (architecture §28; M14b, D-340).
 *
 *   node dist/main.release.js
 *
 * Brings the database up to this release before any of its containers boot: the schema
 * migrations as `erp_owner`, then the job queue's schema, queues and grants. Kamal's
 * `pre-deploy` hook runs it from the new image (`infra/kamal/hooks/pre-deploy`), in the
 * worker role, the only role holding `DATABASE_OWNER_URL`; the API never sees the owner.
 *
 * The queues are here as well as in the worker's boot because the API waits for them:
 * on a first deploy, an API booted before any worker would spend its minute waiting for a
 * schema nobody was installing. Both steps are idempotent, and the migrations hold an
 * advisory lock, so a release step run twice, or beside a booting worker, is harmless.
 */
import { currentDatabaseConfig, runMigrations } from '@elysium/db';

import { ALL_QUEUES } from './job-queues.js';
import { JobsRuntime } from './platform/jobs/jobs.runtime.js';
import { createLogger } from './platform/logging/logger.js';

async function release(): Promise<void> {
  const logger = createLogger('release');
  const database = currentDatabaseConfig();
  const ownerUrl = database.DATABASE_OWNER_URL;
  if (ownerUrl === undefined || ownerUrl === '') {
    throw new Error('the release step needs DATABASE_OWNER_URL: it runs as erp_owner (§28)');
  }

  const { total, milliseconds } = await runMigrations(ownerUrl);
  logger.info({ total, milliseconds }, 'migrations applied');

  const jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: ownerUrl,
    appRole: decodeURIComponent(new URL(database.DATABASE_URL).username) || 'erp_app',
    queues: ALL_QUEUES,
    logger,
  });
  const drift = jobs.policyDrift();
  await jobs.stop();
  logger.info(
    { queues: ALL_QUEUES.length, drift },
    drift.length === 0
      ? 'job queues ready'
      : 'job queues ready; some policies drifted, see docs/runbooks/queue-policy.md',
  );
}

release().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`release failed: ${String(error)}\n`);
    process.exit(1);
  },
);
