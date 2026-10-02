import { z } from 'zod';

import { isoDateSchema, monthSchema } from './hr.schemas.js';

/**
 * What the targets, bonus-rule and productivity endpoints accept (M20; §12, §23).
 *
 * Two shapes are deliberately absent. No request carries an achieved figure or a weekly
 * plan: both are computed — the split by `splitTarget`, the progress from the orders the
 * agents confirmed and delivered — and a client that could send either could write its own
 * bonus. And no request carries a bonus amount: a bonus is what an approved rule pays for
 * a target's result (`evaluateBonus`), never a number somebody typed.
 */

const METRICS = ['confirmed_orders', 'delivered_orders', 'delivered_revenue'] as const;

/**
 * A target value: orders, or poisha for a revenue target, as a decimal string.
 *
 * Bounded at ৳10 crore (10^10 poisha) for revenue and the same digits for a count —
 * far above any month a desk could do, and low enough that a keystroke adding three zeros
 * is a refusal rather than a target nobody can reach.
 */
const targetValueSchema = z
  .string()
  .regex(/^\d{1,11}$/, 'A target is a whole number, sent as a decimal string.')
  .refine((value) => BigInt(value) > 0n && BigInt(value) <= 10_000_000_000n, {
    message: 'A target must be more than zero and no more than 10,000,000,000.',
  });

export const createTargetSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('employee'),
      month: monthSchema,
      metric: z.enum(METRICS),
      employeeId: z.string().uuid('That is not a valid employee id.'),
      targetValue: targetValueSchema,
      note: z.string().trim().min(1).max(300).optional(),
    })
    .strict(),
  z
    .object({
      scope: z.literal('team'),
      month: monthSchema,
      metric: z.enum(METRICS),
      teamName: z.string().trim().min(1).max(80),
      memberIds: z
        .array(z.string().uuid('That is not a valid employee id.'))
        .min(1, 'A team has at least one member.')
        .max(50, 'A team has at most 50 members.'),
      branchId: z.string().uuid().optional(),
      targetValue: targetValueSchema,
      note: z.string().trim().min(1).max(300).optional(),
    })
    .strict(),
]);

export type CreateTargetInput = z.infer<typeof createTargetSchema>;

export const targetQuerySchema = z
  .object({
    month: monthSchema.optional(),
    employeeId: z.string().uuid().optional(),
    status: z.enum(['active', 'cancelled']).optional(),
  })
  .strict();

export type TargetQuery = z.infer<typeof targetQuerySchema>;

export const meQuerySchema = z.object({ month: monthSchema.optional() }).strict();

/**
 * A productivity window: Asia/Dhaka dates, both inclusive, at most 92 days.
 *
 * The cap is a cost bound, not a policy: the report replays every desk event of every
 * order touched in the window, and a quarter is the longest window anybody reviews.
 */
export const productivityQuerySchema = z
  .object({ from: isoDateSchema, to: isoDateSchema })
  .strict()
  .refine((value) => value.from <= value.to, { message: 'The window ends before it starts.' })
  .refine(
    (value) =>
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000 <
      92,
    { message: 'A productivity window is at most 92 days.' },
  );

export type ProductivityQuery = z.infer<typeof productivityQuerySchema>;

/**
 * A bonus rule's JSON, checked for shape here and for meaning by `parseBonusRule`.
 *
 * Kept as `unknown` past the edge on purpose: the domain parser is the one place that
 * says what a rule may contain, and a second, looser copy here would be the copy that
 * drifts.
 */
export const createBonusRuleSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    definition: z.record(z.string(), z.unknown()),
  })
  .strict();

export type CreateBonusRuleInput = z.infer<typeof createBonusRuleSchema>;

export const bonusVersionSchema = z
  .object({ definition: z.record(z.string(), z.unknown()) })
  .strict();

export const submitVersionSchema = z
  .object({ reason: z.string().trim().min(1).max(500).optional() })
  .strict();

export const previewQuerySchema = z.object({ month: monthSchema }).strict();
