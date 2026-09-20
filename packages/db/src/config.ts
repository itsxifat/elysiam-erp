import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/**
 * Database connections, one per privilege level (architecture §5, D-042).
 *
 * These are four different roles on purpose. Collapsing them into one URL is
 * how an application ends up running as the object owner, and an owner with
 * FORCE RLS disabled — or worse, a superuser — is a tenant isolation hole that
 * no test above the database layer can see.
 */
const urlSchema = z.string().url().startsWith('postgres');

const schema = z.object({
  /** `erp_app`. The running API and worker. Subject to every RLS policy. */
  DATABASE_URL: urlSchema,
  /** `erp_owner`. Migrations and seeds only. Owns the objects, never serves a request. */
  DATABASE_OWNER_URL: urlSchema.optional(),
  /** `erp_analytics`. Cross-org reads for the analytics module. Cannot write. */
  DATABASE_ANALYTICS_URL: urlSchema.optional(),
  /** Superuser. Used by `pnpm db:bootstrap` and by nothing else, ever. */
  DATABASE_ADMIN_URL: urlSchema.optional(),
});

export type DatabaseConfig = z.infer<typeof schema>;

/**
 * Load `packages/db/.env` if it is there.
 *
 * The db commands run from this package, so they never see an app's `.env`.
 * The database lifecycle belongs to this package, so its connection strings
 * live here too rather than being duplicated into every app that might need one.
 */
export function loadDatabaseEnv(): void {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

export function databaseConfig(
  source: Record<string, string | undefined> = process.env,
): DatabaseConfig {
  const result = schema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .sort()
      .join('\n');
    throw new Error(
      `Invalid database configuration:\n${problems}\n\n` +
        `Copy apps/server/.env.example to .env, or run \`pnpm setup:env\`.`,
    );
  }

  return result.data;
}

/** Read a URL that only some commands need, with a message naming the command. */
export function requireUrl(
  config: DatabaseConfig,
  key: 'DATABASE_OWNER_URL' | 'DATABASE_ANALYTICS_URL' | 'DATABASE_ADMIN_URL',
  usedBy: string,
): string {
  const value = config[key];
  if (value === undefined || value === '') {
    throw new Error(`${usedBy} needs ${key}, which is not set.`);
  }
  return value;
}

export interface ParsedUrl {
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

/**
 * Pull the role and password out of a connection string.
 *
 * Bootstrap sets each role's password to whatever its own URL says, so the
 * connection strings stay the single source of truth and there is no second
 * set of password variables to drift out of sync.
 */
export function parseUrl(url: string): ParsedUrl {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ''),
  };
}
