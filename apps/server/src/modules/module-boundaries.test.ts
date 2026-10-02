import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Invariant 12, across every module, as a ratchet.
 *
 * "Modules talk only through each other's `*.api.ts` service interfaces or events, never
 * directly through each other's tables." A join is a read, and a read written as one line
 * of SQL costs nothing at the time: the foreign key is already there and the column comes
 * back in the same round trip. What it costs is later — the owning module cannot change
 * the shape of its own table without breaking a reader that never declared itself, and no
 * test fails when it does. `courier.repository.ts` carried eight such joins for three
 * milestones while its own header said it carried none.
 *
 * This test does not pretend the tree is clean. It records what each module reaches into
 * today in `DEBT`, and fails in **both** directions:
 *
 * - a foreign table that is not in `DEBT` fails — no new coupling, ever;
 * - a `DEBT` entry that is no longer read fails — once a module is weaned off a table it
 *   cannot quietly go back.
 *
 * So the list only shrinks. Deleting the last entry deletes the debt.
 *
 * **Enums are not tables.** `${value}::ledger.account_subtype` names a type, not rows, and
 * a cast couples a module to a vocabulary the database already enforces — so the
 * qualified enum names below are excluded rather than counted as debt.
 */

const MODULES = path.join(import.meta.dirname);

/** Schema → the module that owns it. A schema missing here is nobody's and must be added. */
const OWNER: Readonly<Record<string, string>> = {
  approvals: 'approvals',
  // Platform-owned: written through the audit interceptor and the outbox, never by a
  // module's own SQL. `platform` matches no module directory, so any module that reads
  // one of these counts as foreign — which is how `audit.audit_log` below was found.
  audit: 'platform',
  events: 'platform',
  catalog: 'catalog',
  courier: 'courier',
  files: 'files',
  hr: 'hr',
  iam: 'iam',
  intake: 'intake',
  inventory: 'inventory',
  investors: 'investors',
  ledger: 'ledger',
  // M16: codes and redemptions, and messages, templates and opt-outs, each reached
  // from elsewhere only through `PromoApi` / `NotifyApi`.
  notify: 'notify',
  pos: 'pos',
  promo: 'promo',
  sales: 'orders',
  supply: 'supply',
  wallets: 'wallets',
};

/**
 * Schemas no module owns, so reading them crosses no boundary.
 *
 * §5 makes `org` global — the brand and branch rows every module resolves against — and
 * `ref` holds the geography the whole system shares. Neither has an owning module to ask.
 * `audit` and `events` are not here: they are platform-owned (see `OWNER`), so a module
 * that reads one is debt like any other.
 */
const GLOBAL = new Set(['org', 'ref']);

/** Qualified enum types. Casting to one is not a read. */
const ENUMS = new Set([
  'ledger.account_class',
  'ledger.account_subtype',
  'ledger.normal_balance',
  'iam.membership_role',
]);

/**
 * What each module reads from another module's schema today, and why it is still here.
 *
 * Every line is a port waiting to be written. The shape of the fix is already in the tree:
 * `courier/ports/orders.port.ts` and `ledger-read.port.ts` are what the courier module
 * used to replace its own entries.
 */
const DEBT: Readonly<Record<string, readonly string[]>> = {
  // A product's images. The files module owns the object row and its visibility rules.
  catalog: ['files.objects'],
  // SKU and product names on a stock screen; posting accounts for movement journals.
  inventory: ['catalog.products', 'catalog.skus', 'ledger.accounts'],
  // KYC documents, the investor's membership, and posting accounts.
  investors: ['files.objects', 'iam.memberships', 'ledger.accounts'],
  // The desk's activity feed reads the audit log directly; agent names come from iam.
  orders: ['audit.audit_log', 'iam.memberships', 'iam.users', 'ledger.accounts'],
  // Purchase lines name SKUs, invoices are files, and supplier statements read journals.
  supply: [
    'catalog.products',
    'catalog.skus',
    'files.objects',
    'ledger.accounts',
    'ledger.journal_lines',
    'ledger.journals',
  ],
  // Receipts are files; every balance on these screens is derived from journal lines.
  wallets: ['files.objects', 'ledger.accounts', 'ledger.journal_lines', 'ledger.journals'],
};

/** The SQL of a file, with comments stripped: a schema named in prose is not a read. */
function sqlOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

function repositoriesOf(module: string): string[] {
  const dir = path.join(MODULES, module);
  if (!statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.repository.ts'))
    .map((name) => path.join(dir, name));
}

/** Every `schema.table` a module names that belongs to another module. */
function foreignTables(module: string): string[] {
  const found = new Set<string>();
  for (const file of repositoriesOf(module)) {
    const sql = sqlOf(file);
    for (const match of sql.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)) {
      const [qualified, schema] = [match[0], match[1] ?? ''];
      if (!(schema in OWNER) || GLOBAL.has(schema)) continue;
      if (OWNER[schema] === module || ENUMS.has(qualified)) continue;
      found.add(qualified);
    }
  }
  return [...found].sort();
}

const MODULE_NAMES = readdirSync(MODULES).filter((name) =>
  statSync(path.join(MODULES, name)).isDirectory(),
);

describe('modules do not read each other’s tables (invariant 12)', () => {
  it('finds the repositories it is meant to be checking', () => {
    // Guards the whole file: a rename that made `repositoriesOf` return nothing would
    // turn every assertion below green.
    const withRepositories = MODULE_NAMES.filter((name) => repositoriesOf(name).length > 0);
    expect(withRepositories.length).toBeGreaterThan(10);
    expect(withRepositories).toContain('courier');
  });

  it.each(MODULE_NAMES)('%s reads only what the debt list allows', (module) => {
    const allowed = DEBT[module] ?? [];
    const foreign = foreignTables(module);

    const added = foreign.filter((table) => !allowed.includes(table));
    expect(
      added,
      `${module} reads another module's tables. Ask for what you need on a port in ` +
        `modules/${module}/ports — see courier/ports/orders.port.ts — rather than adding ` +
        `to the debt list.`,
    ).toEqual([]);

    const fixed = allowed.filter((table) => !foreign.includes(table));
    expect(
      fixed,
      `${module} no longer reads these, so remove them from DEBT in this file. The list ` +
        `only shrinks.`,
    ).toEqual([]);
  });

  it('holds the courier module to no debt at all', () => {
    // The one module that has been weaned off, and the proof the ratchet's upper end
    // works: it was the worst offender, with eight joins on `sales.couriers` (D-199).
    expect(DEBT.courier).toBeUndefined();
    expect(foreignTables('courier')).toEqual([]);
  });

  it('counts a cross-module join and not an enum cast', () => {
    // The check working, on the line that was removed and on a cast that must stay legal.
    const join = 'join sales.couriers co on co.org_id = c.org_id';
    const cast = 'where subtype = ${subtype}::ledger.account_subtype';
    const scan = (sql: string) =>
      [...sql.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)]
        .filter((m) => (m[1] ?? '') in OWNER && !GLOBAL.has(m[1] ?? '') && !ENUMS.has(m[0]))
        .map((m) => m[0]);

    expect(scan(join)).toContain('sales.couriers');
    expect(scan(cast)).toEqual([]);
  });
});
