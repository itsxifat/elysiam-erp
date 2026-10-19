import { z } from 'zod';

/**
 * A buyer's numbers and the people one number names (M48, D-870 to D-889): what the console sends
 * and receives for the Numbers card, the merge, an order's buyer and the desk's chooser.
 *
 * The closed lists are the domain's (`@elysium/domain`'s `PHONE_KINDS` and the rest), repeated here
 * because this package does not import the domain; a server test (`numbers.lists.test.ts`) keeps the two
 * in step.
 */

export const CUSTOMER_PHONE_KINDS = [
  'mobile',
  'whatsapp',
  'home',
  'office',
  'shop',
  'other',
] as const;
export const CUSTOMER_PHONE_RELATIONS = [
  'own',
  'household',
  'relative',
  'work',
  'someone_else',
  'other',
] as const;
export const CUSTOMER_PHONE_SOURCES = [
  'staff',
  'order',
  'website',
  'inbox',
  'call',
  'import',
] as const;
export const CUSTOMER_PHONE_RETIRE_REASONS = [
  'changed_number',
  'wrong_number',
  'not_theirs',
  'other',
] as const;

export type CustomerPhoneKind = (typeof CUSTOMER_PHONE_KINDS)[number];
export type CustomerPhoneRelation = (typeof CUSTOMER_PHONE_RELATIONS)[number];
export type CustomerPhoneSource = (typeof CUSTOMER_PHONE_SOURCES)[number];
export type CustomerPhoneRetireReason = (typeof CUSTOMER_PHONE_RETIRE_REASONS)[number];

const phoneInput = z.string().trim().min(6).max(32);
const note = z.string().trim().min(1).max(500);
const uuid = z.string().uuid();

/** `POST /v1/customers/:id/phones`: staff add a number, and say why (D-871). */
export const customerPhoneAddSchema = z
  .object({
    phone: phoneInput,
    kind: z.enum(CUSTOMER_PHONE_KINDS).default('mobile'),
    relation: z.enum(CUSTOMER_PHONE_RELATIONS).default('own'),
    note,
  })
  .strict();
export type CustomerPhoneAddInput = z.input<typeof customerPhoneAddSchema>;

/** `PATCH /v1/customers/:id/phones/:phoneId`: its details, or its place (1 makes it primary). */
export const customerPhoneUpdateSchema = z
  .object({
    kind: z.enum(CUSTOMER_PHONE_KINDS).optional(),
    relation: z.enum(CUSTOMER_PHONE_RELATIONS).optional(),
    note: note.optional(),
    rank: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Say what to change: the kind, the relation, the note or the rank.',
  });
export type CustomerPhoneUpdateInput = z.infer<typeof customerPhoneUpdateSchema>;

/** `POST /v1/customers/:id/phones/:phoneId/retire`: a changed or recycled SIM, a wrong number. */
export const customerPhoneRetireSchema = z
  .object({
    reason: z.enum(CUSTOMER_PHONE_RETIRE_REASONS),
    note: note.optional(),
  })
  .strict();
export type CustomerPhoneRetireInput = z.infer<typeof customerPhoneRetireSchema>;

