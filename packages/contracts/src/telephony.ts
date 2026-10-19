import { z } from 'zod';

import { CALL_OUTCOME_VALUES } from './workflow.js';

/**
 * Phone calls through Envo (M47, D-830 to D-862): Settings → Calls' connections and extensions,
 * placing a call, the call log's filters, the person's wrap-up after a call, the caller panel and
 * its pinned note. The request shapes the server validates at its edge and the console builds,
 * and the answers' types (erased from every bundle). No shape here ever carries a secret back.
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

export const telephonyConnectionCreateSchema = z
  .object({
    name: z.string().trim().min(1, 'Name the connection.').max(60),
    baseUrl: z.string().trim().max(200).default(TELEPHONY_DEFAULT_BASE_URL),
    apiKey: apiKeySchema,
    webhookSecret: webhookSecretSchema.optional(),
    enabled: z.boolean().default(true),
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
 * phone on it), a customer, a phone shown on a screen, or an inbox conversation's contact (D-862:
 * the conversation's owner is asked first, as for the inbox's other writes; `phone` is then the
 * number the panel shows, and must be the contact's). At least one; a conversation never with an
 * order or a customer.
 */
export const phoneCallPlaceSchema = z
  .object({
    orderId: uuid.optional(),
    customerId: uuid.optional(),
    conversationId: uuid.optional(),
    phone: z.string().trim().min(6).max(32).optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.orderId !== undefined ||
      input.customerId !== undefined ||
      input.conversationId !== undefined ||
      input.phone !== undefined,
    'Say whom to call: an order, a customer, a conversation or a phone.',
  )
  .refine(
    (input) =>
      input.conversationId === undefined ||
      (input.orderId === undefined && input.customerId === undefined),
    'Call from a conversation, or about an order or a customer, not both.',
  );
export type PhoneCallPlaceInput = z.infer<typeof phoneCallPlaceSchema>;

/** The browser's phone answered a call from this number (D-836). */
export const phoneCallAnsweredSchema = z
  .object({ from: z.string().trim().min(2).max(40) })
  .strict();
export type PhoneCallAnsweredInput = z.infer<typeof phoneCallAnsweredSchema>;

/** A call's result after it (D-859): M41's five (`CALL_OUTCOME_VALUES`). */
export type PhoneCallResult = (typeof CALL_OUTCOME_VALUES)[number];

/** How long a wrap-up's note may be (D-859); M41's attempt keeps its first 500 characters. */
export const PHONE_CALL_WRAP_UP_NOTE_MAX = 1000;

/** The results whose wrap-up needs a note: what was agreed, or what to call back about. */
export const PHONE_CALL_RESULTS_NEEDING_NOTE: readonly PhoneCallResult[] = ['reached', 'call_back'];

/**
 * The person's wrap-up after a call (D-859): one of M41's five results (the ERP suggests one; the
 * person chooses), what it was about or what was agreed (two characters at least for `reached`
 * and `call_back`), and when to call back (only, and always, for `call_back`; at most 30 days
 * ahead, which the server checks). Written once. A call about a colleague's order needs
 * `x-acknowledge-owner: 1` (M41's gate, D-710) while the order can still be called about.
 */
export const phoneCallWrapUpSchema = z
  .object({
    result: z.enum(CALL_OUTCOME_VALUES),
    note: z
      .string()
      .trim()
      .max(PHONE_CALL_WRAP_UP_NOTE_MAX, 'Keep the note to 1,000 characters.')
      .optional(),
    callBackAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (PHONE_CALL_RESULTS_NEEDING_NOTE.includes(input.result) && (input.note ?? '').length < 2) {
      context.addIssue({
        code: 'custom',
        path: ['note'],
        message:
          input.result === 'call_back'
            ? 'Say what to call back about.'
            : 'Say what the call was about, or what was agreed.',
      });
    }
    if (input.result === 'call_back' && input.callBackAt === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['callBackAt'],
        message: 'Say when to call back.',
      });
    }
    if (input.result !== 'call_back' && input.callBackAt !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['callBackAt'],
        message: 'Only a call-back has a time to call again.',
      });
    }
  });
export type PhoneCallWrapUpInput = z.infer<typeof phoneCallWrapUpSchema>;

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

/**
 * Whose caller panel (D-860): a phone (an incoming call's number), a customer, or a call. Sent as
 * a POST so the number stays out of URLs and access logs (invariant 10). `ordersCursor` asks for
 * the next page of the buyer's orders (the previous answer's `orders.nextCursor`).
 */
export const callerPanelQuerySchema = z
  .object({
    phone: z.string().trim().min(3).max(40).optional(),
    customerId: uuid.optional(),
    callId: uuid.optional(),
    ordersCursor: z.string().max(80).optional(),
  })
  .strict()
  .refine(
    // M48 (D-887): a customer beside a phone or a call switches to another person on that number.
    (input) =>
      (input.phone === undefined || input.callId === undefined) &&
      [input.phone, input.customerId, input.callId].some((value) => value !== undefined),
    'Say whose panel: a phone, a customer or a call.',
  );
