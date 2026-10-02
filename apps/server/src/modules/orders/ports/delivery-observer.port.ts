import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * Who wants to know that an order was delivered, inside the delivering transaction (M18).
 *
 * §11's Conversions API sends a purchase "when an order is delivered", and invariant 6
 * says the send is a job enqueued in the transaction that delivered it — so the marketing
 * module has to be told *here*, before the commit, not after it. Enqueueing from an outbox
 * subscriber would also work, but the outbox is delivered at least once with no durable
 * dedupe on the subscriber's side, while a job enqueued in the same transaction commits or
 * rolls back with the delivery itself.
 *
 * Shaped like `CourierBookingRegistry`, for the same reason: the marketing module reads
 * order facts through `ORDERS_API`, so this module cannot import it back. It registers
 * itself here in `onModuleInit` (D-262).
 *
 * ## Unregistered is a no-op, unlike the courier port
 *
 * A courier booking is part of fulfilment, so a missing courier module refuses the
 * transition. A conversion report is not: a deployment without the marketing module must
 * still deliver parcels. And an observer that throws rolls the delivery back with it, so
 * an observer does only what must commit with the delivery — writing its own row and
 * enqueueing — and nothing that can fail for reasons outside the database.
 */
export interface DeliveryObserver {
  orderDelivered(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      /** `delivered` or `partially_delivered`. */
      readonly status: 'delivered' | 'partially_delivered';
      readonly at: Date;
    },
  ): Promise<void>;
}

@Injectable()
export class DeliveryObserverRegistry {
  private readonly observers: DeliveryObserver[] = [];

  register(observer: DeliveryObserver): void {
    if (!this.observers.includes(observer)) this.observers.push(observer);
  }

  async notify(tx: Tx, input: Parameters<DeliveryObserver['orderDelivered']>[1]): Promise<void> {
    for (const observer of this.observers) await observer.orderDelivered(tx, input);
  }
}
