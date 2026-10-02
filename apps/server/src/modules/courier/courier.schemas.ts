import { RETURN_REASON_CODES } from '@elysium/domain';
import { z } from 'zod';

/**
 * What the courier routes accept, validated at the edge (architecture §23).
 *
 * The shared Zod schemas in `packages/contracts` are the ones a client also uses; these
 * are the server's own edge validation for routes that have no client yet, and they will
 * move to the contracts package with the typed client (`pnpm api:client`). Two rules run
 * through all of them:
 *
 * - **Money is a decimal string**, never a JSON number (invariant 1). A COD of
 *   ৳1,23,45,678.90 is 1234567890 poisha, which is inside a float — but the *sum* of a
 *   statement is not, and a schema that accepted a number here would be the one place a
 *   float could get in.
 * - **A credential is write-only.** `credentials` goes in and never comes back: the
 *   account view returns a fingerprint, so an operator can confirm which key is
 *   configured without anyone being shown one (invariant 10).
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A business date is YYYY-MM-DD.');

/**
 * A non-negative poisha amount, bounded.
 *
 * Non-negative because a *collection* never is, and bounded at ৳1 crore to match
 * `MAX_COD_POISHA` in the domain's booking checks. Both halves matter on
 * `POST /v1/courier/parcels/:id/status`: a manually-typed collection debits
 * `courier_receivable` and recognises revenue (D-003) with no maker-checker in front of it, so
 * this schema is the only thing between a typo and a crore of imaginary revenue. A negative
 * value used to reach the database and surface as a CHECK violation rather than a message.
 */
const collectedPoishaString = z
  .string()
  .regex(/^\d+$/, 'A collected amount is non-negative integer poisha as a decimal string.')
  .refine(
    (value) => BigInt(value) <= 1_000_000_000n,
    'That collected amount is above the ceiling; check it before recording it.',
  );

export const providerCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}$/, 'A provider code is lower-case snake_case.');

/**
 * Registering or updating a courier account.
 *
 * `credentials` is a free-form string map because only the adapter knows which fields its
 * courier needs (`credentialFields`), and the service checks the set against the adapter
 * rather than the schema — a fixed shape here would make adding a courier a change to
 * this file. The values are length-bounded because they are about to be encrypted and
 * stored, and an unbounded string is an unbounded `bytea`.
 */
export const upsertCourierAccountSchema = z
  .object({
    /** M10's `sales.couriers` row this account belongs to. */
    courierId: uuid,
    providerCode: providerCodeSchema,
    label: z.string().min(1).max(120),
    mode: z.enum(['sandbox', 'live']).default('sandbox'),
    baseUrl: z.string().url().max(300).optional(),
    credentials: z.record(z.string(), z.string().min(1).max(500)).optional(),
    webhookSecret: z.string().min(16).max(500).optional(),
    pollAfterHours: z.number().int().min(1).max(168).default(6),
    settlementWalletId: uuid.optional(),
    isActive: z.boolean().default(false),
  })
  .strict();

export type UpsertCourierAccountInput = z.infer<typeof upsertCourierAccountSchema>;

/** Booking a parcel from the desk, for an org whose policy is `manual` (§9). */
export const bookParcelSchema = z
  .object({
    orderId: uuid,
    /**
     * Must be the order's own courier when given (M15): the delivery's receivable is booked
     * against the order's courier, so a parcel with another one would split the COD across
     * two couriers. Change the order's courier to change the parcel's.
     */
    courierId: uuid.optional(),
  })
  .strict();

export const consignmentIdParamSchema = uuid;

/** Confirming a rider physically took the parcel (M12's handover bullet). */
export const confirmHandoverSchema = z
  .object({ occurredAt: z.string().datetime().optional(), note: z.string().max(500).optional() })
  .strict();

/**
 * A status a person sets because the courier's sync has not caught up (§9's fallback).
 *
 * `rawStatus` is required alongside the normalized one, because §9 keeps the raw status on
 * every event and a manual entry has one too: the words a warehouse hand typed, which is
 * what an argument about a parcel is settled with.
 */
