import 'reflect-metadata';

import { pathToFileURL } from 'node:url';

import { buildMotherApp } from './app.js';
import { createMotherAuth } from './auth/auth.js';
import { BrandPools } from './brands/pools.js';
import { motherEnv, trustedOrigins } from './config/env.js';
import { secretsKeyFrom } from './crypto/secrets.js';
import { closeMotherDatabase, configureMotherDatabase } from './db/client.js';
import { sendPull, startJobsClient } from './jobs/jobs.js';
import { createLogger } from './logging/logger.js';

/**
 * The mother's API process (D-480): one process, behind nginx on the mother's own domain,
 * serving the console's calls on the same origin (D-491).
 */
async function main(): Promise<void> {
  const env = motherEnv();
  const logger = createLogger('mother-api', {
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development',
  });
  configureMotherDatabase(env.MOTHER_DATABASE_URL);

  const origins = trustedOrigins(env);
  const secure = new URL(env.MOTHER_PUBLIC_URL).protocol === 'https:';
  const auth = createMotherAuth({
    baseUrl: env.MOTHER_PUBLIC_URL,
    secret: env.MOTHER_AUTH_SECRET,
    trustedOrigins: origins,
  });
  const pools = new BrandPools(
    () => secretsKeyFrom(env.MOTHER_SECRETS_KEY, env.MOTHER_SECRETS_KEY_ID),
    {
      connectTimeoutSeconds: env.MOTHER_BRAND_CONNECT_TIMEOUT_SECONDS,
      statementTimeoutMs: env.MOTHER_BRAND_STATEMENT_TIMEOUT_MS,
    },
  );

  // The worker installs the queue schema; wait a little for it on a fresh database.
  let jobs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      jobs = await startJobsClient({ appUrl: env.MOTHER_DATABASE_URL, logger });
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      logger.warn({ err: error }, 'job schema not ready; waiting for the worker');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  const boss = jobs;

  const app = await buildMotherApp({
    runtime: {
      publicUrl: env.MOTHER_PUBLIC_URL,
      secrets: () => secretsKeyFrom(env.MOTHER_SECRETS_KEY, env.MOTHER_SECRETS_KEY_ID),
      pools,
      enqueuePull: async (job) => {
        await sendPull(boss, job);
      },
      weights: env.MOTHER_LEADERBOARD_WEIGHTS,
      clock: () => new Date(),
      logger,
    },
    auth,
    trustedOrigins: origins,
    secure,
    trustedProxies: env.MOTHER_TRUSTED_PROXIES,
  });

  await app.listen({ port: env.MOTHER_API_PORT, host: env.MOTHER_API_HOST });
  logger.info({ port: env.MOTHER_API_PORT, host: env.MOTHER_API_HOST }, 'mother api listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'mother api shutting down');
      void app
        .close()
        .then(() => boss.stop({ graceful: true, close: true }))
        .then(() => pools.closeAll())
        .then(() => closeMotherDatabase())
        .finally(() => process.exit(0));
    });
  }
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`mother api failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
