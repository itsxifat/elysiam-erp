import { APPROVAL_STATUSES, type ApprovalStatus, type ApprovalType } from '@elysium/contracts';

import type { ConsoleMessageKey } from '../i18n/messages.js';

/**
 * A status's word and its colour, in one place.
 *
 * Both halves matter and they have to agree. §24's floor is "a label beside every
 * status colour", so `StatusBadge` requires the word — and if the mapping from
 * status to tone lived at each call site, the approvals table and the approvals
 * dialog would eventually disagree about whether `cancelled` is a warning or a
 * neutral, on the same row.
 *
 * `Record<ApprovalStatus, …>` rather than a switch with a default, so adding a
 * sixth status to the enum is a compile error here instead of a badge that
 * silently renders grey.
 */

export const APPROVAL_STATUS_OPTIONS: readonly ApprovalStatus[] = APPROVAL_STATUSES;

const KEYS: Record<ApprovalStatus, ConsoleMessageKey> = {
  pending: 'approvals.status.pending',
  approved: 'approvals.status.approved',
  rejected: 'approvals.status.rejected',
  cancelled: 'approvals.status.cancelled',
  auto_approved: 'approvals.status.auto_approved',
};

const TONES: Record<ApprovalStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  // Warning, not neutral: pending is the state that needs somebody to act, and it
  // is the whole reason this screen exists.
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'neutral',
  // Info rather than success, because "the threshold let this through" is a
  // different fact from "a second person agreed", and an auditor reading the list
  // needs to see which one happened at a glance.
  auto_approved: 'info',
};

export function statusKey(status: ApprovalStatus): ConsoleMessageKey {
  return KEYS[status];
}

export function statusTone(status: ApprovalStatus) {
  return TONES[status];
}

/**
 * Each approval type's label.
 *
 * `Record<ApprovalType, …>` against the contract's list, so a type added there is
 * a compile error here until it has words — rather than a raw `wallet_adjustment`
 * reaching a person, which is what the table, the filter and the notifications
 * inbox all showed before.
 */
const TYPE_KEYS: Readonly<Record<ApprovalType, ConsoleMessageKey>> = {
  wallet_adjustment: 'approvals.type.wallet_adjustment',
  stock_write_off: 'approvals.type.stock_write_off',
  stock_gain: 'approvals.type.stock_gain',
  supplier_payment: 'approvals.type.supplier_payment',
  settlement_posting: 'approvals.type.settlement_posting',
  closing_variance: 'approvals.type.closing_variance',
  back_dated_entry: 'approvals.type.back_dated_entry',
  payroll_run: 'approvals.type.payroll_run',
  bonus_rule: 'approvals.type.bonus_rule',
  reseller_payout_batch: 'approvals.type.reseller_payout_batch',
  period_reopen: 'approvals.type.period_reopen',
  threshold_change: 'approvals.type.threshold_change',
  investor_distribution: 'approvals.type.investor_distribution',
  investor_withdrawal: 'approvals.type.investor_withdrawal',
  loan_repayment: 'approvals.type.loan_repayment',
  credential_reset: 'approvals.type.credential_reset',
  opening_stock_reopen: 'approvals.type.opening_stock_reopen',
  stock_in_hand_reversal: 'approvals.type.stock_in_hand_reversal',
};

/**
 * The words for a type, or the type itself.
 *
 * `string` rather than `ApprovalType` because a realtime payload's type is
 * whatever the server sent: a console running against a newer API must show the
 * raw word rather than blank the row.
 */
export function approvalTypeLabel(type: string, t: (key: ConsoleMessageKey) => string): string {
  const key = (TYPE_KEYS as Readonly<Record<string, ConsoleMessageKey>>)[type];
  return key === undefined ? type : t(key);
}
