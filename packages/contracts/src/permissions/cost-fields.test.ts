import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { COST_FIELDS } from './subjects.js';

/**
 * `COST_FIELDS` against the schema it is supposed to cover.
 *
 * Invariant 5 says a role without `read:cost` never receives a cost field, and
 * `serializeFor` enforces that by *name* — so a cost-bearing column whose name
 * is missing from the list is not stripped from anything. The list is the
 * enforcement, and until this test existed nothing compared it to reality:
 * M09 and M10 both added a cost column, both wrote a comment in the schema
 * claiming the column "is in COST_FIELDS", and neither name was ever added.
 * `sales.order_lines.dispatch_unit_cost_poisha` was therefore reaching every
 * role that could read an order, which is every role on the order desk.
 *
 * That is the failure this guards: the omission is invisible at the call site,
 * the compiler cannot see it, and the reviewer reads a comment asserting the
 * opposite. So the migrations are the authority here — they are what actually
 * shipped — and the test reads them as text rather than importing the Drizzle
 * schema, because a column can exist in the database while the TypeScript
 * schema has drifted, and the leak follows the database.
 *
 * Adding a cost column means adding both spellings to `COST_FIELDS`: the
 * snake_case one a raw query returns and the camelCase one Drizzle maps it to.
 * A response is built from either, sometimes both in the same payload.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

/**
 * Names that *look* costed but are not an amount a role could be denied.
 *
 * Kept as an explicit list rather than a cleverer pattern so that adding one is
 * a deliberate act a reviewer sees, instead of a regex quietly widening.
 */
const NOT_AN_AMOUNT = new Set(['cost_drift_count']);

function costColumnsInMigrations(): ReadonlySet<string> {
  const found = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    // A column definition, not a mention: the name must be followed by a numeric
    // column type. `CHECK (... >= 0)` clauses and comments name the same columns
    // and would otherwise each count as a declaration.
    const pattern =
      /"([a-z_]*(?:cost|wac|margin|profit|landed)[a-z_]*)"\s+(?:bigint|numeric|integer)/gi;
    for (const match of sql.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && !NOT_AN_AMOUNT.has(name)) found.add(name);
    }
  }
  return found;
}

describe('COST_FIELDS covers the schema', () => {
  const columns = costColumnsInMigrations();

  it('finds cost columns to check, so a broken scan cannot pass silently', () => {
    // Without this the test would go green the day the path or the pattern
    // breaks, which is exactly when it is most needed.
    expect(columns.size).toBeGreaterThan(0);
    expect(columns).toContain('unit_cost_poisha');
  });

  it.each([...columns].sort())('%s is withheld from roles without read:cost', (column) => {
    expect(COST_FIELDS).toContain(column);
  });

  it('lists a camelCase spelling for every snake_case one', () => {
    const camel = (name: string): string =>
      name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    const missing = COST_FIELDS.filter((f) => f.includes('_')).filter(
      (f) => !COST_FIELDS.includes(camel(f) as (typeof COST_FIELDS)[number]),
    );
    expect(missing).toEqual([]);
  });
});
