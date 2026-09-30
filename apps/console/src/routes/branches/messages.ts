import type { MessageKey } from '@elysium/i18n';

import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';

/**
 * The keys the branch screens render (M23).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, where `bn` is typed
 * `Record<MessageKey, string>`, so a key translated on one side only does not
 * compile. This file keeps the key list, which is what keeps this section's key
 * type narrower than the whole catalogue.
 *
 * Everything on a branch's dashboard is under `branch.` — its shifts, its held
 * documents and its day close — because `shifts`, `reviews` and `closing` on their
 * own would collide with the next module that has one.
 */

const BRANCHES_KEYS = [
  'branches.title',
  'branches.subtitle',
  'branches.deniedTitle',
  'branches.deniedDetail',
  'branches.errorTitle',
  'branches.emptyTitle',
  'branches.emptyDetail',
  'branches.colBranch',
  'branches.colSales',
  'branches.colNet',
  'branches.colRefunds',
  'branches.colShifts',
  'branches.colReviews',
  'branches.colDay',
  'branches.dayClosed',
  'branches.dayOpen',
  'branches.open',
  'branch.back',
  'branch.range',
  'branch.retry',
  'branch.rangeToday',
  'branch.rangeMonth',
  'branch.netRevenue',
  'branch.sales',
  'branch.discounts',
  'branch.refunds',
  'branch.averageBasket',
  'branch.grossProfit',
  'branch.costOfSales',
  'branch.costWithheld',
  'branch.tendersHeading',
  'branch.tenderCash',
  'branch.tenderBkash',
  'branch.tenderCard',
  'branch.topHeading',
  'branch.topEmpty',
  'branch.colItem',
  'branch.colQty',
  'branch.colAmount',
  'branch.pnlHeading',
  'branch.pnlIncome',
  'branch.pnlExpense',
  'branch.pnlNet',
  'branch.pnlEmpty',
  'branch.errorTitle',
  'branch.shifts.heading',
  'branch.shifts.empty',
  'branch.shifts.colRegister',
  'branch.shifts.colShift',
  'branch.shifts.colStatus',
  'branch.shifts.colFloat',
  'branch.shifts.colCounted',
  'branch.shifts.colVariance',
  'branch.shifts.statusOpen',
  'branch.shifts.statusClosed',
  'branch.reviews.heading',
  'branch.reviews.caption',
  'branch.reviews.empty',
  'branch.reviews.colReceipt',
  'branch.reviews.colKind',
  'branch.reviews.colAmount',
  'branch.reviews.colWhy',
  'branch.reviews.colActions',
  'branch.reviews.kindSale',
  'branch.reviews.kindReturn',
  'branch.reviews.post',
  'branch.reviews.void',
  'branch.reviews.postTitle',
  'branch.reviews.postDetail',
  'branch.reviews.voidTitle',
  'branch.reviews.voidDetail',
  'branch.reviews.note',
  'branch.reviews.noteHint',
  'branch.reviews.confirmPost',
  'branch.reviews.confirmVoid',
  'branch.reviews.cancel',
  'branch.reviews.close',
  'branch.reviews.stillHeld',
  'branch.reviews.selfResolve',
  'branch.reviews.aboveCeiling',
  'branch.reviews.failed',
  'branch.reviews.reason.stock_shortfall',
  'branch.reviews.reason.price_mismatch',
  'branch.reviews.reason.discount_above_ceiling',
  'branch.reviews.reason.shift_closed',
  'branch.reviews.reason.outside_posting_window',
  'branch.reviews.reason.sku_unavailable',
  'branch.reviews.reason.sale_not_posted',
  'branch.reviews.reason.return_mismatch',
  'branch.closing.heading',
  'branch.closing.caption',
  'branch.closing.date',
  'branch.closing.counted',
  'branch.closing.wallet',
  'branch.closing.note',
  'branch.closing.submit',
  'branch.closing.notReady',
  'branch.closing.alreadyClosed',
  'branch.closing.failed',
  'branch.closing.noRegisters',
  'branch.closing.resultBalanced',
  'branch.closing.resultPending',
  'branch.closing.resultPosted',
  'branch.closing.expected',
  'branch.closing.variance',
  'branch.closing.historyHeading',
  'branch.closing.historyEmpty',
  'branch.closing.countInvalid',
] as const satisfies readonly MessageKey[];

export type BranchesMessageKey = (typeof BRANCHES_KEYS)[number];

export const branchesMessages = sectionCatalogue(BRANCHES_KEYS);
export const branchesEn = branchesMessages.en;

/**
 * The section's own lookup, closing over the locale from context.
 *
 * Narrow on purpose: a branch screen that reaches for a payroll string should not
 * compile.
 */
export function useBranchesT(): (key: BranchesMessageKey) => string {
  const { locale } = useLocale();
  return (key) => branchesMessages[locale][key];
}