export type CallerPanelQuery = z.infer<typeof callerPanelQuerySchema>;

/** How long a buyer's pinned note may be (D-860). */
export const CUSTOMER_PINNED_NOTE_MAX = 2000;

/**
 * The note pinned on top of a buyer's caller panel (D-860, `PUT /v1/customers/:id/pinned-note`):
 * what to do with them, or who was handling them. An empty body clears it.
 */
export const customerPinnedNoteSchema = z
  .object({
    body: z
      .string()
      .trim()
      .max(CUSTOMER_PINNED_NOTE_MAX, 'Keep the pinned note to 2,000 characters.'),
  })
  .strict();
export type CustomerPinnedNoteInput = z.infer<typeof customerPinnedNoteSchema>;

// --- the answers (types only) -------------------------------------------------------------------

export type PhoneCallDirectionName = 'inbound' | 'outbound' | 'internal' | 'unknown';
export type PhoneCallStatusName =
  'requested' | 'dialing' | 'failed' | 'ringing' | 'answered' | 'ended';
export type PhoneCallDispositionName =
  'answered' | 'no_answer' | 'busy' | 'failed' | 'congestion' | 'unknown';

/** A person of the brand, named when the brand lists them (null for an owner or a leaver). */
export interface PhoneCallPersonRef {
  readonly id: string;
  readonly name: string | null;
}

/** The person's wrap-up of a call (D-859), as written once. */
export interface PhoneCallWrapUpView {
  readonly result: PhoneCallResult;
  readonly note: string | null;
  readonly callBackAt: string | null;
  readonly byUserId: string;
  readonly byName: string | null;
  readonly at: string;
}

/** One call as the API returns it (`callView`), to a person whose scope reaches it (D-841). */
export interface PhoneCallView {
  readonly id: string;
  readonly connectionId: string;
  readonly envoCallId: string | null;
  readonly firstSeen: 'click' | 'webhook' | 'sync';
  readonly direction: PhoneCallDirectionName;
  readonly status: PhoneCallStatusName;
  readonly answered: boolean;
  readonly disposition: PhoneCallDispositionName | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly customerPhone: string | null;
  readonly extension: string | null;
  readonly person: PhoneCallPersonRef | null;
  readonly customer: { readonly id: string; readonly name: string | null } | null;
  readonly order: { readonly id: string; readonly orderNo: string } | null;
  readonly orderOwner: PhoneCallPersonRef | null;
  readonly talkSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly occurredAt: string;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  /**
   * Whether Envo named a recording of it on the connection's own host (D-858). It plays through
   * `GET /v1/telephony/calls/:id/recording`, streamed from Envo while Envo still has it.
   */
  readonly recording: { readonly playable: boolean };
  /** M41's verification attempt recorded on the call's order through its wrap-up (D-838). */
  readonly outcome: PhoneCallResult | null;
  readonly wrapUp: PhoneCallWrapUpView | null;
  /** What the ERP suggests the result was (`suggestWrapUp`), or null when it cannot tell. */
  readonly suggestedResult: PhoneCallResult | null;
  /** Whether the viewer may wrap it up now: their own call, over, not yet wrapped up. */
  readonly canWrapUp: boolean;
  readonly error: { readonly code: string; readonly detail: string | null } | null;
}

/** `POST /v1/telephony/calls/:id/wrap-up`'s answer (D-859). */
export interface PhoneCallWrapUpAnswer {
  readonly call: PhoneCallView;
  /**
   * Whether M41's verification attempt was recorded on the call's order. False for a call with no
   * order, and for one whose order can no longer be called about (the wrap-up is kept).
   */
  readonly orderAttempt: boolean;
}

/**
 * `GET /v1/telephony/calls/wrap-ups` (D-859): the viewer's own calls that ended in the last day
 * and wait for their wrap-up, newest first, at most twenty.
 */
export interface PhoneCallWrapUpsAnswer {
  readonly items: readonly PhoneCallView[];
}

/** One of the buyer's orders in the caller panel: what the order screens show. */
export interface CallerPanelOrder {
  readonly id: string;
  readonly orderNo: string;
  readonly status: string;
  /** The order's COD, integer poisha as a string (shown through `<Money>`). */
  readonly codAmountPoisha: string;
  readonly createdAt: string;
}

/** The note pinned on top of the panel (D-860), with who wrote it and when. */
export interface CallerPanelPinnedNote {
  readonly body: string;
  readonly byUserId: string;
  readonly byName: string | null;
  readonly at: string;
}

export interface CallerPanelCustomer {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly tags: readonly string[];
  /** The buyer's RFM segment (M16), when the nightly job has given one. */
  readonly segment: string | null;
  /** An inbox contact of theirs (by buyer or by phone) is marked fraud (M42). */
  readonly fraud: boolean;
  readonly pinnedNote: CallerPanelPinnedNote | null;
  /** Whether the viewer may change the pinned note. */
  readonly canPin: boolean;
  readonly stats: {
    readonly orders: number;
    readonly delivered: number;
    readonly returned: number;
    readonly cancelled: number;
    /** Returned ÷ (delivered + returned), in basis points; null before either. */
    readonly returnRateBps: number | null;
    /** Spent on delivered orders, integer poisha as a string. */
    readonly spentPoisha: string;
    readonly firstOrderAt: string | null;
    readonly lastOrderAt: string | null;
  };
}

