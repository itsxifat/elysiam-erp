import { businessDateSchema, positivePoishaSchema } from '@elysium/contracts';
import { z } from 'zod';

/**
 * What the supply endpoints accept (architecture §7, §23; validate at the edge).
 *
 * These belong in `packages/contracts` by convention, and M04's generator turns that
 * package into the typed OpenAPI client. They live here for the same reason
 * `wallets.schemas.ts` does: `packages/contracts/src/index.ts` is edited concurrently by
 * other agents this session, and a second write to a barrel silently discards the first.
 * This milestone's INTEGRATION section hands the integrator the move; it is a file rename
 * and a re-export.
 *
 * ## Money crosses the wire as a decimal string
 *
 * §23, and it is not a style preference: `JSON.parse` turns a crore-scale poisha amount
 * into a double and drops its last digits, and the result still looks like money.
 * `positivePoishaSchema` from @elysium/contracts is the shared helper, and every amount
 * here goes through it or through `costPoishaSchema` below.
 *
 * ## The draft body has no cost field, and that is D-005
 *
 * `supplyDraftSchema` and `updateSupplyDraftSchema` carry quantities only. The warehouse
 * counts cartons and accounts prices them, so there is nothing for a warehouse role to
 * send even if one tried — which matters because §6 grants warehouse `create` and
 * `update` on Supply, so the ability check alone cannot express "not the prices". The
 * cost-bearing routes declare `read Cost` instead (D-122) and their services check it
 * again.
 *
 * ## What is deliberately not in any of these shapes
 *
 * * **No entry total.** An entry's value is Σ qty × unit cost over its lines, computed
 *   by the posting rule. A total sent alongside lines is a second number that can
 *   disagree with them, and the disagreement would land in inventory while the supplier
 *   was credited the other figure.
 * * **No supplier balance, and no expected balance anywhere.** Both are derived from
 *   `ledger.journal_lines`. A client-supplied balance is a way to make a discrepancy
 *   disappear by sending the number that makes it zero.
 * * **No `journalId`, `status` or `branchId` on any request.** The journal is posted by
 *   the service, the status is the state machine's, and the branch is derived from the
 *   location or the wallet by migration 0037 — a client-supplied branch would be a
 *   second copy of a fact the trigger owns.
 */

/** The id in `/v1/supply/:id/...`. A malformed one is a 400, not a 500. */
export const idParamSchema = z.string().uuid('No such record.');

/**
 * A purchase cost, which may be zero.
 *
 * Free stock is real — samples, a replacement against a bad lot — and it arrives on the
 * same challan as the paid lines, so refusing a zero would push the whole delivery
 * through a stock adjustment where it would read as a count error rather than a receipt.
 * `supply_lines_cost_not_negative` and `supply_return_lines_cost_not_negative` allow the
 * same thing, and the posting rules refuse an entry whose **total** is nothing.
 *
 * A near-copy of `nonNegativePoishaSchema` in `wallets.schemas.ts`, for the same reason
 * both files are here rather than in contracts. The INTEGRATION section asks for one
 * shared copy.
 */
const costPoishaSchema = z
  .string()
  .max(16, 'Amounts are integer poisha, sent as a decimal string.')
  .regex(/^(0|[1-9]\d*)$/, 'A unit cost is non-negative integer poisha, as a decimal string.')
  // Guarded: Zod runs every check, and `BigInt` would throw on what the regex refused.
  .refine(
    (value) => !/^\d+$/.test(value) || BigInt(value) <= 9_000_000_000_000_000n,
    'That amount is out of range.',
  );

/** Whole units, always a positive magnitude. The direction comes from the endpoint. */
const qtySchema = z
  .number()
  .int('Quantities are whole units.')
  .positive('A quantity must be positive.')
  .max(1_000_000, 'That quantity is larger than any real delivery.');

/**
 * When the goods moved, or the money left.
 *
 * Optional everywhere: left out, the server uses now. It exists because a challan is
 * often entered the next morning, and the business date — and therefore which month's
 * books the journal lands in — is the Asia/Dhaka date of *this* instant, not of the
 * keystroke (invariant 8).
 */
