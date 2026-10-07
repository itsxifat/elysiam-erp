import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import postgres from 'postgres';

import { closeMotherDatabase, configureMotherDatabase } from '../db/client.js';
import { migrateMother } from '../db/migrate.js';
import { applyMotherBootstrap, passwordOf } from '../db/roles.js';

/**
 * A throwaway mother database for a test, on whatever Postgres server the brand harness
 * started (its Testcontainer, or `TEST_DATABASE_URL`): created, bootstrapped with the real
 * role script, migrated with the real migrations, and dropped afterwards.
 *
 * The roles are cluster-wide. When the server is the dev stack's, the configured passwords
 * (`apps/mother-server/.env`) are reused, so a test never changes the password a running
 * dev mother signs in with.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

function configuredPasswords(): { owner: string; app: string } {
  const fallback = { owner: 'mother_owner_test_password', app: 'mother_app_test_password' };
  const file = path.resolve(HERE, '../../.env');
  if (!existsSync(file)) return fallback;
  const values = parseEnv(readFileSync(file, 'utf8'));
  try {
    return {
      owner:
        values.MOTHER_DATABASE_OWNER_URL === undefined
          ? fallback.owner
          : passwordOf(values.MOTHER_DATABASE_OWNER_URL),
      app:
        values.MOTHER_DATABASE_URL === undefined
          ? fallback.app
          : passwordOf(values.MOTHER_DATABASE_URL),
    };
  } catch {
    return fallback;
  }
}

function withDatabase(url: string, database: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface MotherTestDatabase {
  readonly name: string;
  readonly ownerUrl: string;
  readonly appUrl: string;
  stop(): Promise<void>;
}

const BOOTSTRAP_LOCK = 720_480_009;

export async function startMotherDatabase(adminUrl: string): Promise<MotherTestDatabase> {
  const name = `mother_test_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const passwords = configuredPasswords();
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await admin.unsafe(`create database "${name}"`);
    await admin`select pg_advisory_lock(${BOOTSTRAP_LOCK})`;
    const parsed = new URL(adminUrl);
    const onFresh = postgres(
      withDatabase(
        adminUrl,
        name,
        decodeURIComponent(parsed.username),
        decodeURIComponent(parsed.password),
      ),
      { max: 1, onnotice: () => undefined },
    );
    try {
      await applyMotherBootstrap(onFresh, passwords);
    } finally {
      await onFresh.end();
    }
  } finally {
    await admin.end();
  }
  const ownerUrl = withDatabase(adminUrl, name, 'mother_owner', passwords.owner);
  const appUrl = withDatabase(adminUrl, name, 'mother_app', passwords.app);
  await migrateMother(ownerUrl);
  configureMotherDatabase(appUrl);
  return {
    name,
    ownerUrl,
    appUrl,
    async stop() {
      await closeMotherDatabase();
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => undefined });
      try {
        await cleanup.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
