import { APPROVAL_STATUSES, type ApprovalStatus } from '@elysium/contracts';

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
