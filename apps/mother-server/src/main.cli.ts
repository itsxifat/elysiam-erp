import { parseArgs } from 'node:util';

import postgres from 'postgres';

import { breakGlassTwoFactorReset, bootstrapOwner, CliRefused } from './cli.js';
import { motherEnv } from './config/env.js';
import { closeMotherDatabase, configureMotherDatabase } from './db/client.js';
import { migrateMother } from './db/migrate.js';
import { applyMotherBootstrap, passwordOf } from './db/roles.js';

/**
 * `pnpm mother:<command>` (D-480, D-487):
 *
 *   db-bootstrap                         roles, once per database, as an administrator
 *   migrate                              the mother's migrations, as mother_owner
 *   bootstrap --email <e> --name "<n>"   the first owner; prints a one-time link
 *   people reset-two-factor --email <e>  break-glass: clear an owner's second factor
 */

const USAGE = `usage:
  mother db-bootstrap
  mother migrate
  mother bootstrap --email <address> --name "<name>" [--public-url <url>]
  mother people reset-two-factor --email <address>`;

async function dbBootstrap(): Promise<void> {
  const env = motherEnv();
  if (env.MOTHER_DATABASE_ADMIN_URL === undefined || env.MOTHER_DATABASE_OWNER_URL === undefined) {
    throw new CliRefused(
      'db-bootstrap needs MOTHER_DATABASE_ADMIN_URL and MOTHER_DATABASE_OWNER_URL.',
    );
  }
  const target = new URL(env.MOTHER_DATABASE_OWNER_URL).pathname.slice(1);
  const adminUrl = new URL(env.MOTHER_DATABASE_ADMIN_URL);
  // Create the database when it is missing (the dev stack's shared Postgres).
  const maintenance = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
  try {
    const [found] = await maintenance<{ exists: boolean }[]>`
      select exists (select 1 from pg_database where datname = ${target}) as exists
    `;
    if (found?.exists !== true) {
      await maintenance.unsafe(`create database "${target.replace(/"/g, '')}"`);
      console.log(`created database ${target}`);
    }
  } finally {
    await maintenance.end();
  }
  adminUrl.pathname = `/${target}`;
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
  try {
    await applyMotherBootstrap(admin, {
      owner: passwordOf(env.MOTHER_DATABASE_OWNER_URL),
      app: passwordOf(env.MOTHER_DATABASE_URL),
    });
  } finally {
    await admin.end();
  }
  console.log(`mother roles ready on ${target}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, sub, ...rest] = argv;
  const env = motherEnv();
  switch (command) {
    case 'db-bootstrap':
      await dbBootstrap();
      return;
    case 'migrate': {
      if (env.MOTHER_DATABASE_OWNER_URL === undefined) {
        throw new CliRefused('migrate needs MOTHER_DATABASE_OWNER_URL.');
      }
      const result = await migrateMother(env.MOTHER_DATABASE_OWNER_URL);
      console.log(`mother migrations applied: ${String(result.total)}`);
      return;
    }
    case 'bootstrap': {
      const { values } = parseArgs({
        args: [...(sub === undefined ? [] : [sub]), ...rest],
        options: {
          email: { type: 'string' },
          name: { type: 'string' },
          'public-url': { type: 'string' },
        },
      });
      configureMotherDatabase(env.MOTHER_DATABASE_URL);
      const result = await bootstrapOwner({
        email: values.email ?? '',
        name: values.name ?? '',
        publicUrl: values['public-url'] ?? env.MOTHER_PUBLIC_URL,
      });
      console.log('The first owner is ready. Open this link once to set a password:');
      console.log(`  ${result.link}`);
      console.log(`It works until ${result.expiresAt}. Two-step sign-in is set up next.`);
      return;
    }
    case 'people': {
      if (sub !== 'reset-two-factor') throw new CliRefused(USAGE);
      const { values } = parseArgs({ args: rest, options: { email: { type: 'string' } } });
      configureMotherDatabase(env.MOTHER_DATABASE_URL);
      await breakGlassTwoFactorReset(values.email ?? '');
      console.log('Two-step sign-in cleared; they set it up again at their next sign-in.');
      return;
    }
    case undefined:
    default:
      throw new CliRefused(USAGE);
  }
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof CliRefused ? error.message : `mother: ${String(error)}`}\n`,
    );
    process.exitCode = 1;
  })
  .finally(() => closeMotherDatabase());
