import { Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import { serverEnv } from '../../platform/config/env.js';
import { MemoryRateLimiter, type RateLimitStore } from '../../platform/http/rate-limit.js';
import { ValkeyRateLimiter } from '../../platform/http/rate-limit.valkey.js';
import { createLogger } from '../../platform/logging/logger.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { SiteCache } from './site-cache.js';
import { STOREFRONT_API, StorefrontApiService } from './storefront.api.js';
import { STOREFRONT_CONFIG, storefrontConfig, type StorefrontConfig } from './storefront.config.js';
import { StorefrontController } from './storefront.controller.js';
import { StorefrontPublicController } from './storefront-public.controller.js';
import { StorefrontPublicService } from './storefront-public.service.js';
import { StorefrontService } from './storefront.service.js';
import { STOREFRONT_RATE_LIMITER, StorefrontSignatureGuard } from './signature.guard.js';

/**
 * The rate limiter's own Valkey connection (the intake's arrangement, M11): `lazyConnect`,
 * falling back to per-process counters while Valkey is away (D-056), closed with the app.
 */
@Injectable()
class StorefrontValkey implements OnModuleDestroy {
  private client: Redis | undefined;

  constructor(private readonly config: StorefrontConfig) {}

  limiter(): RateLimitStore {
    if (this.config.STOREFRONT_RATE_LIMIT_STORE === 'memory') return new MemoryRateLimiter();
    const env = serverEnv();
    const client = new Redis(env.VALKEY_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    const logger = createLogger('storefront');
    client.on('error', (error: Error) => {
      logger.warn({ err: error }, 'storefront rate limiter valkey connection error');
    });
    this.client = client;
    void client.connect().catch(() => undefined);
    return new ValkeyRateLimiter({
      client,
      keyPrefix: `rl:${env.REALTIME_ADAPTER_KEY}`,
      onError: (error) => {
        logger.error({ err: error }, 'storefront rate limiter fell back to in-memory counters');
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    await client.quit().catch(() => undefined);
    client.disconnect();
  }
}

/**
 * The brand's website, run from its ERP (M33, architecture §31).
 *
 * Owns the `storefront` schema. Reaches the catalog, inventory, the order desk's delivery
 * zones and the files through their exported interfaces (invariant 12), and exports
 * `STOREFRONT_API` for M34 to M36.
 */
@Module({
  imports: [CatalogModule, InventoryModule, OrdersModule, FilesModule],
  controllers: [StorefrontController, StorefrontPublicController],
  providers: [
    { provide: STOREFRONT_CONFIG, useFactory: () => storefrontConfig() },
    {
      provide: StorefrontValkey,
      useFactory: (config: StorefrontConfig) => new StorefrontValkey(config),
      inject: [STOREFRONT_CONFIG],
    },
    {
      provide: STOREFRONT_RATE_LIMITER,
      useFactory: (valkey: StorefrontValkey) => valkey.limiter(),
      inject: [StorefrontValkey],
    },
    SiteCache,
    StorefrontService,
    StorefrontPublicService,
    StorefrontSignatureGuard,
    { provide: STOREFRONT_API, useClass: StorefrontApiService },
  ],
  exports: [STOREFRONT_API],
})
export class StorefrontModule {}
