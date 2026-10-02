import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';
import type { MessageKey } from '@elysium/i18n';

/**
 * The keys the Investors screens render (M25).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, which is where the
 * bn/en parity guarantee lives: `bn` is typed as `Record<MessageKey, string>`,
 * so a key translated on one side only does not compile. This file used to hold
 * its own copies because that catalogue was being written by several agents at
 * once and a second write discarded the first.
 *
 * The bn side matters more here than on most screens — an investor reading their
 * own position in the portal is a Bangla-first reader, and the portal reuses
 * these keys, which it can only do now that they are in the shared catalogue.
 */

const INVESTORS_KEYS = [
  'investors.title',
  'investors.subtitle',
  'investors.deniedTitle',
  'investors.deniedDetail',
  'investors.listHeading',
  'investors.listCaption',
  'investors.colCode',
  'investors.colName',
  'investors.colShare',
  'investors.colCapital',
  'investors.colLocked',
  'investors.colPayable',
  'investors.colStatus',
  'investors.statusActive',
  'investors.statusExited',
  'investors.emptyTitle',
  'investors.emptyDetail',
  'investors.errorTitle',
  'investors.totalCapital',
  'investors.totalPayable',
  'investors.totalLocked',
  'investors.add',
  'investors.addTitle',
  'investors.addDetail',
  'investors.fieldCode',
  'investors.fieldName',
  'investors.fieldShare',
  'investors.fieldJoinedOn',
  'investors.fieldPhone',
  'investors.fieldEmail',
  'investors.fieldNotes',
  'investors.phoneHint',
  'investors.recordCapital',
  'investors.recordCapitalTitle',
  'investors.recordCapitalDetail',
  'investors.fieldInvestor',
  'investors.fieldWallet',
  'investors.fieldAmount',
  'investors.fieldLockIn',
  'investors.fieldTerms',
  'investors.fieldMemo',
  'investors.pickInvestor',
  'investors.pickWallet',
  'investors.lockInHint',
  'investors.declare',
  'investors.declareTitle',
  'investors.declareDetail',
  'investors.fieldMonth',
  'investors.fieldBasis',
  'investors.basisShare',
  'investors.basisCapital',
  'investors.declaredNotice',
  'investors.distributionsHeading',
  'investors.distributionsCaption',
  'investors.colPeriod',
  'investors.colTotal',
  'investors.colBasis',
  'investors.distributionsEmptyTitle',
  'investors.distributionsEmptyDetail',
  'investors.statusPendingApproval',
  'investors.statusDeclared',
  'investors.statusRejected',
  'investors.withdrawalsHeading',
  'investors.withdrawalsCaption',
  'investors.colKind',
  'investors.kindCapital',
  'investors.kindProfit',
  'investors.withdrawalsEmptyTitle',
  'investors.withdrawalsEmptyDetail',
  'investors.statusRequested',
  'investors.statusReviewed',
  'investors.statusApproved',
  'investors.statusPaid',
  'investors.request',
  'investors.requestTitle',
  'investors.requestDetail',
  'investors.fieldReason',
  'investors.review',
  'investors.reviewTitle',
  'investors.reviewDetail',
  'investors.pay',
  'investors.payTitle',
  'investors.payDetail',
  'investors.payConfirm',
  'investors.cancel',
  'investors.reviewedNotice',
  'investors.colPortal',
  'investors.portalLinked',
  'investors.portalNotLinked',
  'investors.portalLink',
  'investors.portalChange',
  'investors.portalTitle',
  'investors.portalDetail',
  'investors.fieldPortalLogin',
  'investors.pickPortalLogin',
  'investors.portalHint',
  'investors.portalLinkedElsewhere',
  'investors.portalNoLogins',
  'investors.linkedNotice',
  'investors.paidNotice',
  'investors.save',
  'investors.saving',
  'investors.detailHeading',
  'investors.contributedLabel',
  'investors.withdrawnLabel',
  'investors.capitalLabel',
  'investors.lockedLabel',
  'investors.withdrawableLabel',
  'investors.declaredLabel',
  'investors.profitPaidLabel',
  'investors.payableLabel',
  'investors.back',
  'investors.statementHeading',
  'investors.statementCaption',
  'investors.colDate',
  'investors.colMovement',
  'investors.colAmount',
  'investors.movementContribution',
  'investors.movementDistribution',
  'investors.movementProfitPaid',
  'investors.movementCapitalWithdrawal',
  'investors.statementEmptyTitle',
  'investors.statementEmptyDetail',
  'investors.documentsHeading',
  'investors.documentsCaption',
  'investors.colTitle',
  'investors.colDocumentKind',
  'investors.documentKindKyc',
  'investors.documentKindAgreement',
  'investors.documentKindOther',
  'investors.documentsEmptyTitle',
  'investors.documentsEmptyDetail',
  'investors.open',
  'investors.opening',
  'investors.documentHint',
] as const satisfies readonly MessageKey[];

export type InvestorsMessageKey = (typeof INVESTORS_KEYS)[number];

export const investorsMessages = sectionCatalogue(INVESTORS_KEYS);
export const investorsEn = investorsMessages.en;

/**
 * The section's own lookup, closing over the locale from context.
 *
 * Separate from `useT()` rather than merged into it because the narrow key type
 * is the point: an investor screen that reaches for a payroll string should not
 * compile.
 */
export function useInvestorsT(): (key: InvestorsMessageKey) => string {
  const { locale } = useLocale();
  return (key) => investorsMessages[locale][key];
}
