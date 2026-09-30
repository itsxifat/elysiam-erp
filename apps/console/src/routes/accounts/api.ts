import type { UploadTicket, UploadedFile } from '@elysium/ui';

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
  readonly income: readonly ReportLine[];
  readonly expense: readonly ReportLine[];
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

/**
 * An upload ticket for a petty-cash receipt.
 *
 * Private, and the purpose the cash-entry endpoint checks: the server refuses a
 * receipt uploaded under any other purpose, and refuses to make this one public.
 */
export function receiptUploadTicket(input: {
  contentType: string;
  sizeBytes: number;
  originalName: string;
}): Promise<UploadTicket> {
  return api.post<UploadTicket>('/v1/files', {
    ...input,
    visibility: 'private',
    purpose: 'petty-cash-receipt',
  });
}

export function finalizeUpload(fileId: string): Promise<UploadedFile> {
  return api.post<UploadedFile>(`/v1/files/${fileId}/finalize`);
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

export function profitAndLoss(range: {
  from: string;
  to: string;
  branchId?: string | undefined;
}): Promise<ProfitAndLoss> {
  const branch = range.branchId === undefined ? '' : `&branchId=${range.branchId}`;
  return api.get<ProfitAndLoss>(
    `/v1/accounts/reports/profit-and-loss?from=${range.from}&to=${range.to}${branch}`,
  );
}

// --- transfers --------------------------------------------------------------------

export interface TransferResult {
  readonly transferId: string;
  readonly journalId: string;
  /** False when this id was already recorded: a retry, answered with the first result. */
  readonly created: boolean;
  readonly businessDate: string;
  readonly amountPoisha: string;
  readonly chargePoisha: string;
}

export function transfer(input: {
  transferId: string;
  fromWalletId: string;
  toWalletId: string;
  amountPoisha: string;
  chargePoisha: string;
  chargeAccountId?: string;
  memo?: string;
}): Promise<TransferResult> {
  return api.post<TransferResult>('/v1/accounts/transfers', input);
}

// --- M03's ledger reports ----------------------------------------------------------

export interface LedgerAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly class: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  readonly subtype: string;
  readonly normalBalance: 'debit' | 'credit';
  readonly branchId: string | null;
  readonly partyType: string | null;
  readonly isSystem: boolean;
  readonly isActive: boolean;
}

export function ledgerAccounts(): Promise<{
  items: readonly LedgerAccount[];
  costWithheld: boolean;
}> {
  return api.get('/v1/ledger/accounts');
}

export interface StatementLine {
  readonly journalId: string;
  readonly lineNo: number;
  readonly businessDate: string;
  readonly sourceType: string;
  readonly memo: string | null;
  readonly branchId: string | null;
  readonly partyType: string | null;
  readonly partyId: string | null;
  readonly debitPoisha: string;
  readonly creditPoisha: string;
  /** Running balance after this line, on the account's normal side. */
  readonly balancePoisha: string;
  /** Cash book only: the other accounts of the entry, by name. Never their amounts. */
  readonly against?: readonly { readonly code: string; readonly name: string }[];
}

export interface Statement {
  readonly account: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly subtype: string;
    readonly normalBalance: 'debit' | 'credit';
    readonly branchId: string | null;
  };
  readonly from: string | null;
  readonly to: string;
  readonly openingBalancePoisha: string;
  readonly totalDebitPoisha: string;
  readonly totalCreditPoisha: string;
  readonly closingBalancePoisha: string;
  /** The server stops at a line limit and says so, rather than paging silently. */
  readonly truncated: boolean;
  readonly items: readonly StatementLine[];
}

/** One wallet's cash book, by its ledger account id. */
export function cashBook(accountId: string, range: { from: string; to: string }) {
  return api.get<Statement>(
    `/v1/ledger/wallets/${accountId}/cash-book?from=${range.from}&to=${range.to}`,
  );
}

export function accountLedger(accountId: string, range: { from: string; to: string }) {
  return api.get<Statement>(
    `/v1/ledger/accounts/${accountId}/ledger?from=${range.from}&to=${range.to}`,
  );
}

export interface TrialBalance {
  readonly asOf: string;
  readonly items: readonly {
    readonly accountId: string;
    readonly code: string;
    readonly name: string;
    readonly class: LedgerAccount['class'];
    readonly subtype: string;
    readonly branchId: string | null;
    readonly debitPoisha: string;
    readonly creditPoisha: string;
    readonly balancePoisha: string;
  }[];
  readonly totalDebitPoisha: string;
  readonly totalCreditPoisha: string;
  /** Zero whenever the books are whole; the screen shows it rather than assuming it. */
  readonly differencePoisha: string;
  readonly costWithheld: boolean;
}

