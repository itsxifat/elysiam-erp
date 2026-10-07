import { defineConfig } from 'drizzle-kit';

/**
 * The mother's own migrations (D-480), never `packages/db/migrations`: a different
 * database, different roles, a different journal. Generated as `mother_owner`; the grants
 * and the append-only trigger are hand-written beside them, as the brand's are.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './migrations',
  dbCredentials: { url: process.env.MOTHER_DATABASE_OWNER_URL ?? '' },
  schemaFilter: ['auth', 'mother'],
  strict: true,
  verbose: true,
});
