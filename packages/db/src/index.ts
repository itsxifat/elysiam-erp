/**
 * @elysium/db
 *
 * Drizzle schema per module, migrations, RLS policies, database roles, the
 * seed, and the access helpers every tenant query goes through
 * (architecture §4, §5).
 *
 * `configureDatabase` and `closeDatabase` are deliberately NOT exported here.
 * They repoint or tear down all three connection pools, which is a test
 * concern; application code reaching them could silently aim the app at
 * another database. They live behind `@elysium/db/testing`.
 */

export {
  withOrg,
  withAnalytics,
  withSystem,
  type Database,
  type OrgContext,
  type Tx,
} from './client.js';

export {
  APPEND_ONLY,
  GLOBAL_SCHEMAS,
  GLOBAL_TABLES,
  ORG_CONTEXT_SQL,
  READ_WRITE,
  globalTableSql,
  tenantTableSql,
  type TablePrivilege,
  type TenantTableOptions,
} from './rls.js';

export * as schema from './schema/index.js';

export { SEED_ORGS, SEED_ORG_IDS, seedOrgId, deterministicUuid } from './seed/orgs.js';
