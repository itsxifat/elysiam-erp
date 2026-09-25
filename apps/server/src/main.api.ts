import 'reflect-metadata';

import { fastifyCookie } from '@fastify/cookie';
import { fastifyCors } from '@fastify/cors';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { activeOrgSlugs, createAuth, RecordingSmsProvider } from '@elysium/db';
import { Redis } from 'ioredis';

import { AppModule } from './app.module.js';
import { applyGlobalPipeline } from './platform/http/pipeline.js';
import { PasswordTokenStore } from './modules/iam/iam.service.js';
import { serverEnv } from './platform/config/env.js';
import { createLogger } from './platform/logging/logger.js';
import { registerAuth } from './platform/http/auth-plugin.js';
import { CSRF_HEADER } from './platform/http/csrf.js';
import { IDEMPOTENCY_HEADER } from './platform/http/idempotency.js';
import { isTrustedOrigin, withBrandOrigins } from './platform/http/origins.js';
import { ValkeyRateLimiter } from './platform/http/rate-limit.valkey.js';
import { createRealtimeGateway } from './platform/realtime/index.js';

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
      /*
       * The logger Fastify hands to `request.log` (§26).
       *
       * Without it Fastify defaults to `logger: false`, and `request.log.error`
       * is a no-op that writes nowhere. The audit interceptor's failure path
       * says "it must be loud, though: a silently missing audit trail is the
       * worst of both worlds" and was, in fact, completely silent — verified.
       * Handing pino to the adapter is what makes that sentence true, and it
       * also puts request logging on the same redaction rules as everything
       * else rather than on Fastify's defaults.
       */
      logger,
    }),
    {
      // Nest's own bootstrap chatter would bypass pino's redaction.
      logger: false,
    },
  );

  /*
   * The ability guard, the row-scope backstop, the serializer and the audit
   * net (architecture §6, §25, invariant 5), in the one order that is correct —
   * see pipeline.ts. Shared with the HTTP test suites so they cannot drift.
   */
  applyGlobalPipeline(app);

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
    // §23's `Idempotency-Key` belongs here too, and leaving it out made the
    // whole feature unreachable: a custom request header triggers a CORS
    // preflight, and a preflight that does not list the header fails before the
    // request is sent. Every browser client would have been silently unable to
    // send one, while the server-side tests — which use `inject` and never
    // preflight — passed.
    allowedHeaders: ['content-type', CSRF_HEADER, IDEMPOTENCY_HEADER],
    maxAge: 600,
  });

  /*
   * The credential rate limiter's counters, in Valkey (D-056's stated exit).
   *
   * Its own connection rather than the realtime adapter's: those two are in
   * subscriber mode, and a RESP client in subscriber mode may issue nothing but
   * subscribe and unsubscribe — an `EVAL` on either would be refused, so every
   * sign-in would fall through to the in-memory fallback and the global limit
   * would quietly not exist.
   *
   * `REALTIME_ADAPTER_KEY` as the namespace because it already answers "which
   * deployment is this", and counters keyed by path and email are identical
   * across environments — sharing them would let a staging load test lock
   * production's users out.
   */
  const limiterClient = new Redis(env.VALKEY_URL, {
    maxRetriesPerRequest: 2,
    // A failed EVAL degrades to the per-process fallback, so waiting is worse
    // than failing: a queued command would add its timeout to a login's latency.
    enableOfflineQueue: false,
  });
  limiterClient.on('error', (error: Error) => {
    logger.warn({ err: error }, 'rate limiter valkey connection error');
  });

  registerAuth(fastify, {
    auth,
    ...originPolicy,
    limiter: new ValkeyRateLimiter({
      client: limiterClient,
      keyPrefix: `rl:${env.REALTIME_ADAPTER_KEY}`,
      onError: (error) => {
        // Loud: the limits have silently become per-process, which is the state
        // D-056 exists to have moved away from.
        logger.error({ err: error }, 'rate limiter fell back to in-memory counters');
      },
    }),
    cookieDomain: env.APP_DOMAIN === 'localhost' ? undefined : `.${env.APP_DOMAIN}`,
    secure: env.NODE_ENV === 'production',
  });

  await app.listen({ port: env.API_PORT, host: env.API_HOST });
  logger.info({ port: env.API_PORT, host: env.API_HOST }, 'api listening');

  /*
   * The realtime gateway, after `listen` (architecture §19).
   *
   * Order, not taste. Socket.IO's `attach` takes the http server's existing
   * `request` listeners, removes them, and re-adds them *behind* its own so it
   * can claim the engine's paths first. Attaching before Fastify's listener is
   * in place would leave both handlers live for the same request, and engine.io
   * plus Fastify both answering one handshake is a "headers already sent" crash
   * on every connection.
   */
  const gateway = createRealtimeGateway(app.getHttpServer(), {
    auth,
    logger,
    ...originPolicy,
    valkey: { url: env.VALKEY_URL, key: env.REALTIME_ADAPTER_KEY },
  });

  /*
   * No outbox bridge here, and that is the design rather than an omission.
   *
   * §19 delivers from the outbox dispatcher, and the dispatch loop runs in the
   * worker (main.worker.ts) so that one process claims each row. This process
   * holds the sockets; the worker's broadcasts arrive on them through the Valkey
   * adapter. Bridging here as well would mean two loops claiming rows and each
   * delivering only its own share, which is the load-dependent half-delivery the
   * adapter exists to prevent.
   */
  logger.info({ namespace: '/rt' }, 'realtime gateway attached');

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'api shutting down');
      // The gateway first: it holds open WebSockets and two Valkey connections,
      // and `app.close()` does not know about any of them, so without this the
      // process would refuse to exit on a `SIGTERM` from the orchestrator.
      void gateway
        .close()
        .catch((error: unknown) => {
          logger.error({ err: error }, 'realtime gateway did not close cleanly');
        })
        // The rate limiter's own connection too, for the same reason: an open
        // ioredis socket keeps the event loop alive and the process would sit
        // there until the orchestrator escalates to SIGKILL.
        .then(() => limiterClient.quit())
        .catch((error: unknown) => {
          logger.warn({ err: error }, 'rate limiter valkey connection did not close cleanly');
        })
        .then(() => app.close())
        .then(() => process.exit(0));
    });
  }
}

bootstrap().catch((error: unknown) => {
  // The logger needs valid config, and the most likely failure here is invalid
  // config, so this one path writes to stderr directly.
  process.stderr.write(`api failed to start: ${String(error)}\n`);
  process.exit(1);
});
