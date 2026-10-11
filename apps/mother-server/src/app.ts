import 'reflect-metadata';

import { fastifyCookie } from '@fastify/cookie';
import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { accountCryptoFrom } from './account/account.js';
import type { MotherAuth } from './auth/auth.js';
import { registerAuth } from './http/auth-plugin.js';
import { CONTROLLERS } from './http/controllers.js';
import { OwnerGuard, ProblemFilter } from './http/nest.js';
import type { MemoryRateLimiter } from './http/rate-limit.js';
import { ACCOUNT_CRYPTO, RUNTIME, type MotherRuntime } from './runtime.js';

/**
 * The mother's API, assembled the one way both `main.api.ts` and the tests use (D-480):
 * Fastify with the cookie plugin, the auth plugin (CSRF, limits, the second-factor wall,
 * Better Auth), and Nest with the owner guard and the problem filter on every route.
 */

@Module({})
class MotherModule {
  static register(runtime: MotherRuntime, auth: MotherAuth): DynamicModule {
    return {
      module: MotherModule,
      controllers: CONTROLLERS,
      providers: [
        { provide: RUNTIME, useValue: runtime },
        { provide: ACCOUNT_CRYPTO, useFactory: () => accountCryptoFrom(auth) },
        {
          provide: APP_GUARD,
          useFactory: (reflector: Reflector) => new OwnerGuard(reflector),
          inject: [Reflector],
        },
        { provide: APP_FILTER, useValue: new ProblemFilter(runtime.logger) },
      ],
    };
  }
}

export interface BuildOptions {
  readonly runtime: MotherRuntime;
  readonly auth: MotherAuth;
  readonly trustedOrigins: readonly string[];
  readonly secure: boolean;
  /** Comma-separated proxy addresses or CIDRs whose `X-Forwarded-For` is believed. */
  readonly trustedProxies: string;
  readonly limiter?: MemoryRateLimiter;
  readonly rateLimitEnabled?: boolean;
}

export async function buildMotherApp(options: BuildOptions): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    // Addresses, never a count: Fastify 5 trusts no header for a hop count (D-487).
    trustProxy: options.trustedProxies.trim() === '' ? false : options.trustedProxies,
    loggerInstance: options.runtime.logger,
    bodyLimit: 256 * 1024,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    MotherModule.register(options.runtime, options.auth),
    adapter,
    { logger: false, abortOnError: false },
  );
  const fastify = app.getHttpAdapter().getInstance();
  await fastify.register(fastifyCookie as never);
  registerAuth(fastify, {
    auth: options.auth,
    trustedOrigins: options.trustedOrigins,
    secure: options.secure,
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    ...(options.rateLimitEnabled === undefined
      ? {}
      : { rateLimitEnabled: options.rateLimitEnabled }),
  });
  await app.init();
  return app;
}
