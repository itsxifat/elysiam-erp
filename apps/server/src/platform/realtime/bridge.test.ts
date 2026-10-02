import { EVENT_NAMES } from '@elysium/contracts';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { OutboxDispatcher, type DeliveredEvent, type Subscriber } from '../events/dispatcher.js';
import { bridgeOutboxToRealtime } from './bridge.js';
import type { DeliverableEvent, RealtimeGateway } from './gateway.js';

/**
 * The bridge, without a socket in sight.
 *
 * Two properties are worth a unit test, and neither needs a gateway: that every
 * catalog event is bridged, and that a delivery failure reaches the dispatcher
 * rather than being swallowed. Both are absences — a missing registration and a
 * caught exception — and absences are what a full end-to-end test is worst at
 * noticing, because the symptom is silence.
 */

const logger = pino({ level: 'silent' });

class Recording extends OutboxDispatcher {
  readonly registered = new Map<string, Subscriber[]>();

  override on(name: string, subscriber: Subscriber): void {
    super.on(name, subscriber);
    const existing = this.registered.get(name) ?? [];
    existing.push(subscriber);
    this.registered.set(name, existing);
  }
}

function stubGateway(deliver: (event: DeliverableEvent) => void): RealtimeGateway {
  return {
    namespace: undefined as never,
    deliver,
    connectionCount: () => Promise.resolve(0),
    revalidateNow: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

const row: DeliveredEvent = {
  id: 'ev-1',
  orgId: 'org-1',
  name: 'ledger.posted',
  payload: { journalId: 'j-1' },
  rooms: ['org:org-1:role:accounts'],
  attempts: 0,
  occurredAt: new Date('2026-10-02T06:00:00Z'),
  actorUserId: null,
};

describe('bridgeOutboxToRealtime', () => {
  it('bridges every event in the catalog', () => {
    const dispatcher = new Recording();
    bridgeOutboxToRealtime(
      dispatcher,
      stubGateway(() => undefined),
      logger,
    );

    // A per-event registration somebody has to remember is one somebody will
    // forget, and the symptom would be a single event type that silently never
    // reaches a browser.
    expect([...dispatcher.registered.keys()].sort()).toEqual([...EVENT_NAMES].sort());
  });

  it('hands the row over unchanged, rooms included', async () => {
    const dispatcher = new Recording();
    const seen: DeliverableEvent[] = [];
    bridgeOutboxToRealtime(
      dispatcher,
      stubGateway((event) => seen.push(event)),
      logger,
    );

    const subscriber = dispatcher.registered.get('ledger.posted')?.[0];
    await subscriber?.(row);

    // The rooms are the ones the outbox stored, not ones recomputed now: the
    // audience depends on the catalog as it stood when the event happened, and a
    // deploy that widened an audience must not widen a row already written.
    expect(seen).toEqual([
      {
        id: 'ev-1',
        orgId: 'org-1',
        name: 'ledger.posted',
        payload: { journalId: 'j-1' },
        rooms: ['org:org-1:role:accounts'],
      },
    ]);
  });

  it('lets a delivery failure through so the dispatcher can retry and dead-letter it', () => {
    const dispatcher = new Recording();
    bridgeOutboxToRealtime(
      dispatcher,
      stubGateway(() => {
        throw new Error('refused: payload carries a cost field');
      }),
      logger,
    );

    const subscriber = dispatcher.registered.get('ledger.posted')?.[0];

    /*
     * Thrown synchronously, and `expect(...).rejects` would therefore never see
     * it — the assertion itself would throw. That is not a test artefact: the
     * dispatcher's `await subscriber(row)` catches a synchronous throw exactly
     * the same way, which is what makes the row fail, retry and eventually
     * dead-letter (§20). Swallowed instead, the row would be marked dispatched
     * and the refusal would be visible nowhere — the worst outcome, because the
     * two things `deliver` throws for are a payload the catalog refuses and a
     * room belonging to another org.
     */
    expect(() => subscriber?.(row)).toThrow(/cost field/);
  });
});