const occurredAtSchema = z.string().datetime();

/** A single line of the draft flow: what arrived, and how many. No price (D-005). */
const draftLineSchema = z.object({ skuId: idParamSchema, qty: qtySchema }).strict();

const draftLinesSchema = z
  .array(draftLineSchema)
  .min(1, 'A supply entry needs at least one line.')
  .max(500);

// --- suppliers ----------------------------------------------------------------

export const supplierListSchema = z
  .object({
    /** Matches a supplier's name, or its code and phone joined (migration 0038). */
    q: z.string().trim().min(1).max(80).optional(),
    includeInactive: z.coerce.boolean().default(false),
    /**
     * The business date the due and advance balances are computed as of.
     *
     * Defaults to today in the service rather than here, because "today" is an
     * Asia/Dhaka date and this file does not own the calendar.
     */
    asOf: businessDateSchema.optional(),
  })
  .strict();
export type SupplierListQuery = z.infer<typeof supplierListSchema>;

export const createSupplierSchema = z
  .object({
    /**
     * Upper-case, digits and dashes, matching `suppliers_code_shape`.
     *
     * Shaped rather than free text because this is what the purchasing team types into
     * the picker and reads off a challan: a code with a space or a lower-case letter in
     * it is a code somebody will fail to find again.
     */
    code: z
      .string()
      .trim()
      .regex(/^[0-9A-Z][0-9A-Z-]{0,23}$/, 'A supplier code is digits, capitals and dashes.'),
    name: z.string().trim().min(1).max(160),
    phone: z.string().trim().min(1).max(32).optional(),
    email: z.string().trim().email('That is not an email address.').max(160).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    /** Net terms in days. Bounded by `suppliers_terms_range`; nothing computes from it yet. */
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
  })
  .strict();
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

/**
 * Change a supplier, or deactivate one.
 *
 * `code` is absent on purpose. It is printed on paperwork and quoted in emails, and
 * renaming it would silently change what every past entry appears to have been bought
 * from. There is no delete either (migration 0036 grants none): a supplier the brand
 * once bought from is part of the record, and `isActive: false` is how one stops being
 * used.
 *
 * The nullable fields are nullable rather than merely optional because clearing a phone
 * number and not mentioning it are different requests, and the repository distinguishes
 * them.
 */
export const updateSupplierSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    phone: z.string().trim().min(1).max(32).nullable().optional(),
    email: z.string().trim().email('That is not an email address.').max(160).nullable().optional(),
    address: z.string().trim().min(1).max(500).nullable().optional(),
    paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

export const supplierContactSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1).max(80).optional(),
    phone: z.string().trim().min(1).max(32).optional(),
    email: z.string().trim().email('That is not an email address.').max(160).optional(),
    /** The repository demotes the others in the same transaction, so there is only ever one. */
    isPrimary: z.boolean().default(false),
  })
  .strict();
export type SupplierContactInput = z.infer<typeof supplierContactSchema>;

export const supplierNoteSchema = z
  .object({ body: z.string().trim().min(1, 'A note needs something in it.').max(2000) })
  .strict();
export type SupplierNoteInput = z.infer<typeof supplierNoteSchema>;

/**
 * Attach an already-uploaded file to a supplier.
 *
 * The id only. Whether that object is a stored, **private** `supply-document` is checked
 * in the service against `files.objects`, because the purpose is what decides who may
 * download the bytes (§22) and a client that could assert it would choose the purpose
 * that makes its quotation readable by everyone with `read Catalog`.
 */
export const supplierDocumentSchema = z
  .object({ fileObjectId: idParamSchema, label: z.string().trim().min(1).max(160) })
  .strict();
export type SupplierDocumentInput = z.infer<typeof supplierDocumentSchema>;

/**
 * The supplier statement's range (M09 check 2).
 *
 * `to` is required: a statement is a document with an as-of date on it, and defaulting
 * it would make two people comparing the same statement disagree about which one they
 * have. `from` is optional and means "since the beginning", which is the opening balance
 * of zero.
 */
