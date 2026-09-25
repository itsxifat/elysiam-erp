import { Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';

import type { ActiveContext } from '../http/context.js';
import { DEAD_LETTER_SUFFIX, DEFAULT_JOBS_SCHEMA } from './queues.js';
import type { FailedJobsQuery } from './failed-jobs.schema.js';

/**
 * Reading what the queue gave up on (architecture §20, "a failed-jobs admin API").
 *
 * §20 says a dead-lettered job emits `job.failed`. An event tells an org_admin
 * that something broke; it does not tell them what is *still* broken an hour
 * later, and it cannot be re-read once the toast is gone. This is that second
 * question, and the reason it is a route rather than a psql query is that the
 * person who needs the answer is a brand's admin, not an operator with a
 * database password.
 *
 * ## Tenancy, without a policy to lean on
 *
 * `pgboss.job` is pg-boss's table: no `org_id` column, no RLS, no FORCE. There is
 * no policy to filter this read, so the filter is explicit — on `data->>'orgId'`,
 * the envelope field every tenant job carries (see `envelope.ts`). Two
 * consequences worth stating rather than discovering:
 *
 * - The predicate is written here and nowhere else, so it is the one line to
 *   review for cross-tenant leakage on this endpoint. Everything else in this
 *   repo can lean on `withOrg`; this cannot.
 * - A job with no `orgId` is a `global` queue's job — a cron fan-out, the whole
 *   installation's work. It belongs to no tenant, so an org_admin never sees one.
 *   Super admin does, because §5's exception 3 is exactly that read.
 *
 * ## Why the error text is not returned
 *
 * A failed job's `output` holds the serialised rejection, and an error message
 * routinely quotes the input that produced it — which for this product means a
 * phone number (invariant 10) and, on a supply or inventory job, a purchase cost
 * (invariant 5). `serializeFor` cannot help: it prunes fields by name, and this
 * would be prose inside one string. So the response carries the error's *code*,
 * which `failureCode` in the runtime already narrowed to a class name, and the
 * counts and timestamps around it. A redacted detail view is a follow-up, not
 * something to approximate now.
 */

export interface FailedJob {
  readonly id: string;
  readonly queue: string;
  /** The row the job was about, from its envelope. Null when it had none. */
  readonly ref: string | null;
  /** The error's class or code, never its message. See the note above. */
  readonly code: string;
  /** How many attempts were spent before it was given up on. */
  readonly attempts: number;
  readonly createdAt: string;
  readonly failedAt: string | null;
}

export interface FailedJobsPage {
  readonly jobs: readonly FailedJob[];
  /** The `createdAt,id` to pass back as `cursor`, or null at the end of the list. */
  readonly nextCursor: string | null;
}

/**
 * One row as PostgreSQL returns it, snake_case and all.
 *
 * Passed to `tx.execute` as `FailedJobRow & Record<string, unknown>`, because
 * `execute<T>` constrains `T` to `Record<string, unknown>` and an interface has
 * no implicit index signature — only an object *type alias* does, and the lint
 * rule in this repo wants an interface. The intersection satisfies both rather
 * than making one of them wrong.
 */
interface FailedJobRow {
  readonly id: string;
  readonly name: string;
  readonly ref: string | null;
  readonly output: unknown;
  readonly retry_count: number;
  /*
   * Formatted in SQL, as ISO 8601 in UTC, rather than converted here.
   *
   * `pgboss.job` is not in our Drizzle schema, so a raw `select created_on` comes
   * back as whatever the driver decides — and it decided on a string, which made
   * `.toISOString()` a TypeError at runtime and nothing at all at compile time.
   * Formatting in the query removes the guess, and it makes the keyset cursor
   * round-trip exactly the value the next page compares against.
   */
  readonly created_at: string;
  readonly failed_at: string | null;
}

/** ISO 8601 with microseconds, in UTC: what `to_char` needs to produce it. */
const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

@Injectable()
export class FailedJobsService {
  async list(context: ActiveContext, query: FailedJobsQuery): Promise<FailedJobsPage> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      // pg-boss installs its own schema on worker boot, so on a database whose
      // worker has never started — a fresh environment, and every HTTP test
      // suite in this repo — the table is simply absent. An empty list is the
      // honest answer to "what has failed" there; a 500 would make the route
      // look broken when nothing is.
      const installed = await tx.execute<{ present: boolean }>(
        sql`select to_regclass(${`${DEFAULT_JOBS_SCHEMA}.job`}) is not null as present`,
      );
      if (installed[0]?.present !== true) return { jobs: [], nextCursor: null };

      // Keyset, per §23, on `created_on,id`: a failed job is exactly what someone
      // is working through one page at a time while more arrive, and an OFFSET
      // page two under that shifts and skips rows.
      const cursor = splitCursor(query.cursor);

      const rows = await tx.execute<FailedJobRow & Record<string, unknown>>(sql`
        select
          id,
          name,
          data->>'ref' as ref,
          output,
          retry_count,
          to_char(created_on at time zone 'UTC', ${ISO_UTC}) as created_at,
          to_char(completed_on at time zone 'UTC', ${ISO_UTC}) as failed_at
        from ${sql.raw(`${DEFAULT_JOBS_SCHEMA}.job`)}
        where state = 'failed'
          -- The dead-letter copy of a failed job is itself a job on the
          -- generated dead-letter queue. Listing both would report every
          -- failure twice, the second time under a queue name no module owns.
          and name not like ${`%${DEAD_LETTER_SUFFIX}`}
          and (
            ${context.isSuperAdmin}
            or data->>'orgId' = ${context.orgId}
          )
          ${
            cursor === null
              ? sql``
              : sql`and (created_on, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
          }
        order by created_on desc, id desc
        limit ${query.limit + 1}
      `);

      const page = [...rows];
      const hasMore = page.length > query.limit;
      const visible = hasMore ? page.slice(0, query.limit) : page;
      const last = visible.at(-1);

      return {
        jobs: visible.map(toFailedJob),
        nextCursor: hasMore && last !== undefined ? `${last.created_at},${last.id}` : null,
      };
    });
  }
}

function toFailedJob(row: FailedJobRow): FailedJob {
  return {
    id: row.id,
    queue: row.name,
    ref: row.ref,
    code: codeFrom(row.output),
    attempts: row.retry_count + 1,
    createdAt: row.created_at,
    failedAt: row.failed_at,
  };
}

/**
 * The code out of pg-boss's stored rejection.
 *
 * Mirrors `failureCode` in the runtime rather than importing it, because the two
 * read different things: that one reads a dead-lettered job's output as the
 * handler threw it, this one reads whatever is on the row now — including
 * failures pg-boss itself recorded, such as a job that expired while its worker
 * was gone.
 */
function codeFrom(output: unknown): string {
  if (output !== null && typeof output === 'object') {
    const named = output as { name?: unknown; code?: unknown };
    if (typeof named.code === 'string' && named.code !== '') return named.code;
    if (typeof named.name === 'string' && named.name !== '') return named.name;
  }
  return 'JOB_FAILED';
}

function splitCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (cursor === undefined) return null;
  const comma = cursor.lastIndexOf(',');
  return { createdAt: cursor.slice(0, comma), id: cursor.slice(comma + 1) };
}
