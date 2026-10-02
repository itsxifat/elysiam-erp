import type { MessageKey } from '@elysium/i18n';

import { sectionCatalogue } from '../../i18n/messages.js';
import { useLocale } from '../../i18n/locale.js';

/**
 * The strings the buyer list, the buyer profile and the lapsed-buyer list render (M16).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`; this file keeps the key list,
 * which keeps the section's key type narrower than the whole catalogue. Keys ending in a
 * server enum value are built at the call site and checked with `isCustomersKey`.
 */
const CUSTOMERS_KEYS = [
  'customers.title',
  'customers.subtitle',
  'customers.nav.all',
  'customers.nav.lapsed',
  'customers.search',
  'customers.col.name',
  'customers.col.phone',
  'customers.col.orders',
  'customers.col.delivered',
  'customers.col.ltv',
  'customers.col.lastOrder',
  'customers.col.segment',
  'customers.emptyTitle',
  'customers.emptyDetail',
  'customers.errorTitle',
  'customers.errorDetail',
  'customers.retry',
  'customers.columns',
  'customers.previous',
  'customers.next',
  'customers.page',
  'customers.sortAscending',
  'customers.sortDescending',
  'customers.deniedTitle',
  'customers.deniedDetail',
  'customers.profile.back',
  'customers.profile.notFound',
  'customers.profile.notFoundDetail',
  'customers.profile.stats',
  'customers.profile.orders',
  'customers.profile.delivered',
  'customers.profile.returned',
  'customers.profile.cancelled',
  'customers.profile.ltv',
  'customers.profile.aov',
  'customers.profile.firstOrder',
  'customers.profile.lastOrder',
  'customers.profile.none',
  'customers.profile.favourites',
  'customers.profile.categories',
  'customers.profile.sizes',
  'customers.profile.units',
  'customers.profile.noFavourites',
  'customers.profile.occasions',
  'customers.profile.notSet',
  'customers.profile.greetings',
  'customers.profile.noGreetings',
  'customers.profile.recent',
  'customers.profile.noOrders',
  'customers.profile.segment',
  'customers.profile.segmentNone',
  'customers.profile.recency',
  'customers.profile.frequency',
  'customers.profile.monetary',
  'customers.profile.scoredOn',
  'customers.profile.order',
  'customers.profile.status',
  'customers.profile.cod',
  'customers.profile.placed',
  'customers.occasion.birthday',
  'customers.occasion.anniversary',
  'customers.lapsed.title',
  'customers.lapsed.subtitle',
  'customers.lapsed.days',
  'customers.lapsed.minDelivered',
  'customers.lapsed.allSegments',
  'customers.lapsed.count',
  'customers.lapsed.cutoff',
  'customers.lapsed.exportCsv',
  'customers.lapsed.exportXlsx',
  'customers.lapsed.emptyTitle',
  'customers.lapsed.emptyDetail',
  'customers.lapsed.deniedTitle',
  'customers.lapsed.deniedDetail',
  'customers.segment.champions',
  'customers.segment.loyal',
  'customers.segment.new',
  'customers.segment.promising',
  'customers.segment.at_risk',
  'customers.segment.hibernating',
  'customers.segment.needs_attention',
  'customers.segment.prospect',
] as const satisfies readonly MessageKey[];

export type CustomersMessageKey = (typeof CUSTOMERS_KEYS)[number];

export const customersMessages = sectionCatalogue(CUSTOMERS_KEYS);
export const customersEn = customersMessages.en;

/** The section's lookup, following the shell's language switch. */
export function useCustomersT(): (key: CustomersMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = (customersMessages[locale] as Record<string, string | undefined>)[key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}

/** A key built from a server value, checked rather than cast. */
export function isCustomersKey(key: string): key is CustomersMessageKey {
  return Object.hasOwn(customersEn, key);
}