export const statementQuerySchema = z
  .object({ from: businessDateSchema.optional(), to: businessDateSchema })
  .strict()
  .refine(
    (value) => value.from === undefined || value.from <= value.to,
    'The statement starts before it ends.',
  );
export type StatementQuery = z.infer<typeof statementQuerySchema>;

// --- supply entries -----------------------------------------------------------

/** The list filters, and — through `.pick()` in the controller — the returns list's too. */
export const supplyListSchema = z
  .object({
    supplierId: idParamSchema.optional(),
    status: z.enum(['draft', 'received']).optional(),
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  })
  .strict();
export type SupplyListQuery = z.infer<typeof supplyListSchema>;

/**
 * A qty-only receipt draft from the warehouse (D-005).
 *
 * `draftId` is generated by the client, once per draft, and it is what makes a
 * double-tapped Save on a phone in a warehouse create one draft rather than two. It is
 * the row's primary key, so the second call finds the first's row instead of inserting.
 */
export const supplyDraftSchema = z
  .object({
    draftId: z.string().uuid(),
    supplierId: idParamSchema,
    locationId: idParamSchema,
    invoiceNumber: z.string().trim().min(1).max(64).optional(),
    lines: draftLinesSchema,
  })
  .strict();
export type SupplyDraftInput = z.infer<typeof supplyDraftSchema>;

/**
 * Correct a draft before it is priced.
 *
 * `lines` replaces the whole set rather than patching one. A draft is a working document
 * whose lines have no identity worth preserving, and a diff would have to decide what a
 * missing line means — which is the kind of guess that silently keeps a quantity nobody
 * counted.
 */
export const updateSupplyDraftSchema = z
  .object({
    /** Null clears the number; absent leaves it alone. The two are different requests. */
    invoiceNumber: z.string().trim().min(1).max(64).nullable().optional(),
    locationId: idParamSchema.optional(),
    lines: draftLinesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change.');
export type UpdateSupplyDraftInput = z.infer<typeof updateSupplyDraftSchema>;

/**
 * Price a draft and receive it: this is where purchase cost enters the system
 * (invariant 5).
 *
 * Every line of the draft must appear here, and no line that is not on it. The service
 * checks both and names the SKU it is missing a price for, because the alternative is the
 * database refusing a null cost after the movements have been attempted — a 500-shaped
 * answer to "you missed a line".
 *
 * `qty` is optional per line: the drafted quantity stands unless the person pricing the
 * entry corrects it against the invoice, which is the ordinary case of a short delivery
 * noticed by accounts rather than by the warehouse.
 */
export const receiveSupplySchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            skuId: idParamSchema,
            qty: qtySchema.optional(),
            unitCostPoisha: costPoishaSchema,
          })
          .strict(),
      )
      .min(1, 'A receipt prices at least one line.')
      .max(500),
    invoiceNumber: z.string().trim().min(1).max(64).optional(),
    occurredAt: occurredAtSchema.optional(),
    /** The scanned challan. Checked against `files.objects` in the service, like a document. */
    attachmentFileId: idParamSchema.optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();
export type ReceiveSupplyInput = z.infer<typeof receiveSupplySchema>;

/**
 * Entered and priced in one call, the way accounts works from a paper invoice.
 *
 * `supplyId` is the client's, for the same reason `draftId` is: this call writes the
 * draft and then receives it, and a retry has to land on the receive path rather than on
 * a duplicate-key error from the insert.
 */
export const createSupplySchema = z
  .object({
    supplyId: z.string().uuid(),
    supplierId: idParamSchema,
    locationId: idParamSchema,
    invoiceNumber: z.string().trim().min(1).max(64).optional(),
    occurredAt: occurredAtSchema.optional(),
    attachmentFileId: idParamSchema.optional(),
    memo: z.string().trim().max(500).optional(),
    lines: z
      .array(
        z
          .object({ skuId: idParamSchema, qty: qtySchema, unitCostPoisha: costPoishaSchema })
          .strict(),
      )
      .min(1, 'A supply entry needs at least one line.')
      .max(500),
  })
  .strict();
