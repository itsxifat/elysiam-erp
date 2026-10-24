import 'reflect-metadata';

import { fastifyCookie } from '@fastify/cookie';
import { fastifyCors } from '@fastify/cors';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  activeOrgSlugs,
  createAuth,
  currentDatabaseConfig,
  RecordingSmsProvider,
} from '@elysium/db';
import { Redis } from 'ioredis';

import { AppModule } from './app.module.js';
import { ALL_QUEUES } from './job-queues.js';
import { JobsRuntime } from './platform/jobs/jobs.runtime.js';
import { applyGlobalPipeline } from './platform/http/pipeline.js';
import { PasswordTokenStore } from './modules/iam/iam.service.js';
import { serverEnv } from './platform/config/env.js';
import { createLogger } from './platform/logging/logger.js';
import { reportError, shutdownObservability } from './platform/observability/errors.js';
import type { Logger } from 'pino';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { registerAuth } from './platform/http/auth-plugin.js';
import { corsOptions } from './platform/http/cors.js';
import { withBrandOrigins } from './platform/http/origins.js';
import { credentialRateLimitsEnabled } from './platform/http/rate-limit.js';
import { ValkeyRateLimiter } from './platform/http/rate-limit.valkey.js';
import { createRealtimeGateway } from './platform/realtime/index.js';
import { useTrackingRateLimitStore } from './modules/courier/tracking.service.js';
import { loadDeploymentBrand } from './platform/brand/deployment.js';

/**
 * The Fastify adapter, exactly as the running API builds it.
 *
 * Extracted so a test can construct it. Nothing else in this file is reachable from a
 * test: every suite builds the application through `startHttpHarness`, which makes its
 * own adapter, so `main.api.ts` is only ever executed by `main.api.js` in a real process
 * — and a boot-time throw here is therefore invisible to the whole suite. One did ship:
 * Fastify 5 split `logger` (options only) from `loggerInstance` (a built logger), and
 * passing pino to `logger` threw `FST_ERR_LOG_INVALID_LOGGER_CONFIG` before the first
 * request, with 1,500 tests green.
 */
/**
 * `TRUSTED_PROXY_COUNT` as Fastify's `trustProxy` (§25, D-479): trust the `count` nearest
 * hops, the socket's peer first, and take the first address beyond them as the client.
 *
 * A function, not the number. Fastify 5.12 turns a numeric `trustProxy` into "trust
 * nothing" (`getTrustProxyFn`: hop-count trust "cannot validate the immediate peer", so it
 * fails closed), which made `request.ip` the proxy's own address for every visitor: one
 * per-address rate-limit bucket for the whole country behind nginx. Trusting by hop is
 * safe here because the API is only reachable through its proxy: every deployment
 * publishes its port on 127.0.0.1 alone (infra/brand, infra/preview, infra/kamal), and the
 * proxy sets `X-Forwarded-For` to the visitor rather than appending to what they sent.
 * 0 means no proxy: the socket's peer is the client and the header is ignored.
 */
export function trustProxyFor(count: number): false | ((address: string, hop: number) => boolean) {
  if (!Number.isSafeInteger(count) || count <= 0) return false;
  // The nearest hop must also be a machine of ours (loopback or a private network, as the
  // host's nginx and Docker's bridge are): a port published to the internet by mistake
  // then trusts nothing, rather than a visitor's own header.
  return (address, hop) => hop < count && (hop > 0 || isPrivateAddress(address));
}

