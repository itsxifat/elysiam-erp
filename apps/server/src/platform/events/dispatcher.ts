import { Injectable } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import {
  claimPending,
  findDeadLettered,
  markDispatched,
  markReported,
  recordFailure,
  retryDelaySeconds,
} from './outbox.js';

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

/** Who the audit trail sees when the dispatcher touches a row. Not a person. */
const DISPATCHER_USER = 'usr_dispatcher';

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
    /*
     * Claimed org by org, inside each org's own context.
     *
     * This used to claim with `withSystem()` — the owner role and no `app.org_id` — on
     * the reasoning that the dispatcher serves every org. But `events.outbox` is FORCE
     * RLS, which binds the owner too, and with no org set the policy compares against
     * NULL and matches nothing. `drain()` returned `{delivered: 0}` on every poll: no
     * realtime event reached a browser and no outbox subscriber ever ran, in any
     * environment, while the suites passed because they drained by other means. The
     * same mistake killed the courier poll cron. The org list is global by design (§5);
     * everything after it is tenant-scoped.
     */
    const orgs = await this.orgIds();

    let delivered = 0;
    let failed = 0;

    for (const orgId of orgs) {
      while (delivered + failed < batchSize) {
        const outcome = await this.deliverNext(orgId);
        if (outcome === 'empty') break;
        if (outcome === 'delivered') delivered += 1;
        else failed += 1;
      }
    }

    return { delivered, failed };
  }

  /**
   * Claim, deliver and mark one row, in one transaction.
   *
   * The row lock is held from the claim to the mark. Claiming in one transaction and
   * marking in another released `for update skip locked` at the first commit, before
   * delivery — so a second worker polling in between claimed the same row and
   * delivered it again. One transaction per row also keeps the original property: a
   * failing subscriber costs its own row a retry and nothing else.
   *
   * A failure is recorded in the same transaction rather than rethrown, because a
   * throw would roll the attempt count back with everything else and the row would
   * retry for ever without reaching the dead-letter threshold.
   */
  private async deliverNext(orgId: string): Promise<'delivered' | 'failed' | 'empty'> {
    return withOrg({ orgId, userId: DISPATCHER_USER }, async (tx) => {
      const [row] = await claimPending(tx, 1, MAX_ATTEMPTS);
      if (row === undefined) return 'empty';
      try {
        await this.deliver(row);
        await markDispatched(tx, row.id);
        return 'delivered';
      } catch (error) {
        await recordFailure(
          tx,
          row.id,
          error instanceof Error ? error.message : String(error),
          // Not due again until the delay has passed, so the loop above moves on to the
          // next row instead of spending this one's remaining attempts in the same pass.
          retryDelaySeconds(row.attempts + 1),
        );
        return 'failed';
      }
    });
  }

  /**
   * Report each row that has spent its attempts, once.
   *
   * §20: a job that lands in the dead-letter queue emits `job.failed`. The row stays
   * undelivered and visible rather than being removed, so the report points at something
   * a human can still inspect. `report` is passed in rather than emitted here, so this
   * class does not recurse into the outbox it is reporting on.
   *
   * Marked after the report, in its own transaction: a crash between the two repeats the
   * report once on restart, which is noise, where marking first would lose it, which is a
   * failure nobody hears about.
   */
  async reportDeadLetters(report: (event: DeliveredEvent) => Promise<void>): Promise<number> {
    let reported = 0;
    for (const orgId of await this.orgIds()) {
      const dead = await withOrg({ orgId, userId: DISPATCHER_USER }, async (tx) =>
        findDeadLettered(tx, MAX_ATTEMPTS),
      );
      for (const row of dead) {
        await report(row);
        await withOrg({ orgId, userId: DISPATCHER_USER }, async (tx) => {
          await markReported(tx, row.id);
        });
        reported += 1;
      }
    }
    return reported;
  }

  /** Every org, read as a global table (§5): the dispatcher serves all of them. */
  private async orgIds(): Promise<string[]> {
    return withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`select id from org.organizations`);
      return [...rows].map((row) => row.id);
    });
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
  return withOrg({ orgId, userId: DISPATCHER_USER }, async (tx: Tx) => {
    const rows = await tx.execute<{ name: string; attempts: number }>(sql`
      select name, attempts from events.outbox
      where dispatched_at is null order by created_at
    `);
    return [...rows];
  });
}
