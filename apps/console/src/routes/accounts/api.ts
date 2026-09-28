import { api } from '../../api.js';

/**
 * The `/v1/accounts/*` endpoints, typed to what the server returns (§7, §23).
 *
 * Hand-written against the controller, like `../api/approvals.ts` and for the same
 * reason: M04's generated client types every response as `unknown` until the
 * OpenAPI document carries response schemas, and an `unknown` at the call site gets
 * cast somewhere — a cast in a page component is a type nobody maintains.
 *
 * **Every amount is a string here and stays a string.** §23 sends integer poisha
 * as a decimal string because `JSON.parse` turns a crore-scale value into a double
 * and silently drops its last digits. Parsing it to a number in the client would
 * undo that at the last possible moment, where every screen downstream would still
 * look correct. `<Money>` takes the string.
 */

export interface WalletRow {
  readonly id: string;
  readonly ledgerAccountId: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly branchId: string | null;
  readonly provider: string | null;
  readonly accountRefMasked: string | null;
  readonly requiresDailyClosing: boolean;
  readonly isActive: boolean;
  /** Integer poisha, derived from the ledger on every read. */
  readonly balancePoisha: string;
}

export interface WalletList {
  readonly asOf: string;
  readonly items: readonly WalletRow[];
  readonly totalPoisha: string;
}

export interface CategoryRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly class: 'income' | 'expense';
  readonly subtype: string;
  readonly branchId: string | null;
}

export interface CashEntryRow {
  readonly id: string;
  readonly walletId: string;
  readonly branchId: string | null;
  readonly kind: 'cash_in' | 'cash_out' | 'petty_cash';
  readonly status: 'posted' | 'pending_approval' | 'rejected';
  readonly categoryAccountId: string;
  readonly categoryCode: string;
  readonly categoryName: string;
  readonly amountPoisha: string;
  readonly businessDate: string;
  readonly memo: string | null;
  /** The id only. A signed URL is minted by the files module, after it authorizes. */
  readonly receiptFileId: string | null;
  readonly approvalRequestId: string | null;
  readonly journalId: string | null;
}

export interface ClosingRow {
  readonly closingId: string;
  readonly walletId: string;
  readonly businessDate: string;
  readonly expectedPoisha: string;
  readonly countedPoisha: string;
  readonly variancePoisha: string;
  readonly status: 'balanced' | 'pending_approval' | 'posted' | 'rejected';
  readonly approvalId: string | null;
  readonly journalId: string | null;
}

export interface ProfitAndLoss {
  readonly from: string;
  readonly to: string;
  readonly income: readonly { code: string; name: string; amountPoisha: string }[];
  readonly expense: readonly { code: string; name: string; amountPoisha: string }[];
  readonly incomePoisha: string;
  readonly expensePoisha: string;
  readonly netPoisha: string;
  readonly costWithheld: boolean;
}

export interface CashEntryResult {
  readonly entryId: string;
  readonly status: 'posted' | 'pending_approval';
  readonly journalId: string | null;
  readonly approvalId: string | null;
  readonly businessDate: string;
  readonly amountPoisha: string;
}

export function listWallets(asOf?: string): Promise<WalletList> {
  const query = asOf === undefined ? '' : `?asOf=${asOf}`;
  return api.get<WalletList>(`/v1/accounts/wallets${query}`);
}

export function listCategories(): Promise<{ items: readonly CategoryRow[] }> {
  return api.get<{ items: readonly CategoryRow[] }>('/v1/accounts/categories');
}

export function listCashEntries(range: {
  from?: string;
  to: string;
}): Promise<{ items: readonly CashEntryRow[] }> {
  const params = new URLSearchParams({ to: range.to });
  if (range.from !== undefined) params.set('from', range.from);
  return api.get<{ items: readonly CashEntryRow[] }>(
    `/v1/accounts/cash-entries?${params.toString()}`,
  );
}

export function recordCashEntry(input: {
  entryId: string;
  walletId: string;
  kind: CashEntryRow['kind'];
  categoryAccountId: string;
  amountPoisha: string;
  receiptFileId?: string;
  memo?: string;
}): Promise<CashEntryResult> {
  return api.post<CashEntryResult>('/v1/accounts/cash-entries', input);
}

export function listClosings(range: {
  from?: string;
  to: string;
}): Promise<{ items: readonly ClosingRow[] }> {
  const params = new URLSearchParams({ to: range.to });
  if (range.from !== undefined) params.set('from', range.from);
  return api.get<{ items: readonly ClosingRow[] }>(`/v1/accounts/closings?${params.toString()}`);
}

export function recordClosing(input: {
  closingId: string;
  walletId: string;
  businessDate: string;
  countedPoisha: string;
  memo?: string;
}): Promise<ClosingRow> {
  return api.post<ClosingRow>('/v1/accounts/closings', input);
}

export function profitAndLoss(range: { from: string; to: string }): Promise<ProfitAndLoss> {
  return api.get<ProfitAndLoss>(
    `/v1/accounts/reports/profit-and-loss?from=${range.from}&to=${range.to}`,
  );
}

/**
 * Today, and the first of this month, as Asia/Dhaka calendar dates (invariant 8).
 *
 * `Intl` with an explicit time zone rather than `new Date().toISOString()`: the
 * browser's own zone is whatever the laptop is set to, and a staff member on a
 * flight would otherwise see yesterday's cash position as today's.
 */
export function dhakaToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function dhakaMonthStart(): string {
  return `${dhakaToday().slice(0, 7)}-01`;
}
