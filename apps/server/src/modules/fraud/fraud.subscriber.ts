import { withOrg } from '@elysium/db';
import type { Logger } from 'pino';

import type { DeliveredEvent, OutboxDispatcher } from '../../platform/events/dispatcher.js';
import type { OrderOutcome } from './fraud.repository.js';
import type { FraudService } from './fraud.service.js';

/**
 * Maintaining the cross-org counters from order events (M13; architecture §10, §19).
 *
 * This is the "maintained from order events" half of `fraud.phone_signals`. It runs in
 * the **worker**, as an in-process outbox subscriber, for the same reason the realtime
 * bridge does: the dispatcher only ever sees rows whose transaction committed, so there
 * is no path from a business change to a counter that can disagree with the order it
 * came from.
 *
 * ## Which statuses count, and why not the others
 *
 * `order.status_changed` fires for every transition §9 allows. Four of them matter:
 *
 * * **confirmed** — `orders_total`. Not `pending`: an order nobody confirmed says
 *   nothing about whether the buyer pays for parcels, and counting pending ones would let
 *   anybody lower a stranger's score by filling in a landing-page form ten times.
 * * **delivered** — `delivered`. `partially_delivered` counts here too: the buyer took
 *   the parcel and paid, which is the behaviour being measured, even if a line came back.
 * * **returned** — `returned`, and it moves `last_incident_at`. `return_in_transit` does
 *   **not**: the parcel is on its way back and counting it there would double-count when
 *   it arrives, since every return passes through both.
 * * **cancelled** — `cancelled`, and `last_incident_at`. §9 lets an order be cancelled
 *   for our own reasons as well as the buyer's, which is why a cancellation weighs the
 *   same as a return in the recency penalty but is counted separately: a later milestone
 *   that wants to distinguish "we cancelled" from "they refused" has the column to do it
 *   with (follow-up).
 *
 * Everything else — packed, handed over, on hold, exchange — is our own logistics and
 * says nothing about the buyer.
 *
 * ## At least once
 *
 * The dispatcher is at-least-once by design, so this handler can run twice for one event.
 * `applyOutcome` is a plain increment, so the idempotency has to come from somewhere, and
 * it comes from the event id: a delivered row redelivered would otherwise add a second
 * delivery to a buyer's record across all five brands.
 *
 * The dedupe is kept in this process, deliberately, and the trade is stated rather than
 * hidden: a worker restart between delivering and marking can double-count one event.
 * The correct fix is a `reported_at`-style column on `events.outbox`, which the worker's
 * dead-letter sweep already wants for exactly the same reason and which belongs to the
 * migration that owns that table (follow-up). Given the choice, over-counting one
 * delivery for one buyer after a crash is the cheaper error than the alternative designs:
 * a unique table here would be a fourth tenant table for bookkeeping, and skipping the
 * dedupe entirely would double-count on every ordinary redelivery rather than only after
 * a restart.
 */

/** §9's statuses, mapped to what each does to the counters. `null` means "ignore". */
export function outcomeForStatus(status: string): OrderOutcome | null {
  switch (status) {
    case 'confirmed':
      return 'confirmed';
    case 'delivered':
    case 'partially_delivered':
      return 'delivered';
    case 'returned':
      return 'returned';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

interface StatusChangedPayload {
  readonly id?: unknown;
  readonly to?: unknown;
  readonly at?: unknown;
}

/**
 * Register the subscriber on a dispatcher.
 *
 * Exported as a function taking the dispatcher, exactly like `bridgeOutboxToRealtime`,
 * so the worker composes it and a test can drive it without booting Nest.
 */
export function subscribeFraudToOrderEvents(
  dispatcher: OutboxDispatcher,
  fraud: FraudService,
  logger: Logger,
): void {
  const applied = new Set<string>();

  dispatcher.on('order.status_changed', async (event: DeliveredEvent) => {
    if (applied.has(event.id)) return;

    const payload = (event.payload ?? {}) as StatusChangedPayload;
    const orderId = typeof payload.id === 'string' ? payload.id : null;
    const to = typeof payload.to === 'string' ? payload.to : null;
    if (orderId === null || to === null) return;

    const outcome = outcomeForStatus(to);
    if (outcome === null) {
      applied.add(event.id);
      return;
    }

    /*
     * The event's own instant, not `now()`. The recency penalty should describe when the
     * parcel came back, not when the worker got round to it — and after a backlog those
     * are hours apart, which would make a fortnight-old return look like this morning's.
     */
    const at = typeof payload.at === 'string' ? new Date(payload.at) : new Date();
    const stamped = Number.isNaN(at.getTime()) ? new Date() : at;

    /*
     * `withOrg` for the event's own org (§19: an event belongs to the tenant it happened
     * in). The counters it updates are cross-org and have no policy, but the
     * `order_phones` row it reads first is tenant-scoped — so this transaction must be in
     * the right org or the lookup finds nothing and the counter silently never moves.
     *
     * Not the analytics role, for two reasons: invariant 4 reserves it for the analytics
     * module, and it cannot write.
     */
    const counted = await withOrg({ orgId: event.orgId }, async (tx) =>
      fraud.applyOutcome(tx, { orgId: event.orgId, orderId, outcome, at: stamped }),
    );

    applied.add(event.id);

    if (!counted) {
      // No `order_phones` row: this order never went through the confirm guard, so there
      // is no number to attribute the outcome to. Logged at debug because it is normal
      // for orders created while the fraud flag was off, and an id is not personal data.
      logger.debug({ orderId, to }, 'fraud signals: no assessed phone for this order');
    }
  });
}
