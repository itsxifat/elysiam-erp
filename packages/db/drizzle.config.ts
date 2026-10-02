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
  // `investors` is here because without it the
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
    // M19. Fourteen tables holding salaries, attendance and staff loans.
    'hr',
    'http',
    'iam',
    'intake',
    'inventory',
    'investors',
    'ledger',
    // M18. Campaigns, spend, leads, the Meta link and the conversion log.
    'marketing',
    // M14a. The record of a brand's opening import and the opening of its books.
    'migration',
    // M16. Templates, opt-outs and the delivery log.
    'notify',
    'org',
    // M23. Eleven tables holding till sales, tenders, returns and branch closings.
    'pos',
    // M16. Promo codes and their redemption ledger.
    'promo',
    'ref',
    'sales',
    'supply',
    'wallets',
  ],
  strict: true,
  verbose: true,
});