export interface CallerPanelAddress {
  /** A saved address of the buyer's, or one an order of theirs was sent to. */
  readonly source: 'saved' | 'order';
  readonly label: string | null;
  readonly district: string | null;
  readonly thana: string | null;
  readonly area: string | null;
  readonly addressLine: string;
  readonly isDefault: boolean;
}

export interface CallerPanelPhone {
  readonly phone: string;
  /** An order's recipient phone, or an inbox contact's saved phone. */
  readonly source: 'order' | 'inbox';
}

/** M48 (D-870): one of the person's own numbers in use, with the staff's note. */
export interface CallerPanelNumber {
  readonly id: string;
  readonly phone: string;
  readonly rank: number;
  readonly kind: string;
  readonly relation: string;
  readonly note: string | null;
  readonly needsDetails: boolean;
}

/** M48 (D-887): one of the people the calling number names, with how they use it. */
export interface CallerPanelPerson {
  readonly customerId: string;
  readonly name: string;
  readonly rank: number;
  readonly relation: string;
  readonly note: string | null;
  readonly lastOrderAt: string | null;
  readonly orders: number;
  /** The automatic pick among them (D-876). */
  readonly suggested: boolean;
  /** The person the panel is showing. */
  readonly current: boolean;
}

/** A website account of the buyer's (M34). */
export interface CallerPanelEmail {
  readonly email: string;
  readonly verified: boolean;
}

/** An inbox contact of the buyer's, on one channel (D-861: shown with its channel's mark). */
export interface CallerPanelSocial {
  readonly contactId: string;
  /** The inbox channel's kind: `messenger`, `instagram` or `whatsapp`. */
  readonly channel: string;
  readonly displayName: string | null;
  readonly profileName: string | null;
  /** Instagram's username, when the channel has one. */
  readonly handle: string | null;
}

export interface CallerPanelConversation {
  readonly id: string;
  readonly channel: string;
  readonly status: 'open' | 'closed';
  readonly lastMessageAt: string;
  readonly assignedTo: PhoneCallPersonRef | null;
  /** The last message's preview, only for a viewer who may read conversations. */
  readonly preview: string | null;
  /** Whether the viewer may open it in the inbox (`read Conversation`). */
  readonly canOpen: boolean;
}

/**
 * One call with this buyer or phone, whoever had it (D-860: "previously another staff was
 * managing"): who, when, how long, and their wrap-up. Who may hear it is still D-841's.
 */
export interface CallerPanelCall {
  readonly id: string;
  readonly person: PhoneCallPersonRef | null;
  readonly direction: PhoneCallDirectionName;
  readonly status: PhoneCallStatusName;
  readonly answered: boolean;
  readonly occurredAt: string;
  readonly talkSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly order: { readonly id: string; readonly orderNo: string } | null;
  readonly wrapUp: PhoneCallWrapUpView | null;
  readonly hasRecording: boolean;
  /** Whether the viewer may hear it (D-841's scope). */
  readonly canPlay: boolean;
}

/** The whole panel (D-860), for a supervisor or a person who reaches or is on a call with them. */
export interface CallerPanelFull {
  readonly full: true;
  /** The phone asked about, or the buyer's own when asked by customer or call. */
  readonly phone: string | null;
  /** Null for a number no buyer of the brand has. */
  readonly customer: CallerPanelCustomer | null;
  /** All the buyer's orders the viewer may open, newest first, twenty a page. */
  readonly orders: {
    readonly items: readonly CallerPanelOrder[];
    readonly nextCursor: string | null;
  };
  readonly addresses: readonly CallerPanelAddress[];
  /** M48: the person's own numbers in use, by rank, with the staff's notes. */
  readonly numbers: readonly CallerPanelNumber[];
  /** M48: everyone the panel's number names, when it is more than one person's. */
  readonly sharedWith: readonly CallerPanelPerson[];
  readonly otherPhones: readonly CallerPanelPhone[];
  readonly emails: readonly CallerPanelEmail[];
  readonly socials: readonly CallerPanelSocial[];
  readonly conversations: readonly CallerPanelConversation[];
  /** Newest first, at most fifty. */
  readonly calls: readonly CallerPanelCall[];
}

/** Today's screen pop for anyone else (D-843): the buyer's name and their open orders. */
export interface CallerPanelMinimal {
  readonly full: false;
  readonly phone: string | null;
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly openOrders: readonly CallerPanelOrder[];
}

/** `POST /v1/telephony/caller-panel`'s answer. */
export type CallerPanelAnswer = CallerPanelFull | CallerPanelMinimal;

/** `PUT /v1/customers/:id/pinned-note`'s answer: the note now pinned, or null once cleared. */
export interface CustomerPinnedNoteAnswer {
  readonly pinnedNote: CallerPanelPinnedNote | null;
}
