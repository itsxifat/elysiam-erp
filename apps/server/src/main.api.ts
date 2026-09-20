import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { serverEnv } from './platform/config/env.js';
import { createLogger } from './platform/logging/logger.js';

async function bootstrap(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('api');

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    // Nest's own bootstrap chatter would bypass pino's redaction.
    logger: false,
  });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info({ port: env.API_PORT, host: env.API_HOST }, 'api listening');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'api shutting down');
      void app.close().then(() => process.exit(0));
    });
  }
}

bootstrap().catch((error: unknown) => {
  // The logger needs valid config, and the most likely failure here is invalid
  // config, so this one path writes to stderr directly.
  process.stderr.write(`api failed to start: ${String(error)}\n`);
  process.exit(1);
});
