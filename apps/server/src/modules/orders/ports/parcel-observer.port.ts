import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * Who wants to know that an order's parcel got its consignment, inside the courier's booking
 * transaction (M46, D-817).
 *
 * The owner's words: "whenever a new order … gets its courier consignment or parcel number it
 * will be ready for label printing". The packing module keeps the order as ready for its label
 * and enqueues the automatic print in the same transaction that saves the consignment, so the
 * print commits or rolls back with the booking and is never a call from inside it (invariant 6).
 *
 * Shaped like `DeliveryObserverRegistry` (D-262) and for the same reason: the courier module
 * books and the packing module prints, both read orders through `ORDERS_API`, and neither may
 * import the other. Packing registers here in `onModuleInit`; the courier notifies.
 *
 * Unregistered is a no-op: a deployment without packing still books parcels. An observer that
 * throws rolls the booking's save back with it, so it only writes its own rows and enqueues.
 */
export interface ParcelObserver {
  parcelBooked(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly consignmentNo: string;
      readonly at: Date;
    },
  ): Promise<void>;
}

@Injectable()
export class ParcelObserverRegistry {
  private readonly observers: ParcelObserver[] = [];

  register(observer: ParcelObserver): void {
    if (!this.observers.includes(observer)) this.observers.push(observer);
  }

  async notify(tx: Tx, input: Parameters<ParcelObserver['parcelBooked']>[1]): Promise<void> {
    for (const observer of this.observers) await observer.parcelBooked(tx, input);
  }
}
