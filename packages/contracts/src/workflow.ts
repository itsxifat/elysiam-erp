import { z } from 'zod';

/**
 * The order workflow (M41, D-710 to D-720): the request shapes the server validates at its edge
 * and the console builds. The rules behind them (who is available, who is offered an order, who
 * may move one) are in `@elysium/domain`; the bounds here repeat that module's constants, which a
 * test keeps in step, because this package depends on nothing but Zod.
 */

const uuid = z.string().uuid('No such record.');

/**
 * The header that says "I know somebody else is handling this order" (D-710).
 *
 * One mechanism for every order write the owner's name guards: without it a non-owner is
 * refused with `ORDER_HANDLED_BY_OTHER`, with it the act goes through, is audited and the owner
 * is told. A header rather than a body field, so a bodyless confirm carries it the same way an
 * edit does.
 */
export const OWNER_ACK_HEADER = 'x-acknowledge-owner';

/** The console's report about its own tab, about every thirty seconds (D-713). */
export const presenceBeatSchema = z
  .object({
    /** `document.visibilityState === 'visible'`. */
    visible: z.boolean(),
    /** Seconds since the last keyboard, pointer or touch input in this tab. */
    idleSeconds: z.number().int().min(0).max(86_400),
  })
  .strict();
export type PresenceBeat = z.infer<typeof presenceBeatSchema>;

/** "Not taking orders" on or off. */
export const presencePauseSchema = z.object({ paused: z.boolean() }).strict();
export type PresencePause = z.infer<typeof presencePauseSchema>;

export const DESK_WORK_TYPES = ['orders', 'messages'] as const;
export type DeskWorkType = (typeof DESK_WORK_TYPES)[number];

/** A staff member's desk (D-714): what they may be offered, and the hub they pack at. */
export const deskProfileSchema = z
  .object({
    workTypes: z
      .array(z.enum(DESK_WORK_TYPES))
      .max(DESK_WORK_TYPES.length)
      .refine((types) => new Set(types).size === types.length, 'Each work type once.'),
    /** The stock location of the hub this person works at; null for none (all locations). */
    hubLocationId: uuid.nullable(),
  })
  .strict();
export type DeskProfileInput = z.infer<typeof deskProfileSchema>;

/**
 * When the courier is booked (§9's `orders.courier_booking`, D-901): as the order is confirmed,
 * as it is packed, or only when a person books it. Booking gives the parcel its consignment,
 * and the label prints by itself from there (D-817).
 */
export const COURIER_BOOKING_POLICIES = ['on_confirm', 'on_pack', 'manual'] as const;
export type CourierBookingPolicy = (typeof COURIER_BOOKING_POLICIES)[number];

/** Settings → Order workflow (D-715; the booking and the courier's hours, D-901, D-903). */
export const workflowSettingsSchema = z
  .object({
    autoAssign: z.boolean(),
    offerSeconds: z.number().int().min(15).max(300),
    maxOpen: z.number().int().min(1).max(200),
    /** Absent leaves it as it is. */
    courierBooking: z.enum(COURIER_BOOKING_POLICIES).optional(),
    /** Hours after the handover with no word from the courier of having the parcel; absent leaves it. */
    notReceivedHours: z.number().int().min(1).max(72).optional(),
  })
  .strict();
export type WorkflowSettingsInput = z.infer<typeof workflowSettingsSchema>;

export const CALL_OUTCOME_VALUES = [
  'reached',
  'no_answer',
  'busy',
  'wrong_number',
  'call_back',
] as const;

/** One verification call (D-718). `callBackAt` only, and always, for a call-back. */
export const callAttemptSchema = z
  .object({
    outcome: z.enum(CALL_OUTCOME_VALUES),
    callBackAt: z.string().datetime({ offset: true }).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type CallAttemptInput = z.infer<typeof callAttemptSchema>;

/** The hub printed these orders' slips (D-719). */
export const markPrintedSchema = z
  .object({ ids: z.array(uuid).min(1).max(100) })
  .strict()
  .refine((input) => new Set(input.ids).size === input.ids.length, 'Each order once.');
export type MarkPrintedInput = z.infer<typeof markPrintedSchema>;
