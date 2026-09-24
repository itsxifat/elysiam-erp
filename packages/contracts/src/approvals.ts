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

/**
 * A decimal integer, optionally negative. Never a float, never exponent form.
 *
 * Bounded as well as shaped. The column is `bigint`, so a 30-digit amount
 * passes the regex and then fails in Postgres as `value out of range` — a 500
 * where §23 asks for problem+json. The bound is PostgreSQL's own
 * `bigint` range, which at poisha scale is about ৯ crore crore taka: far
 * beyond anything real, and exactly where the database stops.
 */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * Built by a function rather than by chaining, and the difference is a bug.
 *
 * `poishaString.regex(/^\d+$/)` was how the threshold schema said "and not
 * negative" — but `poishaString` had just gained a `.refine`, which makes it a
 * `ZodEffects`, and `.regex` on that does not constrain the string it wraps.
 * The extra rule silently stopped applying: `'1.5'` reached `BigInt('1.5')`
 * and came back as a 500 instead of the 400 the schema was there to produce.
 *
 * So each shape is built from scratch, with every rule in one place.
 */
function poisha(options: { signed: boolean }) {
  const pattern = options.signed ? /^-?\d+$/ : /^\d+$/;
  const message = options.signed
    ? 'Amounts are integer poisha, sent as a decimal string.'
    : 'A threshold is a non-negative integer poisha, sent as a decimal string.';

  return z
    .string()
    .regex(pattern, message)
    .refine(
      (value) => {
        /*
         * Total, because Zod does not stop at the first failed check.
         *
         * A `.refine` after a `.regex` still runs when the regex failed, so
         * `BigInt('1.5')` threw out of the validator — turning a malformed
         * amount into a 500, which is precisely the failure this bound was
         * added to prevent. A check that can throw is not a check.
         */
        if (!/^-?\d+$/.test(value)) return true;
        const magnitude = value.startsWith('-') ? BigInt(value.slice(1)) : BigInt(value);
        return magnitude <= BIGINT_MAX;
      },
      { message: 'That amount is larger than any amount this system can hold.' },
    );
}

const poishaString = poisha({ signed: true });

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
  /*
   * Shaped *and* parseable. The first version matched
   * `/^\d{4}-\d{2}-\d{2}T[\d:.]+Z,[0-9a-f-]{36}$/`, which admits
   * `9999-99-99T99:99:99Z` and a 36-character run of hyphens — both pass the
   * regex and both are a Postgres cast error, which is a 500 rather than the
   * 400 the shape check existed to produce.
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

export const thresholdSchema = z.object({
  type: approvalTypeSchema,
  thresholdPoisha: poisha({ signed: false }),
});
export type ThresholdInput = z.infer<typeof thresholdSchema>;
