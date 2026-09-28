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
  // `fraud` is here like every other module schema. Its two cross-org tables carry no
  // `org_id` (§5 exception 1), which changes their policies and not whether drizzle-kit
  // owns them — leaving the schema out would make the drift check silently propose
  // dropping it.
  // `investors` is here for exactly the reason the note above gives: without it the
  // drift check does not compare `src/schema/investors` against migration 0058 at
  // all, so six tables holding investor capital would be invisible to the one gate
  // that notices a schema and its migration disagreeing.
  schemaFilter: [
    'approvals',
    'audit',
    'catalog',
    // M12. Without it, `check:schema` never compares `src/schema/courier/index.ts` against
    // migration 0048, and eight tables holding the record of third-party cash sit outside the
    // one gate that notices a schema and its migration disagreeing.
    'courier',
    'demo',
    'events',
    'files',
    'fraud',
    // M19. Fourteen tables holding salaries, attendance and staff loans.
    'hr',
    'http',
    'iam',
    'inventory',
    'investors',
    'ledger',
    'org',
    'ref',
    'sales',
    'supply',
    'wallets',
  ],
  strict: true,
  verbose: true,
});
