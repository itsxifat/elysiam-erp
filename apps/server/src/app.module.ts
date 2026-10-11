import { Module, type DynamicModule } from '@nestjs/common';
import type { Auth } from '@elysium/db';

import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { ApprovalsModule } from './modules/approvals/approvals.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { CourierModule } from './modules/courier/courier.module.js';
import { DemoModule } from './modules/demo/demo.module.js';
import { FilesModule } from './modules/files/files.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { HrModule } from './modules/hr/hr.module.js';
import { InboxModule } from './modules/inbox/inbox.module.js';
import { IntakeModule } from './modules/intake/intake.module.js';
import { IamModule } from './modules/iam/iam.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { InvestorsModule } from './modules/investors/investors.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { LoansModule } from './modules/loans/loans.module.js';
import { MarketingModule } from './modules/marketing/marketing.module.js';
import { MarketplaceModule } from './modules/marketplace/marketplace.module.js';
import { PackingModule } from './modules/packing/packing.module.js';
import { OrdersModule } from './modules/orders/orders.module.js';
import { PosModule } from './modules/pos/pos.module.js';
import { NotifyModule } from './modules/notify/notify.module.js';
import { PromoModule } from './modules/promo/promo.module.js';
import { StorefrontModule } from './modules/storefront/storefront.module.js';
import { SupplyModule } from './modules/supply/supply.module.js';
import { WalletsModule } from './modules/wallets/wallets.module.js';
import { JobsModule } from './platform/jobs/jobs.module.js';
import type { PasswordTokenStore } from './modules/iam/iam.service.js';
import type { ReadinessProbes } from './modules/health/readiness.js';

/**
 * The API's root module. Every domain module from architecture §3 registers
 * here as it lands, and modules reach each other only through the exported
 * `*.api.ts` service interfaces.
 */
@Module({})
export class AppModule {
  static register(dependencies: {
    readonly auth: Auth;
    readonly tokens: PasswordTokenStore;
    /**
     * Mount the demo resource. Defaults to off in production, on elsewhere.
     *
     * `demo.costed_items` exists so the matrix suite has something real to run
     * against — the same RLS, the same guard, the same serializer as
     * everything that comes after, rather than a mock that proves the mock.
     * That makes it worth having and does not make it worth deploying: it is a
     * writable endpoint carrying `unit_cost_poisha`, with no business behind
     * it, and M06 replaces it with the real catalog.
     *
     * A flag rather than a `NODE_ENV` check inside the module, because the
     * route-coverage gate and the boot test both need to see these routes, and
     * a module that decides for itself is one the gate cannot ask.
     */
    readonly demo?: boolean;
    /**
     * Readiness probes beyond the database and the job queue (§26). The running API adds
     * Valkey's; a suite that boots without Valkey adds none.
     */
    readonly readiness?: ReadinessProbes;
  }): DynamicModule {
    const withDemo = dependencies.demo ?? process.env.NODE_ENV !== 'production';

    return {
      module: AppModule,
      imports: [
        HealthModule.register(dependencies.readiness),
        IamModule.register(dependencies),
        ApprovalsModule,
        // A platform module rather than a domain one, and mounted here because
        // its one route is the only part of §20 that is served over HTTP.
        JobsModule,
        FilesModule,
        LedgerModule,
        CatalogModule,
        InventoryModule,
        WalletsModule,
        // M09. Missing until 2026-09-28: every supply route existed only in its own test
        // suite, which mounts the module through `extraModules`, so the running API had no
        // suppliers, purchases, returns or supplier payments at all. The route manifest
        // agreed with the live routes because both left supply out.
        SupplyModule,
        InvestorsModule,
        HrModule,
        OrdersModule,
        /*
         * After `OrdersModule`, and that is not cosmetic: M12 imports it for `ORDERS_API`
         * and binds its own `ORDERS_PORT`, `WALLETS_PORT` and `LEDGER_READ_PORT` inside
         * `courier.module.ts` — a binding here would not reach the services that inject
         * them, because Nest resolves a provider in the module that declares the injection.
         */
        CourierModule,
        IntakeModule,
        PosModule,
        PromoModule,
        NotifyModule,
        // M18. After orders and promo, whose APIs it reads; it joins the orders module's
        // delivery observers at init (D-262).
        MarketingModule,
        // M24. Last: it reads orders, marketing, HR, the ledger and inventory through their
        // APIs, and nothing reads it.
        AnalyticsModule,
        // M26. Company loans; after notify, whose API its reminders queue through.
        LoansModule,
        // M33. The brand's website: after the catalog, inventory, orders and files, whose
        // APIs it reads; it exports STOREFRONT_API for M34 to M36.
        StorefrontModule,
        // M35b: the ncom.bd marketplace connector.
        MarketplaceModule,
        // M35b: the packing scanner and the order labels.
        PackingModule,
        // M42: the unified inbox; after orders and the catalog, whose APIs it reads.
        InboxModule,
        ...(withDemo ? [DemoModule] : []),
      ],
    };
  }
}
