import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { FlagsModule } from '../../platform/flags/flags.module.js';
import { HrModule } from '../hr/hr.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import {
  ANALYTICS_CONFIG,
  analyticsConfig,
  narrativeProviderFor,
  type AnalyticsConfig,
} from './analytics.config.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { NARRATIVE_PROVIDER } from './providers/narrative.provider.js';
import { RollupService } from './rollup.service.js';

/**
 * Analytics (architecture §18; M24): the rollups and their jobs, the org and consolidated
 * dashboards, the leaderboard, insight rules, the narrative and exports.
 *
 * Reads every source through its owner's `*.api.ts` (invariant 12): orders, marketing, HR,
 * the ledger and inventory. Nothing imports this module; the arrows all point out of it.
 * It is the one module that uses the cross-org read-only role (invariant 4, D-329).
 *
 * The config is a factory run at `app.init()`, so bad leaderboard weights stop the process
 * at boot (D-323).
 */
const configProvider: Provider = {
  provide: ANALYTICS_CONFIG,
  useFactory: () => analyticsConfig(),
};

const narrativeProvider: Provider = {
  provide: NARRATIVE_PROVIDER,
  useFactory: (config: AnalyticsConfig) => narrativeProviderFor(config),
  inject: [ANALYTICS_CONFIG],
};

@Module({
  // `FlagsModule` for `analytics.llm_narrative` (D-327): the first runtime reader of a flag.
  imports: [FlagsModule, OrdersModule, MarketingModule, HrModule, LedgerModule, InventoryModule],
  controllers: [AnalyticsController],
  providers: [configProvider, narrativeProvider, AuditService, RollupService, AnalyticsService],
  exports: [RollupService, NARRATIVE_PROVIDER],
})
export class AnalyticsModule {}
