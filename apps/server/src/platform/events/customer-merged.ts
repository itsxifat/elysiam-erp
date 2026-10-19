import { customerMergedPayload } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';

import type { DeliveredEvent } from './dispatcher.js';

/**
 * A subscriber to `customer.merged` (M48, D-885) for a module that stores a buyer: `move` runs in
 * the event's brand, in its own transaction, and moves that module's rows from the merged record
 * to the kept one. Idempotent: a redelivered event finds nothing left to move.
 */
export function onCustomerMerged(
  actor: string,
  move: (tx: Tx, orgId: string, fromId: string, toId: string) => Promise<number>,
): (event: DeliveredEvent) => Promise<void> {
  return async (event) => {
    const { keptId, mergedId } = customerMergedPayload.parse(event.payload);
    await withOrg({ orgId: event.orgId, userId: actor }, (tx) =>
      move(tx, event.orgId, mergedId, keptId),
    );
  };
}
