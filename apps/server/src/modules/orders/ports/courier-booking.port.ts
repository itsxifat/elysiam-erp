import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * The two things §9's transitions ask a courier module to do (architecture §9, §20).
 *
 * `enqueue_courier_booking` and `enqueue_courier_cancel` are effects of a transition, so
 * they have to happen inside the transaction that moved the order (invariant 6 makes them
 * *enqueues*, never courier calls). That means this module has to reach M12's
 * `BookingService` — while M12's `BookingService` has to reach this module's `ORDERS_PORT`
 * to know what to put on the parcel. Two modules, each needing the other.
 *
 * ## Why a registry rather than a second module import
 *
 * The promo port's arrangement — a port here, bound to the other module's provider in
 * `orders.module.ts` — cannot solve this one. It works for promo because the arrow only
 * goes one way: orders imports `PromoModule` and nothing in promo injects anything of
 * ours. Here both directions exist, and they are a **provider** cycle, not merely a module
 * one: `TransitionsService` → `BookingService` → `ORDERS_PORT` → `OrdersApiService` →
 * `OrdersService` → `TransitionsService`. No arrangement of `imports` breaks that, and
 * `forwardRef` would not either — it makes Nest tolerate the cycle by handing out a proxy,
 * which is the same cycle with a harder stack trace when it deadlocks.
 *
 * So the codebase's other answer is used, the one `ApprovalsService.registerExecutor`
 * already is: the module that owns the *work* registers it with the module that owns the
 * *decision*, once, at startup. `CourierModule` imports `OrdersModule` — one arrow, the
 * same direction as every other consumer of `ORDERS_API` — and its `BookingService`
 * registers itself here in `onModuleInit`, exactly as `SettlementsService` registers
 * `settlement_posting` with the approvals module. Nothing in this module imports anything
 * from `modules/courier`, and the interface below is the whole of what it may ask for.
 *
 * ## Unregistered is a refusal, not a no-op
 *
 * When nothing has registered — a unit test, or a deployment with no courier module — the
 * effects refuse the transition. Skipping them silently would be worse: the org's policy
 * says book on confirm, the desk sees a confirmed order, and no parcel exists anywhere. A
 * refusal rolls the confirm back and says why.
 */
export interface CourierBookingPort {
  /**
   * Whether a parcel is live with a courier for this order.
   *
   * §9 attaches `enqueue_courier_cancel` to the two cancels, and the domain only produces
   * it when `parcelBooked` is true — because enqueueing a cancellation for a parcel that
   * was never booked would send a courier a consignment number we do not have. The answer
   * comes from the courier module, which owns the consignment row.
   */
  hasLiveParcel(tx: Tx, orgId: string, orderId: string): Promise<boolean>;

  /** Write the consignment row and enqueue the booking, in the caller's transaction. */
  reserveConsignment(
    tx: Tx,
    actor: { orgId: string; userId: string; requestId?: string | null },
    input: { orderId: string; courierId?: string | null },
  ): Promise<unknown>;

  /** Enqueue a cancellation with the courier, in the caller's transaction. */
  cancelConsignment(
    tx: Tx,
    actor: { orgId: string; userId: string; requestId?: string | null },
    orderId: string,
  ): Promise<unknown>;
}

/**
 * Where the courier module hands itself in.
 *
 * A provider of this module, exported by `OrdersModule`, so the courier module can inject
 * it through the import it already has. One registration per process, and a second one is
 * an error rather than a silent replacement — two booking implementations would mean some
 * transitions enqueueing through one and some through the other, which is not a bug
 * anybody would find quickly.
 */
@Injectable()
export class CourierBookingRegistry {
  private port: CourierBookingPort | undefined;

  register(port: CourierBookingPort): void {
    if (this.port !== undefined && this.port !== port) {
      throw new Error('a courier booking port is already registered');
    }
    this.port = port;
  }

  /** The registered port, or undefined when this deployment has no courier module. */
  current(): CourierBookingPort | undefined {
    return this.port;
  }
}
