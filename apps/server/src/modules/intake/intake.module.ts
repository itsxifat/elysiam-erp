import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { serverEnv } from '../../platform/config/env.js';
import { MemoryRateLimiter, type RateLimitStore } from '../../platform/http/rate-limit.js';
import { ValkeyRateLimiter } from '../../platform/http/rate-limit.valkey.js';
import { createLogger } from '../../platform/logging/logger.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { INTAKE_CONFIG, intakeConfig, type IntakeConfig } from './intake.config.js';
import { PublicIntakeController, SiteKeysController } from './intake.controller.js';
import { INTAKE_RATE_LIMITER, IntakeService, TURNSTILE_VERIFIER } from './intake.service.js';
import { IntakeRawBody } from './raw-body.js';
import {
  BypassTurnstile,
  CloudflareTurnstile,
  UnconfiguredTurnstile,
  type TurnstileVerifier,
} from './turnstile.js';

/**
 * The rate limiter's own Valkey connection, closed with the application.
 *
 * Its own rather than the auth limiter's, because that one is built in `main.api.ts` and
 * is not reachable from a module — and the realtime adapter's two are in subscriber mode,
 * where `EVAL` is refused. `lazyConnect` so a process booted with no Valkey at all (the
 * route-coverage gate does exactly that) does not start by failing to connect; the first
 * public order connects it, and until then — or whenever Valkey is down — the limiter
 * degrades to per-process counters, which is D-056's stated fallback rather than no limit.
 */
@Injectable()
class IntakeValkey implements OnModuleDestroy {
  private client: Redis | undefined;

  constructor(private readonly config: IntakeConfig) {}

  limiter(): RateLimitStore {
    if (this.config.INTAKE_RATE_LIMIT_STORE === 'memory') return new MemoryRateLimiter();
    const env = serverEnv();
    const client = new Redis(env.VALKEY_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    const logger = createLogger('intake');
    client.on('error', (error: Error) => {
      logger.warn({ err: error }, 'intake rate limiter valkey connection error');
    });
    this.client = client;
    // Connect in the background; a failed command meanwhile falls back to memory.
    void client.connect().catch(() => undefined);
    return new ValkeyRateLimiter({
      client,
      keyPrefix: `rl:${env.REALTIME_ADAPTER_KEY}`,
      onError: (error) => {
        logger.error({ err: error }, 'intake rate limiter fell back to in-memory counters');
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    // An open socket keeps the event loop alive: without this a test run or a SIGTERM
    // waits on a connection nobody is using.
    const client = this.client;
    if (client === undefined) return;
    await client.quit().catch(() => undefined);
    // `quit` only closes a connected client. One still connecting when the app closes
    // refuses it, and ioredis goes on retrying for ever: `pnpm check:routes` printed
    // PASS and then never exited (2026-10-01). `disconnect` stops the retries too.
    client.disconnect();
  }
}

function turnstileFor(config: IntakeConfig): TurnstileVerifier {
  if (config.INTAKE_TURNSTILE_BYPASS) return new BypassTurnstile();
  if (config.TURNSTILE_SECRET_KEY === undefined) return new UnconfiguredTurnstile();
  return new CloudflareTurnstile({
    secret: config.TURNSTILE_SECRET_KEY,
    url: config.INTAKE_TURNSTILE_VERIFY_URL,
    timeoutMs: config.INTAKE_TURNSTILE_TIMEOUT_MS,
  });
}

/**
 * The public order intake (architecture §23; M11).
 *
 * Three imports, each for one interface: `ORDERS_API` to create the order in the intake's
 * transaction (invariant 12), `CATALOG_API` to turn a SKU code on a landing page into a
 * SKU, and `ApprovalsModule` for the `AuditService` it exports. Nothing here reads or
 * writes `sales.*` or `catalog.*`.
 *
 * `INTAKE_CONFIG` is parsed when the module is built, which is what makes an unsafe
 * production setting — a Turnstile bypass above all — refuse to start the process rather
 * than serve orders without a bot check. See `intake.config.ts`.
 */
@Module({
  imports: [OrdersModule, CatalogModule, ApprovalsModule],
  controllers: [PublicIntakeController, SiteKeysController],
  providers: [
    { provide: INTAKE_CONFIG, useFactory: () => intakeConfig() },
    {
      provide: IntakeValkey,
      useFactory: (config: IntakeConfig) => new IntakeValkey(config),
      inject: [INTAKE_CONFIG],
    },
    {
      provide: INTAKE_RATE_LIMITER,
      useFactory: (valkey: IntakeValkey) => valkey.limiter(),
      inject: [IntakeValkey],
    },
    {
      provide: TURNSTILE_VERIFIER,
      useFactory: (config: IntakeConfig) => turnstileFor(config),
      inject: [INTAKE_CONFIG],
    },
    IntakeRawBody,
    IntakeService,
  ],
})
export class IntakeModule {}
