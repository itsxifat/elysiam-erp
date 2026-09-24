import { z } from 'zod';

import { approvalTypeSchema } from './approvals.js';

/**
 * Filters and the cursor for `GET /v1/approvals` (architecture §23).
 *
 * §23 asks for cursor pagination — `?cursor=&limit=50`, maximum 200 — and
 * Zod-validated filters on every list. This one had neither: it returned the
 * newest hundred rows and stopped. An org raising a hundred approvals in a week
 * is routine across five showrooms, and the hundred-and-first pushed an older
 * **pending** supplier payment off the end of the only endpoint that lists
 * them. There is no other way to discover the id, so the checker could not
 * find the request they were there to decide — while the list looked perfectly
 * healthy.
 *
 * In its own file rather than in `approvals.ts` so the schema and the enum it
 * draws from cannot end up in a cycle when M04 generates the OpenAPI client
 * from these.
 */

/** The five states a request can be in. Mirrors `approvals.approval_status`. */
export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'auto_approved',
] as const;

export const approvalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalListSchema = z.object({
  status: approvalStatusSchema.optional(),
  type: approvalTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /*
   * The composite `createdAt,id` of the last row seen.
   *
   * Keyset rather than OFFSET, because rows arrive constantly and an offset
   * page two shifts under the reader — on this endpoint that means a pending
   * payment can be skipped entirely between two clicks.
   *
   * Composite because `created_at` alone is not unique: a page boundary landing
   * inside a same-millisecond group either repeats a row or drops one, and a
   * dropped row here is a payment nobody approves.
   *
   * Validated for *parseability*, not only for shape. A regex that accepts
   * `9999-99-99T99:99:99Z` or a 36-character run of hyphens hands Postgres a
   * cast it cannot make, which is a 500 where the check existed to produce a
   * 400.
   */
  cursor: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z,[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'A cursor is the `createdAt,id` of the last row you saw.',
    )
    .refine((value) => !Number.isNaN(Date.parse(value.split(',')[0] ?? '')), {
      message: 'That cursor does not carry a real timestamp.',
    })
    .optional(),
});

export type ApprovalListInput = z.infer<typeof approvalListSchema>;
