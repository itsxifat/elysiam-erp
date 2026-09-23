import 'reflect-metadata';

import { fastifyCookie } from '@fastify/cookie';
import { fastifyCors } from '@fastify/cors';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { activeOrgSlugs, createAuth, RecordingSmsProvider } from '@elysium/db';

import { AppModule } from './app.module.js';
import { AbilityGuard } from './platform/auth/abilities.js';
import { SerializeInterceptor } from './platform/http/serialize.interceptor.js';
import { PasswordTokenStore } from './modules/iam/iam.service.js';
import { serverEnv } from './platform/config/env.js';
import { createLogger } from './platform/logging/logger.js';
import { registerAuth } from './platform/http/auth-plugin.js';
import { CSRF_HEADER } from './platform/http/csrf.js';
import { isTrustedOrigin, withBrandOrigins } from './platform/http/origins.js';

async function bootstrap(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('api');

  /*
   * The trusted origins, resolved once (architecture §25, D-035, D-054).
   *
   * Enumerated, never patterned: the configured origins plus one per active
   * brand hostname. A wildcard would trust every host under the domain —
   * including the Vercel landing sites (D-026) and Chatwoot (§16) — and CORS is
   * the control that stops a sibling host using the CSRF token it can already
   * read. One list feeds CORS, the CSRF origin check and Better Auth, so the
   * three cannot drift apart or interpret a pattern differently.
   */
  const originPolicy = {
    trustedOrigins: withBrandOrigins(env.TRUSTED_ORIGINS, env.APP_DOMAIN, await activeOrgSlugs()),
  };
  logger.info({ origins: originPolicy.trustedOrigins.length }, 'trusted origins resolved');

  // Built before Nest, because the modules depend on it: it owns a connection
  // pool and a shutdown, so the composition root makes it rather than a module.
  //
  // The real SMS gateway and email adapter arrive in M16 (D-012). Until then
  // OTPs are recorded rather than sent, and an invite token is handed back to
  // the admin who created the user instead of being emailed to them.
  const tokens = new PasswordTokenStore();
  const { auth } = createAuth({
    baseUrl: env.API_PUBLIC_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: originPolicy.trustedOrigins,
    cookieDomain: env.APP_DOMAIN === 'localhost' ? undefined : `.${env.APP_DOMAIN}`,
    sms: new RecordingSmsProvider(),
    onPasswordToken: ({ email, token }) => {
      tokens.put(email, token);
      return Promise.resolve();
    },
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ auth, tokens }),
    // `trustProxy` is what makes `request.ip` the client rather than the proxy,
    // and the per-IP rate limit is only meaningful if it is right (§25).
    //
    // Cast: Fastify passes this straight to `proxy-addr`, which accepts a hop
    // count, but the published type only lists the boolean/string/function
    // forms. 0 becomes `false` — trust the socket, no proxy.
    new FastifyAdapter({
      trustProxy:
        env.TRUSTED_PROXY_COUNT === 0 ? false : (env.TRUSTED_PROXY_COUNT as unknown as boolean),
    }),
    {
      // Nest's own bootstrap chatter would bypass pino's redaction.
      logger: false,
    },
  );

  /*
   * The ability guard, globally (architecture §6).
   *
   * Global rather than per-controller on purpose: a guard you have to remember
   * to add is a guard that is missing from the route somebody wrote in a hurry.
   * It denies anything that has not declared what it needs, and
   * `check-route-matrix` fails the build for the same omission, so the two
   * agree about what "undeclared" means.
   */
  app.useGlobalGuards(new AbilityGuard(app.get(Reflector)));

  /*
   * And the serializer, on the way out (invariant 5).
   *
   * Global for the same reason the guard is: a handler that forgets
   * `serializeFor` returns cost to a reseller and nothing anywhere says so.
   * Responses are the one place the failure is silent in both directions —
   * nobody reports a bug about seeing more than they should.
   */
  app.useGlobalInterceptors(new SerializeInterceptor(app.get(Reflector)));

  const fastify = app.getHttpAdapter().getInstance();
  // Cast: @fastify/cookie augments FastifyInstance, and its declared plugin
  // type no longer matches the un-augmented instance Nest hands back.
  await fastify.register(fastifyCookie as never);

  /*
   * CORS (architecture §25).
   *
   * The console, the portal and the POS are served from their own origins and
   * talk to this API cross-origin, with cookies. That combination has two hard
   * requirements the browser enforces: the allowed origin must be echoed
   * exactly — `*` is rejected outright once credentials are involved — and
   * `credentials` must be true, or the session cookie is simply never sent and
   * every request looks anonymous.
   */
  await fastify.register(fastifyCors as never, {
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow: boolean) => void,
    ) => {
      // No Origin header at all is a same-origin or non-browser request; CORS
      // has nothing to decide, and CSRF still applies to it.
      if (origin === undefined) return callback(null, true);
      callback(null, isTrustedOrigin(origin, originPolicy));
    },
    credentials: true,
    // The double-submit token rides in a custom header, which means every
    // mutation is preflighted. Omitting it here would fail them all.
    allowedHeaders: ['content-type', CSRF_HEADER],
    maxAge: 600,
  });

  registerAuth(fastify, {
    auth,
    ...originPolicy,
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
