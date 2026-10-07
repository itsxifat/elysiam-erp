import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { branches, organizations } from '../org/index.js';
import { primaryId, timestamps } from '../columns.js';

/**
 * Identity: users, sessions, credentials and memberships (architecture §6).
 *
 * This is the one schema where the tenancy model bends, and §5 exception 4 says
 * so explicitly: one person can work for three of the five brands with a
 * different role in each. A user row therefore belongs to no org, and adding
 * `org_id` to it would make that impossible.
 *
 * So `users`, `sessions`, `accounts`, `verifications` and `two_factors` are
 * global, and are declared in `GLOBAL_TABLES` so M01's guard does not flag
 * them. That declaration is the point: the guard is opt-out, so a global table
 * has to be argued for rather than quietly omitted.
 *
 * `memberships` and `membership_branches` are tenant tables and carry the
 * standard isolation policy, plus — for memberships — one extra policy so a
 * user can see their own rows across orgs. See the migration.
 *
 * Better Auth owns the shape of the first five tables. The field names here
 * match what it expects, verified by reading `getAuthTables()` from the library
 * rather than from documentation; the column names are snake_case per our
 * conventions, and the adapter maps between them.
 */
export const iam = pgSchema('iam');

/**
 * Membership roles (§6). `super_admin` is deliberately absent: it is global,
 * not a role held within one org, so it lives as a flag on the user.
 */
export const membershipRole = iam.enum('membership_role', [
  'org_admin',
  'sales',
  'accounts',
  'marketing',
  'hr',
  'branch_manager',
  'warehouse',
  'reseller',
  'investor',
]);

export const users = iam.table('users', {
  /** Text, not uuid: Better Auth generates and owns these ids. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),

  /** E.164. Resellers sign in with a phone and an OTP (§6). */
  phoneNumber: text('phone_number').unique(),
  phoneNumberVerified: boolean('phone_number_verified').notNull().default(false),

  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),

  /**
   * Global, not a membership role (§6). A super admin sees every org, which is
   * why it cannot be expressed as a row in a tenant table.
   */
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),

  isActive: boolean('is_active').notNull().default(true),

  /**
   * When this person last finished signing in, second factor included (gaps-users-auth).
   * Stamped by the auth bridge after Better Auth answers, for the staff screen: an admin
   * deciding whether an account is still used should not have to read the audit log.
   */
  lastSignInAt: timestamp('last_sign_in_at', { withTimezone: true, mode: 'date' }),

  /**
   * An owner (M31, D-473): a super admin who reaches this brand only by an owner sign-in
   * link — no password here, no membership, never on the Staff screen. Shown to everyone
   * but other owners as "Owner" in the brand's records. Set when the link first creates
   * the identity; never on an account that has a password or a role here.
   */
  isOwner: boolean('is_owner').notNull().default(false),
  ...timestamps,
});

export const sessions = iam.table(
  'sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    /**
     * The org switcher's choice (§6). Held in the session rather than a cookie
     * so it cannot be changed by the client without a server round trip that
     * re-checks membership.
     */
    activeOrgId: uuid('active_org_id').references(() => organizations.id, {
      onDelete: 'set null',
    }),

    /**
     * Opened by an owner sign-in link (M31, D-473). Its second factor was checked where
     * the link was minted, so the enrolment wall lets it through; it lasts two hours from
     * creation and is never extended, whatever the cookies say.
     */
    ownerLink: boolean('owner_link').notNull().default(false),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

export const accounts = iam.table(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Argon2 hash for credential logins. Never a plaintext secret (§25). */
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),
    scope: text('scope'),
    ...timestamps,
  },
  (table) => [index('accounts_user_idx').on(table.userId)],
);

export const verifications = iam.table(
  'verifications',
  {
    id: text('id').primaryKey(),
    /** An email address or a phone number, depending on the flow. */
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    ...timestamps,
  },
  (table) => [index('verifications_identifier_idx').on(table.identifier)],
);

