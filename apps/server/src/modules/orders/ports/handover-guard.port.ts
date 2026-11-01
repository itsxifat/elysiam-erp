import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import type { AuditableRequest } from '../../../platform/audit/audit.interceptor.js';

/**
 * Whether an order may be packed, or handed to the courier by a person's Ship (M46, D-808, D-928).
 *
 * An order is packed only once every lot's label was printed with its consignment (D-928), and an
 * order packed in several lots goes to the courier only when every lot's label was scanned at the
 * handover (D-808). The labels and lots are the packing module's, and packing reads orders through
 * `ORDERS_API`, so it cannot be imported here: it registers a guard instead, which the order's own
 * Pack and Ship (one order or many, the desk's or the station's) ask inside the moving
 * transaction, after the order is locked. A courier's status that ships an order is not asked:
 * the parcel is already with the courier.
 *
 * Unregistered is a no-op. A guard refuses by throwing a typed error with a code the orders
 * module's error mapping understands (`ORDER_LOTS_NOT_HANDED`, `ORDER_LABEL_NOT_PRINTED`).
 */
export interface HandoverGuard {
  assertPackable(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly orderNo: string },
  ): Promise<void>;
  assertShippable(
    tx: Tx,
    input: { readonly orgId: string; readonly orderId: string; readonly orderNo: string },
  ): Promise<void>;
  /**
   * M52 (D-941): a person is confirming this order. Above the brand's limit it refuses with
   * `ORDER_LOTS_REQUIRED` until `lots` says how many; an answer is saved in this transaction, so
   * it commits or rolls back with the confirm.
   */
  settleLots(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly orderId: string;
      readonly orderNo: string;
      readonly userId: string;
      readonly lots: number | undefined;
      readonly request: AuditableRequest;
    },
  ): Promise<void>;
}

@Injectable()
export class HandoverGuardRegistry {
  private readonly guards: HandoverGuard[] = [];

  register(guard: HandoverGuard): void {
    if (!this.guards.includes(guard)) this.guards.push(guard);
  }

  async assertPackable(tx: Tx, input: Parameters<HandoverGuard['assertPackable']>[1]) {
    for (const guard of this.guards) await guard.assertPackable(tx, input);
  }

  async assertShippable(tx: Tx, input: Parameters<HandoverGuard['assertShippable']>[1]) {
    for (const guard of this.guards) await guard.assertShippable(tx, input);
  }

  async settleLots(tx: Tx, input: Parameters<HandoverGuard['settleLots']>[1]) {
    for (const guard of this.guards) await guard.settleLots(tx, input);
  }
}
