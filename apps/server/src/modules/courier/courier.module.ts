import { Module } from '@nestjs/common';

import { MemoryRateLimiter, type RateLimitStore } from '../../platform/http/rate-limit.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { FilesModule } from '../files/files.module.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WALLETS_API, type WalletsApi } from '../wallets/wallets.api.js';
import { WalletsModule } from '../wallets/wallets.module.js';
import { CourierAccountsService } from './accounts.service.js';
import {
  COURIER_ADAPTERS,
  CourierAdapterRegistry,
  type CourierAdapter,
} from './adapters/courier-adapter.js';
import { FakeCourierAdapter } from './adapters/fake.adapter.js';
import { PathaoCourierAdapter } from './adapters/pathao.adapter.js';
import { RedxCourierAdapter } from './adapters/redx.adapter.js';
import { SteadfastCourierAdapter } from './adapters/steadfast.adapter.js';
import { BookingService } from './booking.service.js';
import { CourierController } from './courier.controller.js';
import { CourierLabelsService } from './labels.service.js';
import { CourierReportsService } from './reports.service.js';
import { ReturnsService } from './returns.service.js';
import { CourierSelectionService } from './selection.service.js';
import { SettlementsService } from './settlements.service.js';
import { StuckParcelsService } from './stuck.service.js';
import { LEDGER_READ_PORT, type LedgerReadPort } from './ports/ledger-read.port.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';
import { WALLETS_PORT, type WalletsPort } from './ports/wallets.port.js';
import { CourierSyncService } from './sync.service.js';
import { TrackingController } from './tracking.controller.js';
import {
  TRACKING_RATE_LIMITER,
  trackingRateLimitStore,
  TrackingService,
} from './tracking.service.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { CourierReferencesBinding } from './references.binding.js';

/**
 * Couriers, parcels, returns and settlements (architecture §9, §20, §21; M12).
 *
 * Imports `LedgerModule` for `LEDGER_API` — every journal this module causes is posted
 * through `ledger.post()` with a posting rule from `packages/domain/src/posting`
 * (invariants 2 and 12), and nothing here writes `ledger.journals` or `ledger.journal_lines`
 * — and `ApprovalsModule` for the one executor it registers, `settlement_posting`, which is
 * the only path to a posted settlement (§9: "→ approval → posting").
 *
 * ## The three ports, bound here and not in `AppModule`
 *
 * `ORDERS_PORT`, `WALLETS_PORT` and `LEDGER_READ_PORT` are declared in `./ports` — this
 * module's own statement of what it needs from three other modules (invariant 12) — and
 * they are bound **in this file**, because Nest resolves a provider in the module that
 * declares the injection: a binding placed in `AppModule` would not reach `BookingService`
 * at all. Each one is bound to the exported service interface of the module that owns the
 * data, which is the same arrangement `orders.module.ts` uses for its promo port.
 *
 * The bindings are `useFactory` with a typed parameter rather than `useExisting`, and that
 * is the only reason they are three lines each: `useExisting` is unchecked, so the day
 * `OrdersApi` and `OrdersPort` disagree about a method's shape the failure would be a
 * `TypeError` inside a booking job. Written this way, it is a compile error here — which is
 * what makes two declarations of one contract safe.
 *
 * ## Booking goes the other way, through a registry
 *
 * §9's transitions have to call `BookingService` inside the transaction that moves the
 * order, so the dependency exists in both directions and cannot be two module imports: it
 * is a provider cycle. `BookingService.onModuleInit` registers itself with the orders
 * module's `CourierBookingRegistry` instead, exactly as `SettlementsService` registers its
 * executor with the approvals module. One module arrow, courier → orders, and no
 * `forwardRef`.
 *
 * ## Why the adapters are a registry and not providers
 *
 * One instance per *provider*, not per account, built once at boot and handed credentials
 * per call. An adapter constructed per account would hold a decrypted key in a field for the
 * life of the process (§25), and a provider map lets an unknown provider code be an error
 * with the known codes in the message rather than an undefined whose first symptom is a
 * booking job throwing on a property read.
 */
@Module({
  // `FilesModule` for `GotenbergClient`, which renders the courier labels (M15).
  // M39a: the catalog's and inventory's references registries (D-621, D-629); both are
  // below this module, so neither import closes a cycle.
  imports: [
    LedgerModule,
    ApprovalsModule,
    OrdersModule,
    // D-903: the not-received alert reaches the branch managers whose branches cover the parcel.
    IamDirectoryModule,
    WalletsModule,
    FilesModule,
    CatalogModule,
    InventoryModule,
  ],
  controllers: [CourierController, TrackingController],
  providers: [
    // M39a: what a received return holds about a SKU or a location (D-621, D-629).
    CourierReferencesBinding,
    {
      provide: COURIER_ADAPTERS,
      useFactory: (): CourierAdapterRegistry => {
        const adapters: CourierAdapter[] = [
          // §21: "every adapter has a fake implementation for tests and local development."
          new FakeCourierAdapter(),
          // D-006's primary courier, UNVERIFIED (D-176). `AccountsService` refuses to
          // activate an account on it unless COURIER_STEADFAST_ENABLED says so, which is
          // why it is safe to register unconditionally: registering it is not enabling it.
          new SteadfastCourierAdapter(),
          // D-006's other two, M15, both UNVERIFIED and both off until their switch is set —
          // and since M15 the switch is read at every use, not only at activation.
          new PathaoCourierAdapter(),
          new RedxCourierAdapter(),
        ];
        return new CourierAdapterRegistry(adapters);
      },
    },
    /*
     * The public tracking route's rate-limit counters (M15).
     *
     * The API's shared Valkey store when `main.api.ts` has handed it over with
     * `useTrackingRateLimitStore` (an INTEGRATION line), which makes the limit global across
     * replicas; otherwise in memory, per process — the same trade D-056 made for the
     * credential endpoints before Valkey arrived. A real limit either way.
     */
    {
      provide: TRACKING_RATE_LIMITER,
      useFactory: (): RateLimitStore => trackingRateLimitStore(() => new MemoryRateLimiter()),
    },
    {
      provide: ORDERS_PORT,
      useFactory: (orders: OrdersApi): OrdersPort => orders,
      inject: [ORDERS_API],
    },
    {
      provide: WALLETS_PORT,
      useFactory: (wallets: WalletsApi): WalletsPort => wallets,
      inject: [WALLETS_API],
    },
    {
      provide: LEDGER_READ_PORT,
      useFactory: (ledger: LedgerApi): LedgerReadPort => ledger,
      inject: [LEDGER_API],
    },
    CourierAccountsService,
    BookingService,
    CourierSyncService,
    ReturnsService,
    SettlementsService,
    CourierReportsService,
    CourierSelectionService,
    StuckParcelsService,
    CourierLabelsService,
    TrackingService,
  ],
  exports: [
    BookingService,
    CourierSyncService,
    SettlementsService,
    // D-903: the worker's not-received sweep.
    StuckParcelsService,
    COURIER_ADAPTERS,
    TRACKING_RATE_LIMITER,
  ],
})
export class CourierModule {}
