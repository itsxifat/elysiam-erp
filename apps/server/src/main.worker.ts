import 'reflect-metadata';

import { serverEnv } from './platform/config/env.js';
import { createLogger } from './platform/logging/logger.js';

/**
 * The worker runs the same codebase from a different entrypoint and owns every
 * outbound integration call (architecture §3). M04 registers the pg-boss queues
 * and the Asia/Dhaka cron schedules here.
 */
async function bootstrap(): Promise<void> {
  serverEnv();
  const logger = createLogger('worker');

  logger.info('ready');

  await new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        logger.info({ signal }, 'worker shutting down');
        resolve();
      });
    }
  });
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`worker failed to start: ${String(error)}\n`);
  process.exit(1);
});