export const twoFactors = iam.table(
  'two_factors',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** TOTP secret. Encrypted at rest by Better Auth (§25). */
    secret: text('secret').notNull(),
    /** Single-use recovery codes, for a lost authenticator. */
    backupCodes: text('backup_codes').notNull(),
    verified: boolean('verified').notNull().default(false),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
  },
  (table) => [index('two_factors_user_idx').on(table.userId)],
);

/**
 * Who may act in which org, and as what (§6).
 *
 * Tenant-scoped, so "list the users in this org" isolates like everything
 * else. The migration adds a second permissive policy for a user's own rows,
 * which is what lets the org switcher answer "which orgs may I enter" without
 * reading anyone else's memberships.
 */
export const memberships = iam.table(
  'memberships',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /**
     * Who granted this membership, when a person did (D-077). Null for a seed
     * or a fixture. Read by maker-checker: whoever granted a checker role —
     * and, while invites are not emailed (D-212), received that user's invite token —
     * may never be approved by them, directly or down the chain.
     */
    grantedBy: text('granted_by'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('memberships_org_user_role_idx').on(table.orgId, table.userId, table.role),
    index('memberships_org_idx').on(table.orgId),
    index('memberships_user_idx').on(table.userId),
    // The target of membership_branches' composite reference (D-047).
    unique('memberships_org_id_id_key').on(table.orgId, table.id),
    /**
     * Nobody is their own granter (D-077, the ledger audit's C2): a self-grant would cut
     * the lineage that keeps a person from approving their granter's requests.
     */
    check('memberships_not_self_granted', sql`${table.grantedBy} is distinct from ${table.userId}`),
  ],
);

/**
 * Branch scope, as rows rather than a uuid array.
 *
 * An array could not carry a foreign key, and this reference has to be the
 * composite kind from D-047 — otherwise one org could scope a membership to
 * another org's branch, which is the same class of hole as `locations`.
 * No rows for a membership means the whole org.
 */
export const membershipBranches = iam.table(
  'membership_branches',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /**
     * Deliberately not `.references(() => memberships.id)`. A tenant-to-tenant
     * reference must carry org_id or it can be satisfied by another org's row
     * (D-047) — the guard test caught this one before it was ever committed.
     */
    membershipId: uuid('membership_id').notNull(),
    branchId: uuid('branch_id').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('membership_branches_unique_idx').on(table.membershipId, table.branchId),
    index('membership_branches_org_idx').on(table.orgId),
    foreignKey({
      name: 'membership_branches_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'membership_branches_org_id_membership_id_fk',
      columns: [table.orgId, table.membershipId],
      foreignColumns: [memberships.orgId, memberships.id],
    }).onDelete('cascade'),
  ],
);

/**
 * The record of every sign-in reset an admin asked for (gaps-users-auth, D-402 to D-406).
 *
 * `invite` is a password link for someone who never set a password, `password` a link
 * that replaces a password, `two_factor` the removal of an enrolled second factor. A
 * reset of someone who can decide approvals at org tier waits for a second admin
 * (`pending_approval`, D-404); an approved password reset waits for the admin who asked
 * to collect its link (`approved`), for 24 hours. Every row is kept: it is also what the
 * reset limits count (D-402).
 *
 * Tenant-scoped: a reset is asked for in one brand, by that brand's admin, and only that
 * brand's admins should read it. Migration 0099 adds RLS, the grants (no DELETE) and the
 * trigger that holds the lifecycle.
 */
