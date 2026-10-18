import { z } from 'zod';

import { callAttemptSchema } from './workflow.js';

/**
 * Phone calls through Envo (M47, D-830 to D-853): Settings → Calls' connections and extensions,
 * placing a call, the call log's filters, and recording a call's outcome. The request shapes the
 * server validates at its edge and the console builds. No shape here ever carries a secret back.
 */

const uuid = z.string().uuid('No such record.');

export const TELEPHONY_DEFAULT_BASE_URL = 'https://envo.enfinito.cloud';

/** Envo's keys are `envo_live_…`; any printable token is taken, and checked by the Test. */
const apiKeySchema = z
  .string()
  .trim()
  .min(20, 'Paste the whole API key from Envo’s Developers page.')
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'An API key has no spaces.');

/** Envo's webhook secrets are `whsec_…`. */
const webhookSecretSchema = z
  .string()
  .trim()
  .min(8, 'Paste the whole signing secret from Envo’s webhook.')
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'A signing secret has no spaces.');

const retentionSchema = z.coerce
  .number()
  .int()
  .min(30, 'Keep recordings for at least 30 days.')
  .max(3650, 'Keep recordings for at most ten years.');

export const telephonyConnectionCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the connection.').max(60),
    baseUrl: z.string().trim().max(200).default(TELEPHONY_DEFAULT_BASE_URL),
    apiKey: apiKeySchema,
    webhookSecret: webhookSecretSchema.optional(),
    enabled: z.boolean().default(true),
    recordingRetentionDays: retentionSchema.default(365),
  })
  .strict();
export type TelephonyConnectionCreateInput = z.infer<typeof telephonyConnectionCreateSchema>;

/** A secret left out is kept as it is (write-only fields, D-830). */
export const telephonyConnectionUpdateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the connection.').max(60),
    baseUrl: z.string().trim().max(200),
    apiKey: apiKeySchema.optional(),
    webhookSecret: webhookSecretSchema.optional(),
    enabled: z.boolean(),
    recordingRetentionDays: retentionSchema,
  })
  .strict();
export type TelephonyConnectionUpdateInput = z.infer<typeof telephonyConnectionUpdateSchema>;

/** One extension of a connection to one person of the brand (D-846). */
export const telephonyAssignSchema = z
  .object({
    extension: z
      .string()
      .trim()
      .regex(/^[0-9]{2,8}$/, 'An extension is two to eight digits.'),
    userId: z.string().trim().min(1).max(64),
  })
  .strict();
export type TelephonyAssignInput = z.infer<typeof telephonyAssignSchema>;

/**
 * Call a customer from your own extension (D-834): about an order (its buyer, or the recipient's
 * phone on it), a customer, or a phone shown on a screen (the inbox's panel). At least one.
 */
export const phoneCallPlaceSchema = z
  .object({
    orderId: uuid.optional(),
    customerId: uuid.optional(),
    phone: z.string().trim().min(6).max(32).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.orderId !== undefined || input.customerId !== undefined || input.phone !== undefined,
    'Say whom to call: an order, a customer or a phone.',
  );
export type PhoneCallPlaceInput = z.infer<typeof phoneCallPlaceSchema>;

/** The browser's phone answered a call from this number (D-836). */
export const phoneCallAnsweredSchema = z
  .object({ from: z.string().trim().min(2).max(40) })
  .strict();
export type PhoneCallAnsweredInput = z.infer<typeof phoneCallAnsweredSchema>;

/** The verification outcome of a call about an order, as M41 records one (D-838). */
export const phoneCallOutcomeSchema = callAttemptSchema;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD.');

/** The Calls page's filters (D-845): dates are Asia/Dhaka calendar dates, both inclusive. */
export const phoneCallListQuerySchema = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    userId: z.string().trim().min(1).max(64).optional(),
    direction: z.enum(['inbound', 'outbound', 'internal']).optional(),
    answered: z.enum(['answered', 'missed']).optional(),
    orderNo: z.string().trim().min(1).max(40).optional(),
    phone: z.string().trim().min(3).max(32).optional(),
    orderId: uuid.optional(),
    customerId: uuid.optional(),
    /** The last row of the previous page: `<startedAt ISO>|<id>`. */
    cursor: z.string().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type PhoneCallListQuery = z.infer<typeof phoneCallListQuerySchema>;

export const phoneLookupQuerySchema = z
  .object({ phone: z.string().trim().min(3).max(40) })
  .strict();
