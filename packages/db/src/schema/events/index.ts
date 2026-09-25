import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organizations } from '../org/index.js';
import { primaryId } from '../columns.js';

/**
 * The transactional outbox (architecture §19, §27, invariant 6).
 *
 * Invariant 6 says no external call — courier, SMS, Meta, Chatwoot — runs
 * inside a database transaction, and that instead a job is enqueued in the same
 * transaction. This table is the half of that which cannot be skipped: a row
 * written here commits or rolls back with the business change that caused it,
 * so "the journal posted but the SMS did not" and "the SMS went but the journal
 * rolled back" are both impossible by construction rather than by care.
 *
 * Without it the alternative is calling out from inside the transaction, which
 * holds a database connection open across someone else's network and turns a
 * courier's bad afternoon into our outage.
 *
 * **Marked, never deleted.** A dispatched row keeps `dispatched_at` and stays.
 * Deleting on dispatch would make "did this event ever fire" unanswerable, and
 * that question is asked exactly when something has gone wrong — a customer
 * who got no SMS, a dashboard that never refreshed. §20's retry and
 * dead-letter story needs the attempt count to survive too.
 */
export const events = pgSchema('events');

export const outbox = events.table(
  'outbox',
  {
    id: primaryId,

    /**
     * The tenant the event happened in.
     *
     * Not the actor's org: an event is addressed to the org whose data changed,
     * and the room names are computed from this. A dispatcher that read the
     * actor's context instead would deliver a super admin's action into their
     * own org rather than the one they acted on.
     */
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /** An `EventName` from `packages/contracts/src/events.ts`. */
    name: text('name').notNull(),

    /**
     * The payload, already validated against its schema and already stripped.
     *
     * §19 allows ids plus the display fields every recipient role may see, and
     * nothing else. The emit helper parses against a `.strict()` schema before
     * the row is written, so what lands here is publishable as it stands —
     * which matters because the dispatcher has no request context to serialize
     * against later.
     */
    payload: jsonb('payload').notNull(),

    /**
     * The rooms this event goes to, resolved at emit time.
     *
     * Stored rather than recomputed, because the answer depends on the payload
     * and on the catalog as it was when the event happened. A dispatcher
     * recomputing it after a deploy could widen the audience of a row that was
     * written under narrower rules.
     */
    rooms: jsonb('rooms').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /** Null until delivered. The dispatcher's claim marker. */
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' }),

    /**
     * How many times delivery has been tried.
     *
     * §20 wants exponential backoff and a dead-letter queue; both need this to
     * outlive the process that failed. A row that has spent its attempts is
     * what raises `job.failed`.
     */
    attempts: integer('attempts').notNull().default(0),

    /** Why the last attempt failed. Redacted like any other stored text. */
    lastError: text('last_error'),
  },
  (table) => [
    index('outbox_org_idx').on(table.orgId),
    /*
     * The dispatcher's index, and the shape of its query.
     *
     * It claims the oldest undispatched rows with `for update skip locked`, so
     * the only scan that matters is "undelivered, oldest first". A partial
     * index keeps it the size of the backlog rather than the size of history —
     * this table only grows, and by M12 it grows per parcel scan.
     */
    index('outbox_pending_idx')
      .on(table.createdAt)
      .where(sql`dispatched_at is null`),
  ],
);
