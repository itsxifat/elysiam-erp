/*
 * GENERATED FILE. Do not edit.
 *
 * Emitted from openapi.json by `pnpm api:client`. `pnpm check:api-client`
 * regenerates it into a scratch directory and fails the build if this copy
 * differs by a single byte, so an edit here is reverted by the next commit that
 * runs verify — change the contracts or the operation catalog instead.
 */

import type {
  ApprovalDecisionInput,
  ApprovalRequestInput,
  CashInInput,
  ClosePeriodInput,
  CreateUser,
  ReopenPeriodInput,
  SwitchOrg,
  ThresholdInput,
} from '@elysium/contracts';

import { request, type ApiRuntime, type RequestOptions } from '../runtime.js';

/** Every operation, with the ability its route declares (§6). */
export const OPERATIONS = {
  accountLedger: {
    method: 'GET',
    path: '/v1/ledger/accounts/{id}/ledger',
    ability: 'read:LedgerReport',
  },
  cashBook: { method: 'GET', path: '/v1/ledger/wallets/{id}/cash-book', ability: 'read:Wallet' },
  cashIn: { method: 'POST', path: '/v1/ledger/cash-in', ability: 'update:Wallet' },
  closePeriod: { method: 'POST', path: '/v1/ledger/periods/close', ability: 'update:LedgerPeriod' },
  createApproval: { method: 'POST', path: '/v1/approvals', ability: 'request:ApprovalRequest' },
  createDemoCostedItem: {
    method: 'POST',
    path: '/v1/demo/costed-items',
    ability: 'create:CostedItem',
  },
  createUser: { method: 'POST', path: '/v1/users', ability: 'create:User' },
  dayBook: { method: 'GET', path: '/v1/ledger/day-book', ability: 'read:LedgerReport' },
  decideApproval: {
    method: 'POST',
    path: '/v1/approvals/{id}/decide',
    ability: 'approve:ApprovalRequest',
  },
  getApproval: { method: 'GET', path: '/v1/approvals/{id}', ability: 'read:ApprovalRequest' },
  getV1FilesByIdDownload: {
    method: 'GET',
    path: '/v1/files/{id}/download',
    ability: 'read:FileObject',
  },
  getV1FilesContent: { method: 'GET', path: '/v1/files/content', ability: 'public' },
  getV1JobsFailed: { method: 'GET', path: '/v1/jobs/failed', ability: 'read:AuditLog' },
  healthLive: { method: 'GET', path: '/health/live', ability: 'public' },
  listApprovals: { method: 'GET', path: '/v1/approvals', ability: 'read:ApprovalRequest' },
  listDemoCostedItems: { method: 'GET', path: '/v1/demo/costed-items', ability: 'read:CostedItem' },
  listLedgerAccounts: { method: 'GET', path: '/v1/ledger/accounts', ability: 'read:LedgerReport' },
  listMyOrgs: { method: 'GET', path: '/v1/me/orgs', ability: 'authenticated' },
  listPeriods: { method: 'GET', path: '/v1/ledger/periods', ability: 'read:LedgerPeriod' },
  listWallets: { method: 'GET', path: '/v1/ledger/wallets', ability: 'read:Wallet' },
  loginBranding: { method: 'GET', path: '/v1/auth/login-branding', ability: 'public' },
  me: { method: 'GET', path: '/v1/me', ability: 'authenticated' },
  partyBalances: { method: 'GET', path: '/v1/ledger/party-balances', ability: 'read:LedgerReport' },
  postV1Files: { method: 'POST', path: '/v1/files', ability: 'create:FileObject' },
  postV1FilesByIdFinalize: {
    method: 'POST',
    path: '/v1/files/{id}/finalize',
    ability: 'create:FileObject',
  },
  putV1FilesContent: { method: 'PUT', path: '/v1/files/content', ability: 'public' },
  reopenPeriod: {
    method: 'POST',
    path: '/v1/ledger/periods/reopen',
    ability: 'update:LedgerPeriod',
  },
  setApprovalThresholds: {
    method: 'PUT',
    path: '/v1/approvals/thresholds',
    ability: 'update:ApprovalThreshold',
  },
  switchOrg: { method: 'POST', path: '/v1/me/active-org', ability: 'authenticated' },
  trialBalance: { method: 'GET', path: '/v1/ledger/trial-balance', ability: 'read:LedgerReport' },
} as const;

export type OperationName = keyof typeof OPERATIONS;

/**
 * The typed client.
 *
 * Return types are `unknown` wherever `packages/contracts` does not yet
 * describe the response. That is deliberate: a made-up response type would be
 * relied on by a frontend and would fail at runtime rather than at compile
 * time (follow-up F-M04-1).
 */
