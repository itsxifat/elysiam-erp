import { z } from 'zod';

/**
 * Maker-checker schemas (architecture §6).
 *
 * Amounts cross the wire as strings, not numbers. Money is integer poisha
 * (invariant 1) and a poisha amount above 2^53 is perfectly ordinary at
 * crore scale — JSON numbers would round it silently, which is the exact
 * failure mode the integer-poisha rule exists to prevent.
 */

export const APPROVAL_TYPES = [
  'wallet_adjustment',
  'stock_write_off',
  'stock_gain',
  'supplier_payment',
  'settlement_posting',
  'closing_variance',
  'back_dated_entry',
  'payroll_run',
  'bonus_rule',
  'reseller_payout_batch',
  /*
   * §6's maker-checker list names "investor withdrawals and distributions" and
   * "fraud block overrides", and neither was here. The consequence is not that
   * they were unapproved — it is that they could not be routed through
   * approvals at all, because the enum has no value for them, so M15 and M10
   * would each have arrived at a wall and invented something.
   */
  'investor_withdrawal',
  'investor_distribution',
  'fraud_override',
  'period_reopen',
] as const;

export const approvalTypeSchema = z.enum(APPROVAL_TYPES);
export type ApprovalType = z.infer<typeof approvalTypeSchema>;

/** A decimal integer, optionally negative. Never a float, never exponent form. */
const poishaString = z
  .string()
  .regex(/^-?\d+$/, 'Amounts are integer poisha, sent as a decimal string.');

export const approvalRequestSchema = z.object({
  type: approvalTypeSchema,
  amountPoisha: poishaString.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().trim().max(500).optional(),
});
export type ApprovalRequestInput = z.infer<typeof approvalRequestSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

/**
 * List filters and the cursor (§23).
 *
 * §23 asks for `?cursor=&limit=50`, maximum 200. The list had neither: it
 * returned the newest 100 rows and stopped, with no way to page and no way to
 * filter. An org raising a hundred approvals in a week — routine across five
 * showrooms — pushed an older *pending* supplier payment off the end of the
 * only endpoint that lists them, and the id is discoverable nowhere else. The
 * checker could not find the request they were there to decide.
 *
 * The cursor is the composite `created_at,id` of the last row seen, because
 * `created_at` alone is not unique and a page boundary landing inside a
 * same-millisecond group either repeats a row or skips one.
 */
export const approvalListSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  type: approvalTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z,[0-9a-f-]{36}$/,
      'A cursor is the `createdAt,id` of the last row you saw.',
    )
    .optional(),
});
export type ApprovalListInput = z.infer<typeof approvalListSchema>;

export const thresholdSchema = z.object({
  type: approvalTypeSchema,
  thresholdPoisha: poishaString.regex(/^\d+$/, 'A threshold cannot be negative.'),
});
export type ThresholdInput = z.infer<typeof thresholdSchema>;
