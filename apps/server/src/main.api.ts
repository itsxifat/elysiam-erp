import 'reflect-metadata';

import { fastifyCookie } from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createAuth, RecordingSmsProvider } from '@elysium/db';

import { AppModule } from './app.module.js';
import { serverEnv } from './platform/config/env.js';
import { createLogger } from './platform/logging/logger.js';
import { registerAuth } from './platform/http/auth-plugin.js';

async function bootstrap(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('api');

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    // Nest's own bootstrap chatter would bypass pino's redaction.
    logger: false,
  });

  const fastify = app.getHttpAdapter().getInstance();
  // Cast: @fastify/cookie augments FastifyInstance, and its declared plugin
  // type no longer matches the un-augmented instance Nest hands back.
  await fastify.register(fastifyCookie as never);

  // The real SMS gateway arrives in M16 (D-012). Until then OTPs are recorded
  // rather than sent, which is also what the tests assert against.
  const { auth } = createAuth({
    baseUrl: `http://${env.API_HOST}:${String(env.API_PORT)}`,
    secret: env.AUTH_SECRET,
    trustedOrigins: env.TRUSTED_ORIGINS,
    cookieDomain: env.APP_DOMAIN === 'localhost' ? undefined : `.${env.APP_DOMAIN}`,
    sms: new RecordingSmsProvider(),
  });

  registerAuth(fastify, {
    auth,
    trustedOrigins: env.TRUSTED_ORIGINS,
    cookieDomain: env.APP_DOMAIN === 'localhost' ? undefined : `.${env.APP_DOMAIN}`,
    secure: env.NODE_ENV === 'production',
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
