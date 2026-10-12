import { z } from 'zod';

/**
 * Voice messages and calls in the inbox (M45, D-780 to D-788): the request shapes the server
 * validates at its edge and the console builds.
 */

const uuid = z.string().uuid('No such record.');

/** The longest voice message the composer sends: two minutes (D-781). */
export const INBOX_VOICE_MAX_MS = 120_000;

/**
 * A recorded voice message, sent. The browser uploaded the recording first (a private
 * `inbox-media` file, ticket, PUT and finalize) and names it here; `id` is the browser's own id
 * for the message, so a retried send is one message (D-746).
 */
export const inboxVoiceSchema = z
  .object({
    id: uuid,
    fileId: uuid,
    durationMs: z.number().int().min(500).max(INBOX_VOICE_MAX_MS),
  })
  .strict();
export type InboxVoiceInput = z.infer<typeof inboxVoiceSchema>;

/**
 * The agent's browser answering a call (D-787). WhatsApp gives an SDP offer and takes the
 * browser's answer, first to `pre_accept` (the connection is set up) and then to `accept` (the
 * call is put through); Messenger takes the browser's offer with `accept` and answers with its
 * own. The SDP is RFC 8866 text: lines ending in CRLF, a few kilobytes.
 */
export const inboxCallAnswerSchema = z
  .object({
    step: z.enum(['pre_accept', 'accept']),
    sdp: z
      .string()
      .min(10)
      .max(16_000)
      .refine((value) => value.startsWith('v=0'), 'That is not a session description.'),
  })
  .strict();
export type InboxCallAnswerInput = z.infer<typeof inboxCallAnswerSchema>;
