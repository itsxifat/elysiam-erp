import { Module } from '@nestjs/common';

import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { IamDirectoryModule } from '../iam/iam.api.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { AdvancesController } from './advances.controller.js';
import { AdvancesService } from './advances.service.js';
import { BuyersService } from './buyers.service.js';
import { CustomersService } from './customers.service.js';
import { DeskService } from './desk.service.js';
import { DocumentsService } from './documents.service.js';
import { ORDERS_API, OrdersApiService } from './orders.api.js';
import {
  BuyersController,
  CustomersController,
  DeliveryZonesController,
  OrdersController,
  ReengagementController,
} from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { ReturnReasonsService } from './returns.service.js';
import { TransitionsService } from './transitions.service.js';
import { PROMO_API } from '../promo/promo.api.js';
import { BuyerHistoryBinding } from './buyer-history.binding.js';
import { OrdersReferencesBinding } from './references.binding.js';
import { PromoModule } from '../promo/promo.module.js';
import { NOTIFY_API } from '../notify/notify.api.js';
import { NotifyModule } from '../notify/notify.module.js';
import { CrmService } from './crm.service.js';
import { BuyerProfileService } from './profile.service.js';
import { ReengagementService } from './reengagement.service.js';
import { NOTIFY_PORT } from './ports/notify.port.js';
import { BrandLogoRegistry } from './ports/brand-logo.port.js';
import { CourierBookingRegistry } from './ports/courier-booking.port.js';
import { DeliveryObserverRegistry } from './ports/delivery-observer.port.js';
import { PROMO_PORT } from './ports/promo.port.js';

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
    PromoModule,
    NotifyModule,
    // Who on an order is an owner (M31, D-473), through identity's interface.
    IamDirectoryModule,
  ],
  controllers: [
    OrdersController,
    CustomersController,
    DeliveryZonesController,
    BuyersController,
    ReengagementController,
    // M17: advance claims, the accounts queue, and returns by reason.
    AdvancesController,
  ],
  providers: [
    CustomersService,
    CourierBookingRegistry,
    // M43 (D-754): the website's logo for the order documents, registered by the storefront.
    BrandLogoRegistry,
    // M18: the marketing module registers here to hear of deliveries (D-262).
    DeliveryObserverRegistry,
    // M17: advances end inside the order's own transitions (D-232, D-233).
    AdvancesService,
    ReturnReasonsService,
    TransitionsService,
    OrdersService,
    DocumentsService,
    // M11: the desk's reads and bulk confirm, and the buyer list. Neither is exported —
    // they are screens, and another module that wanted them would want `ORDERS_API`.
    DeskService,
    BuyersService,
    // M16: the desk prices and redeems a code through its own port (D-204).
    { provide: PROMO_PORT, useExisting: PROMO_API },
    // M35a: first-order discounts ask the promo module, which asks this one (D-543).
    BuyerHistoryBinding,
    // M39a: what orders hold about a SKU, a location or a discount (D-621).
    OrdersReferencesBinding,
    // M16: the CRM's greetings queue a message through their own port, in their own
    // transaction, beside the code they announce.
    { provide: NOTIFY_PORT, useExisting: NOTIFY_API },
    CrmService,
    // M16: the buyer profile and the re-engagement list — screens, like the buyer list.
    BuyerProfileService,
    ReengagementService,
    { provide: ORDERS_API, useClass: OrdersApiService },
  ],
  exports: [
    ORDERS_API,
    CustomersService,
    CourierBookingRegistry,
    DeliveryObserverRegistry,
    // M43 (D-754): the storefront registers the website's logo for the order documents.
    BrandLogoRegistry,
    CrmService,
  ],
})
export class OrdersModule {}
