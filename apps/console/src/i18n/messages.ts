import { messages, type Locale, type MessageKey } from '@elysium/i18n';

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
  'nav.resellers',
  'nav.investors',
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
 * Both locales are built once at module load rather than looked up per render,
 * because a section's `useXT` runs in a component body and rebuilding a
 * 160-key object on every keystroke in the order desk is the kind of cost §24's
 * latency budget has no room for.
 *
 * The locales are named rather than derived from `LOCALES`, so adding a third
 * one is a compile error here instead of a section that silently renders English
 * in it.
 */
export function sectionCatalogue<Key extends MessageKey>(
  keys: readonly Key[],
): Record<Locale, Record<Key, string>> {
  const forLocale = (locale: Locale) =>
    Object.fromEntries(keys.map((key) => [key, messages[locale][key]])) as Record<Key, string>;
  return { en: forLocale('en'), bn: forLocale('bn') };
}

export const consoleMessages = sectionCatalogue(CONSOLE_KEYS);
export const consoleEn = consoleMessages.en;
export const consoleBn = consoleMessages.bn;
