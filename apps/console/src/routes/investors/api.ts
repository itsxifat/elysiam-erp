import { api } from '../../api.js';

/**
 * The `/v1/investors/*` endpoints, typed to what the server returns (§15, §23).
 *
 * Hand-written against the controller, like `../accounts/api.ts` and for the same
 * reason: M04's generated client types every response as `unknown` until the OpenAPI
 * document carries response schemas, and an `unknown` at the call site gets cast
 * somewhere — a cast in a page component is a type nobody maintains.
 *
 * **Every amount is a string here and stays a string.** §23 sends integer poisha as
 * a decimal string because `JSON.parse` turns a crore-scale value into a double and
 * silently drops its last digits — and investor capital is exactly the figure that
 * reaches crore scale. Parsing it to a number in the client would undo that at the
 * last possible moment, where every screen downstream would still look correct.
 * `<Money>` takes the string.
 *
 * **No document URL is ever a field.** A signed URL is a bearer token, so it is
 * fetched one click at a time from `documentUrl()` and never stored, cached or put
 * in a list response (§22, D-115).
 */

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
  readonly phoneMasked: string | null;
  readonly email: string | null;
  readonly shareBps: number;
  readonly status: 'active' | 'exited';
  readonly joinedOn: string;
  readonly notes: string | null;
  readonly position: Position;
}

export interface WalletAccountRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly branchId: string | null;
}

export interface InvestmentRow {
  readonly id: string;
  readonly investorId: string;
  readonly amountPoisha: string;
  readonly walletAccountId: string;
  readonly businessDate: string;
  readonly lockInUntil: string | null;
  readonly terms: string | null;
  readonly memo: string | null;
  readonly journalId: string;
}

export interface DistributionRow {
  readonly id: string;
  readonly periodStartsOn: string;
  readonly periodEndsOn: string;
  readonly totalPoisha: string;
  readonly basis: 'share_bps' | 'capital';
  readonly status: 'pending_approval' | 'declared' | 'rejected';
  readonly approvalId: string | null;
  readonly journalId: string | null;
  readonly declaredOn: string | null;
  readonly memo: string | null;
}

export interface DistributionDetail extends DistributionRow {
  readonly lines: readonly {
    readonly investorId: string;
    readonly investorCode: string;
    readonly investorName: string;
    readonly weight: string;
    readonly amountPoisha: string;
  }[];
}

export interface WithdrawalRow {
  readonly id: string;
  readonly investorId: string;
  readonly investorCode: string;
  readonly investorName: string;
  readonly kind: 'capital' | 'profit';
  readonly amountPoisha: string;
  readonly status: 'requested' | 'reviewed' | 'approved' | 'paid' | 'rejected';
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly walletAccountId: string | null;
  readonly approvalId: string | null;
  readonly journalId: string | null;
  readonly paidOn: string | null;
}

export interface DocumentRow {
  readonly id: string;
  readonly investorId: string;
  readonly investmentId: string | null;
  readonly kind: 'kyc' | 'agreement' | 'other';
  readonly title: string;
  /** The id only. The URL comes from `documentUrl()`, one request at a time. */
  readonly fileId: string;
  readonly uploadedAt: string;
}

export interface StatementEntry {
  readonly date: string;
  readonly kind: 'contribution' | 'distribution' | 'profit_paid' | 'capital_withdrawal';
  readonly amountPoisha: string;
  readonly reference: string;
  readonly journalId: string | null;
  readonly note: string | null;
}

export interface Statement {
  readonly investor: Omit<InvestorRow, 'position'>;
  readonly from: string;
  readonly to: string;
  readonly entries: readonly StatementEntry[];
  readonly position: Position;
}

export interface DeclaredDistribution {
  readonly distributionId: string;
  readonly status: string;
  readonly approvalId: string | null;
  readonly journalId: string | null;
  readonly totalPoisha: string;
  readonly lines: readonly { investorId: string; weight: string; amountPoisha: string }[];
}

export function listInvestors(includeExited = false): Promise<{ items: readonly InvestorRow[] }> {
  return api.get<{ items: readonly InvestorRow[] }>(
    `/v1/investors?includeExited=${String(includeExited)}`,
  );
}

export function getInvestor(investorId: string): Promise<InvestorRow> {
  return api.get<InvestorRow>(`/v1/investors/${investorId}`);
}

export function createInvestor(input: {
  code: string;
  name: string;
  joinedOn: string;
  shareBps: number;
  phone?: string;
  email?: string;
  notes?: string;
}): Promise<InvestorRow> {
  return api.post<InvestorRow>('/v1/investors', input);
}

