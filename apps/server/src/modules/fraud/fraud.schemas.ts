import { isNormalizableBdPhone } from '@elysium/domain';
import { z } from 'zod';

/**
 * What the fraud routes accept (architecture §23 "validate at the edge").
 *
 * In this module rather than in `packages/contracts`, the same way
 * `inventory.schemas.ts` is: that package's barrel is one file several milestones are
 * writing to at once, and an agent appending to it silently discards whatever another
 * agent wrote. The shared *error codes* are in contracts, which is the part clients
 * branch on.
 *
 * The phone field is the one worth reading. It is validated through the domain's own
 * `isNormalizableBdPhone` rather than a regex here, because a second definition of "a
 * Bangladeshi mobile" is a second thing that can disagree with the one that decides
 * customer identity — and when they disagree, the desk can look a number up and then fail
 * to save an order for it.
 */

const phone = z
  .string()
  .min(1, 'A phone number is required.')
  .max(20)
  .refine(isNormalizableBdPhone, 'That is not a Bangladeshi mobile number.');

/** `GET /v1/fraud/check?phone=…` */
export const fraudCheckQuerySchema = z.object({ phone }).strict();

/**
 * `POST /v1/fraud/flags`
 *
 * The reason floor is 3 characters, matching 0045's check. Short, because a flag is often
 * a shorthand an agent will recognise — but not empty: a flag with no reason blocks sales
 * and nobody can say why.
 */
export const raiseFlagSchema = z
  .object({
    phone,
    severity: z.number().int().min(1).max(3).default(1),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

/** `POST /v1/fraud/flags/:id/clear` */
export const clearFlagSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/**
 * `PUT /v1/fraud/rules`
 *
 * The ordering rule is not here. It is `assertBands` in the domain, checked again by a
 * constraint and a trigger — three copies of one rule, and this schema deliberately is
 * not a fourth. A Zod `superRefine` would be the fourth, and the day somebody relaxed
 * one of the others the schema would still pass and the database would raise a
 * constraint name instead of `FRAUD_RULES_INVALID`. Better that the request reaches the
 * one function that owns the rule.
 */
export const setRulesSchema = z
  .object({
    allowMin: z.number().int().min(0).max(100),
    warnMin: z.number().int().min(0).max(100),
    requireAdvanceMin: z.number().int().min(0).max(100),
    providerEnabled: z.boolean().default(false),
    /** Minutes. §10's default is 72 hours; a week is the ceiling before it is a guess. */
    providerTtlMinutes: z.number().int().min(1).max(10_080).default(4_320),
  })
  .strict();

export type FraudCheckQuery = z.infer<typeof fraudCheckQuerySchema>;
export type RaiseFlagInput = z.infer<typeof raiseFlagSchema>;
export type ClearFlagInput = z.infer<typeof clearFlagSchema>;
export type SetRulesInput = z.infer<typeof setRulesSchema>;
