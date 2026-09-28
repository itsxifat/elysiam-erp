import type { ApprovalStatus, ApprovalType } from '@elysium/contracts';

import { api } from '../api.js';

/**
 * `GET /v1/approvals` and `POST /v1/approvals/:id/decide`, typed to what the
 * server actually returns (§6, §23).
 *
 * Hand-written against the controller rather than taken from the generated
 * client, because M04's generator currently types every operation's result as
 * `unknown` — the OpenAPI document carries paths and abilities but not response
 * schemas yet. An `unknown` at the call site would be cast somewhere, and a cast
 * in a page component is a type that nobody maintains. When the generator emits
 * response types these interfaces are deleted and the import changes.
 *
 * **`amountPoisha` is a string and stays a string.** §23: amounts cross the wire
 * as decimal strings, never JSON numbers, because `JSON.parse` turns a
 * crore-scale poisha value into a double and loses the last digits. Parsing it to
 * a number here would undo that at the last possible moment, which is the worst
 * place for it — every screen downstream would look correct.
 *
 * `amountWithheld` is the other half of invariant 5: a caller without
 * `read:cost` receives no amount for a cost-valued type, and the flag is how the
 * UI knows to render "withheld" rather than an em dash that reads as zero.
 */

export interface ApprovalRow {
  readonly id: string;
  readonly type: ApprovalType;
  readonly status: ApprovalStatus;
  readonly requestedBy: string;
  readonly branchId: string | null;
  /** Integer poisha as a decimal string, or null (no amount, or withheld). */
  readonly amountPoisha: string | null;
  readonly amountWithheld: boolean;
  readonly thresholdChange: {
    readonly targetType: ApprovalType | null;
    readonly fromPoisha: string | null;
    readonly toPoisha: string | null;
  } | null;
  readonly decidedBy: string | null;
}

export interface ApprovalPage {
  readonly rows: readonly ApprovalRow[];
  readonly nextCursor: string | null;
}

export interface ApprovalListQuery {
  readonly status?: string | undefined;
  readonly type?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export function listApprovals(query: ApprovalListQuery): Promise<ApprovalPage> {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.status !== undefined) params.set('status', query.status);
  if (query.type !== undefined) params.set('type', query.type);
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  return api.get<ApprovalPage>(`/v1/approvals?${params.toString()}`);
}

/**
 * Decide one request.
 *
 * The body shape is `approvalDecisionSchema`'s and nothing else: `decision` is
 * `'approved' | 'rejected'` (the past tense, matching the stored status) and the
 * free-text field is `note`, not `reason`. Both are easy to get subtly wrong from
 * memory, and either mistake is a 400 that reads as a permissions problem.
 */
export function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<{ id: string; status: ApprovalStatus }> {
  return api.post<{ id: string; status: ApprovalStatus }>(`/v1/approvals/${id}/decide`, {
    decision,
    ...(note === undefined ? {} : { note }),
  });
}
