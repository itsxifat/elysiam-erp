import { z } from 'zod';

/**
 * The query `GET /v1/jobs/failed` accepts (architecture §23).
 *
 * §23's list rules — cursor pagination, `limit` capped at 200, Zod-validated
 * filters — apply to every list, and a failed-jobs list is the one somebody
 * pages through while an incident is still running.
 *
 * It lives beside the route rather than in `packages/contracts` because the
 * cursor is a pg-boss job's `created_on,id`, and pg-boss's job shape is this
 * platform module's business, not the shared contract surface every frontend
 * compiles against. When M04's OpenAPI generation needs it there, it moves with
 * a decision row behind it.
 *
 * The cursor is validated for *parseability*, not only for shape: a regex that
 * accepts `9999-99-99T99:99:99Z` hands PostgreSQL a cast it cannot make, which
 * is a 500 where the check existed to produce a 400. The same trap the approvals
 * list hit.
 */
export const failedJobsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'A cursor is the `createdAt,id` of the last failed job you saw.',
      )
      .refine((value) => !Number.isNaN(Date.parse(value.split(',')[0] ?? '')), {
        message: 'That cursor does not carry a real timestamp.',
      })
      .optional(),
  })
  .strict();

export type FailedJobsQuery = z.infer<typeof failedJobsQuerySchema>;
