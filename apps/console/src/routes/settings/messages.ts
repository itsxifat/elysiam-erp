import type { MessageKey } from '@elysium/i18n';

import { sectionCatalogue } from '../../i18n/messages.js';
import { useLocale } from '../../i18n/locale.js';

/**
 * The strings the settings screens render (D-394 to D-396).
 *
 * The values live in `packages/i18n/src/locales/{en,bn}.ts`; this list keeps the section's key
 * type narrow. It borrows the approval type names and two channel names from the sections
 * that own them rather than spelling them twice.
 */
const SETTINGS_KEYS = [
  'settings.title',
  'settings.deniedTitle',
  'settings.deniedDetail',
  'settings.nav.thresholds',
  'settings.nav.zones',
  'settings.nav.couriers',
  'settings.nav.siteKeys',
  'settings.nav.registers',
  'settings.nav.security',
  'settings.loading',
  'settings.errorTitle',
  'settings.errorDetail',
  'settings.retry',
  'settings.saved',
  'settings.save',
  'settings.cancel',
  'settings.close',
  'settings.edit',
  'settings.active',
  'settings.inactive',
  'settings.colStatus',
  'settings.empty',
  'settings.choose',
  'settings.thresholds.caption',
  'settings.thresholds.colType',
  'settings.thresholds.colCurrent',
  'settings.thresholds.colPending',
  'settings.thresholds.colNew',
  'settings.thresholds.none',
  'settings.thresholds.alwaysHeld',
  'settings.thresholds.set',
  'settings.thresholds.applied',
  'settings.thresholds.sentForApproval',
  'settings.thresholds.invalid',
  'settings.zones.caption',
  'settings.zones.colCode',
  'settings.zones.colNameEn',
  'settings.zones.colCharge',
  'settings.zones.chargeInput',
  'settings.zones.colCourier',
  'settings.zones.add',
  'settings.zones.formTitle',
  'settings.zones.noCourier',
  'settings.zones.codeHint',
  'settings.zones.invalid',
  'settings.couriers.caption',
  'settings.couriers.colCourier',
  'settings.couriers.colProvider',
  'settings.couriers.colMode',
  'settings.couriers.colKeys',
  'settings.couriers.add',
  'settings.couriers.formTitle',
  'settings.couriers.fieldLabel',
  'settings.couriers.fieldBaseUrl',
  'settings.couriers.fieldWebhookSecret',
  'settings.couriers.fieldPoll',
  'settings.couriers.fieldWallet',
  'settings.couriers.fieldActive',
  'settings.couriers.modeSandbox',
  'settings.couriers.modeLive',
  'settings.couriers.keysSet',
  'settings.couriers.keysMissing',
  'settings.couriers.keepSecret',
  'settings.couriers.unverified',
  'settings.couriers.webhookPath',
  'settings.couriers.noCouriers',
  'settings.couriers.invalid',
  'settings.siteKeys.caption',
  'settings.siteKeys.colLabel',
  'settings.siteKeys.colChannel',
  'settings.siteKeys.colKeyId',
  'settings.siteKeys.colLastUsed',
  'settings.siteKeys.never',
  'settings.siteKeys.revoked',
  'settings.siteKeys.issue',
  'settings.siteKeys.issueTitle',
  'settings.siteKeys.secretTitle',
  'settings.siteKeys.secretDetail',
  'settings.siteKeys.secret',
  'settings.siteKeys.revoke',
  'settings.siteKeys.revokeTitle',
  'settings.siteKeys.revokeDetail',
  'settings.siteKeys.invalid',
  'settings.registers.caption',
  'settings.registers.colBranch',
  'settings.registers.colCode',
  'settings.registers.colName',
  'settings.registers.colLocation',
  'settings.registers.colTenders',
  'settings.registers.add',
  'settings.registers.formTitle',
  'settings.registers.fieldCash',
  'settings.registers.fieldBkash',
  'settings.registers.fieldCard',
  'settings.registers.codeHint',
  'settings.registers.activate',
  'settings.registers.deactivate',
  'settings.registers.tender.cash',
  'settings.registers.tender.bkash',
  'settings.registers.tender.card',
  'settings.registers.invalid',
  'settings.couriers.unverifiedBadge',
  'approvals.type.wallet_adjustment',
  'approvals.type.stock_write_off',
  'approvals.type.stock_gain',
  'approvals.type.supplier_payment',
  'approvals.type.settlement_posting',
  'approvals.type.closing_variance',
  'approvals.type.back_dated_entry',
  'approvals.type.payroll_run',
  'approvals.type.bonus_rule',
  'approvals.type.reseller_payout_batch',
  'approvals.type.period_reopen',
  'approvals.type.threshold_change',
  'approvals.type.investor_distribution',
  'approvals.type.investor_withdrawal',
  'approvals.type.loan_repayment',
  'orders.channel.landing_page',
  'orders.channel.website',
] as const satisfies readonly MessageKey[];

export type SettingsMessageKey = (typeof SETTINGS_KEYS)[number];

export const settingsMessages = sectionCatalogue(SETTINGS_KEYS);
export const settingsEn = settingsMessages.en;

export function useSettingsT(): (key: SettingsMessageKey) => string {
  const { locale } = useLocale();
  return (key) => settingsMessages[locale][key];
}

/** A key built from a server value, checked rather than cast. */
export function isSettingsKey(key: string): key is SettingsMessageKey {
  return Object.hasOwn(settingsEn, key);
}
