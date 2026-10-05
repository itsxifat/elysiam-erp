import { z } from 'zod';

/**
 * What the website's server sends when a shopper buys, signs up or pays (M34, D-520 to D-539),
 * and what the console sends for the website's payment and email settings. One schema per
 * request, shared, so the website and the console can never be accepted by one side and
 * refused by the other.
 *
 * Money is integer poisha as a decimal string (§23, D-078). Lines name a SKU by its id or by
 * the old website's variant id (`legacy_ids`, D-505). Quantities follow the old site's limits:
 * at most 20 of a size and 50 lines in one order (D-536).
 */

const poishaString = z
  .string()
  .regex(/^\d{1,16}$/, 'An amount is integer poisha, sent as a decimal string.')
  .refine(
    (value) => !/^\d+$/.test(value) || BigInt(value) <= 9_000_000_000_000_000n,
    'That amount is out of range.',
  );

const uuid = z.string().uuid('No such record.');

export const MAX_CART_LINES = 50;
export const MAX_LINE_QTY = 20;

/** Where the shopper is, as the website's server saw them: for the per-shopper limits (D-534). */
export const shopperClientSchema = z
  .object({
    ip: z
      .string()
      .trim()
      .regex(/^[0-9A-Fa-f:.]{2,64}$/, 'An IP address.'),
    userAgent: z.string().max(400).optional(),
  })
  .strict();

/**
 * The browser's half of a purchase, sent with the checkout so the ERP's own server-side
 * `Purchase` carries Meta's browser ids and GA4's client id (M35b, D-552). Optional.
 */
export const purchaseTrackingSchema = z
  .object({
    fbp: z.string().max(200).optional(),
    fbc: z.string().max(200).optional(),
    eventSourceUrl: z
      .string()
      .max(1000)
      .regex(/^https:\/\/[^\s]+$/, 'An https:// page.')
      .optional(),
    gaClientId: z.string().max(100).optional(),
    gaSessionId: z.string().max(100).optional(),
  })
  .strict();

export type PurchaseTracking = z.infer<typeof purchaseTrackingSchema>;

export const cartLineSchema = z
  .object({
    skuId: uuid.optional(),
    /** The old website's variant id, when the cart was filled before the switch (D-505). */
    variantId: z.string().trim().min(1).max(64).optional(),
    qty: z.number().int().min(1).max(MAX_LINE_QTY),
  })
  .strict()
  .refine((line) => (line.skuId === undefined) !== (line.variantId === undefined), {
    message: 'A line names a SKU id or an old variant id, one of the two.',
  });

const cartLinesSchema = z.array(cartLineSchema).min(1).max(MAX_CART_LINES);

const areaSchema = z
  .object({
    districtId: z.number().int().positive(),
    thanaId: z.number().int().positive(),
  })
  .strict();

const codesSchema = z.array(z.string().trim().min(3).max(40)).max(5);

const phoneInput = z.string().trim().min(6).max(32);

export const cartQuoteSchema = z
  .object({
    lines: cartLinesSchema,
    address: areaSchema.optional(),
    codes: codesSchema.optional(),
    /** The signed-in shopper's account, for per-customer discount limits. */
    accountId: uuid.optional(),
    /** A guest's phone, for the same, once the shopper has typed it. */
    phone: phoneInput.optional(),
  })
  .strict();

export type CartQuoteRequest = z.infer<typeof cartQuoteSchema>;

export const CHECKOUT_PAYMENT_METHODS = ['cod', 'sslcommerz'] as const;
export const SHOPPER_LOCALES = ['bn', 'en'] as const;

export const checkoutSchema = z
  .object({
    lines: cartLinesSchema,
    contact: z
      .object({
        name: z.string().trim().min(1).max(200),
        phone: phoneInput,
        email: z.string().trim().max(254).optional(),
      })
      .strict(),
    address: areaSchema
      .extend({
        area: z.string().trim().max(160).optional(),
        addressLine: z.string().trim().min(3).max(500),
      })
      .strict(),
    codes: codesSchema.optional(),
    accountId: uuid.optional(),
    paymentMethod: z.enum(CHECKOUT_PAYMENT_METHODS),
    notes: z.string().trim().max(1000).optional(),
    locale: z.enum(SHOPPER_LOCALES).optional(),
    /** What the shopper was shown; any moved figure is `409 CART_REPRICED` (D-521). */
    expected: z
      .object({
        totalPoisha: poishaString,
        lines: z
          .array(z.object({ skuId: uuid, unitPricePoisha: poishaString }).strict())
          .max(MAX_CART_LINES)
          .optional(),
      })
      .strict(),
    client: shopperClientSchema.optional(),
    /** M35b: the browser's ids for the server-side `Purchase` (D-552). */
    tracking: purchaseTrackingSchema.optional(),
  })
  .strict();

