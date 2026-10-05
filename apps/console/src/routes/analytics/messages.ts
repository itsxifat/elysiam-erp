import type { MessageKey } from '@elysium/i18n';

import { sectionCatalogue } from '../../i18n/messages.js';
import { useLocale } from '../../i18n/locale.js';

/**
 * The strings the analytics screens render (M24).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`; this file keeps the key list,
 * which keeps the section's key type narrower than the whole catalogue. The order channels'
 * names are the order desk's own (`orders.channel.*`), so a channel reads the same here.
 */
const ANALYTICS_KEYS = [
  'analytics.title',
  'analytics.deniedTitle',
  'analytics.deniedDetail',
  'analytics.period.from',
  'analytics.period.to',
  'analytics.period.tooLong',
  'analytics.loadFailed',
  'analytics.retry',
  'analytics.empty',
  'analytics.dashboard.subtitle',
  'analytics.coverage',
  'analytics.coverage.at',
  'analytics.refresh',
  'analytics.refreshing',
  'analytics.refreshDone',
  'analytics.refreshTooLong',
  'analytics.refreshFailed',
  'analytics.exportCsv',
  'analytics.exportXlsx',
  'analytics.metric.placed',
  'analytics.metric.confirmed',
  'analytics.metric.delivered',
  'analytics.metric.returned',
  'analytics.metric.cancelled',
  'analytics.metric.revenue',
  'analytics.metric.revenueHint',
  'analytics.metric.grossProfit',
  'analytics.metric.spend',
  'analytics.metric.aov',
  'analytics.metric.returnRate',
  'analytics.metric.deliverySuccess',
  'analytics.metric.deliverySuccessHint',
  'analytics.metric.cpo',
  'analytics.metric.cpdo',
  'analytics.metric.roas',
  'analytics.metric.pickup',
  'analytics.metric.cash',
  'analytics.metric.cashHint',
  'analytics.metric.stockValue',
  'analytics.trend',
  'analytics.trend.table',
  'analytics.col.date',
  'analytics.byChannel',
  'analytics.byBranch',
  'analytics.byCampaign',
  'analytics.agents',
  'analytics.topSkus',
  'analytics.col.channel',
  'analytics.col.branch',
  'analytics.col.campaign',
  'analytics.col.agent',
  'analytics.col.sku',
  'analytics.col.product',
  'analytics.col.units',
  'analytics.unattributed',
  'analytics.unknownAgent',
  'analytics.unnamedBranch',
  'analytics.insights',
  'analytics.insights.month',
  'analytics.insights.none',
  'analytics.insight.outsideDhakaReturns.title',
  'analytics.insight.outsideDhakaReturns.detail',
  'analytics.insight.returnRateRising.title',
  'analytics.insight.returnRateRising.detail',
  'analytics.insight.campaignBelowBreakEven.title',
  'analytics.insight.campaignBelowBreakEven.detail',
  'analytics.insight.cpdoRising.title',
  'analytics.insight.cpdoRising.detail',
  'analytics.insight.slowPickup.title',
  'analytics.insight.slowPickup.detail',
  'analytics.insight.channelReturns.title',
  'analytics.insight.channelReturns.detail',
  'analytics.insight.deliverySuccessBelowUsual.title',
  'analytics.insight.deliverySuccessBelowUsual.detail',
  'analytics.severity.warning',
  'analytics.severity.info',
  'analytics.narrative',
  'analytics.narrative.note',
  'analytics.narrative.failed',
  'analytics.seconds',
  'analytics.minutes',
  'orders.channel.facebook',
  'orders.channel.whatsapp',
  'orders.channel.instagram',
  'orders.channel.tiktok',
  'orders.channel.landing_page',
  'orders.channel.website',
  'orders.channel.phone',
  'orders.channel.walk_in',
  'orders.channel.reseller',
] as const satisfies readonly MessageKey[];

export type AnalyticsMessageKey = (typeof ANALYTICS_KEYS)[number];

export const analyticsMessages = sectionCatalogue(ANALYTICS_KEYS);
export const analyticsEn = analyticsMessages.en;

/** The section's lookup, following the shell's language switch. */
export function useAnalyticsT(): (key: AnalyticsMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = (analyticsMessages[locale] as Record<string, string | undefined>)[key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}

/** A key built from a server value, checked rather than cast. */
export function isAnalyticsKey(key: string): key is AnalyticsMessageKey {
  return Object.hasOwn(analyticsEn, key);
}

/** `{name}` placeholders, filled in order of appearance; an unknown name is left as is. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => values[name] ?? whole);
}
