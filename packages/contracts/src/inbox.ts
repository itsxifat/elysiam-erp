import { z } from 'zod';

/**
 * The unified inbox (M42, D-730 to D-749): the request shapes the server validates at its edge
 * and the console builds. The lists here are the domain's (`@elysium/domain/inbox`); a server
 * test holds them equal.
 */

const uuid = z.string().uuid('No such record.');

export const INBOX_CHANNEL_KINDS = ['messenger', 'instagram', 'whatsapp'] as const;
export type InboxChannelKindName = (typeof INBOX_CHANNEL_KINDS)[number];

export const INBOX_CONTACT_STAGES = [
  'visitor',
  'lead',
  'customer',
  'not_qualified',
  'fraud',
] as const;
export type InboxContactStage = (typeof INBOX_CONTACT_STAGES)[number];

/**
 * The header a write on someone else's conversation must carry (D-737): `x-acknowledge-owner:
 * 1`. Uniform across every inbox write, so the console sends it the same way everywhere, and
 * named so a log line says what it meant.
 */
export const ACKNOWLEDGE_OWNER_HEADER = 'x-acknowledge-owner';

/** The list: whose, which channel, which stage, unread only, a name or phone fragment. */
export const inboxListQuerySchema = z
  .object({
    view: z.enum(['all', 'mine', 'unassigned']).default('all'),
    channel: z.enum(INBOX_CHANNEL_KINDS).optional(),
    stage: z.enum(INBOX_CONTACT_STAGES).optional(),
    status: z.enum(['open', 'closed', 'any']).default('open'),
    unread: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    q: z.string().trim().min(2).max(64).optional(),
    /** The `lastMessageAt` of the last row of the previous page, for the next one. */
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict();
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

/** A thread's messages, newest last; `before` pages back through older ones. */
export const inboxThreadQuerySchema = z
  .object({
    before: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
  })
  .strict();
export type InboxThreadQuery = z.infer<typeof inboxThreadQuerySchema>;

/**
 * A reply. `id` is the browser's own id for it, so a reply retried after a dropped connection
 * is one message (D-746). Meta caps a Messenger or Instagram text at 2,000 characters and 1,000
 * bytes respectively; 1,000 characters keeps every channel's limit.
 */
export const inboxReplySchema = z
  .object({
    id: uuid,
    text: z.string().trim().min(1).max(1000),
  })
  .strict();
export type InboxReplyInput = z.infer<typeof inboxReplySchema>;

export const inboxHandOverSchema = z.object({ userId: z.string().min(1).max(64) }).strict();
export type InboxHandOverInput = z.infer<typeof inboxHandOverSchema>;

/** A phone as typed or as found in the chat; the server normalises it as the desk does. */
export const inboxPhoneSchema = z.object({ phone: z.string().trim().min(6).max(32) }).strict();
export type InboxPhoneInput = z.infer<typeof inboxPhoneSchema>;

export const inboxAddressSchema = z
  .object({
    districtId: z.number().int().positive(),
    thanaId: z.number().int().positive(),
    area: z.string().trim().max(160).optional(),
    addressLine: z.string().trim().min(3).max(500),
  })
  .strict();
export type InboxAddressInput = z.infer<typeof inboxAddressSchema>;

/** Customer is never chosen: it follows from an order. `auto` hands the stage back to the rules. */
export const inboxStageSchema = z
  .object({ stage: z.enum(['lead', 'not_qualified', 'fraud', 'auto']) })
  .strict();
export type InboxStageInput = z.infer<typeof inboxStageSchema>;

export const inboxTagsSchema = z
  .object({
    tags: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(40)
          .regex(/^[^,]+$/, 'A tag has no commas.'),
      )
      .max(20),
  })
  .strict();
export type InboxTagsInput = z.infer<typeof inboxTagsSchema>;

export const inboxNoteSchema = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
export type InboxNoteInput = z.infer<typeof inboxNoteSchema>;

export const inboxInterestSchema = z.object({ productId: uuid, skuId: uuid.optional() }).strict();
export type InboxInterestInput = z.infer<typeof inboxInterestSchema>;

/** The order desk's warning: is this phone a contact marked fraud? */
export const inboxPhoneFlagsQuerySchema = z
  .object({ phone: z.string().trim().min(6).max(32) })
  .strict();

/**
 * A channel's settings (D-733). The id is Meta's (numeric); the token is write-only: left out,
 * the stored one stays; an empty string is refused rather than read as "remove".
 */
export const inboxChannelUpdateSchema = z
  .object({
    externalId: z
      .string()
      .trim()
      .regex(/^\d{1,30}$/, 'Meta ids are digits.'),
    enabled: z.boolean(),
    accessToken: z.string().trim().min(20).max(1024).optional(),
  })
  .strict();
export type InboxChannelUpdateInput = z.infer<typeof inboxChannelUpdateSchema>;

/** The Meta app's secret and the webhook's verify token; each left out stays as it is. */
export const inboxMetaAppSchema = z
  .object({
    // Not held to a format: Meta's pages describe the secret, not its shape.
    appSecret: z.string().trim().min(16).max(256).optional(),
    verifyToken: z.string().trim().min(16).max(128).optional(),
  })
  .strict()
  .refine((value) => value.appSecret !== undefined || value.verifyToken !== undefined, {
    message: 'Give the app secret, the verify token, or both.',
  });
export type InboxMetaAppInput = z.infer<typeof inboxMetaAppSchema>;