export const manualStatusSchema = z
  .object({
    status: z.enum([
      'booked',
      'pickup_pending',
      'picked_up',
      'in_transit',
      'out_for_delivery',
      'hold',
      'delivered',
      'partial_delivered',
      'return_in_transit',
      'returned_to_merchant',
      'cancelled',
      'unknown',
    ]),
    rawStatus: z.string().min(1).max(200),
    occurredAt: z.string().datetime().optional(),
    collectedPoisha: collectedPoishaString.optional(),
    reason: z.string().min(1).max(500),
    /** For a partial delivery: what actually arrived. */
    deliveredLines: z
      .array(z.object({ skuId: uuid, deliveredQty: z.number().int().min(0) }).strict())
      .max(200)
      .optional(),
  })
  .strict();

/**
 * Receiving a returned parcel, with the inspection (§7, §8).
 *
 * Per line and not per parcel, because §7 sends sellable and damaged units to different
 * locations: a single `damaged: true` flag would send a whole box to the damaged shelf
 * because one kurti in it was torn, and the write-off that follows needs an approval per
 * §7 — so the quantity matters.
 */
export const receiveReturnSchema = z
  .object({
    /** Where sellable units go back. Defaults to the order's own location. */
    locationId: uuid.optional(),
    /** §7's `damaged` location. Required when anything was damaged. */
    damagedLocationId: uuid.optional(),
    reason: z.string().min(1).max(500),
    /** Why it came back, from the fixed list (M17, D-234). Required on every return. */
    returnReason: z.enum(RETURN_REASON_CODES),
    inspectionNote: z.string().max(1000).optional(),
    occurredAt: z.string().datetime().optional(),
    lines: z
      .array(
        z
          .object({
            skuId: uuid,
            sellableQty: z.number().int().min(0).max(100_000),
            damagedQty: z.number().int().min(0).max(100_000),
          })
          .strict()
          .refine(
            (line) => line.sellableQty + line.damagedQty > 0,
            'A line records at least one unit.',
          ),
      )
      .min(1)
      .max(200),
  })
  .strict();

/**
 * Importing a settlement file.
 *
 * The file arrives as base64 rather than multipart, and that is a considered trade: §22's
 * upload path is presigned-PUT-then-finalize, which is right for a product image and
 * wrong for a 40 KB CSV that has to be parsed synchronously so the operator sees the
 * exceptions on the next screen. `fileObjectId` is optional and is how a file already
 * uploaded through §22 is attached instead, which is the path the console will use for
 * the audit trail.
 *
 * 8 MB decoded, which is a very long statement — the ceiling exists because a base64 body
 * is held in memory while it is parsed.
 */
export const importSettlementSchema = z
  .object({
    courierId: uuid,
    /** The wallet §7's "Dr W" debits. Defaults to the account's configured one. */
    walletId: uuid.optional(),
    fileName: z.string().min(1).max(200),
    fileBase64: z.string().min(1).max(11_000_000),
    /** An already-uploaded `settlement-sheet` object, for the audit trail (§22). */
    fileObjectId: uuid.optional(),
    /** Overrides the date read from the file, when the export carries none. */
    settlementDate: isoDate.optional(),
  })
  .strict();

export const settlementIdParamSchema = uuid;

export const requestSettlementApprovalSchema = z
  .object({ reason: z.string().max(500).optional() })
  .strict();

export const rejectSettlementSchema = z.object({ reason: z.string().min(1).max(500) }).strict();

export const settlementListSchema = z
  .object({
    status: z.enum(['imported', 'pending_approval', 'posted', 'rejected']).optional(),
    courierId: uuid.optional(),
  })
  .strict();

export const reconciliationQuerySchema = z
  .object({ asOf: isoDate.optional(), courierId: uuid.optional() })
  .strict();

export type ManualStatusInput = z.infer<typeof manualStatusSchema>;
export type ReceiveReturnInput = z.infer<typeof receiveReturnSchema>;
export type ImportSettlementInput = z.infer<typeof importSettlementSchema>;

