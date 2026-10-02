import { fromDrizzle } from 'pg-boss';
import { sql } from 'drizzle-orm';

import type { Tx } from '@elysium/db';

import { assertSerialisablePayload, type JobEnvelope } from './envelope.js';
import { activeJobsRuntime, type JobsRuntime } from './jobs.runtime.js';

/**
 * Enqueueing a job through the caller's transaction (architecture §20, invariant 6).
 *
 * `enqueue(tx, …)` takes the *caller's* transaction, exactly as the outbox's
 * `emit(tx, …)` does, and for the same reason: the job row commits or rolls back
 * with the business change that caused it. Acceptance check 1 is the whole point
 * — "a job enqueued inside a transaction that rolls back never runs; after a
 * commit it runs exactly once" — and it is a property of PostgreSQL here rather
 * than a property of our care.
 *
 * Invariant 6 forbids the alternative, which is calling the courier from inside
 * the transaction. That rule is only followable if enqueueing is transactional,
 * which is what this is.
 *
 * ## pg-boss really does support this
 *
 * pg-boss v12 accepts an `IDatabase` per call through `SendOptions.db`, and
 * ships `fromDrizzle(tx, sql)` to wrap a Drizzle transaction as one. The insert
 * therefore runs on the caller's connection, inside the caller's transaction,
 * through pg-boss's own statement — so there is no hand-written INSERT here to
 * drift out of step with pg-boss's schema when it migrates. No outbox table of
 * our own is needed for jobs (the `events.outbox` table is for realtime events,
 * which is a different problem: those fan out to sockets, these are work).
 *
 * The one thing that does *not* run inside the transaction is the queue lookup:
 * `send` resolves the queue's partition table from the runtime's cache, and on a
 * cache miss reads it on pg-boss's own pool. That read is of a queue definition,
 * not of the caller's data, so it neither sees nor writes anything the
 * transaction could roll back. It does mean a queue must exist before anything
 * enqueues to it, which `registerQueues` guarantees on worker boot.
 *
 * ## At least once, never exactly once
 *
 * "Runs exactly once" in check 1 is about the enqueue, not about delivery. A
 * worker that crashes between finishing its work and marking the job complete
 * will run it again — pg-boss is at-least-once, like every queue that survives a
 * power cut — which is why §20 requires every job to be idempotent. Pretending
 * otherwise here would be the more dangerous design.
 */

export interface EnqueueOptions {
  /**
   * The tenant this job's work belongs to.
   *
   * Required on a tenant-scoped queue, and refused on a global one. `pgboss.job`
   * has no `org_id` and no RLS, so this is what stands in for invariant 4: the
   * handler wrapper opens `withOrg` for it, and the failed-jobs endpoint filters
   * on it. Getting it from the caller rather than from ambient context is
   * deliberate — a super admin acting in Oura's data enqueues an Oura job, and
   * reading the actor's context would attribute it to whichever org they last
   * switched into.
   */
  readonly orgId?: string | null;
  /** The row this job is about, for `job.failed` and the failed-jobs view. An id, never a payload. */
  readonly ref?: string | null;
  /** The request that caused the enqueue, so a failure three retries later is still traceable (§26). */
  readonly requestId?: string | null;
  /** Earliest the job may run. A number is seconds from now. */
  readonly startAfter?: number | string | Date;
  /**
   * A key that collapses duplicates — **only on a queue whose `policy` is
   * `exclusive`** (`QueueDefinition.policy`). There, while a job with this key is
   * queued, retrying or running, another with the same key is dropped and `enqueue`
   * returns `null`.
   *
   * On a `standard` queue, which is every queue that sets no policy, pg-boss stores
   * the key and enforces nothing: both jobs are written. That was true of every use
   * in this codebase until D-207 found it, so a caller that needs "at most once" must
   * either use an `exclusive` queue or be idempotent in its handler, as the courier
   * and fraud handlers are.
   */
  readonly singletonKey?: string;
  /** Higher runs first. Default 0. */
  readonly priority?: number;
}

/**
 * Write one job into the caller's transaction.
 *
 * Returns the job id, or `null` when a `singletonKey` on an `exclusive` queue meant
 * this job was collapsed into one already queued. `null` is a success, not a
 * failure: the work is going to happen, just not twice.
 */
export async function enqueue(
  tx: Tx,
  queue: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const runtime = activeJobsRuntime();
  if (runtime === undefined) {
    throw new Error(
      `enqueue(${queue}) ran with no jobs runtime started in this process; call JobsRuntime.start() during boot`,
    );
  }

  return enqueueWith(runtime, tx, queue, payload, options);
}

/**
 * The same thing against an explicit runtime.
 *
 * Exists for tests, which run several runtimes against several throwaway
 * databases in one process and must not depend on which one happened to start
 * last.
 */
export async function enqueueWith(
  runtime: JobsRuntime,
  tx: Tx,
  queue: string,
  payload: unknown,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const definition = runtime.definitionFor(queue);
  if (definition === undefined) {
    throw new Error(
      `enqueue(${queue}) names a queue this process did not register; add it to the module's queue definitions (§20)`,
    );
  }

  const orgId = options.orgId ?? null;
  if (definition.scope === 'org' && orgId === null) {
    throw new Error(
      `enqueue(${queue}) needs an orgId: the queue is tenant-scoped, and its handler has no other way to know which tenant to open withOrg for`,
    );
  }
  if (definition.scope === 'global' && orgId !== null) {
    throw new Error(
      `enqueue(${queue}) passed an orgId to a global queue; a global job's work is the whole installation's, and an org id here would be read as a tenant scope it does not have`,
    );
  }

  assertSerialisablePayload(queue, payload);

  const envelope: JobEnvelope = {
    orgId,
    ref: options.ref ?? null,
    requestId: options.requestId ?? null,
    payload,
  };

  return runtime.boss.send(queue, envelope as unknown as object, {
    // The caller's transaction. Everything above is validation; this line is the
    // acceptance check.
    db: fromDrizzle(tx, sql),
    ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
    ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  });
}
