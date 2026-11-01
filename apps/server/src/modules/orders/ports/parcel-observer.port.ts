import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * Who wants to know that an order's parcel got its consignment, inside the courier's booking
 * transaction (M46, D-817).
 *
 * The owner's words: "whenever a new order … gets its courier consignment or parcel number it
 * will be ready for label printing". The packing module keeps the order as ready for its label,
 * with its consignment, in the same transaction that saves the consignment, so the row commits or
 * rolls back with the booking and is never a call from inside it (invariant 6).
 *
 * D-917: nothing prints by itself any more. The owner's words: "whenever a new label print request
 * comes after order confirmation it will stay in the queue and when an agent releases the queue
 * they will print all in bulk". An observer only keeps the order in "Ready for label".
 *
 * Shaped like `DeliveryObserverRegistry` (D-262) and for the same reason: the courier module
 * books and the packing module prints, both read orders through `ORDERS_API`, and neither may
 * import the other. Packing registers here in `onModuleInit`; the courier notifies.
 *
 * Unregistered is a no-op: a deployment without packing still books parcels. An observer that
 * throws rolls the booking's save back with it, so it only writes its own rows.
 *
 * D-914: an order is ready for its label once it is **confirmed**, not only once a consignment
 * comes back. An own rider's order, one booked by hand and one whose booking failed never get a
 * consignment from a booking job, so the confirm and a booking's final failure are told here too,
 * each in the transaction that records it. The orders module tells `orderConfirmed`; the courier
 * module tells `parcelBooked` and `bookingFailed`.
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

  /**
   * The order was confirmed, in the confirm's transaction (D-914). `awaitingConsignment` is true
   * only when a consignment will come back through `parcelBooked`: this confirm queued the
   * courier booking (the brand books on Confirm), or the brand books by hand and the order's
   * courier can be booked here (a person's Book now brings it). An own rider's order: false.
   * Since D-917 no observer reads it (it decided whether the label printed at once); it stays
   * until the orders module stops working it out.
   */
  orderConfirmed?(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly orderNo: string;
      readonly locationId: string | null;
      readonly awaitingConsignment: boolean;
      readonly at: Date;
    },
  ): Promise<void>;

  /**
   * Every attempt to book the order's parcel failed for good (D-914), in the transaction that
   * flags the consignment failed: no consignment is coming.
   */
  bookingFailed?(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly at: Date },
  ): Promise<void>;

  /**
   * The order was received back (M51, D-938), by whichever route, in that transaction: its open
   * return inspection ends with it.
   */
  orderReturned?(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly userId: string;
      readonly at: Date;
    },
  ): Promise<void>;
}

type ConfirmedInput = Parameters<NonNullable<ParcelObserver['orderConfirmed']>>[1];
type FailedInput = Parameters<NonNullable<ParcelObserver['bookingFailed']>>[1];
type ReturnedInput = Parameters<NonNullable<ParcelObserver['orderReturned']>>[1];

@Injectable()
export class ParcelObserverRegistry {
  private readonly observers: ParcelObserver[] = [];

  register(observer: ParcelObserver): void {
    if (!this.observers.includes(observer)) this.observers.push(observer);
  }

  async notify(tx: Tx, input: Parameters<ParcelObserver['parcelBooked']>[1]): Promise<void> {
    for (const observer of this.observers) await observer.parcelBooked(tx, input);
  }

  /** D-914: the order was confirmed. */
  async notifyConfirmed(tx: Tx, input: ConfirmedInput): Promise<void> {
    for (const observer of this.observers) await observer.orderConfirmed?.(tx, input);
  }

  /** D-914: the order's booking failed for good. */
  async notifyBookingFailed(tx: Tx, input: FailedInput): Promise<void> {
    for (const observer of this.observers) await observer.bookingFailed?.(tx, input);
  }

  /** M51 (D-938): the order was received back. */
  async notifyReturned(tx: Tx, input: ReturnedInput): Promise<void> {
    for (const observer of this.observers) await observer.orderReturned?.(tx, input);
  }

  /** Whether anyone listens: a confirm with no listener opens no savepoint. */
  get empty(): boolean {
    return this.observers.length === 0;
  }
}
