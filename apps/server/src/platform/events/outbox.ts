import {
  parseEventPayload,
  roomsForEvent,
  type EventName,
  type EventPayload,
} from '@elysium/contracts';
import { sql } from 'drizzle-orm';

import type { Tx } from '@elysium/db';

/**
 * Writing to the transactional outbox (architecture §19, invariant 6).
 *
 * `emit(tx, …)` takes the *caller's* transaction. That is the entire point and
 * the reason this is not a service method: the row commits or rolls back with
 * the business change that caused it, so "the journal posted but nothing
 * happened afterwards" and "the SMS went out for a journal that rolled back"
 * are both impossible rather than merely unlikely.
 *
 * The alternative — calling the courier or the SMS gateway from inside the
 * transaction — is what invariant 6 forbids, and the reason is not purity: it
 * holds a database connection open across somebody else's network, so a
 * courier's slow afternoon becomes our outage.
 */

export interface EmitOptions {
  /**
   * The org the event happened in.
   *
   * The event's org, not the actor's. A super admin acting in Oura's data emits
   * an Oura event; reading the actor's context instead would deliver it to
   * whichever org they last switched into.
   */
  readonly orgId: string;
}

/**
 * Record one event for delivery after this transaction commits.
 *
 * The payload is parsed against its `.strict()` schema *here*, before the row
 * exists, so §19's rule — ids plus only the fields every recipient role may see
 * — is enforced at the boundary. A payload that grew a cost field is a thrown
 * error at the emit site, where somebody can read the stack, rather than a
 * value that arrives in a reseller's browser.
 *
 * Rooms are resolved now and stored, not recomputed at dispatch. The audience
 * depends on the payload and on the catalog as it stood when the event
 * happened; a dispatcher recomputing it after a deploy could widen the audience
 * of a row written under narrower rules.
 */
export async function emit<TName extends EventName>(
  tx: Tx,
  name: TName,
  payload: EventPayload<TName>,
  options: EmitOptions,
): Promise<void> {
  const parsed = parseEventPayload(name, payload);
  const rooms = roomsForEvent(name, options.orgId, parsed);

  /*
   * The actor is read from the transaction, not passed in (D-277). `withOrg` sets
   * `app.user_id` for the request that is acting, so every emit site records who acted
   * without being able to forget it or name somebody else. A worker records its own system
   * id (`usr_dispatcher`, `usr_targets_refresh`, …); only a public caller with no login leaves
   * it null. §3 says every event carries it, and M20's pickup time is the
   * first reader that needs it: a confirmation by a supervisor is not the assignee's.
   */
  await tx.execute(sql`
    insert into events.outbox (org_id, name, payload, rooms, actor_user_id)
    values (
      ${options.orgId},
      ${name},
      ${JSON.stringify(parsed)}::jsonb,
      ${JSON.stringify(rooms)}::jsonb,
      nullif(current_setting('app.user_id', true), '')
    )
  `);
}

export interface OutboxRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly payload: unknown;
  readonly rooms: string[];
  readonly attempts: number;
  /** When the emitting transaction wrote the row (§3's `occurred_at`). */
  readonly occurredAt: Date;
  /** Who acted, or null (D-277). */
  readonly actorUserId: string | null;
}

interface OutboxRecord extends Record<string, unknown> {
  id: string;
  org_id: string;
  name: string;
  payload: unknown;
  rooms: string[];
  attempts: number;
  created_at: string | Date;
  actor_user_id: string | null;
}

function toOutboxRow(row: OutboxRecord): OutboxRow {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    payload: row.payload,
    rooms: row.rooms,
    attempts: row.attempts,
    occurredAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    actorUserId: row.actor_user_id,
  };
}

/**
 * Claim a batch of undelivered events for this dispatcher.
 *
 * `for update skip locked` rather than a status column the dispatcher writes
 * first: several workers run (§3 has api and worker as separate processes, and
 * production runs replicas of each), and `skip locked` is how two of them take
 * different rows without coordinating. A `claimed_by` column would need its own
 * transaction, and a worker that died between claiming and delivering would
 * leave rows claimed by a process that no longer exists.
 *
 * Ordered oldest first, because an event's usefulness decays and because a
 * backlog that delivers newest-first starves its own tail.
 */
export async function claimPending(
  tx: Tx,
  limit: number,
  maxAttempts: number,
): Promise<OutboxRow[]> {
  const rows = await tx.execute<OutboxRecord>(sql`
    select id, org_id, name, payload, rooms, attempts, created_at, actor_user_id
    from events.outbox
    where dispatched_at is null
      and attempts < ${maxAttempts}
      and (next_attempt_at is null or next_attempt_at <= now())
    order by created_at
    limit ${limit}
    for update skip locked
  `);

  return [...rows].map(toOutboxRow);
}

/** Mark one event delivered. Marked, never deleted — see the schema comment. */
export async function markDispatched(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`
    update events.outbox set dispatched_at = now() where id = ${id}
  `);
}

/**
 * Record a failed attempt.
 *
 * The attempt count lives on the row rather than in the worker, so it survives
 * the process that failed — which is the point of §20's backoff and
 * dead-letter rules. The error text goes through the caller's redaction before
 * it gets here: a failure message routinely quotes the payload that caused it,
 * and this table is read by anyone with `read AuditLog`.
 */
export async function recordFailure(
  tx: Tx,
  id: string,
  error: string,
  retryInSeconds: number,
): Promise<void> {
  await tx.execute(sql`
    update events.outbox
    set attempts = attempts + 1,
        last_error = ${error.slice(0, 2000)},
        next_attempt_at = now() + make_interval(secs => ${retryInSeconds})
    where id = ${id}
  `);
}

/**
 * How long a row waits after its nth failed attempt (§20: exponential backoff).
 *
 * 5 s, 30 s, 2 min, 10 min: about thirteen minutes in all before the fifth failure
 * dead-letters it, which is long enough to ride out a restart of Postgres or Valkey and
 * short enough that a genuinely broken subscriber is reported the same quarter-hour. The
 * table is here rather than in SQL so the policy is one list a reader can see and a test
 * can pin.
 */
const RETRY_DELAYS_SECONDS = [5, 30, 120, 600] as const;

export function retryDelaySeconds(failedAttempts: number): number {
  const last = RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1] ?? 600;
  return RETRY_DELAYS_SECONDS[Math.max(0, failedAttempts - 1)] ?? last;
}

/** Mark a dead-lettered row as reported, so its `job.failed` is raised once. */
export async function markReported(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`update events.outbox set reported_at = now() where id = ${id}`);
}

/**
 * Events that have spent their attempts, for the dead-letter sweep.
 *
 * Not marked dispatched — they never were. They stay undelivered and visible,
 * which is what makes `job.failed` a report of something a human can still find
 * rather than a notification about a row that has vanished.
 */
export async function findDeadLettered(tx: Tx, maxAttempts: number): Promise<OutboxRow[]> {
  const rows = await tx.execute<OutboxRecord>(sql`
    select id, org_id, name, payload, rooms, attempts, created_at, actor_user_id
    from events.outbox
    where dispatched_at is null and attempts >= ${maxAttempts} and reported_at is null
    order by created_at
  `);

  return [...rows].map(toOutboxRow);
}
