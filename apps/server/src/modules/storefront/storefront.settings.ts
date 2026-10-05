import {
  announcementSchema,
  paymentMethodsSchema,
  promoBannerSchema,
  shippingRuleSchema,
  siteInfoSchema,
  socialLinksSchema,
  testimonialsSchema,
  type Announcement,
  type PaymentMethods,
  type PromoBanner,
  type ShippingRuleInput,
  type SiteInfo,
  type SocialLinks,
  type Testimonial,
} from '@elysium/contracts';
import type { z } from 'zod';

import type { DeliveryZoneSummary } from '../orders/orders.api.js';
import type { SettingsRow } from './storefront.repository.js';

/**
 * The website's settings as one object, and the defaults a brand starts from (M33, D-503).
 *
 * Read defensively: each section stored in `storefront.settings` is parsed with its own
 * contract schema, and a section that does not parse (a hand-edited row, a schema that
 * tightened since) falls back to its default rather than failing the whole website. The
 * defaults name nothing but the brand itself: the site's name is the brand's own name from
 * `org.organizations` (white label, D-472), and every text is empty until somebody writes it.
 */

export interface StorefrontSettings {
  readonly siteInfo: SiteInfo;
  readonly social: SocialLinks;
  readonly announcement: Announcement;
  readonly promoBanner: PromoBanner;
  readonly testimonials: readonly Testimonial[];
  readonly shipping: ShippingRuleInput;
  readonly payments: PaymentMethods;
  readonly webLocationIds: readonly string[];
}

/** How the old site's three zones map onto the ERP's seeded zone codes by default. */
const DEFAULT_ZONE_CODES: Readonly<Record<'inside_dhaka' | 'suburbs' | 'outside_dhaka', string>> = {
  inside_dhaka: 'inside_dhaka',
  suburbs: 'dhaka_suburbs',
  outside_dhaka: 'outside_dhaka',
};

export function defaultShipping(zones: readonly DeliveryZoneSummary[]): ShippingRuleInput {
  const zone = (key: keyof typeof DEFAULT_ZONE_CODES) => {
    const found = zones.find((candidate) => candidate.code === DEFAULT_ZONE_CODES[key]);
    return {
      feePoisha: (found?.chargePoisha ?? 0n).toString(),
      deliveryZoneIds: found === undefined ? [] : [found.id],
    };
  };
  return {
    freeShippingEnabled: false,
    freeShippingThresholdPoisha: null,
    zones: {
      inside_dhaka: zone('inside_dhaka'),
      suburbs: zone('suburbs'),
      outside_dhaka: zone('outside_dhaka'),
    },
  };
}

export function defaultSettings(input: {
  readonly siteName: string;
  readonly zones: readonly DeliveryZoneSummary[];
  readonly defaultLocationId: string | null;
}): StorefrontSettings {
  return {
    siteInfo: {
      siteName: input.siteName.slice(0, 120) || 'Shop',
      logoFileId: null,
      merchantId: '',
      whatsapp: '',
      phone: '',
      email: '',
      address: '',
      siteUrl: '',
    },
    social: { facebook: '', instagram: '', tiktok: '', youtube: '' },
    announcement: { enabled: false, text: '', link: '' },
    promoBanner: {
      enabled: false,
      headline: '',
      subtext: '',
      note: '',
      decorativeText: '',
      primaryLabel: '',
      primaryHref: '',
      secondaryLabel: '',
      secondaryHref: '',
    },
    testimonials: [],
    shipping: defaultShipping(input.zones),
    payments: { cod: true, sslcommerz: false },
    webLocationIds: input.defaultLocationId === null ? [] : [input.defaultLocationId],
  };
}

function section<T extends z.ZodType>(
  schema: T,
  stored: unknown,
  fallback: z.infer<T>,
): z.infer<T> {
  const parsed = schema.safeParse(stored);
  return parsed.success ? parsed.data : fallback;
}

/** The stored row over the defaults, section by section. */
export function settingsFromRow(
  row: SettingsRow | undefined,
  defaults: StorefrontSettings,
  webLocationIds: readonly string[],
): StorefrontSettings {
  if (row === undefined) {
    return {
      ...defaults,
      webLocationIds: webLocationIds.length > 0 ? webLocationIds : defaults.webLocationIds,
    };
  }
  const info = (row.site_info ?? {}) as Record<string, unknown>;
  return {
    siteInfo: section(
      siteInfoSchema,
      { ...defaults.siteInfo, ...info, siteName: row.site_name, logoFileId: row.logo_file_id },
      { ...defaults.siteInfo, siteName: row.site_name, logoFileId: row.logo_file_id },
    ),
    social: section(socialLinksSchema, row.social, defaults.social),
    announcement: section(announcementSchema, row.announcement, defaults.announcement),
    promoBanner: section(promoBannerSchema, row.promo_banner, defaults.promoBanner),
    testimonials: section(testimonialsSchema, row.testimonials, [...defaults.testimonials]),
    shipping: section(shippingRuleSchema, row.shipping, defaults.shipping),
    payments: section(paymentMethodsSchema, row.payments, defaults.payments),
    webLocationIds: webLocationIds.length > 0 ? webLocationIds : defaults.webLocationIds,
  };
}