/** Loopback, private (RFC 1918), unique-local or link-local, IPv4-mapped included. */
export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const v4 = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  if (isIP(v4) === 4) {
    const [a = -1, b = -1] = v4.split('.').map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (isIP(lower) === 6) {
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

export function createApiAdapter(trustedProxyCount: number, logger: Logger): FastifyAdapter {
  return new FastifyAdapter({
    // `trustProxy` is what makes `request.ip` the client rather than the proxy,
    // and the per-IP rate limit is only meaningful if it is right (§25).
    trustProxy: trustProxyFor(trustedProxyCount),
    /*
     * The logger Fastify hands to `request.log` (§26).
     *
     * Without it Fastify defaults to `logger: false`, and `request.log.error` is a no-op
     * that writes nowhere. The audit interceptor's failure path says "it must be loud,
     * though: a silently missing audit trail is the worst of both worlds" and was, in
     * fact, completely silent — verified. Handing pino to the adapter is what makes that
     * sentence true, and it also puts request logging on the same redaction rules as
     * everything else rather than on Fastify's defaults.
     *
     * `loggerInstance`, not `logger`, for the Fastify 5 reason above.
     */
    loggerInstance: logger,
  });
}

/**
 * Start the jobs client, waiting a bounded time for the worker to install the schema.
 *
 * A client never creates pg-boss's schema — only the worker migrates it — so on a fresh
 * database, or under `pnpm dev` where both processes start together, the API can come
 * up first. Failing immediately would crash-loop the API until the worker won the race;
 * waiting forever would hide a worker that is not coming. A minute, logged while it
 * waits, then the real error.
 */
export async function startJobsClient(logger: Logger): Promise<JobsRuntime> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await JobsRuntime.start({
        role: 'client',
        connectionString: currentDatabaseConfig().DATABASE_URL,
        queues: ALL_QUEUES,
        logger,
      });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      logger.warn({ err: error }, 'jobs schema not ready; waiting for the worker to install it');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function bootstrap(): Promise<void> {
  const env = serverEnv();
  const logger = createLogger('api');

  /*
   * One brand per deployment (D-470). With `ERP_BRAND_SLUG` set, a database holding any
   * other real brand stops the process here, before it serves anything. The brand's own
   * name then signs the second factor and the sign-in texts (D-472).
   */
  const brand = await loadDeploymentBrand(env.ERP_BRAND_SLUG);
  if (brand !== null) logger.info({ brand: brand.slug }, 'brand deployment');

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
    // A brand's own deployment serves one host per app, all listed in TRUSTED_ORIGINS: it
    // has no per-brand hostnames to add (D-474).
    trustedOrigins: withBrandOrigins(
      env.TRUSTED_ORIGINS,
      env.APP_DOMAIN,
      brand === null ? await activeOrgSlugs() : [],
    ),
  };
  logger.info({ origins: originPolicy.trustedOrigins.length }, 'trusted origins resolved');

  /*
   * The credential limits, ours and Better Auth's, decided once for both. Off only for the
   * real-stack browser runs (`CREDENTIAL_RATE_LIMITS=off`), which production refuses to
   * boot with; said loudly when it happens.
   */
  const credentialLimits = credentialRateLimitsEnabled(env);
  if (!credentialLimits) {
    logger.warn(
      'credential rate limits are OFF (CREDENTIAL_RATE_LIMITS=off): a throwaway test stack only',
    );
  }

  // Built before Nest, because the modules depend on it: it owns a connection
  // pool and a shutdown, so the composition root makes it rather than a module.
  //
  // M16 built the notify module's SMS gateway, but sign-in OTPs do not go through
  // it yet (D-212): the gateway is unverified (D-012) and Better Auth's port returns
  // nothing a delivery log could use. Until then OTPs are recorded rather than sent,
  // and an invite token is handed back to the admin who created the user instead of
  // being emailed to them — there is no email adapter.
  const tokens = new PasswordTokenStore();
  const { auth } = createAuth({
    baseUrl: env.API_PUBLIC_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: originPolicy.trustedOrigins,
    cookieDomain: env.APP_DOMAIN === 'localhost' ? undefined : `.${env.APP_DOMAIN}`,
    sms: new RecordingSmsProvider(),
    rateLimitEnabled: credentialLimits,
    ...(brand === null ? {} : { brandName: brand.displayName }),
    onPasswordToken: ({ email, token }) => {
      tokens.put(email, token);
      return Promise.resolve();
    },
  });

  const limiterClient = new Redis(env.VALKEY_URL, {
    maxRetriesPerRequest: 2,
    // A failed EVAL degrades to the per-process fallback, so waiting is worse
    // than failing: a queued command would add its timeout to a login's latency.
    enableOfflineQueue: false,
  });
  limiterClient.on('error', (error: Error) => {
    logger.warn({ err: error }, 'rate limiter valkey connection error');
  });
  const limiter = new ValkeyRateLimiter({
    client: limiterClient,
    keyPrefix: `rl:${env.REALTIME_ADAPTER_KEY}`,
    onError: (error) => {
      // Loud: the limits have silently become per-process, which is the state
      // D-056 exists to have moved away from.
      logger.error({ err: error }, 'rate limiter fell back to in-memory counters');
    },
  });

  /*
   * Built before the application, and handed to the public tracking page first.
   *
   * `POST /v1/track` is the one route a stranger can use to guess at an order (M15 check
   * 3), and its guard is a limit of five attempts per order. Its provider resolves the
   * store while Nest initialises, so a limiter created after `NestFactory.create` — where
   * this block used to sit — arrives too late and the route falls back to a per-process
   * counter: five guesses per *replica*, which is a limit that weakens every time the API
   * scales out.
   */
  useTrackingRateLimitStore(limiter);

  const app = await NestFactory.create<NestFastifyApplication>(
    // Valkey joins the readiness checks here, through the rate limiter's own connection:
    // with its offline queue off, a ping fails at once rather than waiting (§26).
    AppModule.register({ auth, tokens, readiness: { valkey: () => limiterClient.ping() } }),
    // `trustProxy` is what makes `request.ip` the client rather than the proxy,
    // and the per-IP rate limit is only meaningful if it is right (§25).
    //
    // Cast: Fastify passes this straight to `proxy-addr`, which accepts a hop
    // count, but the published type only lists the boolean/string/function
    // forms. 0 becomes `false` — trust the socket, no proxy.
    createApiAdapter(env.TRUSTED_PROXY_COUNT, logger),
    {
      // Nest's own bootstrap chatter would bypass pino's redaction.
      logger: false,
      // With the logger off, Nest's default on a provider that throws is to log through
      // nothing and `process.exit(1)` itself — so the handler at the bottom of this file
      // never saw the error and the API died without a word (an empty `.env` value did
      // exactly that, 2026-10-02). Rethrowing hands it to that handler, which prints it.
      abortOnError: false,
    },
  );

  /*
   * The ability guard, the row-scope backstop, the serializer and the audit
   * net (architecture §6, §25, invariant 5), in the one order that is correct —
   * see pipeline.ts. Shared with the HTTP test suites so they cannot drift.
   */
  applyGlobalPipeline(app);

  /*
   * The jobs runtime, as a client: the API enqueues, the worker runs.
   *
   * This line did not exist, and nothing noticed. `enqueue(tx, …)` needs a started
   * runtime in the process that calls it, and every test suite that enqueues starts its
   * own, so the whole suite was green while the running API threw on every request that
   * queued work: a courier booking from an order transition failed inside the request. Started before `listen`, because the first request may be one
   * that enqueues.
   */
  const jobs = await startJobsClient(logger);

  const fastify = app.getHttpAdapter().getInstance();
  // Cast: @fastify/cookie augments FastifyInstance, and its declared plugin
  // type no longer matches the un-augmented instance Nest hands back.
  await fastify.register(fastifyCookie as never);

  // CORS (architecture §25): the exact-origin, credentialed policy in `cors.ts`.
  await fastify.register(fastifyCors as never, corsOptions(originPolicy));

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
  registerAuth(fastify, {
    auth,
    ...originPolicy,
    limiter,
    rateLimitEnabled: credentialLimits,
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
        .then(() => jobs.stop())
        .catch((error: unknown) => {
          logger.warn({ err: error }, 'jobs client did not stop cleanly');
        })
        .then(() => app.close())
        // Last: the error events and spans of the requests just drained (§26).
        .then(() => shutdownObservability())
        .then(() => process.exit(0));
    });
  }
}

/*
 * Boot only when this file *is* the process.
 *
 * Without the guard, importing this module for `createApiAdapter` starts a real server —
 * and on missing configuration takes `process.exit(1)` with it, which ends the test runner
 * rather than the test. A composition root that runs on import is one no test can reach,
 * which is how the Fastify 5 `loggerInstance` change shipped unnoticed.
 */
const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url) {
  bootstrap().catch(async (error: unknown) => {
    // The logger needs valid config, and the most likely failure here is invalid
    // config, so this one path writes to stderr directly.
    process.stderr.write(`api failed to start: ${String(error)}\n`);
    // A boot that fails during a deploy is the error most worth being told about.
    reportError(error, { kind: 'boot', process: 'api' });
    await shutdownObservability();
    process.exit(1);
  });
}
