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

export const thresholdSchema = z.object({
  type: approvalTypeSchema,
  thresholdPoisha: poishaString.regex(/^\d+$/, 'A threshold cannot be negative.'),
});
export type ThresholdInput = z.infer<typeof thresholdSchema>;
