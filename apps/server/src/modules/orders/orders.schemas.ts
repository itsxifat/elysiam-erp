import { ORDER_CHANNELS } from '@elysium/contracts';
import { RFM_SEGMENTS } from '@elysium/domain/crm';
import { z } from 'zod';

/**
 * What the order endpoints accept (architecture §23; validate at the edge).
 *
 * Two rules run through all of it:
 *
 * * **Money arrives as a decimal string of poisha, never a JSON number** (invariant 1).
 *   `JSON.parse` turns every number into a float, and a float is exactly where a taka
 *   goes missing — ৳1,23,456.78 is 12345678 poisha, which survives as a string and
 *   does not survive a round trip through a format with 53 bits of mantissa once the
 *   numbers get large. The schema refuses anything that is not digits.
 * * **No cost field is accepted from a client** (invariant 5, D-072). There is no unit
 *   cost, no WAC and no dispatch value anywhere in this file. The selling price is a
 *   client's to send; what a unit cost is the server's to know, and a request that
 *   could name it is a request that could set gross profit.
 */

/** Integer poisha as a decimal string. Positive or zero unless stated otherwise. */
const poishaString = z
  .string()
  .regex(/^\d{1,16}$/, 'Amounts are integer poisha written as digits.');

const uuid = z.string().uuid();

/**
 * A phone number as typed, normalised by the domain rather than here.
 *
 * Deliberately permissive at the edge and strict in `normalizeBdPhone`: the schema's job
 * is to refuse a body that is not a string of plausible length, and the domain's job is
 * to decide what a Bangladeshi mobile number is. Duplicating the rule in a Zod regex
 * would give two answers to "is this the same buyer", and the one the schema gave would
 * be the one nobody tested.
 */
const phoneInput = z.string().min(6).max(32);

const reason = z.string().trim().min(3).max(500);

export const orderIdSchema = uuid;

/** From `packages/contracts` (`channels.ts`), so promo scope speaks the same words. */
export const orderChannels = ORDER_CHANNELS;

/** §9's `source` block: where the order came from, for M11's attribution. */
const sourceSchema = z
  .object({
    pageId: z.string().max(120).optional(),
    campaignId: z.string().max(120).optional(),
    adId: z.string().max(120).optional(),
    landingPageId: uuid.optional(),
    chatwootConversationId: z.string().max(120).optional(),
    utmSource: z.string().max(120).optional(),
    utmMedium: z.string().max(120).optional(),
    utmCampaign: z.string().max(120).optional(),
    utmContent: z.string().max(120).optional(),
    // M11: the fifth UTM parameter. A landing page forwards all five, and dropping one at
    // the edge would make a paid-search keyword unrecoverable after the fact.
    utmTerm: z.string().max(120).optional(),
  })
  .strict();

const addressSchema = z
  .object({
    districtId: z.number().int().positive(),
    thanaId: z.number().int().positive(),
    area: z.string().trim().max(160).optional(),
    addressLine: z.string().trim().min(3).max(500),
  })
  .strict();

