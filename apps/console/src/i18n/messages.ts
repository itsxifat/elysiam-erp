import type { Locale, MessageKey } from '@elysium/i18n';

import { catalogueFor } from './catalogue.js';

/**
 * The keys the console shell renders, and the helper each section's catalogue is
 * built with.
 *
 * The strings live in `packages/i18n/src/locales/{en,bn}.ts`. The console kept
 * its own copies only while that file was being written by several agents at
 * once, where a second write silently discarded the first; keeping them would
 * have cost both guarantees the shared catalogue exists for — `bn.ts` is typed
 * against `en.ts`, so a key in one locale and not the other is only impossible
 * while every key is there, and `scripts/check-i18n.mjs` reads that directory
 * and nothing else.
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
  'nav.campaigns',
  'nav.marketing',
  'nav.resellers',
  'nav.investors',
  'nav.loans',
  'nav.audit',
  'nav.settings',
  'nav.tables',
  'nav.sectionWork',
  'nav.sectionMoney',
  'nav.sectionPeople',
  'nav.sectionAdmin',
  'nav.primary',
  'nav.collapse',
  'nav.expand',
  'shell.skipToContent',
  'shell.openPalette',
  'shell.paletteHint',
  'shell.locale',
  'shell.localeToBangla',
  'shell.localeToEnglish',
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
 * A section's two catalogues, read out of the shared one.
 *
 * Each locale is built once, on first read, rather than looked up per render,
 * because a section's `useXT` runs in a component body and rebuilding a 160-key
 * object on every keystroke in the order desk is the kind of cost §24's latency
 * budget has no room for. On first read rather than at module load, because
 * Bangla arrives later than the module does (`catalogue.ts`).
 *
 * The locales are named rather than derived from `LOCALES`, so adding a third
 * one is a compile error here instead of a section that silently renders English
 * in it.
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
    get bn() {
      return forLocale('bn');
    },
  };
}

export const consoleMessages = sectionCatalogue(CONSOLE_KEYS);
export const consoleEn = consoleMessages.en;
