import { pathToFileURL } from 'node:url';

import type { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';

import { BrandPools } from './brands/pools.js';
import { listBrands } from './brands/registry.js';
import { motherEnv } from './config/env.js';
import { secretsKeyFrom } from './crypto/secrets.js';
import { closeMotherDatabase, configureMotherDatabase } from './db/client.js';
import {
  appRoleOf,
  PULL_BRAND,
  PULL_NIGHTLY,
  PULL_TICK,
  sendPull,
  startJobsWorker,
  type PullBrandJob,
} from './jobs/jobs.js';
import { createLogger } from './logging/logger.js';
import { PullService } from './pull/pull.js';

/**
 * The mother's worker (D-484): the pull schedule and every pull. The only process that
 * talks to the brands on a timer; the API reads a brand only when an owner opens its page.
 */

/** Send one pull per active brand: the tick and the nightly run both do this. */
export async function fanOut(boss: PgBoss, trigger: 'schedule' | 'nightly'): Promise<number> {
  const brands = (await listBrands()).filter((brand) => brand.is_active);
  for (const brand of brands) {
    await sendPull(boss, { brandId: brand.id, trigger, full: trigger === 'nightly' });
  }
  return brands.length;
}

export async function registerWorkers(
  boss: PgBoss,
  service: PullService,
  logger: Logger,
): Promise<void> {
  await boss.work<PullBrandJob>(PULL_BRAND, async (jobs) => {
    for (const job of jobs) {
      // Each brand on its own: a failure is recorded on the brand, never thrown into the
      // queue, so one brand that is down never holds up another (D-486).
      const outcome = await service.pull(job.data.brandId, {
        trigger: job.data.trigger,
        full: job.data.full,
      });
      logger.debug({ brandId: job.data.brandId, status: outcome.status }, 'pull finished');
    }
  });
  await boss.work(PULL_TICK, async () => {
    const count = await fanOut(boss, 'schedule');
    logger.debug({ brands: count }, 'pull tick');
  });
  await boss.work(PULL_NIGHTLY, async () => {
    const count = await fanOut(boss, 'nightly');
    logger.info({ brands: count }, 'nightly full pull queued');
  });
}

async function main(): Promise<void> {
  const env = motherEnv();
  const logger = createLogger('mother-worker', {
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
  if (env.MOTHER_DATABASE_OWNER_URL === undefined) {
    throw new Error('The worker needs MOTHER_DATABASE_OWNER_URL for its job queue.');
  }
  configureMotherDatabase(env.MOTHER_DATABASE_URL);
  const pools = new BrandPools(
    () => secretsKeyFrom(env.MOTHER_SECRETS_KEY, env.MOTHER_SECRETS_KEY_ID),
    {
      connectTimeoutSeconds: env.MOTHER_BRAND_CONNECT_TIMEOUT_SECONDS,
      statementTimeoutMs: env.MOTHER_BRAND_STATEMENT_TIMEOUT_MS,
    },
  );
  const boss = await startJobsWorker({
    ownerUrl: env.MOTHER_DATABASE_OWNER_URL,
    appRole: appRoleOf(env.MOTHER_DATABASE_URL),
    logger,
    everyMinutes: env.MOTHER_PULL_EVERY_MINUTES,
  });
  const service = new PullService(pools, env.MOTHER_PULL_WINDOW_DAYS, logger);
  await registerWorkers(boss, service, logger);
  // A first pass at boot, so a restart does not leave the figures waiting for the tick.
  await fanOut(boss, 'schedule');
  logger.info({ everyMinutes: env.MOTHER_PULL_EVERY_MINUTES }, 'mother worker running');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'mother worker shutting down');
      void boss
        .stop({ graceful: true, close: true })
        .then(() => pools.closeAll())
        .then(() => closeMotherDatabase())
        .finally(() => process.exit(0));
    });
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`mother worker failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