export const createCustomerSchema = z
  .object({
    phone: phoneInput,
    name: z.string().trim().min(1).max(200),
    birthday: z.string().date().optional(),
    anniversary: z.string().date().optional(),
    gender: z.enum(['female', 'male', 'other']).optional(),
    ageBand: z.string().trim().max(40).optional(),
    profession: z.string().trim().max(120).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    notes: z.string().trim().max(2000).optional(),
    address: addressSchema.optional(),
  })
  .strict();

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = createCustomerSchema
  .partial()
  .omit({ phone: true })
  .extend({
    /**
     * `null` removes a date; leaving the field out keeps it (M16). A birthday typed on the
     * wrong buyer must be removable, or the occasions job greets them every year for it.
     */
    birthday: z.string().date().nullable().optional(),
    anniversary: z.string().date().nullable().optional(),
  })
  .strict();

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const customerQuerySchema = z
  .object({
    /** A phone fragment, a name fragment, or a whole number. */
    q: z.string().trim().min(2).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export type CustomerQuery = z.infer<typeof customerQuerySchema>;

export const createOrderLineSchema = z
  .object({
    skuId: uuid,
    qty: z.number().int().min(1).max(100_000),
    /**
     * Optional. Left out, the SKU's list price is used.
     *
     * Allowed because an agent negotiating on a phone call is the ordinary case in this
     * business, not an exception — and refusing it would mean the discount had to be
     * expressed as an order-level figure, which loses which item was discounted and
     * makes §7's partial-delivery apportioning guess.
     */
    unitPricePoisha: poishaString.optional(),
    discountPoisha: poishaString.optional(),
  })
  .strict();

export const createOrderSchema = z
  .object({
    channel: z.enum(orderChannels),
    source: sourceSchema.optional(),
    /** One of the two: an existing buyer, or enough to create one. */
    customerId: uuid.optional(),
    customer: createCustomerSchema.optional(),
    /** Left out, the buyer's default address is snapshotted. */
    shipTo: addressSchema.extend({ name: z.string().trim().min(1).max(200).optional() }).optional(),
    branchId: uuid.optional(),
    locationId: uuid.optional(),
    deliveryZoneId: uuid.optional(),
    courierId: uuid.optional(),
    /** Left out, the zone's charge applies. Set to override it for this order. */
    deliveryChargePoisha: poishaString.optional(),
    discountPoisha: poishaString.optional(),
    advancePaidPoisha: poishaString.optional(),
    /**
     * A promo code as the buyer typed it. Never an id and never an amount: the server
     * prices the word against the lines it priced itself (D-204). The promo module checks
     * the real shape and answers PROMO_NOT_FOUND for anything else.
     */
    promoCode: z.string().trim().min(3).max(40).optional(),
    notes: z.string().trim().max(2000).optional(),
    /** Assign on creation. Left out, the order joins the unassigned queue (§6). */
    assignedTo: z.string().min(1).max(64).optional(),
    lines: z.array(createOrderLineSchema).min(1).max(100),
  })
  .strict()
  .refine((value) => value.customerId !== undefined || value.customer !== undefined, {
    message: 'An order needs a buyer: name an existing customer or supply one.',
  });

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * What an agent may still change after the order exists (§24's order desk).
 *
 * Narrower than `createOrderSchema` on purpose, and the omissions are the design:
 *
 * * **No buyer.** Moving an order to a different customer would take its history with
 *   it — and §10's trust score is computed from a buyer's delivery ratio, so a
 *   reassigned order silently rewrites two people's fraud signal. A wrong buyer is
 *   fixed by cancelling and re-entering.
 * * **No branch.** The branch is what `branch` scope is evaluated against, so a caller
 *   who could change it could move an order out of their own reach and into somebody
 *   else's — or, worse, take one from another branch by claiming it into theirs.
 * * **No advance.** An advance is a posted journal (§7). It moves by recording another
 *   one, never by editing a column, or the ledger and the order stop agreeing.
 *
 * `lines`, when present, is the whole new set rather than a patch: a partial line edit
 * has to say what happened to the lines it does not mention, and every answer to that
 * is a guess.
 */
export const updateOrderSchema = z
  .object({
    shipTo: addressSchema.extend({ name: z.string().trim().min(1).max(200).optional() }).optional(),
    locationId: uuid.optional(),
    deliveryZoneId: uuid.optional(),
    courierId: uuid.optional(),
    deliveryChargePoisha: poishaString.optional(),
    /** The order-level discount. Line discounts travel on the lines. */
    discountPoisha: poishaString.optional(),
    notes: z.string().trim().max(2000).optional(),
    lines: z.array(createOrderLineSchema).min(1).max(100).optional(),
  })
  .strict();

export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export const orderQuerySchema = z
  .object({
    status: z
      .enum([
        'pending',
        'confirmed',
        'on_hold',
        'packed',
        'shipped',
        'delivered',
        'partially_delivered',
        'return_in_transit',
        'returned',
        'cancelled',
        'exchange',
      ])
      .optional(),
    /** `unassigned` is §6's queue; `mine` is what the caller is working. */
    queue: z.enum(['unassigned', 'mine']).optional(),
    customerId: uuid.optional(),
    q: z.string().trim().min(2).max(64).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    // M11's list filters (Build list: status, channel, date, agent, zone).
    channel: z.enum(orderChannels).optional(),
    /** An agent's user id. Narrows the caller's scope; it never reaches past it. */
    assignedTo: z.string().trim().min(1).max(64).optional(),
    zoneId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export type OrderQuery = z.infer<typeof orderQuerySchema>;

/** Comma-separated uuids, or the same parameter repeated. */
function uuidList(max: number) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      (Array.isArray(value) ? value : value.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    )
    .pipe(z.array(uuid).min(1).max(max));
}

/**
 * The duplicate warning's question (M11 Build list): this number, these SKUs, 24 hours.
 *
 * The SKUs are the ones on the form right now, not "any SKU": the same buyer ordering a
 * second, different item an hour later is a customer coming back, and warning on it would
 * teach the desk to ignore the banner by lunchtime.
 */
export const duplicatesQuerySchema = z
  .object({ phone: phoneInput, skuIds: uuidList(100) })
  .strict();

export type DuplicatesQuery = z.infer<typeof duplicatesQuerySchema>;

/** `GET /v1/customers/lookup?phone=` — the desk's first keystrokes. */
export const customerLookupSchema = z.object({ phone: phoneInput }).strict();

/**
 * Bulk confirm (M11 Build list). A hundred at a time, and each one on its own.
 *
 * The cap is the size of a desk's evening queue, not a performance limit: a request that
 * could confirm ten thousand orders is one misclick from reserving a warehouse.
 */
export const bulkConfirmSchema = z
  .object({ ids: z.array(uuid).min(1).max(100) })
  .strict()
  .refine((value) => new Set(value.ids).size === value.ids.length, {
    message: 'An order appears twice in that list.',
  });

export type BulkConfirmInput = z.infer<typeof bulkConfirmSchema>;

/** The document kinds §22 renders for an order. `label` is the parcel's address label. */
export const orderDocumentKinds = ['invoice', 'packing_slip', 'label'] as const;
export type OrderDocumentKindName = (typeof orderDocumentKinds)[number];

/** Bulk print: one PDF, one page (or label) per order, in the order the ids were given. */
export const bulkDocumentQuerySchema = z
  .object({ ids: uuidList(100), kind: z.enum(orderDocumentKinds).default('invoice') })
  .strict();

/**
 * The buyer list's filters (M11 Build list: product, SKU, size, date, channel).
 *
 * * `product` is a fragment of the product name **as the order line recorded it**. The
 *   line's snapshot is what the buyer actually bought, and reading the catalog's current
 *   name from this module would cross invariant 12 for a rename the buyer never saw.
 * * `sku` is an exact SKU code.
 * * `size` is a variant code (`M`, `XL`, `42`) and matches a variant segment of the
 *   line's SKU code — the segments `buildSkuCode` appends after the product's sequence
 *   number. See `buyers.repository.ts` for why this is the size and not a guess.
 * * `from` and `to` are Asia/Dhaka order dates (invariant 8).
 */
export const buyerQuerySchema = z
  .object({
    product: z.string().trim().min(2).max(120).optional(),
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]+(-[A-Z0-9]+)*$/, 'That is not a SKU code.')
      .max(64)
      .optional(),
    size: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{1,8}$/, 'A size is a variant code such as M or 42.')
      .optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    channel: z.enum(orderChannels).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export type BuyerQuery = z.infer<typeof buyerQuerySchema>;

export const buyerExportQuerySchema = buyerQuerySchema
  .omit({ limit: true, offset: true })
  .extend({ format: z.enum(['csv', 'xlsx']).default('csv') })
  .strict();

export type BuyerExportQuery = z.infer<typeof buyerExportQuerySchema>;

export const confirmOrderSchema = z
  .object({
    /** §10: required when the fraud decision is `block`, and only org_admin may send it. */
    fraudOverrideReason: reason.optional(),
  })
  .strict();

export const holdOrderSchema = z.object({ reason }).strict();
export const cancelOrderSchema = z.object({ reason }).strict();

export const assignOrderSchema = z.object({ assignedTo: z.string().min(1).max(64) }).strict();

export const shipOrderSchema = z
  .object({
    courierId: uuid.optional(),
    /** The courier's own tracking reference, when the desk booked by hand. */
    consignmentNo: z.string().trim().max(120).optional(),
  })
  .strict();

const deliveredLineSchema = z
  .object({ skuId: uuid, deliveredQty: z.number().int().min(0).max(100_000) })
  .strict();

export const deliverOrderSchema = z
  .object({
    /**
     * What the rider actually collected. Left out, the order's COD is assumed.
     *
     * Present because §7 sends any difference to Sales discounts with a reason, and the
     * difference only exists if the real figure can be reported.
     */
    collectedPoisha: poishaString.optional(),
    differenceReason: reason.optional(),
    /** Set for a partial delivery: the units that actually arrived. */
    lines: z.array(deliveredLineSchema).min(1).max(100).optional(),
    occurredAt: z.string().datetime().optional(),
  })
  .strict();

export type DeliverOrderInput = z.infer<typeof deliverOrderSchema>;

export const returnOrderSchema = z
  .object({
    reason,
    /** Where the units go back to. Left out, the order's own location. */
    locationId: uuid.optional(),
    /** Units that came back damaged go to the `damaged` location instead (§8). */
    damaged: z.boolean().optional(),
    occurredAt: z.string().datetime().optional(),
  })
  .strict();

export type ReturnOrderInput = z.infer<typeof returnOrderSchema>;

export const startReturnSchema = z.object({ reason: reason.optional() }).strict();

export const exchangeOrderSchema = z
  .object({
    reason,
    /** Which of the delivered units are coming back. */
    returnLines: z
      .array(z.object({ skuId: uuid, qty: z.number().int().min(1).max(100_000) }).strict())
      .min(1)
      .max(100),
    /** The replacement order's lines. May be a different SKU, a different size, more. */
    lines: z.array(createOrderLineSchema).min(1).max(100),
    /** The replacement's delivery charge. Left out, the original order's. */
    deliveryChargePoisha: poishaString.optional(),
    locationId: uuid.optional(),
    occurredAt: z.string().datetime().optional(),
  })
  .strict();

export type ExchangeOrderInput = z.infer<typeof exchangeOrderSchema>;

export const recordAdvanceSchema = z
  .object({
    /** Which wallet took the money. §7 needs the account, not a channel name. */
    walletAccountId: uuid,
    amountPoisha: poishaString,
    occurredAt: z.string().datetime().optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();

export type RecordAdvanceInput = z.infer<typeof recordAdvanceSchema>;

export const availabilityQuerySchema = z
  .object({
    /** Comma-separated SKU ids, or repeated `skuId` params. */
    skuIds: z
      .union([z.string(), z.array(z.string())])
      .transform((value) =>
        (Array.isArray(value) ? value : value.split(','))
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ''),
      )
      .pipe(z.array(uuid).min(1).max(100)),
    locationId: uuid.optional(),
  })
  .strict();

export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const zoneLookupSchema = z
  .object({
    districtId: z.coerce.number().int().positive(),
    thanaId: z.coerce.number().int().positive().optional(),
  })
  .strict();

export const upsertZoneSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,31}$/, 'A zone code is lower snake_case.'),
    nameEn: z.string().trim().min(1).max(120),
    nameBn: z.string().trim().min(1).max(120),
    chargePoisha: poishaString,
    defaultCourierId: uuid.optional(),
    position: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpsertZoneInput = z.infer<typeof upsertZoneSchema>;

export const documentQuerySchema = z
  .object({ kind: z.enum(orderDocumentKinds).default('invoice') })
  .strict();

/**
 * The re-engagement list's filters (M16; architecture §10 "no purchase in N days, plus
 * filters"). `days` is how long since the buyer's last order, by the Dhaka calendar;
 * `minDelivered` keeps the list to people who have actually received something.
 */
export const reengagementQuerySchema = z
  .object({
    days: z.coerce.number().int().min(1).max(3_650).default(90),
    minDelivered: z.coerce.number().int().min(1).max(1_000).default(1),
    segment: z.enum(RFM_SEGMENTS).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

export type ReengagementQuery = z.infer<typeof reengagementQuerySchema>;

export const reengagementExportQuerySchema = reengagementQuerySchema
  .omit({ limit: true, offset: true })
  .extend({ format: z.enum(['csv', 'xlsx']).default('csv') })
  .strict();

export type ReengagementExportQuery = z.infer<typeof reengagementExportQuerySchema>;
