import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';
import type { MessageKey } from '@elysium/i18n';

/**
 * The keys the Accounts screens render (M08).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, which is where the
 * bn/en parity guarantee lives: `bn` is typed as `Record<MessageKey, string>`,
 * so a key translated on one side only does not compile. This file used to hold
 * its own copies because that catalogue was being written by several agents at
 * once and a second write discarded the first.
 *
 * The list is still worth having. `satisfies readonly MessageKey[]` makes a typo
 * a build error, and `AccountsMessageKey` stays narrow enough that the wallet,
 * cash-kind and status label maps below cannot be pointed at an unrelated string.
 */

const ACCOUNTS_KEYS = [
  'accounts.title',
  'accounts.subtitle',
  'accounts.deniedTitle',
  'accounts.deniedDetail',
  'accounts.walletsHeading',
  'accounts.walletsCaption',
  'accounts.totalCash',
  'accounts.totalCashHint',
  'accounts.noWallets',
  'accounts.noWalletsDetail',
  'accounts.walletsErrorTitle',
  'accounts.kindHandCash',
  'accounts.kindBank',
  'accounts.kindBkash',
  'accounts.kindMfsOther',
  'accounts.inactive',
  'accounts.recordCash',
  'accounts.recordCashTitle',
  'accounts.recordCashDetail',
  'accounts.fieldWallet',
  'accounts.fieldKind',
  'accounts.fieldCategory',
  'accounts.fieldAmount',
  'accounts.fieldMemo',
  'accounts.fieldReceipt',
  'accounts.receiptHint',
  'accounts.kindCashIn',
  'accounts.kindCashOut',
  'accounts.kindPettyCash',
  'accounts.pickWallet',
  'accounts.pickCategory',
  'accounts.save',
  'accounts.saving',
  'accounts.heldNotice',
  'accounts.entriesHeading',
  'accounts.entriesCaption',
  'accounts.colDate',
  'accounts.colWallet',
  'accounts.colKind',
  'accounts.colCategory',
  'accounts.colAmount',
  'accounts.colStatus',
  'accounts.statusPosted',
  'accounts.statusPending',
  'accounts.statusRejected',
  'accounts.entriesEmptyTitle',
  'accounts.entriesEmptyDetail',
  'accounts.pnlHeading',
  'accounts.pnlIncome',
  'accounts.pnlExpense',
  'accounts.pnlNet',
  'accounts.costWithheld',
  'accounts.closingsHeading',
  'accounts.closingsCaption',
  'accounts.colExpected',
  'accounts.colCounted',
  'accounts.colVariance',
  'accounts.closingsEmptyTitle',
  'accounts.closingsEmptyDetail',
  'accounts.countCash',
  'accounts.countCashTitle',
  'accounts.countCashDetail',
  'accounts.fieldBusinessDate',
  'accounts.fieldCounted',
  'accounts.varianceNotice',
] as const satisfies readonly MessageKey[];

export type AccountsMessageKey = (typeof ACCOUNTS_KEYS)[number];

export const accountsMessages = sectionCatalogue(ACCOUNTS_KEYS);
export const accountsEn = accountsMessages.en;
export const accountsBn = accountsMessages.bn;

/**
 * The section's own lookup, closing over the locale from context.
 *
 * Separate from `useT()` rather than merged into it because the narrow key type
 * is the point: a screen in this section that reaches for a payroll string should
 * not compile.
 */
export function useAccountsT(): (key: AccountsMessageKey) => string {
  const { locale } = useLocale();
  return (key) => accountsMessages[locale][key];
}