export function createApiClient(runtime: ApiRuntime) {
  return {
    /** Every posting to one account over a date range. */
    accountLedger: (
      input: {
        readonly path: { readonly id: string };
        readonly query: { readonly from?: string; readonly to: string };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.accountLedger, input, options),
    /** Movements through one wallet over a date range. */
    cashBook: (
      input: {
        readonly path: { readonly id: string };
        readonly query: { readonly from?: string; readonly to: string };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.cashBook, input, options),
    /** Record money received into a wallet. */
    cashIn: (input: { readonly body: CashInInput }, options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.cashIn, input, options),
    /** Close a month, locking every date up to its end. */
    closePeriod: (
      input: { readonly body: ClosePeriodInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.closePeriod, input, options),
    /** Raise an approval request for a money-moving action. */
    createApproval: (
      input: { readonly body: ApprovalRequestInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.createApproval, input, options),
    /** Test fixture for the permission matrix. Not deployed to production. */
    createDemoCostedItem: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.createDemoCostedItem, undefined, options),
    /** Invite a user into this organization with one or more roles. */
    createUser: (
      input: { readonly body: CreateUser },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.createUser, input, options),
    /** Every journal posted in a date range, newest first. */
    dayBook: (
      input: { readonly query: { readonly from: string; readonly to: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.dayBook, input, options),
    /** Approve or reject a request as the checker. */
    decideApproval: (
      input: { readonly path: { readonly id: string }; readonly body: ApprovalDecisionInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.decideApproval, input, options),
    /** One approval request, with its decision lineage. */
    getApproval: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getApproval, input, options),
    /** GET /v1/files/:id/download */
    getV1FilesByIdDownload: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.getV1FilesByIdDownload, input, options),
    /** GET /v1/files/content */
    getV1FilesContent: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1FilesContent, undefined, options),
    /** GET /v1/jobs/failed */
    getV1JobsFailed: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.getV1JobsFailed, undefined, options),
    /** Liveness probe. */
    healthLive: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.healthLive, undefined, options),
    /** Approval requests, filtered and cursor-paginated. */
    listApprovals: (
      input: {
        readonly query?: {
          readonly cursor?: string;
          readonly limit?: string;
          readonly status?: string;
          readonly type?: string;
        };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.listApprovals, input, options),
    /** Test fixture for the permission matrix. Not deployed to production. */
    listDemoCostedItems: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listDemoCostedItems, undefined, options),
    /** The chart of accounts visible to this caller. */
    listLedgerAccounts: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listLedgerAccounts, undefined, options),
    /** The organizations this user may enter. */
    listMyOrgs: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listMyOrgs, undefined, options),
    /** Accounting periods and whether each is closed. */
    listPeriods: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listPeriods, undefined, options),
    /** Cash, bank and mobile-money wallets with their balances. */
    listWallets: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.listWallets, undefined, options),
    /** The brand name and logo for the login screen, chosen by hostname. */
    loginBranding: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.loginBranding, undefined, options),
    /** The signed-in user, their roles and active org. */
    me: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.me, undefined, options),
    /** Outstanding balances per customer, supplier or reseller. */
    partyBalances: (
      input: {
        readonly query: {
          readonly asOf: string;
          readonly partyId?: string;
          readonly partyType?: string;
        };
      },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.partyBalances, input, options),
    /** POST /v1/files */
    postV1Files: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.postV1Files, undefined, options),
    /** POST /v1/files/:id/finalize */
    postV1FilesByIdFinalize: (
      input: { readonly path: { readonly id: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.postV1FilesByIdFinalize, input, options),
    /** PUT /v1/files/content */
    putV1FilesContent: (options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.putV1FilesContent, undefined, options),
    /** Ask to reopen a closed month. Needs an approval. */
    reopenPeriod: (
      input: { readonly body: ReopenPeriodInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.reopenPeriod, input, options),
    /** Set this organization's maker-checker thresholds. */
    setApprovalThresholds: (
      input: { readonly body: ThresholdInput },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.setApprovalThresholds, input, options),
    /** Enter an organization for the rest of this session. */
    switchOrg: (input: { readonly body: SwitchOrg }, options?: RequestOptions): Promise<unknown> =>
      request(runtime, OPERATIONS.switchOrg, input, options),
    /** Debit and credit totals per account as of a business date. */
    trialBalance: (
      input: { readonly query: { readonly asOf: string } },
      options?: RequestOptions,
    ): Promise<unknown> => request(runtime, OPERATIONS.trialBalance, input, options),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
