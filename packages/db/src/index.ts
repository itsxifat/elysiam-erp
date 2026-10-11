/**
 * @elysium/db
 *
 * Drizzle schema per module, migrations, RLS policies, database roles, the
 * seed, authentication, and the access helpers every tenant query goes through
 * (architecture §4, §5, §6).
 *
 * `configureDatabase` and `closeDatabase` are deliberately NOT exported here.
 * They repoint or tear down all three connection pools, which is a test
 * concern; application code reaching them could silently aim the app at
 * another database. They live behind `@elysium/db/testing`.
 */

export {
  currentDatabaseConfig,
  withAnalytics,
  withGlobal,
  withOrg,
  withSystem,
  withUser,
  type Database,
  type OrgContext,
  type Tx,
} from './client.js';

// The release step (M14b): migrations as erp_owner, one run at a time.
export { runMigrations, type MigrationResult } from './migrations.js';

export {
  ANALYTICS_READABLE,
  ANALYTICS_READABLE_COLUMNS,
  APPEND_ONLY_TABLES,
  ANALYTICS_READABLE_SCHEMAS,
  APPEND_ONLY,
  DECLARED_POLICIES,
  NO_DELETE_TABLES,
  GLOBAL_SCHEMAS,
  GLOBAL_TABLES,
  ORG_CONTEXT_SQL,
  READ_WRITE,
  USER_CONTEXT_SQL,
  globalTableSql,
  tenantTableSql,
  type DeclaredPolicy,
  type GlobalTableOptions,
  type TablePrivilege,
  type TenantTableOptions,
} from './rls.js';

export * as schema from './schema/index.js';

export { SEED_ORGS, SEED_ORG_IDS, seedOrgId, deterministicUuid } from './seed/orgs.js';
export { ensureBranchWallets, seedAccountId } from './seed/ledger.js';
/**
 * M10's zones and own-rider courier (§9, D-009).
 *
 * Exported because a test harness may be pointed at a database whose migration journal was
 * integrated before these rows existed, and calling the seed's own function is better than
 * a suite inventing zones of its own — a fixture that seeded a different charge would make
 * every COD in that suite disagree with production's.
 */
export { seedDeliveryZones, type DeliveryZoneSeedResult } from './seed/delivery-zones.js';
export { branchCashCode, COA_TEMPLATE, type TemplateAccount } from './seed/coa-template.js';
/** M14a: the training org's set-up, for `pnpm demo:org` (D-223). */
export { seedTrainingOrg, TRAINING_ORG_SLUG, trainingOrgId } from './seed/training.js';
/**
 * `pnpm db:seed`'s two steps, for `pnpm preview:seed` (D-380), which runs them first so one
 * command makes a fresh database previewable. Both are idempotent upserts.
 */
export { seedGeography, type GeographySeedResult } from './seed/geography.js';
export {
  seedBrandsFrom,
  seedOrganizations,
  seedOrgsFor,
  type SeedOptions,
  type SeedResult,
} from './seed/index.js';

export {
  availableOrgs,
  canEnterOrg,
  resolveContext,
  type AvailableOrg,
  type MembershipRole,
  type RequestContext,
} from './iam/context.js';

export {
  activeOrgSlugs,
  GENERIC_LOGIN,
  resolveLoginBranding,
  slugFromHost,
  type LoginBranding,
} from './iam/branding.js';

export {
  INVITE_LINK_SECONDS,
  LIBRARY_RATE_RULES,
  PASSWORD_LINK_SECONDS,
  RecordingSmsProvider,
  TWO_FACTOR_REQUIRED_ROLES,
  createAuth,
  mayHoldSession,
  mustEnrolTwoFactor,
  requiresTwoFactor,
  verificationText,
  type Auth,
  type AuthOptions,
  type SmsProvider,
} from './auth/index.js';
export { OWNER_SESSION_SECONDS } from './auth/owner-session.js';
export {
  loadTwoFactorPolicy,
  newAuthenticatorSecret,
  totpMatchesEncrypted,
  twoFactorPolicyFor,
  twoFactorStanding,
  type AuthSecrets,
  type PendingSecret,
  type TwoFactorStanding,
} from './auth/two-factor.js';
