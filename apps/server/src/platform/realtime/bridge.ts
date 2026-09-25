import { EVENT_NAMES } from '@elysium/contracts';
import type { Logger } from 'pino';

import type { DeliveredEvent, OutboxDispatcher } from '../events/dispatcher.js';
import type { RealtimeGateway } from './gateway.js';

/**
 * From the outbox to the sockets (architecture §19, "emit only after commit,
 * from the outbox dispatcher").
 *
 * This function is the only path from a business change to a browser, and it is
 * deliberately the *last* link rather than a shortcut around the others: the
 * dispatcher only ever sees rows whose transaction committed, so there is no
 * code path by which a rolled-back journal can light up a dashboard.
 *
 * It subscribes per event name rather than with one catch-all, because the
 * dispatcher's `on()` is keyed by name and a catch-all would need a second
 * registration mechanism. The loop over `EVENT_NAMES` means a catalog entry
 * added in a later milestone is bridged the moment it exists — a per-event
 * registration somebody has to remember is a per-event registration somebody
 * will forget, and the symptom would be one event type that silently never
 * reaches a client.
 */
export function bridgeOutboxToRealtime(
  dispatcher: OutboxDispatcher,
  gateway: RealtimeGateway,
  logger: Logger,
): void {
  for (const name of EVENT_NAMES) {
    dispatcher.on(name, (event: DeliveredEvent) => {
      /*
       * Synchronous, and that matters for the redelivery story.
       *
       * The dispatcher awaits its subscribers and marks the row dispatched
       * afterwards, so anything thrown here fails the row: it is retried and
       * eventually dead-lettered (§20). `deliver()` throws on a payload the
       * catalog refuses and on a room addressed to another org, which are
       * exactly the two cases that should stop a row rather than let it through.
       *
       * What it does *not* wait for is a socket acknowledging receipt, because
       * there is nothing to wait for: a broadcast is fire-and-forget by design,
       * and a client that was offline refetches over REST when it returns (§19).
       * Holding the row until every browser confirmed would make one closed
       * laptop a stuck queue.
       */
      gateway.deliver({
        id: event.id,
        orgId: event.orgId,
        name: event.name,
        payload: event.payload,
        rooms: event.rooms,
      });

      logger.debug(
        { event: event.name, orgId: event.orgId, rooms: event.rooms.length },
        'realtime event delivered',
      );
    });
  }
}
