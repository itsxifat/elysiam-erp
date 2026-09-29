import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/**/index.ts',
  out: './.drift-probe-m23',
  schemaFilter: ['approvals','audit','catalog','courier','demo','events','files','fraud','hr','http','iam','inventory','investors','ledger','org','ref','sales','supply','wallets','pos'],
});
