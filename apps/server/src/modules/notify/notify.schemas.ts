import { z } from 'zod';

/**
 * The notify module's wire shapes (architecture §23), validated at the edge.
 *
 * Template keys are dotted lower-case words, the database CHECK's own shape. Bodies are
 * bounded at 1,000 characters, the CHECK's limit: a few SMS segments, which is already
 * more than a buyer reads.
 */

export const upsertTemplateSchema = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_.]{2,63}$/, 'A template key is lower-case words joined by dots.'),
    /**
     * Not `otp`: an OTP template skips opt-outs and quiet hours, so a marketer who could
     * mark a greeting `otp` could text opted-out buyers at midnight. OTP templates are the
     * system's, seeded rather than edited (ledger audit W4).
     */
    category: z.enum(['transactional', 'marketing']),
    /** The message, in English: the one body every SMS is sent from (D-750, D-755). */
    bodyEn: z.string().trim().min(1).max(1000),
    isActive: z.boolean().optional(),
  })
  .strict();
export type UpsertTemplateInput = z.infer<typeof upsertTemplateSchema>;

export const optOutSchema = z
  .object({
    phone: z.string().min(6).max(32),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const optOutPhoneParamSchema = z.string().min(6).max(32);

export const messageListSchema = z
  .object({
    state: z.enum(['queued', 'sent', 'failed', 'suppressed']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