/** `POST /v1/customers/:id/merge`: the other record is the same person and joins this one. */
export const customerMergeSchema = z
  .object({
    otherCustomerId: uuid,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type CustomerMergeInput = z.infer<typeof customerMergeSchema>;

/**
 * `POST /v1/orders/:id/buyer`: a supervisor puts the order on the right person (D-882). The order's
 * own buyer again only confirms them, which clears "check the buyer".
 */
export const orderBuyerChangeSchema = z
  .object({
    customerId: uuid,
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
export type OrderBuyerChangeInput = z.infer<typeof orderBuyerChangeSchema>;

/** One of a person's numbers, as the Numbers card and the caller panel show it. */
export interface CustomerPhoneView {
  readonly id: string;
  readonly phone: string;
  readonly rank: number;
  readonly kind: CustomerPhoneKind;
  readonly relation: CustomerPhoneRelation;
  readonly note: string | null;
  /** No note yet: an automatic path added it (D-871). */
  readonly needsDetails: boolean;
  readonly source: CustomerPhoneSource;
  readonly addedBy: { readonly id: string; readonly name: string | null } | null;
  readonly addedAt: string;
  readonly retired: {
    readonly at: string;
    readonly reason: CustomerPhoneRetireReason;
    readonly note: string | null;
    readonly by: { readonly id: string; readonly name: string | null } | null;
  } | null;
}

/** One person a number names (D-875), for a screen with a person in front of it. */
export interface BuyerCandidateView {
  readonly customerId: string;
  readonly name: string;
  /** The number's place on this person: 1 is their primary. */
  readonly rank: number;
  readonly kind: CustomerPhoneKind;
  readonly relation: CustomerPhoneRelation;
  readonly note: string | null;
  readonly lastOrderAt: string | null;
  readonly orders: number;
  readonly delivered: number;
  readonly returned: number;
  /** The automatic path's choice among them (D-876). */
  readonly suggested: boolean;
}

// --- M49: a buyer's details and address book, from the buyer page and the inbox (D-891 to D-895) ---

export const CUSTOMER_GENDERS = ['female', 'male', 'other'] as const;
export type CustomerGender = (typeof CUSTOMER_GENDERS)[number];

/**
 * A buyer's details: `PATCH /v1/customers/:id` and the inbox's `PATCH …/customer` (D-891). A field
 * left out is kept; `null` clears it (a wrong email or birthday must be removable). The number is
 * not here: numbers are the Numbers card's (M48).
 */
export const customerDetailsSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().max(254).email().nullable().optional(),
    birthday: z.string().date().nullable().optional(),
    anniversary: z.string().date().nullable().optional(),
    gender: z.enum(CUSTOMER_GENDERS).nullable().optional(),
    ageBand: z.string().trim().min(1).max(40).nullable().optional(),
    profession: z.string().trim().min(1).max(120).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    notes: z.string().trim().min(1).max(2000).nullable().optional(),
  })
  .strict();
export type CustomerDetailsInput = z.infer<typeof customerDetailsSchema>;

/**
 * One address in a buyer's address book (D-894): `POST /v1/customers/:id/addresses` adds it, `PUT
 * …/addresses/:addressId` replaces it. `isDefault` makes it the one the desk fills in first.
 */
export const customerAddressSchema = z
  .object({
    label: z.string().trim().min(1).max(40).nullable().optional(),
    districtId: z.number().int().positive(),
    thanaId: z.number().int().positive(),
    area: z.string().trim().max(160).nullable().optional(),
    addressLine: z.string().trim().min(3).max(500),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type CustomerAddressInput = z.infer<typeof customerAddressSchema>;

/** One saved address, with its district's and thana's names. */
export interface CustomerAddressView {
  readonly id: string;
  readonly label: string | null;
  readonly districtId: number;
  readonly districtName: string | null;
  readonly thanaId: number;
  readonly thanaName: string | null;
  readonly area: string | null;
  readonly addressLine: string;
  readonly isDefault: boolean;
}

/**
 * The buyer as the inbox's customer card shows and edits them (D-890): the details, every number
 * with the staff's notes, the address book and the pinned note. No cost, nothing a buyer page
 * would not show.
 */
export interface CustomerCardView {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly email: string | null;
  readonly gender: CustomerGender | null;
  readonly ageBand: string | null;
  readonly profession: string | null;
  readonly birthday: string | null;
  readonly anniversary: string | null;
  readonly tags: readonly string[];
  readonly notes: string | null;
  readonly segment: string | null;
  readonly phones: readonly CustomerPhoneView[];
  readonly addresses: readonly CustomerAddressView[];
  readonly pinnedNote: {
    readonly body: string;
    readonly at: string;
    readonly by: { readonly id: string; readonly name: string | null };
  } | null;
}

// --- M49: the inbox's Save as customer and link (D-892), kept off the first download ---------

/**
 * M49 (D-892): save the chat's person as a new customer: their name, and the number (the contact's
 * saved one when left out). Always a new record; one of the people already on the number is
 * linked with `inboxLinkCustomerSchema` instead.
 */
export const inboxSaveCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    phone: z.string().trim().min(6).max(32).optional(),
  })
  .strict();
export type InboxSaveCustomerInput = z.infer<typeof inboxSaveCustomerSchema>;

/** M49 (D-892): this chat is that customer, one of the people on the contact's saved number. */
export const inboxLinkCustomerSchema = z.object({ customerId: z.string().uuid() }).strict();
export type InboxLinkCustomerInput = z.infer<typeof inboxLinkCustomerSchema>;
