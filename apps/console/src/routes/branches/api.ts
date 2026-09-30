import { api } from '../../api.js';

/**
 * The `/v1/pos/*` endpoints the branch screens read, typed to what the server
 * returns (M23; §14, §23).
 *
 * Hand-written against the controller, like `../accounts/api.ts`: the generated
 * client types these responses as `unknown` until integration regenerates it.
 *
 * **Every amount is a string and stays one** (§23): `<Money>` takes the string, and
 * nothing here is added up in the browser. **The cost fields are optional** —
 * `cogsPoisha` and `grossProfitPoisha` are stripped by the server for a role
 * without `read:cost` (D-014), so their absence is the permission, not a bug.
 */

export interface BranchRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly businessDate: string;
  readonly salesCount: number;
  readonly netSalesPoisha: string;
  readonly refundsPoisha: string;
  readonly openShifts: number;
  readonly openReviews: number;
  readonly closed: boolean;
}

export interface RegisterRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly cashWalletId: string;
  readonly bkashWalletId: string | null;
  readonly cardWalletId: string | null;
}

export interface BranchSummary {
  readonly branch: { readonly id: string; readonly code: string; readonly name: string };
  readonly salesCount: number;
  readonly heldCount: number;
  readonly grossPoisha: string;
  readonly discountPoisha: string;
  readonly netSalesPoisha: string;
  readonly returnsCount: number;
  readonly refundsPoisha: string;
  readonly netRevenuePoisha: string;
  readonly averageBasketPoisha: string;
  readonly tenders: {
    readonly cashPoisha: string;
    readonly bkashPoisha: string;
    readonly cardPoisha: string;
  };
  /** Present only for roles with `read:cost` (D-014). */
  readonly cogsPoisha?: string;
  readonly grossProfitPoisha?: string;
  readonly openShifts: number;
  readonly openReviews: number;
  readonly topSkus: readonly {
    readonly skuId: string;
    readonly skuCode: string;
    readonly name: string;
    readonly qty: number;
    readonly netPoisha: string;
  }[];
  readonly registers: readonly RegisterRow[];
}

export type HoldReason =
  | 'stock_shortfall'
  | 'price_mismatch'
  | 'discount_above_ceiling'
  | 'shift_closed'
  | 'outside_posting_window'
  | 'sku_unavailable'
  | 'sale_not_posted'
  | 'return_mismatch'
  | 'outside_shift';

export interface ReviewRow {
  readonly id: string;
  readonly branchId: string;
  readonly kind: 'sale' | 'return';
  readonly receiptNo: string;
  readonly amountPoisha: string;
  readonly occurredAt: string;
  readonly reasons: readonly HoldReason[];
  readonly status: 'open' | 'posted' | 'voided';
  readonly attempts: number;
}

export interface ShiftRow {
  readonly id: string;
  readonly registerCode: string;
  readonly shiftNo: number;
  readonly status: 'open' | 'closed';
  readonly openedAt: string;
  readonly businessDate: string;
  readonly openingFloatPoisha: string;
  readonly countedCashPoisha: string | null;
  readonly expectedCashPoisha: string | null;
  readonly variancePoisha: string | null;
}

export interface WalletClosing {
  readonly closingId: string;
  readonly walletId: string;
  readonly expectedPoisha: string;
  readonly countedPoisha: string;
  readonly variancePoisha: string;
  readonly status: 'balanced' | 'pending_approval' | 'posted';
  readonly approvalId: string | null;
}

export interface BranchClosingResult {
  readonly closingId: string;
  readonly businessDate: string;
  readonly salesCount: number;
  readonly netSalesPoisha: string;
  readonly wallets: readonly WalletClosing[];
}

export interface BranchClosingRow {
  readonly id: string;
  readonly businessDate: string;
  readonly salesCount: number;
  readonly netSalesPoisha: string;
  readonly refundsPoisha: string;
  readonly closedAt: string;
}

export interface BranchProfitAndLoss {
  readonly income: readonly { code: string; name: string; amountPoisha: string }[];
  readonly expense: readonly { code: string; name: string; amountPoisha: string }[];
  readonly incomePoisha: string;
  readonly expensePoisha: string;
  readonly netPoisha: string;
  readonly costWithheld: boolean;
}

export function listBranches(): Promise<{ items: readonly BranchRow[] }> {
  return api.get<{ items: readonly BranchRow[] }>('/v1/pos/branches');
}

export function branchSummary(
  branchId: string,
  range: { from: string; to: string },
): Promise<BranchSummary> {
  return api.get<BranchSummary>(
    `/v1/pos/branches/${branchId}/summary?from=${range.from}&to=${range.to}`,
  );
}

/**
 * M08's own branch P&L — this module does not compute a second one. The server
 * withholds cost-bearing accounts from a role without `read:cost` and says so with
 * `costWithheld` (D-014, D-085).
 */
export function branchProfitAndLoss(
  branchId: string,
  range: { from: string; to: string },
): Promise<BranchProfitAndLoss> {
  return api.get<BranchProfitAndLoss>(
    `/v1/accounts/reports/profit-and-loss?from=${range.from}&to=${range.to}&branchId=${branchId}`,
  );
}

export function listReviews(branchId: string): Promise<{ items: readonly ReviewRow[] }> {
  return api.get<{ items: readonly ReviewRow[] }>(
    `/v1/pos/reviews?branchId=${branchId}&status=open`,
  );
}

export function resolveReview(
  reviewId: string,
  input: { action: 'post' | 'void'; note: string },
): Promise<{ outcome: 'posted' | 'voided' | 'held'; reasons: readonly HoldReason[] }> {
  return api.post(`/v1/pos/reviews/${reviewId}/resolve`, input);
}

export function listShifts(
  branchId: string,
  range: { from: string; to: string },
): Promise<{ items: readonly ShiftRow[] }> {
  return api.get(`/v1/pos/shifts?branchId=${branchId}&from=${range.from}&to=${range.to}`);
}

export function listBranchClosings(
  branchId: string,
  range: { from: string; to: string },
): Promise<{ items: readonly BranchClosingRow[] }> {
  return api.get(`/v1/pos/branches/${branchId}/closings?from=${range.from}&to=${range.to}`);
}

export function closeBranchDay(
  branchId: string,
  input: {
    closingId: string;
    businessDate: string;
    counts: readonly { walletId: string; countedPoisha: string }[];
    note?: string;
  },
): Promise<BranchClosingResult> {
  return api.post<BranchClosingResult>(`/v1/pos/branches/${branchId}/closings`, input);
}

export function createRegister(input: {
  branchId: string;
  locationId: string;
  code: string;
  name: string;
  cashWalletId: string;
  bkashWalletId?: string | null;
  cardWalletId?: string | null;
}): Promise<RegisterRow> {
  return api.post<RegisterRow>('/v1/pos/registers', input);
}

/** Today and the first of this month, as Asia/Dhaka calendar dates (invariant 8). */
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
