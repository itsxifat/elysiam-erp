import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Invariant 12, for this module, checked rather than remembered.
 *
 * "Modules talk only through each other's `*.api.ts` service interfaces or events, never
 * directly through each other's tables." A join is a read, and this file's subject spent
 * three milestones with eight `join sales.couriers` in it while its own header paragraph
 * said nothing here reads another module's tables. A sentence is not a check.
 *
 * What makes the violation easy to commit is that it costs nothing at the time: the FK is
 * already there, the join is one line, and the name comes back in the same round trip.
 * What it costs is later — M10 cannot change the shape of its own table without breaking
 * a module that never declared it was reading it, and no test fails when it does.
 *
 * The courier's name now comes from `OrdersPort.courierParties`, so the only schemas this
 * repository may name are its own and the two §5 calls global.
 */

const OWN = ['courier'];

/**
 * Schemas no module owns, so reading them is not crossing a boundary.
 *
 * `org` holds the brand and branch rows every module resolves against (§5), and `ref`
 * holds the geography the whole system shares (districts, thanas). Neither has an owning
 * module to ask, and neither carries anything a module could be said to encapsulate.
 */
const GLOBAL = ['org', 'ref'];

/** Every schema in the database, so a new one is caught rather than silently allowed. */
const SCHEMAS = [
  'approvals',
  'audit',
  'catalog',
  'courier',
  'events',
  'files',
  'fraud',
  'hr',
  'iam',
  'intake',
  'inventory',
  'investors',
  'ledger',
  'org',
  'pos',
  'ref',
  'sales',
  'supply',
  'wallets',
];

/** The SQL, with comments stripped: a schema named in prose is not a read. */
function sqlOf(file: string): string {
  const source = readFileSync(path.join(import.meta.dirname, file), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

describe('the courier module reads only its own tables (invariant 12)', () => {
  it('names no other module’s schema in its SQL', () => {
    const sql = sqlOf('courier.repository.ts');
    const foreign = SCHEMAS.filter(
      (schema) => ![...OWN, ...GLOBAL].includes(schema) && sql.includes(`${schema}.`),
    );

    expect(
      foreign,
      'these belong to other modules; ask for what you need on a port in ./ports',
    ).toEqual([]);
  });

  it('still reads the tables it owns, so the check above cannot pass vacuously', () => {
    const sql = sqlOf('courier.repository.ts');

    expect(sql).toContain('courier.consignments');
    expect(sql).toContain('courier.courier_accounts');
  });

  it('would catch the join that was there: a fixture naming another schema fails', () => {
    // The same rule applied to a line of the kind that was removed, so a reader can see
    // the check working rather than trusting that it would.
    const offending = 'join sales.couriers co on co.org_id = c.org_id';
    const foreign = SCHEMAS.filter(
      (schema) => ![...OWN, ...GLOBAL].includes(schema) && offending.includes(`${schema}.`),
    );

    expect(foreign).toEqual(['sales']);
  });
});
