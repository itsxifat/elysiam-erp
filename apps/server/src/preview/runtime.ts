import { fastifyCookie } from '@fastify/cookie';
import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createAuth, currentDatabaseConfig, RecordingSmsProvider, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

import { AppModule } from '../app.module.js';
import { ALL_QUEUES } from '../job-queues.js';
import { createApiAdapter } from '../main.api.js';
import { PasswordTokenStore } from '../modules/iam/iam.service.js';
import { MigrationModule } from '../modules/migration/migration.module.js';
import { serverEnv } from '../platform/config/env.js';
import { OutboxDispatcher } from '../platform/events/dispatcher.js';
import { registerAuth } from '../platform/http/auth-plugin.js';
import { applyGlobalPipeline } from '../platform/http/pipeline.js';
import { MemoryRateLimiter } from '../platform/http/rate-limit.js';
import { JobsRuntime } from '../platform/jobs/jobs.runtime.js';
import { registerWorkerJobs, runDispatchLoop } from '../worker-jobs.js';
import { PreviewClient, SEED_ORIGIN } from './client.js';

/**
 * The application, booted inside the preview seed's own process (D-380).
 *
 * The API exactly as `main.api.ts` mounts it — `AppModule`, the global pipeline, the auth
 * plugin — but reached through `server.inject()` instead of a port, so nothing listens
 * and nothing outside this process can call it. Beside it, the worker's job handlers and
 * its outbox dispatch loop (`worker-jobs.ts`), so the work a request queues — a parcel
 * booking, a target's progress, a dashboard rollup — is done by the same code a deployed
 * worker runs, before the seed checks the books and exits.
 *
 * The seed's Better Auth instance trusts one origin, `SEED_ORIGIN`, which no browser
 * uses; the password-set tokens it mints are kept in this process (`tokens`), which is
 * how an invite is redeemed while there is no email adapter (D-212).
 */

@Module({})
class PreviewRoot {}

export interface PreviewRuntime {
  readonly app: NestFastifyApplication;
  readonly server: FastifyInstance;
  readonly auth: ReturnType<typeof createAuth>;
  readonly tokens: PasswordTokenStore;
  /** A fresh anonymous browser with its own address. */
  client(): PreviewClient;
  /**
   * Wait until every job that is due has run and the outbox is empty, so what a request
   * set in motion has finished. Returns what is still pending after `timeoutMs`.
   */
  settle(timeoutMs?: number): Promise<{ readonly jobs: number; readonly events: number }>;
  close(): Promise<void>;
}

export async function startPreviewRuntime(logger: Logger): Promise<PreviewRuntime> {
  const env = serverEnv();
  const database = currentDatabaseConfig();
  const ownerUrl = database.DATABASE_OWNER_URL;
  if (ownerUrl === undefined || ownerUrl === '') {
    throw new Error('preview:seed needs DATABASE_OWNER_URL, like `pnpm db:seed`.');
  }

  const tokens = new PasswordTokenStore();
  const auth = createAuth({
    baseUrl: env.API_PUBLIC_URL,
    secret: env.AUTH_SECRET,
    trustedOrigins: [SEED_ORIGIN],
    sms: new RecordingSmsProvider(),
    // The seed signs in a dozen people from one process in a few seconds.
    rateLimitEnabled: false,
    onPasswordToken: ({ email, token }) => {
      tokens.put(email, token);
      return Promise.resolve();
    },
  });

  const root: DynamicModule = {
    module: PreviewRoot,
    // The migration module for the training brand's import (`pnpm demo:org`), which the
    // API does not mount: its importers are run by the implementation team (D-214).
    imports: [AppModule.register({ auth: auth.auth, tokens }), MigrationModule],
  };

  const app = await NestFactory.create<NestFastifyApplication>(
    root,
    // The API's own adapter, so a failing request is logged with the same redaction.
    createApiAdapter(0, logger),
    { logger: false, abortOnError: false },
  );
  applyGlobalPipeline(app);

  // The worker's runtime, not a client's: it installs pg-boss's schema on a fresh
  // database, lets a request's `enqueue` find a started runtime, and runs the handlers.
  const jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: ownerUrl,
    appRole: decodeURIComponent(new URL(database.DATABASE_URL).username) || 'erp_app',
    queues: ALL_QUEUES,
    logger,
  });

  const server = app.getHttpAdapter().getInstance();
  await server.register(fastifyCookie as never);
  registerAuth(server, {
    auth: auth.auth,
    limiter: new MemoryRateLimiter(),
    rateLimitEnabled: false,
    trustedOrigins: [SEED_ORIGIN],
    secure: false,
  });
  await app.init();
  await server.ready();

  const dispatcher = new OutboxDispatcher();
  await registerWorkerJobs({ context: app, jobs, dispatcher, logger });
  const stopping = new AbortController();
  const dispatching = runDispatchLoop(dispatcher, logger, stopping.signal);

  return {
    app,
    server,
    auth,
    tokens,
    client: () => new PreviewClient(server),
    async settle(timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      let quiet = 0;
      for (;;) {
        const pending = await pendingWork();
        // Twice in a row, half a second apart: a job that just finished may have queued
        // the next one, or emitted an event the dispatcher has not claimed yet.
        quiet = pending.jobs === 0 && pending.events === 0 ? quiet + 1 : 0;
        if (quiet >= 2 || Date.now() > deadline) return pending;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    async close() {
      stopping.abort();
      await dispatching;
      await jobs.stop();
      await app.close();
      await auth.close();
    },
  };
}

/**
 * Jobs that are due and not finished, and events not yet delivered.
 *
 * Read as `erp_owner`, which owns pg-boss's schema. A job deferred into the future — a
 * cron run, a retry's backoff — is not due and is not waited for.
 */
async function pendingWork(): Promise<{ jobs: number; events: number }> {
  const { jobs, orgIds } = await withSystem(async (tx) => {
    const [due] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pgboss.job
      where state in ('created', 'retry', 'active') and start_after <= now()
    `);
    // The org list is global (§5); the outbox is FORCE RLS, so it is counted per org,
    // as the dispatcher claims it (dispatcher.ts explains why an uncontexted read sees
    // nothing).
    const orgs = await tx.execute<{ id: string }>(sql`select id from org.organizations`);
    return { jobs: due?.n ?? 0, orgIds: orgs.map((row) => row.id) };
  });
  let events = 0;
  for (const orgId of orgIds) {
    events += await withSystem(
      async (tx) => {
        const [row] = await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from events.outbox
          where dispatched_at is null and attempts < 5
            and (next_attempt_at is null or next_attempt_at <= now())
        `);
        return row?.n ?? 0;
      },
      { orgId },
    );
  }
  return { jobs, events };
}
