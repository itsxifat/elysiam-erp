import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { organizations } from '../org/index.js';
import { primaryId } from '../columns.js';

/**
 * Idempotency records for mutating requests (architecture §23).
 *
 * §23 says mutations accept an `Idempotency-Key` header and the answer is kept
 * for 24 hours per user and route. The failure this prevents is the one the
 * order desk hits daily: a POST is sent over a phone connection, the reply is
 * lost, the operator taps again, and the customer is charged twice or two
 * journals post for one cash entry. Replaying the stored answer makes the
 * second tap a no-op that still looks like success to the client.
 *
 * ## Why Postgres and not Valkey
 *
 * Valkey would be faster and the eviction would be free. It would also be able
 * to disagree with the database: Valkey is not in the transaction that posted
 * the journal, so an eviction, a failover or a flush turns a replay into a
 * second execution, and a cached 201 that survives a rolled-back transaction
 * turns a failure into a reported success. A replayed response that disagrees
 * with the database is worse than a slow one, so the record lives in the same
 * database as the work it describes (D-095).
 *
 * ## Why a row is written *before* the handler runs
 *
 * Two identical requests can be in flight at once — that is exactly what a
 * double tap on a slow connection produces. The unique index below is the
 * mutual exclusion: the first request inserts a reserved row, the second
 * collides and is refused with `IDEMPOTENCY_CONFLICT` rather than being allowed
 * to run the mutation a second time. A store that only wrote *after* the
 * handler finished would let both run and would cache whichever finished last.
 */
export const http = pgSchema('http');

export const idempotencyKeys = http.table(
  'idempotency_keys',
  {
    id: primaryId,

    /**
     * The org the mutation acts in.
     *
     * NOT NULL, so this is an ordinary tenant table under RLS like every other
     * (invariant 4) — and so one org's stored answers can never be replayed
     * into another's request. The consequence is that a mutation made before an
     * org is chosen (`POST /v1/me/active-org`) is not cached; it is idempotent
     * by its own nature, since it sets a value rather than appending one.
     */
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /**
     * Whose request this was.
     *
     * Part of the key because §23 scopes the record per user: two operators
     * legitimately send the same client-generated key, and one must not receive
     * the other's response — which would leak across a branch scope as well as
     * being wrong. Text, not uuid, because `iam.users.id` is Better Auth's text
     * id. No foreign key: `iam.users` is global (§5 exception 4) so a composite
     * org-carrying FK is impossible, and the sweeper removes these rows within
     * a day anyway.
     */
    userId: text('user_id').notNull(),

    /**
     * `POST /v1/ledger/cash-in` — the method and the route *template*, never
     * the concrete url.
     *
     * Per route, as §23 requires, so a key reused against a different endpoint
     * is a fresh request rather than a replay of an unrelated answer.
     */
    route: text('route').notNull(),

    /** The client's `Idempotency-Key` header, verbatim. */
    idempotencyKey: text('idempotency_key').notNull(),

    /**
     * SHA-256 over the method, the concrete path and the request body.
     *
     * The same key with a *different* body is a client bug, and the dangerous
     * reading of it is "replay the old answer": the caller believes their new
     * ৳50,000 payment succeeded when what they got back was the receipt for
     * yesterday's ৳500 one. Comparing fingerprints turns that into a 409.
     */
    requestFingerprint: text('request_fingerprint').notNull(),

    /** Null while the first attempt is still running. */
    statusCode: integer('status_code'),

    /**
     * The response, exactly as it was serialized for the wire.
     *
     * Stored after the pipeline has already stripped what the caller may not
     * read (invariant 5), so a replay cannot widen what the first answer
     * disclosed. Money is safe in jsonb because it left the handler as a
     * decimal poisha *string* (invariant 1) — jsonb would otherwise round a
     * 16-digit number through a float.
     */
    responseBody: jsonb('response_body'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /** Stamped when the handler returned. Null means "still in flight". */
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),

    /**
     * When this record stops being replayable, 24 hours after it was created
     * (§23).
     *
     * Stored rather than computed at read time so the retention window is a
     * property of the row: changing the configured window later must not
     * retroactively resurrect or expire records that were written under the old
     * one.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('idempotency_keys_org_idx').on(table.orgId),

    /*
     * The uniqueness that makes the whole mechanism work, and the lock that
     * makes a double tap safe.
     *
     * RLS confines reads to one org, but a unique index is a *global* structure
     * — so org_id must be the first column or two orgs could not use the same
     * client-generated key, and one tenant could probe another's key space by
     * watching for conflicts.
     */
    uniqueIndex('idempotency_keys_scope_idx').on(
      table.orgId,
      table.userId,
      table.route,
      table.idempotencyKey,
    ),

    /*
     * The sweeper's index. Without it, deleting expired rows becomes a full
     * scan of a table that takes a row per mutation per day — and the sweep
     * then costs more the longer it has been since the last one, which is the
     * wrong way round for a job that runs after an outage.
     */
    index('idempotency_keys_expiry_idx').on(table.expiresAt),

    /*
     * Expiry is enforced by the database, not only by the query that reads the
     * row, so a record whose window has passed is unreplayable even when the
     * sweeper is behind. `created_at` is the floor because a row born with
     * `expires_at` already in the past would be instantly unreplayable — and a
     * mutation whose reservation is invalid the moment it is written runs twice.
     */
    check('idempotency_keys_window_ordered', sql`${table.expiresAt} > ${table.createdAt}`),

    /*
     * A completed record has both halves or neither. A status with no body, or
     * a body with no status, would be replayed as a response with no status
     * line — the one failure the replay path cannot report sensibly.
     */
    check(
      'idempotency_keys_completion_consistent',
      sql`(${table.completedAt} is null and ${table.statusCode} is null)
        or (${table.completedAt} is not null and ${table.statusCode} is not null)`,
    ),
  ],
);
