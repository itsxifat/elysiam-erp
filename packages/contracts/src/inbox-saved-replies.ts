import { z } from 'zod';

/**
 * Saved replies (M44a, D-763): the brand's shared answers, typed into the inbox's composer with
 * `/` and a shortcut. The body is any language (Bangla included: it is the brand's own text, not
 * a UI string) and may name the placeholders below, which the console fills from the
 * conversation before the reply is sent.
 */

/** What a body may name; anything else in braces is left as typed. */
export const SAVED_REPLY_PLACEHOLDERS = ['name', 'order_number', 'total', 'phone'] as const;
export type SavedReplyPlaceholder = (typeof SAVED_REPLY_PLACEHOLDERS)[number];

/** Lower case letters, digits, `-` and `_`, as typed after the slash. */
export const SAVED_REPLY_SHORTCUT = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const shortcut = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SAVED_REPLY_SHORTCUT, 'A shortcut is up to 32 letters, digits, - or _, with no spaces.');

export const savedReplyInputSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    shortcut,
    // The reply's own limit (`inboxReplySchema`): a saved reply always fits one message.
    body: z.string().trim().min(1).max(1000),
    category: z
      .string()
      .trim()
      .max(40)
      .optional()
      .transform((value) => (value === undefined || value === '' ? null : value)),
  })
  .strict();
export type SavedReplyInput = z.infer<typeof savedReplyInputSchema>;
