import { api } from '../../api.js';
import type { ReturnReason } from './returns-logic.js';

/**
 * Advances and return reasons over HTTP (M17), typed to what `advances.controller.ts`
 * returns. Hand-written for the reason `api.ts` gives. Every amount is a decimal string of
 * poisha, and `<Money>` takes it as it is.
 */

export const ADVANCE_METHODS = ['bkash', 'nagad', 'bank'] as const;
export type AdvanceMethod = (typeof ADVANCE_METHODS)[number];

export type AdvanceStatus =
  | 'pending'
  | 'rejected'
  | 'verified'
  | 'applied'
  | 'refund_due'
  | 'refunded'
  | 'forfeited'
  | 'voided';

// The fixed list of return reasons lives with the report's pure helpers, so a unit test can
// read it without loading the API client (and the environment it needs).
export { RETURN_REASONS, type ReturnReason } from './returns-logic.js';

export interface AdvanceRow {
  readonly id: string;
  readonly orderId: string;
  /** An agent's claim, or `sslcommerz`: a website payment the gateway validated (M34). */
  readonly method: AdvanceMethod | 'sslcommerz';
  readonly transactionRef: string;
  readonly amountPoisha: string;
  readonly appliedPoisha: string;
  readonly keptPoisha: string;
  /** Still held or owed back: what is neither applied nor kept (0 once it has ended). */
  readonly owedPoisha: string;
  readonly status: AdvanceStatus;
  readonly note: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly rejectReason: string | null;
  readonly walletAccountId: string | null;
  readonly settledAt: string | null;
  readonly refundRef: string | null;
}

export interface QueueRow extends AdvanceRow {
  readonly orderNo: string;
  readonly orderStatus: string;
  readonly codAmountPoisha: string;
  readonly walletName: string | null;
}

export function orderAdvances(orderId: string): Promise<{ items: readonly AdvanceRow[] }> {
  return api.get(`/v1/orders/${orderId}/advances`);
}

export function recordAdvance(
  orderId: string,
  input: {
    readonly method: AdvanceMethod;
    readonly transactionRef: string;
    readonly amountPoisha: string;
    readonly note?: string;
  },
): Promise<AdvanceRow> {
  return api.post(`/v1/orders/${orderId}/advances`, input);
}

export function advanceQueue(
  statuses: readonly AdvanceStatus[],
): Promise<{ items: readonly QueueRow[] }> {
  return api.get(`/v1/order-advances?status=${statuses.join(',')}`);
}

export function verifyAdvance(id: string, walletAccountId: string): Promise<AdvanceRow> {
  return api.post(`/v1/order-advances/${id}/verify`, { walletAccountId });
}

export function rejectAdvance(id: string, reason: string): Promise<AdvanceRow> {
  return api.post(`/v1/order-advances/${id}/reject`, { reason });
}

/** Undo a mistaken verification (D-236): a reversal journal, and the COD back up. */
export function voidAdvance(id: string, reason: string): Promise<AdvanceRow> {
  return api.post(`/v1/order-advances/${id}/void`, { reason });
}

export function refundAdvance(
  id: string,
  input: { readonly walletAccountId?: string; readonly refundRef?: string },
): Promise<AdvanceRow> {
  return api.post(`/v1/order-advances/${id}/refund`, input);
}

export interface ReturnReasonReport {
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly returns: number;
  readonly exchanges: number;
  readonly reasons: readonly {
    readonly reason: ReturnReason;
    readonly returns: number;
    readonly exchanges: number;
    readonly total: number;
    readonly shareBps: number;
  }[];
}

export function returnReasonReport(range: {
  readonly from: string;
  readonly to: string;
}): Promise<ReturnReasonReport> {
  return api.get(`/v1/orders/return-reasons?from=${range.from}&to=${range.to}`);
}
