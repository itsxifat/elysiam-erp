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
