import { PgBoss } from 'pg-boss';
import type { Logger } from 'pino';
import postgres from 'postgres';

import { userOf } from '../db/roles.js';

/**
 * The pull schedule, on pg-boss in the mother's own database (D-484).
 *
 * - `pull-tick` every few minutes and `pull-nightly` at 03:30 Dhaka fan out one
 *   `pull-brand` job per active brand.
 * - `pull-brand` is `exclusive` by brand: at most one queued or running per brand, so an
 *   owner pressing "Pull now" during a scheduled pull adds nothing.
 *
 * The worker starts pg-boss as `mother_owner` (it migrates its own schema) and then grants
 * `mother_app` what enqueueing needs, every boot; the API only sends, as `mother_app`.
 */

export const JOBS_SCHEMA = 'pgboss';
export const PULL_BRAND = 'pull-brand';
export const PULL_TICK = 'pull-tick';
export const PULL_NIGHTLY = 'pull-nightly';
export const DHAKA = 'Asia/Dhaka';

export interface PullBrandJob {
  readonly brandId: string;
  readonly trigger: 'schedule' | 'nightly' | 'owner' | 'first';
  readonly full: boolean;
}

function newBoss(connectionString: string, role: 'worker' | 'client', schema: string): PgBoss {
  const isWorker = role === 'worker';
  return new PgBoss({
    connectionString,
    schema,
    application_name: `mother-jobs-${role}`,
    max: isWorker ? 4 : 2,
    migrate: isWorker,
    createSchema: isWorker,
    supervise: isWorker,
    schedule: isWorker,
  });
}

function watch(boss: PgBoss, logger: Logger): void {
  boss.on('error', (error: unknown) => {
    logger.error({ err: error }, 'pg-boss error');
  });
  boss.on('warning', (warning: unknown) => {
    logger.warn({ warning }, 'pg-boss warning');
  });
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export async function startJobsWorker(input: {
  readonly ownerUrl: string;
  readonly appRole: string;
  readonly logger: Logger;
  readonly everyMinutes: number;
  readonly schema?: string;
}): Promise<PgBoss> {
  const schema = input.schema ?? JOBS_SCHEMA;
  if (!IDENTIFIER.test(schema) || !IDENTIFIER.test(input.appRole)) {
    throw new Error('refusing to build DDL for an unexpected schema or role name');
  }
  const boss = newBoss(input.ownerUrl, 'worker', schema);
  watch(boss, input.logger);
  await boss.start();

  await boss.createQueue(PULL_BRAND, {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 15 * 60,
  });
  await boss.createQueue(PULL_TICK, { policy: 'exclusive', retryLimit: 0 });
  await boss.createQueue(PULL_NIGHTLY, { policy: 'exclusive', retryLimit: 1 });
  await boss.schedule(PULL_TICK, `*/${String(input.everyMinutes)} * * * *`, {}, { tz: DHAKA });
  await boss.schedule(PULL_NIGHTLY, '30 3 * * *', {}, { tz: DHAKA });

  // The API enqueues as mother_app; give it what that needs and nothing more (no DELETE).
  const sql = postgres(input.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    await sql.unsafe(`
      grant usage on schema ${schema} to ${input.appRole};
      grant select, insert, update on all tables in schema ${schema} to ${input.appRole};
      grant usage, select on all sequences in schema ${schema} to ${input.appRole};
      grant execute on all functions in schema ${schema} to ${input.appRole};
    `);
  } finally {
    await sql.end();
  }
  return boss;
}

export async function startJobsClient(input: {
  readonly appUrl: string;
  readonly logger: Logger;
  readonly schema?: string;
}): Promise<PgBoss> {
  const boss = newBoss(input.appUrl, 'client', input.schema ?? JOBS_SCHEMA);
  watch(boss, input.logger);
  await boss.start();
  return boss;
}

/**
 * One waiting pull per brand and kind. A full pull has its own key: under the `exclusive`
 * policy a tick's pull queued or running for the brand would otherwise swallow the nightly
 * full one, and a period reopened long ago would never reach the mother (D-484).
 */
export async function sendPull(boss: PgBoss, job: PullBrandJob): Promise<string | null> {
  const singletonKey = job.full ? `${job.brandId}:full` : job.brandId;
  return boss.send(PULL_BRAND, { ...job }, { singletonKey });
}

export function appRoleOf(appUrl: string): string {
  return userOf(appUrl);
}
