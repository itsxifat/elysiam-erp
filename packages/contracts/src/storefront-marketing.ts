import { z } from 'zod';

import { isSiteLink } from './storefront.js';
import { shopperClientSchema } from './storefront-buying.js';

/**
 * The rest of the old admin panel, moved into the ERP (M35b, D-550 to D-559): campaign links,
 * the website's tracking, the ncom.bd marketplace connector, the packing scanner and the
 * order labels. One schema per request, shared by the console and the server.
 *
 * Secrets are write-only everywhere here: leaving a secret out keeps the stored one, `null`
 * removes it, and a string replaces it. No answer ever carries one back.
 */

const uuid = z.string().uuid('No such record.');
const text = (max: number) => z.string().trim().max(max);
const flag = z.boolean();

/** A path on the website only (`/shop?category=men`): never an outside address. */
const sitePath = z
  .string()
  .max(300)
  .refine(
    (value) => value.startsWith('/') && isSiteLink(value),
    'A path on the website, starting with /.',
  );
const optionalSiteLink = z.union([
  z.literal(''),
  z
    .string()
    .max(500)
    .refine(isSiteLink, 'A link is a path on the site (starting with /) or an https:// address.'),
]);
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour as #RRGGBB.');

// --- campaign links (D-551) -----------------------------------------------------------------

export const CAMPAIGN_LINK_BASES = ['category', 'shop', 'custom'] as const;
export type CampaignLinkBase = (typeof CAMPAIGN_LINK_BASES)[number];
export const MAX_HIGHLIGHTED_PRODUCTS = 24;

export const campaignLinkBannerSchema = z
  .object({
    enabled: flag,
    text: text(200),
    bgColor: hexColour,
    textColor: hexColour,
    link: optionalSiteLink,
  })
  .strict();

export const campaignLinkModalSchema = z
  .object({
    enabled: flag,
    type: z.enum(['text', 'image']),
    title: text(120),
    text: text(1000),
    /** A public campaign image (`campaign-asset`), for an image pop-up. */
    imageFileId: uuid.nullable(),
    ctaText: text(60),
    ctaLink: optionalSiteLink,
  })
  .strict();

export const campaignLinkSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    baseType: z.enum(CAMPAIGN_LINK_BASES),
    categoryId: uuid.nullable(),
    customPath: z.union([z.literal(''), sitePath]),
    highlightProductIds: z.array(uuid).max(MAX_HIGHLIGHTED_PRODUCTS),
    banner: campaignLinkBannerSchema,
    modal: campaignLinkModalSchema,
    isActive: flag,
  })
  .strict()
  .refine((link) => link.baseType !== 'category' || link.categoryId !== null, {
    message: 'A category link names its category.',
    path: ['categoryId'],
  })
  .refine((link) => link.baseType !== 'custom' || link.customPath !== '', {
    message: 'A custom link names its path.',
    path: ['customPath'],
  })
  .refine(
    (link) => !link.modal.enabled || link.modal.type !== 'image' || link.modal.imageFileId !== null,
    {
      message: 'An image pop-up needs its image.',
      path: ['modal', 'imageFileId'],
    },
  );

export type CampaignLinkInput = z.infer<typeof campaignLinkSchema>;

// --- tracking (D-552) -----------------------------------------------------------------------

export const TRACKING_ACTION_SOURCES = [
  'website',
  'app',
  'email',
  'phone_call',
  'chat',
  'physical_store',
  'system_generated',
  'other',
] as const;

const eventName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'An event name: letters, digits and underscores.');

export const trackingEventRouteSchema = z
  .object({
    name: eventName,
    enabled: flag,
    client: flag,
    server: flag,
    meta: flag,
    ga4: flag,
  })
  .strict();

/** A write-only secret: left out keeps it, null removes it, a string replaces it. */
const secret = (min: number, max: number) =>
  z.union([z.null(), z.string().trim().min(min).max(max)]).optional();

const digits = (max: number) =>
  z.union([z.literal(''), z.string().regex(new RegExp(`^\\d{1,${String(max)}}$`), 'Digits only.')]);

export const trackingSettingsSchema = z
  .object({
    meta: z
      .object({
        pixelEnabled: flag,
        capiEnabled: flag,
        pixelId: digits(24),
        /** Defaults to the pixel. */
        datasetId: digits(24),
        apiVersion: z.string().regex(/^v\d{1,3}\.\d$/, 'A Graph API version, like v21.0.'),
        accessToken: secret(20, 600),
        testEventCode: z.union([z.literal(''), z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)]),
        defaultCountryCode: z.string().regex(/^\d{1,4}$/),
      })
      .strict(),
    ga4: z
      .object({
        clientEnabled: flag,
        mpEnabled: flag,
        measurementId: z.union([z.literal(''), z.string().regex(/^G-[A-Z0-9]{4,20}$/)]),
        apiSecret: secret(8, 120),
      })
      .strict(),
    /** The website's first-party paths for the pixel and gtag (its nginx proxies them). */
    proxy: z
      .object({
        metaScriptPath: sitePath,
        metaCollectPath: sitePath,
        ga4ScriptPath: sitePath,
        ga4CollectPath: sitePath,
      })
      .strict(),
    testMode: flag,
    events: z.array(trackingEventRouteSchema).max(40),
    logRetentionDays: z.number().int().min(1).max(365),
  })
  .strict()
  .refine(
    (settings) =>
      new Set(settings.events.map((event) => event.name)).size === settings.events.length,
    { message: 'Each event is listed once.', path: ['events'] },
  );