export type CreateSupplyInput = z.infer<typeof createSupplySchema>;

// --- returns ------------------------------------------------------------------

/**
 * Stock going back to a supplier (§8's worked example; M09 check 3).
 *
 * `originalUnitCostPoisha` is what the supplier charged, and it is the **only** cost in
 * this body. What inventory is relieved at is the weighted average, captured by M07
 * under the cost row's lock as the movement is written — reading it here, or accepting it
 * from a client, would let the purchase price variance become a number anybody can steer.
 *
 * `supplyId` is optional because a return is not always traceable to one delivery: a
 * shade problem found across two lots is one credit note.
 */
export const supplyReturnSchema = z
  .object({
    returnId: z.string().uuid(),
    supplierId: idParamSchema,
    supplyId: idParamSchema.optional(),
    locationId: idParamSchema,
    occurredAt: occurredAtSchema.optional(),
    reason: z.string().trim().min(1, 'Say why the goods are going back.').max(500),
    lines: z
      .array(
        z
          .object({
            skuId: idParamSchema,
            qty: qtySchema,
            originalUnitCostPoisha: costPoishaSchema,
          })
          .strict(),
      )
      .min(1, 'A return needs at least one line.')
      .max(500),
  })
  .strict();
export type SupplyReturnInput = z.infer<typeof supplyReturnSchema>;

// --- payments and advances ----------------------------------------------------

export const paymentListSchema = z
  .object({
    supplierId: idParamSchema.optional(),
    kind: z.enum(['advance', 'payment']).optional(),
    status: z.enum(['pending_approval', 'posted', 'rejected']).optional(),
    from: businessDateSchema.optional(),
    to: businessDateSchema.optional(),
  })
  .strict();
export type PaymentListQuery = z.infer<typeof paymentListSchema>;

/**
 * Pay a supplier, or pay one in advance (§7: `Dr Supplier payable / Cr W` and
 * `Dr Supplier advance / Cr W`).
 *
 * `paymentId` is the client's and becomes the posting rule's idempotency key, so a
 * double-clicked Save posts one journal rather than two. The service refuses a replay of
 * the same id with a different amount (`IDEMPOTENCY_CONFLICT`) instead of quietly
 * answering from the first row: the second amount is what somebody meant to pay.
 *
 * `walletAccountId` is a `ledger.accounts` id whose subtype must be a `wallet_*` —
 * checked by the service, and again by migration 0037 on the row, because crediting
 * anything else would balance the journal and misstate where the money came from.
 *
 * No `status` and no `approvalRequestId`. Whether this waits for a checker is the org's
 * threshold and §6's business, and a request that could name its own approval could name
 * somebody else's.
 */
export const supplierPaymentSchema = z
  .object({
    paymentId: z.string().uuid(),
    supplierId: idParamSchema,
    walletAccountId: idParamSchema,
    kind: z.enum(['advance', 'payment']),
    amountPoisha: positivePoishaSchema,
    occurredAt: occurredAtSchema.optional(),
    memo: z.string().trim().max(500).optional(),
  })
  .strict();
export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;

/**
 * Set a posted advance against a received supply (§7: `Dr Supplier payable / Cr Supplier
 * advance`).
 *
 * Separate from the receipt, and the separation is the point: a receipt credits the
 * payable for what the invoice says, whatever was paid ahead, and this cancels the two
 * balances afterwards. Netting inside the receipt would post a payable that does not
 * match the supplier's own invoice, and the first reconciliation against their statement
 * would be unexplainable.
 *
 * The amount is the client's, but how much of the advance is left is not: the service
 * locks the payment row, sums what is already applied and refuses the excess — and
 * migration 0037 does it again, because an over-application would leave
 * `supplier_advance` credit-balanced, which is an asset account holding a negative asset.
 */
export const applyAdvanceSchema = z
  .object({
    applicationId: z.string().uuid(),
    paymentId: idParamSchema,
    supplyId: idParamSchema,
    amountPoisha: positivePoishaSchema,
  })
  .strict();
export type ApplyAdvanceInput = z.infer<typeof applyAdvanceSchema>;
