import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * Whether an order may be handed to the courier by a person's Ship (M46, D-808).
 *
 * An order packed in several lots goes to the courier only when every lot's label was scanned
 * at the handover. The lots are the packing module's, and packing reads orders through
 * `ORDERS_API`, so it cannot be imported here: it registers a guard instead, which the order's
 * own Ship (one order or many) asks inside the moving transaction, after the order is locked.
 * A courier's status that ships an order is not asked: the parcel is already with the courier.
 *
 * Unregistered is a no-op. A guard refuses by throwing a typed error with a code the orders
 * module's error mapping understands (`ORDER_LOTS_NOT_HANDED`).
 */
export interface HandoverGuard {
  assertShippable(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly orderNo: string },
  ): Promise<void>;
}

@Injectable()
export class HandoverGuardRegistry {
  private readonly guards: HandoverGuard[] = [];

  register(guard: HandoverGuard): void {
    if (!this.guards.includes(guard)) this.guards.push(guard);
  }

  async assertShippable(tx: Tx, input: Parameters<HandoverGuard['assertShippable']>[1]) {
    for (const guard of this.guards) await guard.assertShippable(tx, input);
  }
}
