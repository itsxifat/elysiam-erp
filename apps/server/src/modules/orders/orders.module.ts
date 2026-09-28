import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { CustomersService } from './customers.service.js';
import { DocumentsService } from './documents.service.js';
import { ORDERS_API, OrdersApiService } from './orders.api.js';
import {
  CustomersController,
  DeliveryZonesController,
  OrdersController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { TransitionsService } from './transitions.service.js';
import { FRAUD_API } from '../fraud/fraud.api.js';
import { FraudModule } from '../fraud/fraud.module.js';
import { CourierBookingRegistry } from './ports/courier-booking.port.js';
import { FRAUD_GATE } from './ports/fraud-gate.port.js';

/**
 * Orders, customers, delivery zones and the state machine (architecture §9, §7).
 *
 * Five imports. Four are for one interface each (invariant 12); the fifth,
 * `ApprovalsModule`, is for the `AuditService` it exports — M10 raises no approval type of
 * its own, and every mutation here still writes its audit row inside the transaction that
 * made the change rather than relying on the interceptor's net.
 *
 * * **`CatalogModule`** for `CATALOG_API` — the selling price, the SKU code and the
 *   product name an order line snapshots. That interface has no cost in it and cannot
 *   grow one, which is the boundary invariant 5 is drawn along.
 * * **`InventoryModule`** for `INVENTORY_API` — reserve on confirm, release on cancel,
 *   dispatch on handover, and units coming back. Nothing here writes `inventory.*`, and
 *   nothing here posts the inventory side of a journal: `dispatch()` makes the movements
 *   *and* §7's handover journal in one call, because the value the journal posts is the
 *   average the movement recorded.
 * * **`LedgerModule`** for `LEDGER_API` — the delivery, return, exchange and advance
 *   journals, each built by a posting rule in `packages/domain/src/posting`. Nothing here
 *   writes `ledger.journals` or `ledger.journal_lines`.
 * * **`FilesModule`** for `GotenbergClient` — §22's invoice and packing slip, rendered by
 *   the same headless Chromium and the same vendored Bangla fonts as M04's sample.
 *
 * ## The fraud gate
 *
 * `FRAUD_GATE` is a port this module declares (`ports/fraud-gate.port.ts`) and M13
 * satisfies. It was bound to `AllowAllFraudGate` while M13 did not exist, which is what
 * let M10 be built and tested without a fraud engine; now it is bound to M13's
 * `FRAUD_API`, whose service already matches the port structurally.
 *
 * The import goes orders → fraud rather than the other way. Nest resolves a provider in
 * the module that declares it, so a binding placed in `AppModule` would not replace the
 * one in this file — and binding it the other way round, by having `FraudModule` provide
 * this module's symbol, makes the two modules import each other and needs a `forwardRef`.
 * The port stays because it is what the module is *written* against: nothing here imports
 * a fraud type, and `AllowAllFraudGate` remains the binding every orders test uses.
 *
 * ## The courier booking registry
 *
 * §9's `enqueue_courier_booking` and `enqueue_courier_cancel` are effects of a transition,
 * so they have to happen inside the transaction that moved the order — which means this
 * module has to reach M12's `BookingService`, while that service has to reach `ORDERS_API`
 * for the parcel's address. Both directions at once, and at the *provider* level, so no
 * arrangement of imports resolves it.
 *
 * `CourierBookingRegistry` is this module's answer, and it is the answer
 * `ApprovalsService.registerExecutor` already gave: the module that owns the work registers
 * it, once, at startup. `CourierModule` imports this one — one arrow, the same direction as
 * every other consumer of `ORDERS_API` — and its `BookingService` registers itself in
 * `onModuleInit`. Nothing here imports anything from `modules/courier`, and with nothing
 * registered the two effects refuse the transition rather than silently skipping it. See
 * `ports/courier-booking.port.ts`.
 *
 * `ORDERS_API` is exported for M12 (courier webhooks moving orders), M13 (writing a trust
 * score), M21 (reseller orders) and M23 (POS). `TransitionsService` is not exported: a
 * module that could perform a transition without going through `ORDERS_API` would be a
 * module deciding for itself when §9's effects happen.
 */
@Module({
  imports: [
    CatalogModule,
    InventoryModule,
    LedgerModule,
    FilesModule,
    ApprovalsModule,
    FraudModule,
  ],
  controllers: [OrdersController, CustomersController, DeliveryZonesController],
  providers: [
    CustomersService,
    CourierBookingRegistry,
    TransitionsService,
    OrdersService,
    DocumentsService,
    { provide: FRAUD_GATE, useExisting: FRAUD_API },
    { provide: ORDERS_API, useClass: OrdersApiService },
  ],
  exports: [ORDERS_API, CustomersService, CourierBookingRegistry],
})
export class OrdersModule {}
