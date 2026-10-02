/**
 * Every module's Drizzle schema, one folder per Postgres schema
 * (architecture §3).
 *
 * Re-exported flat rather than as namespaces: Drizzle walks this object looking
 * for tables, and `export * as ns` produces a module namespace object with a
 * null prototype, which its `is()` check cannot inspect.
 *
 * Names must therefore stay unique across modules. That is a feature — two
 * modules with a table of the same name would be ambiguous in a join anyway.
 */
export * from './advances/index.js';
export * from './analytics/index.js';
export * from './approvals/index.js';
export * from './audit/index.js';
export * from './catalog/index.js';
export * from './courier/index.js';
export * from './crm/index.js';
export * from './demo/index.js';
export * from './events/index.js';
export * from './files/index.js';
export * from './hr/index.js';
export * from './http/index.js';
export * from './iam/index.js';
export * from './intake/index.js';
export * from './inventory/index.js';
export * from './investors/index.js';
export * from './ledger/index.js';
export * from './loans/index.js';
export * from './marketing/index.js';
export * from './migration/index.js';
export * from './notify/index.js';
export * from './org/index.js';
export * from './orders/index.js';
export * from './pos/index.js';
export * from './promo/index.js';
export * from './ref/index.js';
export * from './supply/index.js';
export * from './targets/index.js';
export * from './wallets/index.js';
