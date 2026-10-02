import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type postgres from 'postgres';

/**
 * `bootstrap.sql`, next to this file in `src` and, after `copy-sql-assets`, in `dist`.
 */
const BOOTSTRAP_SQL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bootstrap.sql');

/** The password each of the three roles (architecture §5, D-042) is given. */
export interface RolePasswords {
  readonly owner: string;
  readonly app: string;
  readonly analytics: string;
}

/**
 * Create or reset the three database roles, on whatever database `admin` is connected to.
 *
 * The one place `bootstrap.sql` is run from: `pnpm db:bootstrap`, the test harness and the
 * managed-Postgres test all call it, so none of them can run an approximation of it.
 * `admin` needs CREATEROLE and ownership of the database, not superuser (D-341).
 *
 * The passwords travel as transaction-local settings rather than being interpolated into
 * the script, so none of them is ever written into a SQL string or a query log
 * (invariant 10); `format('%L')` quotes them inside the script.
 */
export async function applyBootstrap(admin: postgres.Sql, passwords: RolePasswords): Promise<void> {
  const script = await readFile(BOOTSTRAP_SQL, 'utf8');
  await admin.begin(async (tx) => {
    await tx`select set_config('bootstrap.owner_password', ${passwords.owner}, true)`;
    await tx`select set_config('bootstrap.app_password', ${passwords.app}, true)`;
    await tx`select set_config('bootstrap.analytics_password', ${passwords.analytics}, true)`;
    await tx.unsafe(script);
  });
}
