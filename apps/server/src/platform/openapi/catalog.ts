import {
  approvalDecisionSchema,
  callAttemptSchema,
  deskProfileSchema,
  markPrintedSchema,
  presenceBeatSchema,
  presencePauseSchema,
  workflowSettingsSchema,
  approvalListSchema,
  approvalRequestSchema,
  cashInSchema,
  closePeriodSchema,
  confirmWithCodeSchema,
  createUserSchema,
  credentialResetSchema,
  dateRangeSchema,
  dayBookQuerySchema,
  deactivateUserSchema,
  ERROR_CODES,
  inboxAddressSchema,
  inboxChannelUpdateSchema,
  inboxHandOverSchema,
  inboxInterestSchema,
  inboxMetaAppSchema,
  inboxNoteSchema,
  inboxPhoneSchema,
  inboxReplySchema,
  inboxStageSchema,
  inboxTagsSchema,
  packingCameraCreateSchema,
  packingCameraUpdateSchema,
  partyBalanceQuerySchema,
  reopenPeriodSchema,
  replacementCodeSchema,
  setRolesSchema,
  switchOrgSchema,
  thresholdSchema,
  trialBalanceQuerySchema,
  twoFactorPolicySchema,
  updateProfileSchema,
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
  'GET /v1/users': {
    operationId: 'listUsers',
    summary: "This organization's staff, their roles and sign-in state, and open resets.",
  },
  'PUT /v1/users/:id/roles': {
    operationId: 'setUserRoles',
    summary: "Replace a person's roles and branch scope in this organization.",
    body: named('SetRoles', setRolesSchema, 'SetRoles'),
  },
  'POST /v1/users/:id/deactivate': {
    operationId: 'deactivateUser',
    summary: 'Switch a leaver off here: their roles end, and so do their sessions.',
    body: named('DeactivateUser', deactivateUserSchema, 'DeactivateUser'),
  },
  'POST /v1/users/:id/password-link': {
    operationId: 'userPasswordLink',
    summary: 'Issue, ask for, or collect a one-time link that sets a password.',
    body: named('CredentialReset', credentialResetSchema, 'CredentialResetInput'),
  },
  'POST /v1/users/:id/two-factor/reset': {
    operationId: 'resetUserTwoFactor',
    summary: "Remove a person's second factor, so they enrol again at next sign-in.",
    body: named('CredentialReset', credentialResetSchema, 'CredentialResetInput'),
  },
  'POST /v1/users/:id/trust': {
    operationId: 'voteUserTrust',
    summary: 'Vouch for an admin: two thirds of the independent admins make them trusted.',
  },
  'DELETE /v1/users/:id/trust': {
    operationId: 'withdrawUserTrust',
    summary: 'Withdraw your trust vote for an admin.',
  },
  'POST /v1/users/:id/super-admin': {
    operationId: 'voteSuperAdmin',
    summary:
      'Say yes to making an admin a super admin: at once while there is one super admin, else when all have.',
  },
  'DELETE /v1/users/:id/super-admin': {
    operationId: 'withdrawSuperAdminNomination',
    summary: 'Withdraw a pending super admin nomination.',
  },
  'POST /v1/users/:id/super-admin-removal': {
    operationId: 'voteSuperAdminRemoval',
    summary:
      'Say yes to removing a super admin: the first starts it; it removes when every other super admin has.',
  },
  'DELETE /v1/users/:id/super-admin-removal': {
    operationId: 'withdrawSuperAdminRemoval',
    summary: 'Withdraw a pending super admin removal.',
  },
  'POST /v1/users/me/step-down': {
    operationId: 'stepDownSuperAdmin',
    summary: 'Give up your own super admin power at once; never the last super admin.',
  },
  'POST /v1/users/:id/two-factor/turn-off': {
    operationId: 'turnOffUserTwoFactor',
    summary: "Turn a person's two-step sign-in off, where no role of theirs requires it.",
    body: named('CredentialReset', credentialResetSchema, 'CredentialResetInput'),
  },
  'POST /v1/users/:id/sign-out-everywhere': {
    operationId: 'signOutUserEverywhere',
    summary: "End a person's sessions: everywhere, or in this brand for someone in another.",
  },

  // M40: My account and Settings → Security.
  'GET /v1/account': {
    operationId: 'getMyAccount',
    summary: 'Your name, roles here, and two-step sign-in: on or off, and whether it is required.',
  },
  'PATCH /v1/account/profile': {
    operationId: 'updateMyProfile',
    summary: 'Change the name you go by.',
    body: named('UpdateProfile', updateProfileSchema, 'UpdateProfile'),
  },
  'GET /v1/account/sessions': {
    operationId: 'listMySessions',
    summary: 'The devices you are signed in on, with the address partly hidden.',
  },
  'DELETE /v1/account/sessions/:id': {
    operationId: 'endMySession',
    summary: 'Sign one of your other devices out.',
  },
  'POST /v1/account/sessions/sign-out-others': {
    operationId: 'endMyOtherSessions',
    summary: 'Sign out every device but this one.',
  },
  'POST /v1/account/two-factor/replace': {
    operationId: 'startTwoFactorReplacement',
    summary: 'With your password and a current code, start moving two-step sign-in to a new phone.',
    body: named('ConfirmWithCode', confirmWithCodeSchema, 'ConfirmWithCode'),
  },
  'POST /v1/account/two-factor/replace/confirm': {
    operationId: 'confirmTwoFactorReplacement',
    summary:
      "Finish moving two-step sign-in with the new phone's code; the old phone stops working.",
    body: named('ReplacementCode', replacementCodeSchema, 'ReplacementCode'),
  },
  'POST /v1/account/two-factor/recovery-codes': {
    operationId: 'newMyRecoveryCodes',
    summary:
      'With your password and a current authenticator code, make ten new recovery codes; the old ones stop working.',
    body: named('ConfirmWithCode', confirmWithCodeSchema, 'ConfirmWithCode'),
  },
  'POST /v1/account/two-factor/turn-off': {
    operationId: 'turnOffMyTwoFactor',
    summary:
      'With your password and a current code, turn two-step sign-in off where nothing requires it.',
    body: named('ConfirmWithCode', confirmWithCodeSchema, 'ConfirmWithCode'),
  },
  'GET /v1/security/two-factor-policy': {
    operationId: 'getTwoFactorPolicy',
    summary: 'Which roles must use two-step sign-in in this brand (super admins only).',
  },
  'PUT /v1/security/two-factor-policy': {
    operationId: 'setTwoFactorPolicy',
    summary: 'Choose which roles must use two-step sign-in in this brand (super admins only).',
    body: named('TwoFactorPolicy', twoFactorPolicySchema, 'TwoFactorPolicyInput'),
  },

  // M41: the order workflow, presence and desk profiles.
  'POST /v1/team/presence': {
    operationId: 'reportPresence',
    summary: 'The console reports whether its tab is visible and how long since the last input.',
    body: named('PresenceBeat', presenceBeatSchema, 'PresenceBeat'),
  },
  'POST /v1/team/presence/pause': {
    operationId: 'setNotTakingOrders',
    summary: 'Switch "Not taking orders" on or off for yourself.',
    body: named('PresencePause', presencePauseSchema, 'PresencePause'),
  },
  'GET /v1/team/me': {
    operationId: 'getMyDesk',
    summary: 'Your presence and your desk profile.',
  },
  'GET /v1/team/profiles': {
    operationId: 'listDeskProfiles',
    summary: "Every staff member's work types and hub, with their presence.",
  },
  'PUT /v1/team/profiles/:userId': {
    operationId: 'saveDeskProfile',
    summary: "Set a staff member's work types and hub location.",
    body: named('DeskProfile', deskProfileSchema, 'DeskProfileInput'),
  },
  'POST /v1/orders/:id/release': {
    operationId: 'releaseOrder',
    summary: 'Put an order back in the unassigned queue (its owner or a supervisor).',
  },
  'POST /v1/orders/:id/calls': {
    operationId: 'logOrderCall',
    summary: 'Record one verification call to the buyer.',
    body: named('CallAttempt', callAttemptSchema, 'CallAttemptInput'),
  },
  'GET /v1/orders/:id/calls': {
    operationId: 'listOrderCalls',
    summary: "An order's verification calls, newest first.",
  },
  'POST /v1/orders/mark-printed': {
    operationId: 'markSlipsPrinted',
    summary: "The hub printed these confirmed orders' slips.",
    body: named('MarkPrinted', markPrintedSchema, 'MarkPrintedInput'),
  },
  'GET /v1/orders/offers/mine': {
    operationId: 'myOrderOffers',
    summary: 'The orders offered to you right now, with their countdown.',
  },
  'POST /v1/orders/offers/:id/accept': {
    operationId: 'acceptOrderOffer',
    summary: 'Accept an offered order: it is yours if nobody took it first.',
  },
  'POST /v1/orders/offers/:id/decline': {
    operationId: 'declineOrderOffer',
    summary: 'Decline an offered order; it goes to the next person.',
  },
  'GET /v1/orders/workflow-settings': {
    operationId: 'getWorkflowSettings',
    summary: 'Auto-assign, the offer countdown and the cap on open orders per person.',
  },
  'PUT /v1/orders/workflow-settings': {
    operationId: 'saveWorkflowSettings',
    summary: 'Change auto-assign, the offer countdown and the cap on open orders per person.',
    body: named('WorkflowSettings', workflowSettingsSchema, 'WorkflowSettingsInput'),
  },
  'GET /v1/orders/team-board': {
    operationId: 'teamBoard',
    summary: "Who is active, idle or away, their open orders, today's confirmations and offers.",
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

  // M38c: the packing tables' IP cameras (D-668, D-669).
  'GET /v1/packing/cameras': {
    operationId: 'listPackingCameras',
    summary: "The packing tables' IP cameras and whether each is filming now.",
  },
  'POST /v1/packing/cameras': {
    operationId: 'addPackingCamera',
    summary: 'Add an IP camera over a packing table. Its password is sealed and never returned.',
    body: named('PackingCameraCreate', packingCameraCreateSchema, 'PackingCameraCreateInput'),
  },
  'DELETE /v1/packing/cameras/:id': {
    operationId: 'deletePackingCamera',
    summary: 'Delete a packing camera from use; past videos keep playing.',
  },
  'GET /v1/packing/cameras/:id/preview': {
    operationId: 'packingCameraPreview',
    summary: "The newest JPEG frame of a packing camera's live preview; 204 when none is live.",
  },
  'PUT /v1/packing/cameras/:id': {
    operationId: 'updatePackingCamera',
    summary: 'Change a packing camera, switch it off, or replace or remove its password.',
    body: named('PackingCameraUpdate', packingCameraUpdateSchema, 'PackingCameraUpdateInput'),
  },

  // M42: the unified inbox (D-730 to D-749).
  'GET /v1/inbox/conversations': {
    operationId: 'listInboxConversations',
    summary: 'Every channel in one list: mine, unassigned or all, by channel, stage and unread.',
  },
  'GET /v1/inbox/conversations/:id': {
    operationId: 'getInboxConversation',
    summary: 'A conversation, its reply window, and its messages (older pages by `before`).',
  },
  'GET /v1/inbox/conversations/:id/panel': {
    operationId: 'getInboxPanel',
    summary:
      'The customer panel: phones found in the chat, the address, the matched customer and their orders, notes, interests, tags and stage.',
  },
  'GET /v1/inbox/conversations/:id/order-draft': {
    operationId: 'getInboxOrderDraft',
    summary: "The order desk's new-order form, prefilled from the chat.",
  },
  'GET /v1/inbox/team': {
    operationId: 'listInboxTeam',
    summary: 'Who can be handed a conversation: active sales and org admins.',
  },
  'GET /v1/inbox/phone-flags': {
    operationId: 'getInboxPhoneFlags',
    summary: 'Whether a phone belongs to a contact marked fraud, for the order desk.',
  },
  'POST /v1/inbox/conversations/:id/take': {
    operationId: 'takeInboxConversation',
    summary: "Take a conversation; someone else's needs x-acknowledge-owner: 1.",
  },
  'POST /v1/inbox/conversations/:id/release': {
    operationId: 'releaseInboxConversation',
    summary: 'Release a conversation back to Unassigned.',
  },
  'POST /v1/inbox/conversations/:id/hand-over': {
    operationId: 'handOverInboxConversation',
    summary: "Hand a conversation to a colleague; someone else's is a supervisor's.",
    body: named('InboxHandOver', inboxHandOverSchema, 'InboxHandOverInput'),
  },
  'POST /v1/inbox/conversations/:id/close': {
    operationId: 'closeInboxConversation',
    summary: 'Close a conversation; a new message reopens it.',
  },
  'POST /v1/inbox/conversations/:id/reopen': {
    operationId: 'reopenInboxConversation',
    summary: 'Reopen a closed conversation.',
  },
  'POST /v1/inbox/conversations/:id/read': {
    operationId: 'readInboxConversation',
    summary: 'The owner has read it: the unread count goes to zero.',
  },
  'POST /v1/inbox/conversations/:id/messages': {
    operationId: 'replyInInboxConversation',
    summary:
      'Reply. Refused outside the 24-hour window (INBOX_WINDOW_CLOSED); sent by a job after the commit.',
    body: named('InboxReply', inboxReplySchema, 'InboxReplyInput'),
  },
  'PUT /v1/inbox/conversations/:id/contact/phone': {
    operationId: 'saveInboxContactPhone',
    summary: "Save the contact's phone; links the brand's buyer with that number.",
    body: named('InboxPhone', inboxPhoneSchema, 'InboxPhoneInput'),
  },
  'PUT /v1/inbox/conversations/:id/contact/address': {
    operationId: 'saveInboxContactAddress',
    summary: "Save the contact's address: district, thana, area and line.",
    body: named('InboxAddress', inboxAddressSchema, 'InboxAddressInput'),
  },
  'PUT /v1/inbox/conversations/:id/contact/stage': {
    operationId: 'setInboxContactStage',
    summary:
      'Mark the contact a lead, not qualified or fraud, or hand the stage back to the rules.',
    body: named('InboxStage', inboxStageSchema, 'InboxStageInput'),
  },
  'PUT /v1/inbox/conversations/:id/contact/tags': {
    operationId: 'setInboxContactTags',
    summary: "Replace the contact's tags.",
    body: named('InboxTags', inboxTagsSchema, 'InboxTagsInput'),
  },
  'POST /v1/inbox/conversations/:id/notes': {
    operationId: 'addInboxNote',
    summary: 'A dated note on the contact, signed by its author.',
    body: named('InboxNote', inboxNoteSchema, 'InboxNoteInput'),
  },
  'POST /v1/inbox/conversations/:id/interests': {
    operationId: 'addInboxInterest',
    summary: 'A product (and optionally a size) the contact asked about.',
    body: named('InboxInterest', inboxInterestSchema, 'InboxInterestInput'),
  },
  'DELETE /v1/inbox/conversations/:id/interests/:interestId': {
    operationId: 'removeInboxInterest',
    summary: 'Remove a product interest.',
  },
  'GET /v1/inbox/channels': {
    operationId: 'listInboxChannels',
    summary: "Settings → Inbox: each channel's id and whether its token is set (never the token).",
  },
  'PUT /v1/inbox/channels/:kind': {
    operationId: 'saveInboxChannel',
    summary: 'Save a channel: its Meta id, on or off, and (write-only) its token.',
    body: named('InboxChannelUpdate', inboxChannelUpdateSchema, 'InboxChannelUpdateInput'),
  },
  'PUT /v1/inbox/meta-app': {
    operationId: 'saveInboxMetaApp',
    summary: "Save the Meta app's secret and the webhook's verify token (write-only).",
    body: named('InboxMetaApp', inboxMetaAppSchema, 'InboxMetaAppInput'),
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