export function trialBalance(asOf: string): Promise<TrialBalance> {
  return api.get<TrialBalance>(`/v1/ledger/trial-balance?asOf=${asOf}`);
}

export interface DayBook {
  readonly from: string;
  readonly to: string;
  readonly truncated: boolean;
  readonly costWithheld: boolean;
  readonly items: readonly {
    readonly journalId: string;
    readonly businessDate: string;
    readonly sourceType: string;
    readonly sourceId: string;
    readonly memo: string | null;
    readonly reversesJournalId: string | null;
    readonly createdAt: string;
    readonly lines: readonly {
      readonly lineNo: number;
      readonly accountId: string;
      readonly accountCode: string;
      readonly accountName: string;
      readonly debitPoisha: string;
      readonly creditPoisha: string;
      readonly memo: string | null;
    }[];
  }[];
}

export function dayBook(range: { from: string; to: string }): Promise<DayBook> {
  return api.get<DayBook>(`/v1/ledger/day-book?from=${range.from}&to=${range.to}`);
}

// --- M08's statements ---------------------------------------------------------------

export interface ReportLine {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly amountPoisha: string;
}

export interface BalanceSheet {
  readonly asOf: string;
  readonly branchId: string | null;
  readonly assets: readonly ReportLine[];
  readonly liabilities: readonly ReportLine[];
  readonly equity: readonly ReportLine[];
  readonly assetsPoisha: string;
  readonly liabilitiesPoisha: string;
  readonly equityPoisha: string;
  /** Income less expenses to date, not yet moved to retained earnings. */
  readonly resultPoisha: string;
  /** Zero for a caller who sees every account; otherwise the value that was withheld. */
  readonly differencePoisha: string;
  readonly costWithheld: boolean;
}

export function balanceSheet(asOf: string, branchId?: string): Promise<BalanceSheet> {
  const branch = branchId === undefined ? '' : `&branchId=${branchId}`;
  return api.get<BalanceSheet>(`/v1/accounts/reports/balance-sheet?asOf=${asOf}${branch}`);
}

export interface Aging {
  readonly asOf: string;
  readonly side: 'payable' | 'receivable';
  readonly costWithheld: boolean;
  readonly items: readonly {
    readonly partyType: string;
    readonly partyId: string;
    readonly bucket0to7Poisha: string;
    readonly bucket8to30Poisha: string;
    readonly bucket31to60Poisha: string;
    readonly bucketOver60Poisha: string;
    readonly totalPoisha: string;
  }[];
}

export function aging(asOf: string, side: 'payable' | 'receivable'): Promise<Aging> {
  return api.get<Aging>(`/v1/accounts/reports/aging?asOf=${asOf}&side=${side}`);
}

// --- periods --------------------------------------------------------------------------

export interface Period {
  readonly id: string;
  /** `YYYY-MM`. */
  readonly month: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: 'open' | 'closed';
  readonly closedAt: string | null;
  readonly closedBy: string | null;
  readonly reopenedAt: string | null;
  readonly reopenApprovalId: string | null;
}

export function listPeriods(): Promise<{ items: readonly Period[] }> {
  return api.get('/v1/ledger/periods');
}

export function closePeriod(month: string): Promise<Period> {
  return api.post<Period>('/v1/ledger/periods/close', { month });
}

/** A reopen is maker-checker: this raises the approval, a second person decides it. */
export function requestReopen(input: {
  month: string;
  reason: string;
}): Promise<{ approvalId: string; status: string; periodId: string }> {
  return api.post('/v1/ledger/periods/reopen', input);
}

// --- consolidation (super admin) ------------------------------------------------------

export interface ConsolidatedWallets {
  readonly orgs: readonly {
    readonly orgId: string;
    readonly orgName: string;
    readonly totalPoisha: string;
    readonly bySubtype: Readonly<Record<string, string>>;
  }[];
  readonly totalPoisha: string;
}

export function consolidatedWallets(): Promise<ConsolidatedWallets> {
  return api.get<ConsolidatedWallets>('/v1/accounts/reports/consolidated-wallets');
}

export interface ConsolidatedProfitAndLoss {
  readonly from: string;
  readonly to: string;
  readonly orgs: readonly {
    readonly orgId: string;
    readonly orgName: string;
    readonly incomePoisha: string;
    readonly expensePoisha: string;
    readonly netPoisha: string;
  }[];
  readonly incomePoisha: string;
  readonly expensePoisha: string;
  readonly netPoisha: string;
}

export function consolidatedProfitAndLoss(range: {
  from: string;
  to: string;
}): Promise<ConsolidatedProfitAndLoss> {
  return api.get<ConsolidatedProfitAndLoss>(
    `/v1/accounts/reports/consolidated-profit-and-loss?from=${range.from}&to=${range.to}`,
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
