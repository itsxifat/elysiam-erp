import {
  approvalDecisionSchema,
  approvalListSchema,
  approvalRequestSchema,
  cashInSchema,
  closePeriodSchema,
  createUserSchema,
  dateRangeSchema,
  dayBookQuerySchema,
  ERROR_CODES,
  partyBalanceQuerySchema,
  reopenPeriodSchema,
  switchOrgSchema,
  thresholdSchema,
  trialBalanceQuerySchema,
} from '@elysium/contracts';
import { z } from 'zod';

/**
 * What each route sends and expects, bound to the Zod schemas that already
 * validate it (architecture §23).
 *
 * §23 says the OpenAPI document is generated *from the contracts*, and this is
 * the join: the document's request schemas are the very objects the server
 * validates with, so a published schema cannot drift looser than the check. The
 * older way round — hand-written OpenAPI — drifts silently, and the client
 * generated from it is then confidently wrong.
 *
 * Deliberately *not* the list of routes. The route list comes from Nest's own
 * container at generation time (`describeRoutes`), so a new endpoint appears in
 * the document whether or not anybody remembered this file; it simply appears
 * with an untyped body until an entry is added. A catalog that was also the
 * route list would let a route ship undocumented and invisible.
 */

/** A schema published under a name in `components.schemas`. */
export interface NamedSchema {
  /** The component name, e.g. `CashIn`. */
  readonly name: string;
  readonly schema: z.ZodType;
  /**
   * The type `@elysium/contracts` exports for this schema, e.g. `CashInInput`.
   *
   * Carried into the document as an extension so the client generator can type
   * a body as the contract's own inferred type. Emitting TypeScript from the
   * JSON Schema instead would *lose* information — a branded poisha string
   * would come back as `string`, and the whole point of invariant 1 is that
   * those are not interchangeable.
   */
  readonly type?: string;
}

export interface OperationSpec {
  /** Stable across regenerations; the client's method name comes from it. */
  readonly operationId: string;
  readonly summary: string;
  readonly body?: NamedSchema;
  readonly query?: NamedSchema;
}

const named = (name: string, schema: z.ZodType, type?: string): NamedSchema => ({
  name,
  schema,
  ...(type === undefined ? {} : { type }),
});

/**
 * RFC 9457 problem details, as a schema, so the document enumerates every
 * error code a client may receive.
 *
 * Built from `ERROR_CODES` rather than typed out, which means adding a code to
 * `errors.ts` publishes it — and a generated client can narrow on the union
 * instead of comparing strings. `errors.ts` says the codes are append-only, and
 * this is where that promise becomes visible to the people relying on it.
 */
export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.enum(ERROR_CODES),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .describe('RFC 9457 problem details. `code` is the stable value clients branch on.');

/**
 * `METHOD /path` → what it takes.
 *
 * Keys are exactly the keys `route-matrix.manifest.ts` uses, so the two lists
 * can be read side by side and a route present in one but not the other is a
 * one-line diff rather than a hunt.
 */
export const OPERATION_CATALOG: Readonly<Record<string, OperationSpec>> = {
  'GET /health/live': { operationId: 'healthLive', summary: 'Liveness probe.' },
  'GET /health/ready': { operationId: 'healthReady', summary: 'Readiness probe.' },

  'GET /v1/auth/login-branding': {
    operationId: 'loginBranding',
    summary: 'The brand name and logo for the login screen, chosen by hostname.',
  },

  'GET /v1/me': { operationId: 'me', summary: 'The signed-in user, their roles and active org.' },
  'GET /v1/me/orgs': {
    operationId: 'listMyOrgs',
    summary: 'The organizations this user may enter.',
  },
  'POST /v1/me/active-org': {
    operationId: 'switchOrg',
    summary: 'Enter an organization for the rest of this session.',
    body: named('SwitchOrg', switchOrgSchema, 'SwitchOrg'),
  },
  'POST /v1/users': {
    operationId: 'createUser',
    summary: 'Invite a user into this organization with one or more roles.',
    body: named('CreateUser', createUserSchema, 'CreateUser'),
  },

  'GET /v1/approvals': {
    operationId: 'listApprovals',
    summary: 'Approval requests, filtered and cursor-paginated.',
    query: named('ApprovalList', approvalListSchema),
  },
  'GET /v1/approvals/:id': {
    operationId: 'getApproval',
    summary: 'One approval request, with its decision lineage.',
  },
  'POST /v1/approvals': {
    operationId: 'createApproval',
    summary: 'Raise an approval request for a money-moving action.',
    body: named('ApprovalRequest', approvalRequestSchema, 'ApprovalRequestInput'),
  },
  'POST /v1/approvals/:id/decide': {
    operationId: 'decideApproval',
    summary: 'Approve or reject a request as the checker.',
    body: named('ApprovalDecision', approvalDecisionSchema, 'ApprovalDecisionInput'),
  },
  'PUT /v1/approvals/thresholds': {
    operationId: 'setApprovalThresholds',
    summary: "Set this organization's maker-checker thresholds.",
    body: named('ApprovalThreshold', thresholdSchema, 'ThresholdInput'),
  },

  'GET /v1/ledger/accounts': {
    operationId: 'listLedgerAccounts',
    summary: 'The chart of accounts visible to this caller.',
  },
  'GET /v1/ledger/accounts/:id/ledger': {
    operationId: 'accountLedger',
    summary: 'Every posting to one account over a date range.',
    query: named('DateRange', dateRangeSchema),
  },
  'GET /v1/ledger/trial-balance': {
    operationId: 'trialBalance',
    summary: 'Debit and credit totals per account as of a business date.',
    query: named('TrialBalanceQuery', trialBalanceQuerySchema),
  },
  'GET /v1/ledger/party-balances': {
    operationId: 'partyBalances',
    summary: 'Outstanding balances per customer, supplier or reseller.',
    query: named('PartyBalanceQuery', partyBalanceQuerySchema),
  },
  'GET /v1/ledger/day-book': {
    operationId: 'dayBook',
    summary: 'Every journal posted in a date range, newest first.',
    query: named('DayBookQuery', dayBookQuerySchema),
  },
  'GET /v1/ledger/wallets': {
    operationId: 'listWallets',
    summary: 'Cash, bank and mobile-money wallets with their balances.',
  },
  'GET /v1/ledger/wallets/:id/cash-book': {
    operationId: 'cashBook',
    summary: 'Movements through one wallet over a date range.',
    query: named('DateRange', dateRangeSchema),
  },
  'POST /v1/ledger/cash-in': {
    operationId: 'cashIn',
    summary: 'Record money received into a wallet.',
    body: named('CashIn', cashInSchema, 'CashInInput'),
  },
  'GET /v1/ledger/periods': {
    operationId: 'listPeriods',
    summary: 'Accounting periods and whether each is closed.',
  },
  'POST /v1/ledger/periods/close': {
    operationId: 'closePeriod',
    summary: 'Close a month, locking every date up to its end.',
    body: named('ClosePeriod', closePeriodSchema, 'ClosePeriodInput'),
  },
  'POST /v1/ledger/periods/reopen': {
    operationId: 'reopenPeriod',
    summary: 'Ask to reopen a closed month. Needs an approval.',
    body: named('ReopenPeriod', reopenPeriodSchema, 'ReopenPeriodInput'),
  },

  'GET /v1/demo/costed-items': {
    operationId: 'listDemoCostedItems',
    summary: 'Test fixture for the permission matrix. Not deployed to production.',
  },
  'POST /v1/demo/costed-items': {
    operationId: 'createDemoCostedItem',
    summary: 'Test fixture for the permission matrix. Not deployed to production.',
  },
};