export type TrackingSettingsInput = z.infer<typeof trackingSettingsSchema>;

const userText = z.string().max(200).optional();

/** One browser event the website forwards, with the event id the pixel fired it under. */
export const trackingEventSchema = z
  .object({
    eventName,
    eventId: z
      .string()
      .regex(/^[!-~]{1,100}$/, 'An event id: printable characters, no spaces.')
      .optional(),
    /** Unix seconds; at most seven days old (Meta's rule) and never in the future. */
    eventTime: z.number().int().positive().optional(),
    eventSourceUrl: z
      .string()
      .max(1000)
      .refine((value) => value.startsWith('https://') && isSiteLink(value), 'An https:// page.')
      .optional(),
    actionSource: z.enum(TRACKING_ACTION_SOURCES).optional(),
    userData: z
      .object({
        email: userText,
        phone: userText,
        firstName: userText,
        lastName: userText,
        city: userText,
        state: userText,
        zip: userText,
        country: userText,
        externalId: userText,
        fbp: userText,
        fbc: userText,
      })
      .strict()
      .optional(),
    /** Bounded by the domain's `boundedCustomData` before it is kept or sent. */
    customData: z.record(z.string(), z.unknown()).optional(),
    ga4: z
      .object({
        clientId: z.string().max(100).optional(),
        sessionId: z.string().max(100).optional(),
        userId: z.string().max(100).optional(),
        params: z
          .record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()]))
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const trackingEventsSchema = z
  .object({
    events: z.array(trackingEventSchema).min(1).max(20),
    client: shopperClientSchema.optional(),
  })
  .strict();

export type TrackingEventsRequest = z.infer<typeof trackingEventsSchema>;

// --- the ncom.bd marketplace (D-553) --------------------------------------------------------

const httpsUrl = z
  .string()
  .max(300)
  .refine((value) => value.startsWith('https://') && isSiteLink(value), 'An https:// address.');

export const marketplaceSettingsSchema = z
  .object({
    /** ncom may read the catalogue (the connector). */
    enabled: flag,
    /** ncom may hand orders over (order intake). */
    acceptOrders: flag,
    /** Drafts (active, not shown on the website) appear in ncom's dashboard, never sellable. */
    includeDrafts: flag,
    allowSearch: flag,
    allowCategories: flag,
    /** Holds through `/reserve` and `/release`: one switch, a hold that cannot be returned is worse. */
    allowReserve: flag,
    defaultWeightGrams: z.number().int().min(0).max(100_000),
    /** Where ncom's pages link products to; empty is the website's own address. */
    publicBaseUrl: z.union([z.literal(''), httpsUrl]),
    /** ncom's REST base, for the outbox's callback. */
    baseUrl: httpsUrl,
    connectorKeyId: text(120),
    orderKeyId: text(120),
    connectorSecret: secret(8, 300),
    orderSecret: secret(8, 300),
    apiKey: secret(8, 300),
    webhookSecret: secret(8, 300),
  })
  .strict();

export type MarketplaceSettingsInput = z.infer<typeof marketplaceSettingsSchema>;

// --- the packing scanner (D-554) ------------------------------------------------------------

export const scannerSignInSchema = z
  .object({
    email: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(200),
    /** The authenticator's six digits, for an account with two-step sign-in on. */
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'The six digits from the authenticator app.')
      .optional(),
    deviceName: text(80).optional(),
  })
  .strict();

export type ScannerSignIn = z.infer<typeof scannerSignInSchema>;

export const scannerPairSchema = z.object({ deviceName: text(80).optional() }).strict();

export const shipmentCodeSchema = z.string().trim().min(1).max(120);

// --- order labels (D-555) -------------------------------------------------------------------

/** The old label sheet's papers: exact sizes, one label per page. */
export const ORDER_LABEL_SIZES = [
  'a4',
  'a5',
  'a6',
  '2x3',
  '3x2',
  '4x6',
  '100x150',
  '80mm',
] as const;
export type OrderLabelSize = (typeof ORDER_LABEL_SIZES)[number];
export const MAX_ORDER_LABELS = 200;

export const orderLabelsSchema = z
  .object({
    orderIds: z.array(uuid).min(1).max(MAX_ORDER_LABELS),
    size: z.enum(ORDER_LABEL_SIZES),
    /** Small thermal labels only: the recipient on the left, the codes on the right. */
    layout: z.enum(['portrait', 'landscape']).default('portrait'),
    showShopName: flag.default(true),
    showQr: flag.default(true),
    showPrices: flag.default(true),
    showCod: flag.default(true),
  })
  .strict();

export type OrderLabelsInput = z.infer<typeof orderLabelsSchema>;
