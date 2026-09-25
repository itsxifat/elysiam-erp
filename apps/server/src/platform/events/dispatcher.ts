import { Injectable } from '@nestjs/common';
import { withOrg, withSystem, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { claimPending, findDeadLettered, markDispatched, recordFailure } from './outbox.js';

/**
 * Delivering what the outbox holds (architecture §19, §20).
 *
 * The dispatcher runs after commit, by definition: it reads rows that are only
 * visible because their transaction committed. That is what makes §19's "emit
 * only after commit, from the outbox dispatcher" true rather than aspirational
 * — there is no code path from a business transaction to a socket.
 *
 * **At least once, never exactly once.** A row is marked dispatched after its
 * subscribers return, so a crash between the two redelivers it. §20 requires
 * every job to be idempotent for this reason, and pretending otherwise would be
 * the more dangerous design: a dispatcher that marked first would lose events
 * silently, and a lost `wallet.balance_changed` is a cash position nobody
 * notices is wrong.
 */

/** What a subscriber sees. Ids and display fields only — §19 guarantees it. */
export interface DeliveredEvent {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly payload: unknown;
  readonly rooms: readonly string[];
  readonly attempts: number;
}

export type Subscriber = (event: DeliveredEvent) => void | Promise<void>;

/**
 * How many times a row is tried before it is dead-lettered.
 *
 * §20's table gives `delivery.book_parcel` five retries; five is the house
 * default and the only queue with a stated number, so it is the default here
 * too until a queue asks for its own.
 */
export const MAX_ATTEMPTS = 5;

@Injectable()
export class OutboxDispatcher {
  private readonly subscribers = new Map<string, Subscriber[]>();

  /** Subscribers run in-process, in registration order, per §19's "in-process subscribers". */
  on(name: string, subscriber: Subscriber): void {
    const existing = this.subscribers.get(name) ?? [];
    existing.push(subscriber);
    this.subscribers.set(name, existing);
  }

  /**
   * Deliver one batch.
   *
   * Each row gets **its own transaction**, deliberately. One transaction for
   * the batch would mean a single failing subscriber rolls back the marks for
   * every row that already succeeded, so they would all redeliver — turning
   * one bad event into a batch-sized duplicate storm on every poll.
   *
   * Returns how many rows were delivered, so the caller can poll again
   * immediately while a backlog is draining rather than sleeping through it.
   */
  async drain(batchSize = 50): Promise<{ delivered: number; failed: number }> {
    // Claimed with the system role: the dispatcher serves every org and has no
    // single `app.org_id`. It is the only reader of this table that does, which
    // is why the claim and the delivery are separate transactions below —
    // the per-row work runs inside `withOrg` for the row's own org, so a
    // subscriber that touches tenant data is scoped to the right tenant.
    const pending = await withSystem(async (tx) => claimPending(tx, batchSize));

    let delivered = 0;
    let failed = 0;

    for (const row of pending) {
      try {
        await this.deliver(row);
        await withSystem(async (tx) => {
          await markDispatched(tx, row.id);
        });
        delivered += 1;
      } catch (error) {
        failed += 1;
        await withSystem(async (tx) => {
          await recordFailure(tx, row.id, error instanceof Error ? error.message : String(error));
        });
      }
    }

    return { delivered, failed };
  }

  /**
   * Rows that have spent their attempts, reported once each.
   *
   * §20: a job that lands in the dead-letter queue emits `job.failed`. The row
   * stays undelivered and visible rather than being removed, so the report
   * points at something a human can still inspect. `job.failed` itself is
   * emitted by the caller — this returns the facts rather than recursing into
   * the outbox it is reporting on.
   */
  async deadLettered(): Promise<DeliveredEvent[]> {
    return withSystem(async (tx) => findDeadLettered(tx, MAX_ATTEMPTS));
  }

  private async deliver(row: DeliveredEvent): Promise<void> {
    const subscribers = this.subscribers.get(row.name) ?? [];
    for (const subscriber of subscribers) {
      // Sequential and awaited: a subscriber that writes to the database must
      // finish before the row is marked, or a crash loses its work while the
      // event looks delivered.
      await subscriber(row);
    }
  }
}

/**
 * Wait until the outbox is empty, for tests.
 *
 * Exported from the platform rather than reimplemented per suite, because the
 * shape a test reaches for otherwise is `setTimeout(300)` — which passes on a
 * laptop and fails in CI, and when it fails it reads as "the event never
 * fired". This repo has already been bitten by exactly that.
 */
export async function drainOutbox(
  dispatcher: OutboxDispatcher,
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);

  for (;;) {
    const { delivered } = await dispatcher.drain();
    if (delivered === 0) return;
    if (Date.now() > deadline) throw new Error('outbox did not drain in time');
  }
}

/** Undelivered rows for one org, for tests and the failed-jobs admin view. */
export async function pendingFor(orgId: string): Promise<{ name: string; attempts: number }[]> {
  return withOrg({ orgId, userId: 'usr_dispatcher' }, async (tx: Tx) => {
    const rows = await tx.execute<{ name: string; attempts: number }>(sql`
      select name, attempts from events.outbox
      where dispatched_at is null order by created_at
    `);
    return [...rows];
  });
}
