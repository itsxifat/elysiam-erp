import type { Locale, MessageKey } from '@elysium/i18n';

import { catalogueFor } from './catalogue.js';

/**
 * The keys the console shell renders, and the helper each section's catalogue is
 * built with.
 *
 * The strings live in `packages/i18n/src/locales/en.ts` and its sections, English
 * only (D-750). `scripts/check-i18n.mjs` reads that directory and nothing else,
 * so the console keeps no copies of its own.
 *
 * What stays here is the key *list*, which still earns its keep twice.
 * `satisfies readonly MessageKey[]` makes a typo in the list a build error, and
 * `ConsoleMessageKey` stays narrower than `MessageKey`, so `navigation.ts`
 * cannot label a nav item with an invoice string — both properties the old
 * per-module object had, and neither of which survives widening the type to
 * `MessageKey`.
 */

const CONSOLE_KEYS = [
  'nav.overview',
  'nav.orders',
  'nav.labels',
  'nav.packaging',
  'nav.courierPortal',
  'nav.customers',
  'nav.catalog',
  'nav.stock',
  'nav.supply',
  'nav.courier',
  'nav.branches',
  'nav.accounts',
  'nav.approvals',
  'nav.people',
  'nav.payroll',
  'nav.performance',
  'nav.campaigns',
  'nav.marketing',
  'nav.analytics',
  'nav.resellers',
  'nav.investors',
  'nav.loans',
  'nav.users',
  'nav.audit',
  'nav.settings',
  'nav.website',
  'nav.inbox',
  'nav.calls',
  'nav.tables',
  'nav.sectionWork',
  'nav.sectionMoney',
  'nav.sectionPeople',
  'nav.sectionAdmin',
  'nav.sectionHome',
  'nav.sectionSell',
  'nav.sectionStock',
  'nav.sidebar',
  'nav.primary',
  'nav.collapse',
  'nav.expand',
  'shell.skipToContent',
  'shell.openPalette',
  'shell.paletteHint',
  'shell.userMenu',
  'palette.title',
  'palette.description',
  'palette.placeholder',
  'palette.empty',
  'palette.groupNavigate',
  'palette.groupCommands',
  'palette.close',
  'table.page',
  'table.columns',
  'table.previous',
  'table.next',
  'table.sortAscending',
  'table.sortDescending',
  'table.emptyTitle',
  'table.emptyDetail',
  'table.errorTitle',
  'table.errorDetail',
  'table.clearFilters',
  'table.filterStatus',
  'table.filterType',
  'table.search',
  'approvals.title',
  'approvals.subtitle',
  'approvals.caption',
  'approvals.colType',
  'approvals.colStatus',
  'approvals.colAmount',
  'approvals.colRequestedBy',
  'approvals.colBranch',
  'approvals.colActions',
  'approvals.wholeOrg',
  'approvals.approve',
  'approvals.reject',
  'approvals.approveTitle',
  'approvals.approveDetail',
  'approvals.rejectTitle',
  'approvals.rejectDetail',
  'approvals.emptyTitle',
  'approvals.emptyDetail',
  'approvals.deniedTitle',
  'approvals.deniedDetail',
  'approvals.status.pending',
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
  'approvals.type.credential_reset',
  'approvals.type.opening_stock_reopen',
  'approvals.type.stock_in_hand_reversal',
  'approvals.status.approved',
  'approvals.status.rejected',
  'approvals.status.cancelled',
  'approvals.status.auto_approved',
  'approvals.live',
  'approvals.reconnecting',
  'demo.title',
  'demo.subtitle',
  'demo.caption',
  'demo.colReference',
  'demo.colChannel',
  'demo.colStatus',
  'demo.colAmount',
  'demo.colPlacedAt',
  'demo.channel.web',
  'demo.channel.showroom',
  'demo.channel.reseller',
  'demo.status.open',
  'demo.status.settled',
  'demo.status.returned',
  'overview.title',
  'overview.subtitle',
  'overview.shellNote',
  'overview.yourRoles',
  'overview.activeOrg',
  'overview.branchScope',
  'realtime.connected',
  'realtime.disconnected',
  'upload.choose',
  'upload.uploading',
  'upload.uploaded',
  'upload.remove',
  'upload.failed',
  'upload.tooLarge',
  'form.loading',
  'form.noMatches',
  'notFound.title',
  'notFound.detail',
  'notFound.home',
] as const satisfies readonly MessageKey[];

export type ConsoleMessageKey = (typeof CONSOLE_KEYS)[number];

/**
 * A section's catalogue, read out of the shared one.
 *
 * Built once, on first read, rather than looked up per render, because a section's
 * `useXT` runs in a component body and rebuilding a 160-key object on every
 * keystroke in the order desk is the kind of cost §24's latency budget has no room
 * for. On first read rather than at module load, because a section's strings are
 * registered as its chunk loads (`catalogue.ts`).
 */
export function sectionCatalogue<Key extends MessageKey>(
  keys: readonly Key[],
): Record<Locale, Record<Key, string>> {
  const built: Partial<Record<Locale, Record<Key, string>>> = {};
  const forLocale = (locale: Locale): Record<Key, string> => {
    const catalogue = catalogueFor(locale);
    built[locale] ??= Object.fromEntries(keys.map((key) => [key, catalogue[key]])) as Record<
      Key,
      string
    >;
    return built[locale];
  };
  return {
    get en() {
      return forLocale('en');
    },
  };
}

export const consoleMessages = sectionCatalogue(CONSOLE_KEYS);
export const consoleEn = consoleMessages.en;
