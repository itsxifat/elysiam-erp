import { request } from '../http.js';

/**
 * Everything the investor portal asks the API (M25, §15).
 *
 * Only reads, and only routes that already existed: the `investor` role holds `read
 * Investor` at `own` scope and nothing else, and each of these answers with the caller's own
 * rows (check 1 is the server's property; this file only asks). The shapes mirror the
 * controller, as the console's `routes/investors/api.ts` does.
 *
 * Two rules carried over from the console:
 *
 * - **Every amount stays a string.** Integer poisha cross the wire as decimal strings
 *   (§23) and go straight into `<Money>`; investor capital is exactly the figure that
 *   reaches crore scale, where a JavaScript number starts dropping digits.
 * - **No document URL is ever a field.** A signed URL is a bearer token, so it is asked for
 *   one click at a time with `documentUrl()` and never cached (§22, check 3).
 */

// --- session -------------------------------------------------------------------------

export interface AvailableOrg {
  readonly orgId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly roles: readonly string[];
}

export interface RequestContext {
  readonly userId: string;
  readonly orgId: string;
  readonly roles: readonly string[];
}

export interface EnrolmentResult {
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}

export const auth = {
  signIn: (email: string, password: string) =>
    request<{ twoFactorRedirect?: boolean }>('/api/auth/sign-in/email', {
      method: 'POST',
      body: { email, password },
    }),
  signOut: () => request<unknown>('/api/auth/sign-out', { method: 'POST' }),
  verifyTotp: (code: string) =>
    request<unknown>('/api/auth/two-factor/verify-totp', { method: 'POST', body: { code } }),
  verifyBackupCode: (code: string) =>
    request<unknown>('/api/auth/two-factor/verify-backup-code', {
      method: 'POST',
      body: { code },
    }),
  enrol: (password: string) =>
    request<EnrolmentResult>('/api/auth/two-factor/enable', {
      method: 'POST',
      body: { password, method: 'totp' },
    }),
  myOrgs: () => request<{ orgs: AvailableOrg[] }>('/v1/me/orgs'),
  me: () => request<RequestContext>('/v1/me'),
  setActiveOrg: (orgId: string) =>
    request<unknown>('/v1/me/active-org', { method: 'POST', body: { orgId } }),
};

// --- the investor's own rows ---------------------------------------------------------

export interface Position {
  readonly contributedPoisha: string;
  readonly capitalWithdrawnPoisha: string;
  readonly capitalPoisha: string;
  readonly lockedPoisha: string;
  readonly withdrawableCapitalPoisha: string;
  readonly declaredPoisha: string;
  readonly profitPaidPoisha: string;
  readonly payablePoisha: string;
}

export interface InvestorRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly userId: string | null;
  readonly status: 'active' | 'exited';
  readonly joinedOn: string;
  readonly position: Position;
}

export interface InvestmentRow {
  readonly id: string;
  readonly investorId: string;
  readonly amountPoisha: string;
  readonly businessDate: string;
  readonly lockInUntil: string | null;
}

export type WithdrawalStatus = 'requested' | 'reviewed' | 'approved' | 'paid' | 'rejected';

export interface WithdrawalRow {
  readonly id: string;
  readonly investorId: string;
  readonly kind: 'capital' | 'profit';
  readonly amountPoisha: string;
  readonly status: WithdrawalStatus;
  readonly requestedAt: string;
  readonly paidOn: string | null;
}

export interface DocumentRow {
  readonly id: string;
  readonly investorId: string;
  readonly kind: 'kyc' | 'agreement' | 'other';
  readonly title: string;
  readonly uploadedAt: string;
}

export type MovementKind = 'contribution' | 'distribution' | 'profit_paid' | 'capital_withdrawal';

export interface StatementEntry {
  readonly date: string;
  readonly kind: MovementKind;
  readonly amountPoisha: string;
  readonly reference: string;
}

export interface Statement {
  readonly from: string;
  readonly to: string;
  readonly entries: readonly StatementEntry[];
}

type Signal = AbortSignal | undefined;

export const investor = {
  /** The investor rows the caller may see; for the `investor` role, their own. */
  list: (signal?: Signal) => request<{ items: InvestorRow[] }>('/v1/investors', { signal }),
  investments: (investorId: string, signal?: Signal) =>
    request<{ items: InvestmentRow[] }>(`/v1/investors/investments?investorId=${investorId}`, {
      signal,
    }),
  withdrawals: (investorId: string, signal?: Signal) =>
    request<{ items: WithdrawalRow[] }>(`/v1/investors/withdrawals?investorId=${investorId}`, {
      signal,
    }),
  documents: (investorId: string, signal?: Signal) =>
    request<{ items: DocumentRow[] }>(`/v1/investors/documents?investorId=${investorId}`, {
      signal,
    }),
  statement: (investorId: string, range: { from: string; to: string }, signal?: Signal) =>
    request<Statement>(`/v1/investors/${investorId}/statement?from=${range.from}&to=${range.to}`, {
      signal,
    }),
  /** A fresh, short-lived signed URL for one document. Called on click, never cached. */
  documentUrl: (documentId: string) =>
    request<{ url: string; expiresAt: string }>(`/v1/investors/documents/${documentId}/download`),
};
