import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * Whether a buyer has ordered before, for first-order-only discounts (M35a, D-543).
 *
 * The orders are the orders module's, and this module may not read them (invariant 12). The
 * orders module already imports this one, so it cannot be imported back; instead it hands
 * itself in here when it starts, as the courier module does with `CourierBookingRegistry`.
 *
 * **The buyer is the ERP's buyer** (`sales.customers`, by phone). A website account (M34)
 * resolves to its buyer before it asks, so one person with an account and a phone order is
 * one history, and a per-customer limit counts both.
 */
export interface BuyerHistoryPort {
  /**
   * Orders of this buyer that were not cancelled, other than `excludingOrderId` (the order
   * being redeemed for, which exists by then).
   */
  priorOrders(
    tx: Tx,
    orgId: string,
    customerId: string,
    excludingOrderId?: string | null,
  ): Promise<number>;
}

@Injectable()
export class BuyerHistoryRegistry {
  private port: BuyerHistoryPort | undefined;

  register(port: BuyerHistoryPort): void {
    if (this.port !== undefined && this.port !== port) {
      throw new Error('a buyer history port is already registered');
    }
    this.port = port;
  }

  /**
   * True for a buyer with no earlier order that stands, and for no buyer at all (a shopper
   * not yet known by phone has no history), as the old site counted it.
   *
   * With nothing registered the answer is false: a first-order discount is refused rather
   * than given to anybody who asks, which is the safe way round for money.
   */
  async isFirstOrder(
    tx: Tx,
    orgId: string,
    customerId: string | null,
    excludingOrderId: string | null = null,
  ): Promise<boolean> {
    if (customerId === null) return true;
    if (this.port === undefined) return false;
    return (await this.port.priorOrders(tx, orgId, customerId, excludingOrderId)) === 0;
  }
}
