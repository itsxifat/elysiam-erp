import type { MessageKey } from '@elysium/i18n';

import { sectionCatalogue } from '../../i18n/messages.js';
import { useLocale } from '../../i18n/locale.js';

/**
 * The strings promo codes, message templates, opt-outs and the delivery log render (M16).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`; this file keeps the key list,
 * which keeps the section's key type narrower than the whole catalogue. Keys ending in a
 * server enum value are built at the call site and checked with `isCampaignsKey`.
 */
const CAMPAIGNS_KEYS = [
  'campaigns.title',
  'campaigns.nav.codes',
  'campaigns.nav.templates',
  'campaigns.nav.optOuts',
  'campaigns.nav.log',
  'campaigns.columns',
  'campaigns.previous',
  'campaigns.next',
  'campaigns.page',
  'campaigns.sortAscending',
  'campaigns.sortDescending',
  'campaigns.errorTitle',
  'campaigns.errorDetail',
  'campaigns.retry',
  'campaigns.cancel',
  'campaigns.close',
  'campaigns.save',
  'campaigns.optional',
  'campaigns.deniedTitle',
  'campaigns.deniedDetail',
  'campaigns.codes.subtitle',
  'campaigns.codes.new',
  'campaigns.codes.col.code',
  'campaigns.codes.col.offer',
  'campaigns.codes.col.used',
  'campaigns.codes.col.valid',
  'campaigns.codes.col.channels',
  'campaigns.codes.col.status',
  'campaigns.codes.col.actions',
  'campaigns.codes.allStatuses',
  'campaigns.codes.status.active',
  'campaigns.codes.status.paused',
  'campaigns.codes.status.archived',
  'campaigns.codes.pause',
  'campaigns.codes.resume',
  'campaigns.codes.archive',
  'campaigns.codes.kind.percent',
  'campaigns.codes.kind.flat',
  'campaigns.codes.kind.free_delivery',
  'campaigns.codes.off',
  'campaigns.codes.unlimited',
  'campaigns.codes.always',
  'campaigns.codes.allChannels',
  'campaigns.codes.personal',
  'campaigns.codes.origin.occasion',
  'campaigns.codes.emptyTitle',
  'campaigns.codes.emptyDetail',
  'campaigns.codes.deniedTitle',
  'campaigns.codes.deniedDetail',
  'campaigns.codes.form.title',
  'campaigns.codes.form.code',
  'campaigns.codes.form.codeHint',
  'campaigns.codes.form.kind',
  'campaigns.codes.form.percent',
  'campaigns.codes.form.amount',
  'campaigns.codes.form.minOrder',
  'campaigns.codes.form.maxDiscount',
  'campaigns.codes.form.totalLimit',
  'campaigns.codes.form.perCustomer',
  'campaigns.codes.form.validFrom',
  'campaigns.codes.form.validTo',
  'campaigns.codes.form.channels',
  'campaigns.codes.form.channelsHint',
  'campaigns.codes.form.create',
  'campaigns.codes.form.invalidCode',
  'campaigns.codes.form.invalidPercent',
  'campaigns.codes.form.invalidAmount',
  'campaigns.codes.form.invalidCount',
  'campaigns.codes.form.invalidWindow',
  'campaigns.codes.form.failed',
  'campaigns.templates.subtitle',
  'campaigns.templates.new',
  'campaigns.templates.edit',
  'campaigns.templates.editTitle',
  'campaigns.templates.col.key',
  'campaigns.templates.col.category',
  'campaigns.templates.col.body',
  'campaigns.templates.col.active',
  'campaigns.templates.yes',
  'campaigns.templates.no',
  'campaigns.templates.category.otp',
  'campaigns.templates.category.transactional',
  'campaigns.templates.category.marketing',
  'campaigns.templates.form.key',
  'campaigns.templates.form.keyHint',
  'campaigns.templates.form.bodyBn',
  'campaigns.templates.form.bodyEn',
  'campaigns.templates.form.bodyHint',
  'campaigns.templates.form.active',
  'campaigns.templates.form.invalidKey',
  'campaigns.templates.form.required',
  'campaigns.templates.form.failed',
  'campaigns.templates.emptyTitle',
  'campaigns.templates.emptyDetail',
  'campaigns.optOuts.subtitle',
  'campaigns.optOuts.phone',
  'campaigns.optOuts.reason',
  'campaigns.optOuts.add',
  'campaigns.optOuts.remove',
  'campaigns.optOuts.since',
  'campaigns.optOuts.removeTitle',
  'campaigns.optOuts.removeDetail',
  'campaigns.optOuts.invalidPhone',
  'campaigns.optOuts.failed',
  'campaigns.optOuts.emptyTitle',
  'campaigns.optOuts.emptyDetail',
  'campaigns.log.subtitle',
  'campaigns.log.col.to',
  'campaigns.log.col.template',
  'campaigns.log.col.state',
  'campaigns.log.col.due',
  'campaigns.log.col.sent',
  'campaigns.log.col.error',
  'campaigns.log.allStates',
  'campaigns.log.state.queued',
  'campaigns.log.state.sent',
  'campaigns.log.state.failed',
  'campaigns.log.state.suppressed',
  'campaigns.log.emptyTitle',
  'campaigns.log.emptyDetail',
] as const satisfies readonly MessageKey[];

export type CampaignsMessageKey = (typeof CAMPAIGNS_KEYS)[number];

export const campaignsMessages = sectionCatalogue(CAMPAIGNS_KEYS);
export const campaignsEn = campaignsMessages.en;

/** The section's lookup, following the shell's language switch. */
export function useCampaignsT(): (key: CampaignsMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = (campaignsMessages[locale] as Record<string, string | undefined>)[key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}

/** A key built from a server value, checked rather than cast. */
export function isCampaignsKey(key: string): key is CampaignsMessageKey {
  return Object.hasOwn(campaignsEn, key);
}
