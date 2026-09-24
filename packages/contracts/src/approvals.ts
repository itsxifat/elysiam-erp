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
  /** A relaxed approval threshold, raised by one org admin and approved by another (D-073). */
  'threshold_change',
] as const;

export const approvalTypeSchema = z.enum(APPROVAL_TYPES);
export type ApprovalType = z.infer<typeof approvalTypeSchema>;

/**
 * Types that carry no amount: a control action, not a sum of money. The
 * request must send `amountPoisha: null`, and every other type must send one.
 */
export const NO_AMOUNT_APPROVAL_TYPES: readonly ApprovalType[] = [
  'period_reopen',
  'bonus_rule',
  'threshold_change',
];

/**
 * Types no threshold can ever exempt (D-071).
 *
 * Reopening a closed period, a back-dated entry, a bonus rule and a threshold
 * change are controls over the books themselves; "small" is not a property
 * they have. An org admin once set a threshold of 1 on `period_reopen` and the
 * next request with amount 0 was auto-approved and frozen. So these always
 * need a second person, `thresholdSchema` refuses a threshold for them, and
 * the database has a CHECK on both tables saying the same.
 */
export const NEVER_AUTO_APPROVE_TYPES: readonly ApprovalType[] = [
  ...NO_AMOUNT_APPROVAL_TYPES,
  'back_dated_entry',
];

/**
 * Types whose amount the owning module computes, not the requester (D-072).
 *
 * A stock write-off is valued at WAC (M07), a payroll run and a payout batch
 * are sums the system calculates (M19, M21), a settlement comes from the
 * courier's statement (M12) and a closing variance from the till count (M23).
 * Through the generic `POST /v1/approvals` the requester types the number, so
 * it cannot be trusted to decide whether a second person looks: these are
 * always held there. The owning module will raise them with the amount it
 * derived, and only then may the threshold apply.
 */
export const SERVER_DERIVED_AMOUNT_TYPES: readonly ApprovalType[] = [
  'stock_write_off',
  'stock_gain',
  'settlement_posting',
  'closing_variance',
  'payroll_run',
  'reseller_payout_batch',
];

/**
 * Types whose amount is a cost figure (invariant 5, D-074): a write-off or a
 * gain is valued at WAC, which is exactly what `read:cost` protects. Their
 * amounts are withheld from roles without it.
 */
export const COST_VALUED_APPROVAL_TYPES: readonly ApprovalType[] = [
  'stock_write_off',
  'stock_gain',
];

/**
 * Branch items (D-076): §6's "branch items under threshold" for a branch
 * manager. Never auto-approved; under the threshold, with an amount the owning
 * module derived, a branch manager of that branch may decide them. Equal to
 * `CHECKER_TYPES.branch_manager`, which a test asserts.
 */
export const BRANCH_ITEM_APPROVAL_TYPES: readonly ApprovalType[] = [
  'stock_write_off',
  'stock_gain',
  'closing_variance',
];

/**
 * No money in the payload (D-078).
 *
 * `amount_poisha` is the amount a checker saw and approved; an executor must
 * read that and nothing else. A payload carrying its own `amountPoisha` or
 * `total_poisha` is a second amount that can differ from the approved one, and
 * the executor that reads the wrong field pays it. So a payload may not name
 * one, at any depth. Owning modules add their own per-type payload schema.
 */
const MONEY_KEY = /poisha|amount/i;

function moneyKeyIn(value: unknown, path: string): string | null {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = moneyKeyIn(entry, `${path}[${String(index)}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  for (const [key, entry] of Object.entries(value)) {
    if (MONEY_KEY.test(key)) return `${path}.${key}`;
    const found = moneyKeyIn(entry, `${path}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

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

export const approvalRequestSchema = z
  .object({
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
  })
  .superRefine((value, context) => {
    const amountless = NO_AMOUNT_APPROVAL_TYPES.includes(value.type);
    if (amountless && value.amountPoisha !== null) {
      context.addIssue({
        code: 'custom',
        path: ['amountPoisha'],
        message: `A ${value.type} request carries no amount.`,
      });
    }
    if (!amountless && value.amountPoisha === null) {
      context.addIssue({
        code: 'custom',
        path: ['amountPoisha'],
        message: `A ${value.type} request needs an amount.`,
      });
    }
    const moneyKey = moneyKeyIn(value.payload, 'payload');
    if (moneyKey !== null) {
      context.addIssue({
        code: 'custom',
        path: ['payload'],
        message: `${moneyKey}: the amount belongs in amountPoisha, not in the payload.`,
      });
    }
    if (JSON.stringify(value.payload).length > 8_000) {
      context.addIssue({ code: 'custom', path: ['payload'], message: 'The payload is too large.' });
    }
  });
export type ApprovalRequestInput = z.infer<typeof approvalRequestSchema>;

export const approvalDecisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const thresholdSchema = z.object({
  type: approvalTypeSchema.refine(
    (type) => !NEVER_AUTO_APPROVE_TYPES.includes(type),
    'That approval type always needs a second person; it cannot have a threshold.',
  ),
  thresholdPoisha: poishaString.refine(
    (value) => !value.startsWith('-'),
    'A threshold cannot be negative.',
  ),
});
export type ThresholdInput = z.infer<typeof thresholdSchema>;
