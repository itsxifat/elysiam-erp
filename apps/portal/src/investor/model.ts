import { businessDate, formatDate, type Locale } from '@elysium/i18n';

import type {
  AvailableOrg,
  DocumentRow,
  InvestorRow,
  MovementKind,
  StatementEntry,
  WithdrawalRow,
  WithdrawalStatus,
} from './api.js';
import type { PortalMessageKey } from './messages.js';

/**
 * The investor portal's decisions that are not drawing (M25): which brands a sign-in may
 * open, which row is the caller's own, and how a status, a movement or a date reads. Pure,
 * so they are tested without a browser (`investor.test.ts`).
 */

export const INVESTOR_ROLE = 'investor';

/** The brands this sign-in holds an investor stake in, in the order the API listed them. */
export function investorOrgs(orgs: readonly AvailableOrg[]): AvailableOrg[] {
  return orgs.filter((org) => org.roles.includes(INVESTOR_ROLE));
}

/**
 * The brand to open: the session's active one if it is an investor brand, otherwise the
 * first investor brand. `null` when the active one is already right, so the caller makes no
 * switch request it does not need.
 */
export function brandToOpen(
  investorBrands: readonly AvailableOrg[],
  activeOrgId: string | null,
): string | null {
  if (activeOrgId !== null && investorBrands.some((org) => org.orgId === activeOrgId)) {
    return null;
  }
  return investorBrands[0]?.orgId ?? null;
}

/**
 * The caller's own investor row.
 *
 * For the `investor` role the API already answers with exactly one row (check 1). The
 * filter is for the person who is also accounts in the same brand, whose `read Investor`
 * reaches the whole org: their portal must still show their own position, not the first
 * investor in the list.
 */
export function ownInvestor(rows: readonly InvestorRow[], userId: string): InvestorRow | null {
  return rows.find((row) => row.userId === userId) ?? null;
}

/** The profit declared to this investor, out of their statement (D-310). */
export function distributionsOf(entries: readonly StatementEntry[]): StatementEntry[] {
  return entries.filter((entry) => entry.kind === 'distribution');
}

export const MOVEMENT_LABEL: Record<MovementKind, PortalMessageKey> = {
  contribution: 'investors.movementContribution',
  distribution: 'investors.movementDistribution',
  profit_paid: 'investors.movementProfitPaid',
  capital_withdrawal: 'investors.movementCapitalWithdrawal',
};

export const WITHDRAWAL_STATUS_LABEL: Record<WithdrawalStatus, PortalMessageKey> = {
  requested: 'investors.statusRequested',
  reviewed: 'investors.statusReviewed',
  approved: 'investors.statusApproved',
  paid: 'investors.statusPaid',
  rejected: 'investors.statusRejected',
};

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

/** A status is always a word with a tone behind it, never a colour alone (§24). */
export const WITHDRAWAL_STATUS_TONE: Record<WithdrawalStatus, Tone> = {
  requested: 'neutral',
  reviewed: 'info',
  approved: 'warning',
  paid: 'success',
  rejected: 'danger',
};

export const WITHDRAWAL_KIND_LABEL: Record<WithdrawalRow['kind'], PortalMessageKey> = {
  capital: 'investors.kindCapital',
  profit: 'investors.kindProfit',
};

export const DOCUMENT_KIND_LABEL: Record<DocumentRow['kind'], PortalMessageKey> = {
  kyc: 'investors.documentKindKyc',
  agreement: 'investors.documentKindAgreement',
  other: 'investors.documentKindOther',
};

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;

/**
 * A date as a reader wants it, from whatever the API sent.
 *
 * Business dates arrive as `YYYY-MM-DD`; `requestedAt` is a timestamp, whose Dhaka calendar
 * day is what a person means by "the day I asked" (invariant 8). Anything unreadable is
 * shown as it came rather than thrown, because a date that renders oddly is a smaller
 * failure than a statement that does not render.
 */
export function readableDate(value: string, locale: Locale): string {
  const day = ISO_DAY.exec(value)?.[1];
  if (day === undefined) return value;
  if (value.length > 10) {
    const instant = new Date(value);
    if (!Number.isNaN(instant.getTime())) return formatDate(businessDate(instant), { locale });
  }
  return formatDate(day, { locale });
}

/**
 * The whole history, as the console's investor screen reads it. An investor's statement is
 * a handful of rows a month, and the first question anyone asks of it is "everything".
 */
export const STATEMENT_FROM = '2000-01-01';