export const credentialResets = iam.table(
  'credential_resets',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    // Restrict, not cascade: a reset is evidence, and deleting a person must not erase
    // it (D-407). Migration 0100 replaced 0098's cascade.
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    requestedBy: text('requested_by').notNull(),
    reason: text('reason').notNull(),
    /** The `credential_reset` approval a second admin decides, when one was needed. */
    approvalRequestId: uuid('approval_request_id'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** For a link: when it stops working. Never the token itself. */
    linkExpiresAt: timestamp('link_expires_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (table) => [
    index('credential_resets_org_idx').on(table.orgId),
    index('credential_resets_org_user_idx').on(table.orgId, table.userId),
    index('credential_resets_org_requester_idx').on(table.orgId, table.requestedBy),
    /** One open reset per person and kind in a brand: a second ask waits for the first. */
    uniqueIndex('credential_resets_one_open_idx')
      .on(table.orgId, table.userId, table.kind)
      .where(sql`${table.status} in ('pending_approval', 'approved')`),
    check(
      'credential_resets_kind_known',
      sql`${table.kind} in ('invite', 'password', 'two_factor')`,
    ),
    check(
      'credential_resets_status_known',
      sql`${table.status} in ('pending_approval', 'approved', 'completed', 'rejected', 'cancelled', 'expired')`,
    ),
    /** Nobody resets their own sign-in (D-403). */
    check('credential_resets_not_self', sql`${table.requestedBy} <> ${table.userId}`),
    /** An invite is never approved: it is issued at once, and its issuer becomes the granter (D-406). */
    check(
      'credential_resets_invite_unapproved',
      sql`${table.kind} <> 'invite' or ${table.approvalRequestId} is null`,
    ),
    /** Waiting for a second admin means there is an approval to wait for. */
    check(
      'credential_resets_pending_has_approval',
      sql`${table.status} not in ('pending_approval', 'approved') or ${table.approvalRequestId} is not null`,
    ),
  ],
);

/**
 * Everyone who ever granted a person a role in a brand, or held a link that set their
 * password (D-077, D-406, the ledger audit's C2 and N6).
 *
 * `iam.memberships.granted_by` holds only the latest granter, so a re-grant or a reset
 * by a second admin used to drop the first from the lineage — and with it the rule that
 * a person never approves a request raised by whoever could have set their password.
 * This keeps every one of them. Append-only (migration 0101): INSERT and SELECT for
 * `erp_app`, never UPDATE or DELETE. The approvals lineage reads both.
 */
export const membershipGranters = iam.table(
  'membership_granters',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    grantedBy: text('granted_by').notNull(),
    /** `role_granted`, `link_issued` or `backfill`, for whoever reads the lineage later. */
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('membership_granters_org_idx').on(table.orgId),
    index('membership_granters_org_user_idx').on(table.orgId, table.userId),
    check('membership_granters_not_self', sql`${table.grantedBy} <> ${table.userId}`),
    check(
      'membership_granters_reason_known',
      sql`${table.reason} in ('role_granted', 'link_issued', 'backfill')`,
    ),
  ],
);

/**
 * The admins' trust votes (D-654, D-655): one row per admin vouching for one person.
 *
 * A person whom two thirds of the brand's admins (super admins and owners included) vouch
 * for may approve a request from someone in their grant lineage; nobody ever approves their
 * own. Whether a person is trusted is counted live from these rows and the active admins,
 * never stored. Insert and delete only (migration 0126): a vote is cast or withdrawn, never
 * changed, and both are audited in the same transaction.
 */
export const trustVotes = iam.table(
  'trust_votes',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    voterUserId: text('voter_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    candidateUserId: text('candidate_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('trust_votes_org_voter_candidate_idx').on(
      table.orgId,
      table.voterUserId,
      table.candidateUserId,
    ),
    index('trust_votes_org_idx').on(table.orgId),
    index('trust_votes_org_candidate_idx').on(table.orgId, table.candidateUserId),
    check('trust_votes_not_self', sql`${table.voterUserId} <> ${table.candidateUserId}`),
  ],
);

/**
 * Every owner sign-in link this brand has accepted, by its `jti` (M31, D-473).
 *
 * Global (identity, like `users`): a link names a brand by its audience, not an org row.
 * The route inserts the `jti` before it creates a session, `on conflict do nothing`, and
 * refuses the link when nothing was inserted: a link opens one session, once. Rows are
 * pruned a day after use by the worker; a link lives two minutes, so a pruned `jti` can
 * never be presented in time again.
 */
export const ownerLinkUses = iam.table(
  'owner_link_uses',
  {
    jti: text('jti').primaryKey(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('owner_link_uses_used_at_idx').on(table.usedAt)],
);
