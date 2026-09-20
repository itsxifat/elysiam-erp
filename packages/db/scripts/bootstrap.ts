/**
 * Create the three database roles. Once per database, as the superuser.
 *
 * This is the only command that needs superuser rights. Everything afterwards
 * runs as erp_owner, which bootstrap deliberately creates WITHOUT superuser and
 * WITHOUT bypassrls — see D-042 and the comments in bootstrap.sql.
 *
 *   pnpm db:bootstrap
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import postgres from 'postgres';

import { databaseConfig, loadDatabaseEnv, parseUrl, requireUrl } from '../src/config.js';

const SQL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/bootstrap.sql');

async function main(): Promise<void> {
  loadDatabaseEnv();
  const config = databaseConfig();
  const adminUrl = requireUrl(config, 'DATABASE_ADMIN_URL', 'pnpm db:bootstrap');
  const ownerUrl = requireUrl(config, 'DATABASE_OWNER_URL', 'pnpm db:bootstrap');
  const analyticsUrl = requireUrl(config, 'DATABASE_ANALYTICS_URL', 'pnpm db:bootstrap');

  const owner = parseUrl(ownerUrl);
  const app = parseUrl(config.DATABASE_URL);
  const analytics = parseUrl(analyticsUrl);

  for (const [label, parsed, expected] of [
    ['DATABASE_OWNER_URL', owner, 'erp_owner'],
    ['DATABASE_URL', app, 'erp_app'],
    ['DATABASE_ANALYTICS_URL', analytics, 'erp_analytics'],
  ] as const) {
    if (parsed.user !== expected) {
      throw new Error(
        `${label} connects as "${parsed.user}", but this project expects "${expected}". ` +
          `The roles carry different privileges and are not interchangeable (§5).`,
      );
    }
    if (parsed.password === '') {
      throw new Error(`${label} has no password; bootstrap cannot set one for ${expected}.`);
    }
  }

  const sql = postgres(adminUrl, {
    max: 1,
    onnotice: (notice) => console.log(`  ${notice.message}`),
  });

  try {
    const script = await readFile(SQL_FILE, 'utf8');

    await sql.begin(async (tx) => {
      // Passed as settings rather than interpolated, so no password is ever
      // written into a SQL string or a query log.
      await tx`select set_config('bootstrap.owner_password', ${owner.password}, true)`;
      await tx`select set_config('bootstrap.app_password', ${app.password}, true)`;
      await tx`select set_config('bootstrap.analytics_password', ${analytics.password}, true)`;
      await tx.unsafe(script);
    });

    const roles = await sql<
      { rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
    >`
      select rolname, rolsuper, rolbypassrls, rolcanlogin
      from pg_roles
      where rolname in ('erp_owner', 'erp_app', 'erp_analytics')
      order by rolname
    `;

    console.log('\n  role           super  bypassrls  login');
    for (const role of roles) {
      console.log(
        `  ${role.rolname.padEnd(14)} ${String(role.rolsuper).padEnd(6)} ` +
          `${String(role.rolbypassrls).padEnd(10)} ${String(role.rolcanlogin)}`,
      );
    }

    // The property this whole milestone rests on. Asserted here rather than
    // only in tests, because a superuser owner makes every isolation policy a
    // no-op and the failure is otherwise silent.
    const unsafe = roles.filter((role) => role.rolsuper || role.rolbypassrls);
    if (unsafe.length > 0) {
      throw new Error(
        `These roles can bypass row-level security: ${unsafe.map((r) => r.rolname).join(', ')}. ` +
          `Tenant isolation would not apply to them (§5, D-042).`,
      );
    }

    if (roles.length !== 3) {
      throw new Error(`Expected 3 roles, found ${roles.length}.`);
    }

    console.log('\ndb:bootstrap — roles ready, none can bypass RLS.');
  } finally {
    await sql.end();
  }
}

await main();
