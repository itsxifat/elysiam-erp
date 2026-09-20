import { defineConfig } from 'drizzle-kit';

/**
 * M01 fills this in with one folder per module schema (architecture §5) and the
 * RLS policies every tenant table needs. M00 only fixes the layout so the first
 * migration lands in the right place and `check-migrations` can protect it.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/**/*.ts',
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
