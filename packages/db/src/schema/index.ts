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
export * from './approvals/index.js';
export * from './audit/index.js';
export * from './demo/index.js';
export * from './iam/index.js';
export * from './org/index.js';
export * from './ref/index.js';