/**
 * A portal sign-in an investor may be linked to (D-419): someone holding the `investor`
 * role in this brand. The email arrives masked; `linkedInvestorId` names the investor the
 * sign-in already belongs to, if any.
 */
export interface InvestorLoginOption {
  readonly userId: string;
  readonly name: string;
  readonly emailMasked: string;
  readonly linkedInvestorId: string | null;
}

export function listInvestorLogins(): Promise<{ items: readonly InvestorLoginOption[] }> {
  return api.get<{ items: readonly InvestorLoginOption[] }>('/v1/investors/login-options');
}

/** Link an investor to their portal sign-in (`update Investor`). */
export function linkInvestorLogin(investorId: string, userId: string): Promise<InvestorRow> {
  return api.patch<InvestorRow>(`/v1/investors/${investorId}`, { userId });
}

export function listWalletAccounts(): Promise<{ items: readonly WalletAccountRow[] }> {
  return api.get<{ items: readonly WalletAccountRow[] }>('/v1/investors/wallet-accounts');
}

export function listInvestments(investorId?: string): Promise<{ items: readonly InvestmentRow[] }> {
  const query = investorId === undefined ? '' : `?investorId=${investorId}`;
  return api.get<{ items: readonly InvestmentRow[] }>(`/v1/investors/investments${query}`);
}

export function recordInvestment(input: {
  investmentId: string;
  investorId: string;
  walletAccountId: string;
  amountPoisha: string;
  lockInUntil?: string;
  terms?: string;
  memo?: string;
}): Promise<{ investmentId: string; journalId: string; businessDate: string }> {
  return api.post<{ investmentId: string; journalId: string; businessDate: string }>(
    '/v1/investors/investments',
    input,
  );
}

export function listDistributions(): Promise<{ items: readonly DistributionRow[] }> {
  return api.get<{ items: readonly DistributionRow[] }>('/v1/investors/distributions');
}

export function getDistribution(distributionId: string): Promise<DistributionDetail> {
  return api.get<DistributionDetail>(`/v1/investors/distributions/${distributionId}`);
}

export function declareDistribution(input: {
  distributionId: string;
  month: string;
  totalPoisha: string;
  basis: 'share_bps' | 'capital';
  memo?: string;
}): Promise<DeclaredDistribution> {
  return api.post<DeclaredDistribution>('/v1/investors/distributions', input);
}

export function listWithdrawals(investorId?: string): Promise<{ items: readonly WithdrawalRow[] }> {
  const query = investorId === undefined ? '' : `?investorId=${investorId}`;
  return api.get<{ items: readonly WithdrawalRow[] }>(`/v1/investors/withdrawals${query}`);
}

export function requestWithdrawal(input: {
  withdrawalId: string;
  investorId: string;
  kind: 'capital' | 'profit';
  amountPoisha: string;
  reason?: string;
}): Promise<WithdrawalRow> {
  return api.post<WithdrawalRow>('/v1/investors/withdrawals', input);
}

export function reviewWithdrawal(
  withdrawalId: string,
  input: { walletAccountId: string; note?: string },
): Promise<WithdrawalRow> {
  return api.post<WithdrawalRow>(`/v1/investors/withdrawals/${withdrawalId}/review`, input);
}

export function payWithdrawal(withdrawalId: string): Promise<WithdrawalRow> {
  return api.post<WithdrawalRow>(`/v1/investors/withdrawals/${withdrawalId}/pay`, {});
}

export function listDocuments(investorId?: string): Promise<{ items: readonly DocumentRow[] }> {
  const query = investorId === undefined ? '' : `?investorId=${investorId}`;
  return api.get<{ items: readonly DocumentRow[] }>(`/v1/investors/documents${query}`);
}

/**
 * A fresh signed URL for one document.
 *
 * Called on click and never cached: the link expires, and a stale one in a React
 * Query cache reads to whoever clicks it as "the document is broken".
 */
export function documentUrl(
  documentId: string,
): Promise<{ documentId: string; title: string; url: string; expiresAt: string }> {
  return api.get<{ documentId: string; title: string; url: string; expiresAt: string }>(
    `/v1/investors/documents/${documentId}/download`,
  );
}

export function statement(
  investorId: string,
  range: { from: string; to: string },
): Promise<Statement> {
  return api.get<Statement>(
    `/v1/investors/${investorId}/statement?from=${range.from}&to=${range.to}`,
  );
}
