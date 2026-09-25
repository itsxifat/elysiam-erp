import { z } from 'zod';

/**
 * What actually travels in a job's `data` column.
 *
 * pg-boss stores a job's payload as jsonb in `pgboss.job`, a table this
 * application does not own: it has no `org_id`, no RLS and no FORCE, because
 * pg-boss creates and migrates it (see the grant note in `jobs.runtime.ts`).
 * Invariant 4 therefore cannot be satisfied by the table, so it is satisfied by
 * the envelope instead: every tenant job carries the org it belongs to, the
 * handler wrapper opens `withOrg` for that org before the handler sees anything,
 * and the failed-jobs read filters on it.
 *
 * That makes the envelope the tenancy boundary for background work, which is
 * why it is parsed on the way out of the database rather than cast. A row in a
 * table with no policy is a row anything with a connection could have written,
 * and a handler that trusted a cast `orgId` would happily open `withOrg` for
 * whatever it found.
 */

export const jobEnvelopeSchema = z
  .object({
    /**
     * The tenant this job's work belongs to. Null only for a `global` queue —
     * the cron fan-outs, which have no tenant until they enqueue one job per org.
     */
    orgId: z.string().uuid().nullable(),
    /**
     * The row this job is about, for the `job.failed` event and the failed-jobs
     * view. An id, never the payload: §19 allows ids plus display fields, and
     * `job.failed` reaches every org_admin and every super admin.
     */
    ref: z.string().max(200).nullable(),
    /**
     * The request that caused the enqueue, so a failed job three retries later
     * can still be traced back to the click that started it (§26).
     */
    requestId: z.string().max(200).nullable(),
    payload: z.unknown(),
  })
  .strict();

export type JobEnvelope<TPayload = unknown> = Omit<z.infer<typeof jobEnvelopeSchema>, 'payload'> & {
  readonly payload: TPayload;
};

/**
 * Parse one job's `data`, naming the queue when it is not an envelope.
 *
 * The message matters more than it looks: the first thing that will hit this is
 * a job enqueued by an older deploy, or by hand during an incident, and
 * "invalid envelope" without the queue name sends whoever is on call reading
 * every handler in the repo.
 */
export function parseEnvelope(queue: string, data: unknown): JobEnvelope {
  const parsed = jobEnvelopeSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`job on ${queue} does not carry a valid envelope — ${detail}`);
  }
  return parsed.data;
}

/**
 * Refuse a payload PostgreSQL would store as a lossy number.
 *
 * Invariant 1: money is integer poisha, and a `bigint` is what the rest of this
 * codebase holds it in. `JSON.stringify` throws on a bigint with
 * "Do not know how to serialize a BigInt", which is true but says nothing about
 * what to do; worse, a caller who works around it by calling `Number()` has
 * silently converted ৳90,071,992,547,409.92 and above into a value that no
 * longer round-trips. So the check happens here, with the fix in the message,
 * before anything reaches the database.
 *
 * Poisha crosses this boundary as a decimal string, which is what
 * `poishaString` in the contracts already uses for the same reason on the HTTP
 * edge.
 */
export function assertSerialisablePayload(queue: string, value: unknown, path = 'payload'): void {
  if (typeof value === 'bigint') {
    throw new Error(
      `job on ${queue} carries a bigint at ${path}; pass poisha as a decimal string (invariant 1) — JSON has no integer wide enough`,
    );
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertSerialisablePayload(queue, entry, `${path}[${String(index)}]`);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertSerialisablePayload(queue, entry, `${path}.${key}`);
    }
  }
}