// --- M15 ------------------------------------------------------------------------

const PARCEL_STATUS_VALUES = [
  'booked',
  'pickup_pending',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'hold',
  'delivered',
  'partial_delivered',
  'return_in_transit',
  'returned_to_merchant',
  'cancelled',
  'unknown',
] as const;

/** Booking many orders at once from the desk (M15's bulk booking). */
export const bulkBookSchema = z
  .object({
    orderIds: z.array(uuid).min(1).max(200),
    /** When given, each order must already be set to this courier (see `bookParcelSchema`). */
    courierId: uuid.optional(),
  })
  .strict();

/**
 * A label sheet: one 4 × 6 label per parcel, named by a comma-separated `ids` query value.
 *
 * A `GET`, because rendering a label changes nothing; a hundred uuids is under 4 KB of URL.
 */
export const labelsQuerySchema = z
  .object({
    ids: z
      .string()
      .max(4000)
      .transform((value) =>
        value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      )
      .pipe(z.array(uuid).min(1).max(100)),
  })
  .strict();

/**
 * The parcels list. Query-string values, so every field arrives as a string and the numbers
 * are coerced; `status` is a comma-separated list of §9's normalized statuses.
 */
export const parcelListSchema = z
  .object({
    q: z.string().trim().min(1).max(60).optional(),
    status: z
      .string()
      .max(300)
      .transform((value) =>
        value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(PARCEL_STATUS_VALUES)).max(12))
      .optional(),
    bookingState: z.enum(['pending', 'booked', 'failed', 'cancelled']).optional(),
    courierId: uuid.optional(),
    /** One order's parcels, for the order detail's parcel panel (D-392). */
    orderId: uuid.optional(),
    awaitingReturn: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const stuckQuerySchema = z
  .object({
    thresholdDays: z.coerce.number().int().min(1).max(60).optional(),
    courierId: uuid.optional(),
  })
  .strict();

export const repollSchema = z.object({ consignmentIds: z.array(uuid).min(1).max(100) }).strict();

export const escalationSchema = z.object({ note: z.string().trim().min(1).max(1000) }).strict();

export const performanceQuerySchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional(), courierId: uuid.optional() })
  .strict();

const poishaBound = z
  .string()
  .regex(/^\d+$/, 'A COD bound is non-negative integer poisha as a decimal string.')
  .refine((value) => BigInt(value) <= 1_000_000_000n, 'That COD bound is above the ceiling.');

/**
 * The org's zone → courier rules, replaced as a set.
 *
 * Fifty is far more rules than five brands' zones can use; the ceiling exists because the set
 * is replaced in one transaction with one insert per rule.
 */
export const replaceSelectionRulesSchema = z
  .object({
    rules: z
      .array(
        z
          .object({
            priority: z.number().int().min(0).max(10_000),
            deliveryZoneId: uuid.nullable().optional(),
            minCodPoisha: poishaBound.optional(),
            maxCodPoisha: poishaBound.optional(),
            courierId: uuid,
            isActive: z.boolean().default(true),
            note: z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export const selectionPreviewSchema = z
  .object({ orderId: uuid, courierId: uuid.optional() })
  .strict();

export const fetchSettlementsSchema = z.object({ courierId: uuid }).strict();

/**
 * The public tracking request.
 *
 * Lenient on purpose — Bangla digits, spaces and dashes are all accepted here and normalised
 * by `parseTrackingQuery` — and bounded, because this is the one body in the module a
 * stranger writes. A request that fails *this* schema is refused as malformed (400); one that
 * passes it but names nothing real gets the one negative answer every miss gets.
 */
export const trackingRequestSchema = z
  .object({
    brand: z.string().trim().min(1).max(80),
    orderNo: z.string().trim().min(1).max(60),
    phoneLast4: z.string().trim().min(1).max(20),
  })
  .strict();

export type BulkBookInput = z.infer<typeof bulkBookSchema>;
export type ReplaceSelectionRulesInput = z.infer<typeof replaceSelectionRulesSchema>;