export type CheckoutRequest = z.infer<typeof checkoutSchema>;

// --- accounts (D-522) ---------------------------------------------------------------------------

const emailInput = z.string().trim().min(3).max(254);
/** Length is the domain's rule (`passwordProblem`); this only bounds the body. */
const passwordInput = z.string().min(1).max(200);

export const registerAccountSchema = z
  .object({
    email: emailInput,
    password: passwordInput,
    name: z.string().trim().min(1).max(120),
    phone: phoneInput.optional(),
    locale: z.enum(SHOPPER_LOCALES).optional(),
    client: shopperClientSchema.optional(),
  })
  .strict();

export const verifyEmailSchema = z
  .object({
    email: emailInput,
    code: z.string().trim().min(6).max(20),
    client: shopperClientSchema.optional(),
  })
  .strict();

export const accountEmailSchema = z
  .object({ email: emailInput, client: shopperClientSchema.optional() })
  .strict();

export const signInSchema = z
  .object({ email: emailInput, password: passwordInput, client: shopperClientSchema.optional() })
  .strict();

/**
 * A Google sign-in the website already verified (D-522): the website checked the ID token's
 * signature, audience and expiry with Google, and passes what it says. The ERP links or creates
 * an account only for an address Google says is verified.
 */
export const googleSignInSchema = z
  .object({
    email: emailInput,
    emailVerified: z.literal(true),
    /** Google's stable account id (`sub`). */
    googleSub: z.string().trim().min(1).max(255),
    name: z.string().trim().max(120).optional(),
    locale: z.enum(SHOPPER_LOCALES).optional(),
    client: shopperClientSchema.optional(),
  })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'That reset link is not valid.'),
    password: passwordInput,
    client: shopperClientSchema.optional(),
  })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: passwordInput, newPassword: passwordInput })
  .strict();

export const savedAddressSchema = z
  .object({
    id: uuid.optional(),
    label: z.string().trim().max(40).optional(),
    name: z.string().trim().min(1).max(200),
    phone: phoneInput,
    districtId: z.number().int().positive(),
    thanaId: z.number().int().positive(),
    area: z.string().trim().max(160).optional(),
    addressLine: z.string().trim().min(3).max(500),
    isDefault: z.boolean().optional(),
  })
  .strict();

export type SavedAddressInput = z.infer<typeof savedAddressSchema>;

export const updateAccountSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    /** Null clears it. */
    phone: phoneInput.nullable().optional(),
    locale: z.enum(SHOPPER_LOCALES).optional(),
    /** The whole list, replacing the saved one. */
    addresses: z.array(savedAddressSchema).max(10).optional(),
  })
  .strict();

// --- payments (D-525) ---------------------------------------------------------------------------

export const orderNoSchema = z.string().regex(/^[A-Z0-9-]{3,40}$/, 'No such order.');

/** A one-time order view token, as the checkout returned it. */
export const viewTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'No such order.');

export const paymentInitSchema = z
  .object({
    orderNo: orderNoSchema,
    /** A guest's order view token, or the signed-in account that placed the order. */
    token: viewTokenSchema.optional(),
    accountId: uuid.optional(),
  })
  .strict()
  .refine((value) => value.token !== undefined || value.accountId !== undefined, {
    message: 'Name the order with its view token or its account.',
  });

/** SSLCommerz's return to the website, relayed by the website's server. Untrusted: re-checked. */
export const paymentReturnSchema = z
  .object({
    kind: z.enum(['success', 'fail', 'cancel']),
    tranId: z.string().trim().min(6).max(40),
    valId: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

// --- the console's settings (D-528, D-529) --------------------------------------------------------

export const SSLCOMMERZ_MODES = ['sandbox', 'live'] as const;

export const sslcommerzSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(SSLCOMMERZ_MODES),
    storeId: z.string().trim().min(1).max(30),
    /** Write-only. Left out, the stored password stays. */
    storePassword: z.string().min(1).max(100).optional(),
  })
  .strict();

export type SslcommerzSettingsInput = z.infer<typeof sslcommerzSettingsSchema>;

export const emailSettingsSchema = z
  .object({
    enabled: z.boolean(),
    host: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(/^[A-Za-z0-9.-]+$/, 'A host name.'),
    port: z.number().int().min(1).max(65_535),
    /** TLS from the first byte (port 465); otherwise STARTTLS is required. */
    secure: z.boolean(),
    username: z.string().trim().max(254),
    /** Write-only. Left out, the stored password stays. */
    password: z.string().min(1).max(200).optional(),
    fromName: z.string().trim().min(1).max(120),
    fromEmail: z.string().trim().min(3).max(254),
  })
  .strict();

export type EmailSettingsInput = z.infer<typeof emailSettingsSchema>;

export const testEmailSchema = z.object({ to: z.string().trim().min(3).max(254) }).strict();
