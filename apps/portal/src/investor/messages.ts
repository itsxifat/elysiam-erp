import { messages, type Locale, type MessageKey } from '@elysium/i18n';

/**
 * The investor portal's strings (M25).
 *
 * **Bangla first** (D-036, D-310): an investor is a partner, not staff, so the pages open in
 * Bangla with an English toggle. The strings live in `packages/i18n/src/locales/{bn,en}.ts`,
 * where a key on one side only does not compile. Most of them are shared on purpose: the
 * sign-in journey is the console's (`auth.*`) and the money words are the console's
 * investor screens' (`investors.*`), so an investor and the accounts team call the same
 * figure by the same name. Only what the portal says and the console does not is
 * `portal.*`.
 *
 * This list keeps the portal from reaching for a key outside it, which is how a page ends up
 * rendering a staff-console sentence to an investor.
 */
const PORTAL_KEYS = [
  'auth.title',
  'auth.email',
  'auth.email.placeholder',
  'auth.password',
  'auth.signIn',
  'auth.signingIn',
  'auth.signOut',
  'auth.failed',
  'auth.unreachable',
  'auth.tooMany',
  'auth.rejected',
  'auth.twoFactor.title',
  'auth.twoFactor.subtitle',
  'auth.twoFactor.code',
  'auth.twoFactor.verify',
  'auth.twoFactor.verifying',
  'auth.twoFactor.invalid',
  'auth.twoFactor.useRecovery',
  'auth.twoFactor.useApp',
  'auth.twoFactor.recoveryCode',
  'auth.twoFactor.recoveryHint',
  'auth.twoFactor.recoveryInvalid',
  'auth.enrol.title',
  'auth.enrol.step1',
  'auth.enrol.step2',
  'auth.enrol.step3',
  'auth.enrol.copy',
  'auth.enrol.copied',
  'auth.enrol.confirm',
  'auth.enrol.download',
  'auth.enrol.acknowledge',
  'auth.enrol.failed',
  'common.loading',

  'investors.colCode',
  'investors.colDate',
  'investors.colAmount',
  'investors.colStatus',
  'investors.colKind',
  'investors.colMovement',
  'investors.colTitle',
  'investors.colDocumentKind',
  'investors.capitalLabel',
  'investors.lockedLabel',
  'investors.withdrawableLabel',
  'investors.declaredLabel',
  'investors.profitPaidLabel',
  'investors.payableLabel',
  'investors.kindCapital',
  'investors.kindProfit',
  'investors.statusRequested',
  'investors.statusReviewed',
  'investors.statusApproved',
  'investors.statusPaid',
  'investors.statusRejected',
  'investors.statusExited',
  'investors.withdrawalsHeading',
  'investors.withdrawalsEmptyTitle',
  'investors.statementHeading',
  'investors.statementEmptyTitle',
  'investors.movementContribution',
  'investors.movementDistribution',
  'investors.movementProfitPaid',
  'investors.movementCapitalWithdrawal',
  'investors.documentsHeading',
  'investors.documentsEmptyTitle',
  'investors.documentKindKyc',
  'investors.documentKindAgreement',
  'investors.documentKindOther',
  'investors.open',
  'investors.opening',
  'investors.documentHint',

  'portal.investor.title',
  'portal.investor.subtitle',
  'portal.investor.enrolSubtitle',
  'portal.investor.brands',
  'portal.investor.switching',
  'portal.investor.switchFailed',
  'portal.investor.chooseBrandTitle',
  'portal.investor.chooseBrandDetail',
  'portal.investor.notInvestorTitle',
  'portal.investor.notInvestorDetail',
  'portal.investor.noProfileTitle',
  'portal.investor.noProfileDetail',
  'portal.investor.errorTitle',
  'portal.investor.errorDetail',
  'portal.investor.retry',
  'portal.investor.positionHeading',
  'portal.investor.contributionsHeading',
  'portal.investor.contributionsCaption',
  'portal.investor.contributionsEmptyTitle',
  'portal.investor.contributionsEmptyDetail',
  'portal.investor.colLockIn',
  'portal.investor.notLocked',
  'portal.investor.distributionsHeading',
  'portal.investor.distributionsCaption',
  'portal.investor.distributionsEmptyTitle',
  'portal.investor.distributionsEmptyDetail',
  'portal.investor.withdrawalsCaption',
  'portal.investor.withdrawHint',
  'portal.investor.withdrawalsEmptyDetail',
  'portal.investor.colRequestedOn',
  'portal.investor.colPaidOn',
  'portal.investor.statementCaption',
  'portal.investor.statementEmptyDetail',
  'portal.investor.documentsCaption',
  'portal.investor.documentsEmptyDetail',
  'portal.investor.openFailed',
  'portal.language',
  'portal.languageLabel',
  'portal.themeLight',
  'portal.themeDark',
] as const satisfies readonly MessageKey[];

export type PortalMessageKey = (typeof PORTAL_KEYS)[number];

export type Translate = (key: PortalMessageKey) => string;

export function portalTranslator(locale: Locale): Translate {
  return (key) => messages[locale][key];
}

/** Both catalogues, for the parity test. */
export function portalCatalogue(locale: Locale): Record<PortalMessageKey, string> {
  return Object.fromEntries(PORTAL_KEYS.map((key) => [key, messages[locale][key]])) as Record<
    PortalMessageKey,
    string
  >;
}
