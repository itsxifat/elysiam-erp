import {
  boolean,
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
    ...timestamps,
  },
  (table) => [
    uniqueIndex('memberships_org_user_role_idx').on(table.orgId, table.userId, table.role),
    index('memberships_org_idx').on(table.orgId),
    index('memberships_user_idx').on(table.userId),
    // The target of membership_branches' composite reference (D-047).
    unique('memberships_org_id_id_key').on(table.orgId, table.id),
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
