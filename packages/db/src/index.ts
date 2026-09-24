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

export {
  ANALYTICS_READABLE,
  APPEND_ONLY_TABLES,
  ANALYTICS_READABLE_SCHEMAS,
  APPEND_ONLY,
  DECLARED_POLICIES,
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
  RecordingSmsProvider,
  TWO_FACTOR_REQUIRED_ROLES,
  createAuth,
  mustEnrolTwoFactor,
  requiresTwoFactor,
  type Auth,
  type AuthOptions,
  type SmsProvider,
} from './auth/index.js';
