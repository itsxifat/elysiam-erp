import { businessDateSchema, ledgerIdSchema, positivePoishaSchema } from '@elysium/contracts';
import { z } from 'zod';

/**
 * The loan endpoints' request shapes (architecture §15, §23; M26).
 *
 * Every amount is a decimal string of integer poisha, never a JSON number (§23). Every id a
 * client generates for a new row (`loanId`, `paymentId`) makes a retried submit answer from
 * the row that exists rather than posting a second journal.
 */

const textOrNull = (max: number) => z.string().trim().max(max).optional();

export const createLenderSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    kind: z.enum(['bank', 'person', 'other']),
    notes: textOrNull(2_000),
  })
  .strict();
export type CreateLenderInput = z.infer<typeof createLenderSchema>;

/** The terms a schedule is built from, shared by the preview and by recording a loan. */
const termsShape = {
  principalPoisha: positivePoishaSchema,
  /** Nominal annual rate in basis points: 1200 = 12% a year (D-294). */
  rateBps: z.number().int().min(0).max(10_000),
  method: z.enum(['flat', 'reducing']).default('reducing'),
  tenureMonths: z.number().int().min(1).max(360),
  /** Defaults to one month after the receipt, the same day of the month. */
  firstDueOn: businessDateSchema.optional(),
};

export const previewScheduleSchema = z.object(termsShape).strict();
export type PreviewScheduleInput = z.infer<typeof previewScheduleSchema>;

export const createLoanSchema = z
  .object({
    loanId: ledgerIdSchema,
    lenderId: ledgerIdSchema,
    ...termsShape,
    /** The wallet the principal arrived in (§7's W). */
    walletAccountId: ledgerIdSchema,
    reference: textOrNull(80),
    reminderDays: z.number().int().min(0).max(30).default(3),
    /** The brand's own staff number for the SMS reminder. Any form a person types. */
    reminderPhone: z.string().trim().min(6).max(20).optional(),
    memo: textOrNull(500),
  })
  .strict();
export type CreateLoanInput = z.infer<typeof createLoanSchema>;

export const payInstalmentSchema = z
  .object({
    paymentId: ledgerIdSchema,
    /** The instalment the person meant to pay: refused unless it is the next unpaid one. */
    instalmentId: ledgerIdSchema,
    walletAccountId: ledgerIdSchema,
    memo: textOrNull(500),
  })
  .strict();
export type PayInstalmentInput = z.infer<typeof payInstalmentSchema>;

export const idParamSchema = ledgerIdSchema;
