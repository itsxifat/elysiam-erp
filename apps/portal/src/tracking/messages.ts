import { messages, type Locale, type MessageKey } from '@elysium/i18n';

/**
 * The public tracking page's strings (M15).
 *
 * **Bangla first.** The page is customer-facing, and D-036 makes everything a customer reads
 * Bangla by default; English is a toggle. The strings live in `packages/i18n/src/locales/{bn,en}.ts`, where a key present
 * on one side only does not compile; this file keeps the key list, so the tracking page
 * cannot reach for a console string.
 *
 * One sentence matters more than the rest: `notFound`. It is the page's only negative
 * answer, shown alike for a wrong number, wrong digits, an unknown brand and an order not yet
 * with a courier, because the server answers all of them with the same bytes. So it says what
 * to check without saying which of those it was.
 */
const TRACKING_KEYS = [
  'tracking.title',
  'tracking.subtitle',
  'tracking.orderNo',
  'tracking.orderNoHint',
  'tracking.phoneLast4',
  'tracking.phoneLast4Hint',
  'tracking.submit',
  'tracking.checking',
  'tracking.notFound',
  'tracking.rateLimited',
  'tracking.networkError',
  'tracking.invalid',
  'tracking.noBrand',
  'tracking.resultHeading',
  'tracking.stage.received',
  'tracking.stage.processing',
  'tracking.stage.with_courier',
  'tracking.stage.out_for_delivery',
  'tracking.stage.delivered',
  'tracking.stage.returned',
  'tracking.stage.cancelled',
  'tracking.courier',
  'tracking.trackingCode',
  'tracking.cod',
  'tracking.lastUpdate',
  'tracking.again',
  'tracking.language',
  'tracking.languageLabel',
  'tracking.themeLight',
  'tracking.themeDark',
] as const satisfies readonly MessageKey[];

export type TrackingMessageKey = (typeof TRACKING_KEYS)[number];

function pick(locale: Locale): Record<TrackingMessageKey, string> {
  return Object.fromEntries(TRACKING_KEYS.map((key) => [key, messages[locale][key]])) as Record<
    TrackingMessageKey,
    string
  >;
}

/**
 * The page's two catalogues. Both ship: a customer switches language on this page, and
 * it is small enough that loading one on demand would cost more than it saves.
 */
export const trackingEn = pick('en');
export const trackingBn = pick('bn');

export function trackingText(locale: Locale, key: TrackingMessageKey): string {
  return messages[locale][key];
}
