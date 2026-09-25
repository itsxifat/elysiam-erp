import { withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { IDEMPOTENCY_WINDOW_HOURS } from './idempotency.js';

/**
 * Every statement the idempotency store runs (§23; tenancy rules: raw SQL lives
 * in a repository, parameterised, never interpolated).
 *
 * All of it runs inside `withOrg()`, so RLS confines it to the active org; the
 * explicit `org_id` in each WHERE is for the unique index and for the reader,
 * not as the control.
 *
 * The claim and the completion are **separate transactions** on purpose. The
 * reservation must be visible to a concurrent request *before* the handler runs,
 * or the mutual exclusion the unique index provides is exclusion against
 * nothing: two simultaneous taps would both insert, both commit at the end, and
 * one would lose on the index having already done the work twice.
 */

export interface IdempotencyScope {
  readonly orgId: string;
  readonly userId: string;
  readonly route: string;
  readonly key: string;
}

export interface IdempotencyRecord {
  readonly requestFingerprint: string;
  readonly statusCode: number | null;
  readonly responseBody: unknown;
  readonly completedAt: Date | null;
}

interface RecordRow extends Record<string, unknown> {
  readonly request_fingerprint: string;
  readonly status_code: number | null;
  readonly response_body: unknown;
  readonly completed_at: Date | null;
}

export type ClaimResult =
  /** This request owns the key and must run. */
  | { readonly kind: 'claimed' }
  /** Somebody got there first; here is what they left. */
  | { readonly kind: 'existing'; readonly record: IdempotencyRecord };

/**
 * Take the key, or report who already has it.
 *
 * One transaction doing three things, and all three have to be in it:
 *
 * 1. Delete an expired record for this scope. §23's window is 24 hours, and
 *    after that the key is free again — but the unique index does not expire, so
 *    without this a client that reuses a daily key would be permanently locked
 *    out by its own record from yesterday. Doing it in a separate statement
 *    outside the transaction would race the insert.
 * 2. Insert the reservation, `on conflict do nothing`. This is the lock.
 * 3. If nothing was inserted, read the row that won.
 *
 * `on conflict do nothing` rather than a `select ... for update` first: the
 * select-then-insert version has a window between the two where a concurrent
 * insert commits, and the second request then fails on the index with a raw
 * 23505 instead of a 409 the caller can act on.
 */
export async function claim(
  scope: IdempotencyScope,
  requestFingerprint: string,
  windowHours: number = IDEMPOTENCY_WINDOW_HOURS,
): Promise<ClaimResult> {
  return withOrg({ orgId: scope.orgId, userId: scope.userId }, async (tx) => {
    await tx.execute(sql`
      delete from http.idempotency_keys
      where org_id = ${scope.orgId}::uuid
        and user_id = ${scope.userId}
        and route = ${scope.route}
        and idempotency_key = ${scope.key}
        and expires_at <= now()
    `);

    const inserted = await tx.execute<{ id: string }>(sql`
      insert into http.idempotency_keys
        (org_id, user_id, route, idempotency_key, request_fingerprint, expires_at)
      values (
        ${scope.orgId}::uuid, ${scope.userId}, ${scope.route}, ${scope.key},
        ${requestFingerprint},
        now() + ${`${String(windowHours)} hours`}::interval
      )
      on conflict (org_id, user_id, route, idempotency_key) do nothing
      returning id
    `);
    if (inserted.length > 0) return { kind: 'claimed' };

    const rows = await tx.execute<RecordRow>(sql`
      select request_fingerprint, status_code, response_body, completed_at
      from http.idempotency_keys
      where org_id = ${scope.orgId}::uuid
        and user_id = ${scope.userId}
        and route = ${scope.route}
        and idempotency_key = ${scope.key}
    `);

    const row = rows[0];
    if (row === undefined) {
      /*
       * The insert conflicted and the row is gone: the holder released it
       * between the two statements, which happens when its handler failed. The
       * honest answer is "treat this as a fresh attempt" — the caller retrying
       * is exactly what should happen next — so report it as claimed rather
       * than inventing a conflict against a record that no longer exists.
       */
      return { kind: 'claimed' };
    }

    return {
      kind: 'existing',
      record: {
        requestFingerprint: row.request_fingerprint,
        statusCode: row.status_code,
        responseBody: row.response_body,
        completedAt: row.completed_at,
      },
    };
  });
}

/** Store the answer, so the next identical request replays it. */
export async function complete(
  scope: IdempotencyScope,
  statusCode: number,
  responseBody: unknown,
): Promise<void> {
  await withOrg({ orgId: scope.orgId, userId: scope.userId }, async (tx) => {
    await tx.execute(sql`
      update http.idempotency_keys
      set status_code = ${statusCode},
          response_body = ${JSON.stringify(responseBody ?? null)}::jsonb,
          completed_at = now()
      where org_id = ${scope.orgId}::uuid
        and user_id = ${scope.userId}
        and route = ${scope.route}
        and idempotency_key = ${scope.key}
        and completed_at is null
    `);
  });
}

/**
 * Give the key back after a failed attempt.
 *
 * Without this a handler that threw would leave a reservation that never
 * completes, and the client's legitimate retry — with the same key, because that
 * is what the key is *for* — would be refused with `IDEMPOTENCY_IN_FLIGHT` for
 * the next 24 hours. The transient failure would become a day-long one.
 *
 * Only the still-open reservation is deleted, so this can never remove a stored
 * answer: a completed record is the thing the whole mechanism exists to keep.
 */
export async function release(scope: IdempotencyScope): Promise<void> {
  await withOrg({ orgId: scope.orgId, userId: scope.userId }, async (tx) => {
    await tx.execute(sql`
      delete from http.idempotency_keys
      where org_id = ${scope.orgId}::uuid
        and user_id = ${scope.userId}
        and route = ${scope.route}
        and idempotency_key = ${scope.key}
        and completed_at is null
    `);
  });
}

/**
 * Drop this org's expired records. Returns how many went.
 *
 * The lazy delete in `claim` only ever reaches a key that is used again, so
 * without a sweep the table keeps a row per mutation forever — and this is the
 * hottest write path in the system by M12. Per-org rather than global because
 * the delete runs under RLS like every other tenant statement; the job that
 * calls it iterates the orgs.
 */
export async function sweepExpired(orgId: string, userId: string): Promise<number> {
  return withOrg({ orgId, userId }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      delete from http.idempotency_keys
      where org_id = ${orgId}::uuid and expires_at <= now()
      returning id
    `);
    return rows.length;
  });
}
