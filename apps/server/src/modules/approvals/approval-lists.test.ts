import {
  BRANCH_ITEM_APPROVAL_TYPES,
  CHECKER_TYPES,
  NEVER_AUTO_APPROVE_TYPES,
} from '@elysium/contracts';
import { schema } from '@elysium/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

/**
 * The approval type lists exist twice — once in @elysium/contracts, which the
 * service reads, and once in the Drizzle schema, which the database CHECKs are
 * generated from. Neither package may depend on the other, so this is where
 * they are held to each other (final ledger pass, note 6). If they drift, the
 * service and the database disagree about which requests may be
 * auto-approved, and the database is the one that is wrong silently.
 */

const sorted = (values: readonly string[]) => [...values].sort();

describe('the approval lists agree between contracts and the database', () => {
  it('never-auto-approve types', () => {
    expect(sorted(schema.NEVER_AUTO_APPROVE_TYPE_NAMES)).toEqual(sorted(NEVER_AUTO_APPROVE_TYPES));
  });

  it('and the SQL the CHECK constraints are built from names exactly those', () => {
    const rendered = new PgDialect().sqlToQuery(schema.NEVER_AUTO_APPROVE_SQL).sql;
    const names = [...rendered.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? '');
    expect(sorted(names)).toEqual(sorted(NEVER_AUTO_APPROVE_TYPES));
  });

  it('branch items, which are also exactly what a branch manager checks', () => {
    expect(sorted(schema.BRANCH_ITEM_TYPE_NAMES)).toEqual(sorted(BRANCH_ITEM_APPROVAL_TYPES));
    expect(sorted(BRANCH_ITEM_APPROVAL_TYPES)).toEqual(sorted(CHECKER_TYPES.branch_manager));
  });
});
