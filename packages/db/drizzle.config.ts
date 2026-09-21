import { existsSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside the app, so it loads this package's own .env.
// Resolved from cwd rather than import.meta.dirname: drizzle-kit transpiles
// this config to CJS, where import.meta.dirname is undefined.
const envFile = path.resolve(process.cwd(), '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

/**
 * Migrations are generated as `erp_owner`, never as the app role, and land in
 * one ordered journal alongside the hand-written SQL that Drizzle cannot
 * express — RLS policies, grants and roles (architecture §5).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/**/index.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? '' },
  schemaFilter: ['iam', 'org', 'ref'],
  strict: true,
  verbose: true,
});
