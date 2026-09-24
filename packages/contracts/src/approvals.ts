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
  'period_reopen',
] as const;

export const approvalTypeSchema = z.enum(APPROVAL_TYPES);
export type ApprovalType = z.infer<typeof approvalTypeSchema>;

/** The range of a PostgreSQL `bigint`, which is where every `*_poisha` lands. */
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

/**
 * A decimal integer, optionally negative. Never a float, never exponent form,
 * and never outside `bigint`: an amount the column cannot hold used to reach
 * the insert and come back as a 500 rather than a 400.
 */
const poishaString = z
  .string()
  .max(20, 'Amounts are integer poisha, sent as a decimal string.')
  .regex(/^-?\d+$/, 'Amounts are integer poisha, sent as a decimal string.')
  .refine((value) => {
    // The regex above has already reported a malformed string; `BigInt` would
    // throw on one, and Zod runs every check rather than stopping at the first.
    if (!/^-?\d+$/.test(value)) return true;
    const amount = BigInt(value);
    return amount >= BIGINT_MIN && amount <= BIGINT_MAX;
  }, 'That amount is out of range.');

/** The id in `/v1/approvals/:id/...`. A malformed one is a 400, not a 500. */
export const approvalIdSchema = z.string().uuid('No such approval request.');

export const approvalRequestSchema = z.object({
  type: approvalTypeSchema,
  amountPoisha: poishaString.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().trim().max(500).optional(),
  /**
   * The branch the request is about (§6 "branch items"). Optional for an
   * org-level action; required in effect for a branch-scoped requester, whose
   * only branch is used when they name none.
   */
  branchId: z.string().uuid().optional(),
});
export type ApprovalRequestInput = z.infer<typeof approvalRequestSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const thresholdSchema = z.object({
  type: approvalTypeSchema,
  thresholdPoisha: poishaString.refine(
    (value) => !value.startsWith('-'),
    'A threshold cannot be negative.',
  ),
});
export type ThresholdInput = z.infer<typeof thresholdSchema>;
