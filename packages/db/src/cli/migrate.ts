/**
 * Apply migrations as `erp_owner`.
 *
 * Never as the app role, and never as a superuser: the objects must end up
 * owned by erp_owner, which is subject to FORCE RLS like everyone else (§5).
 * In production this runs as part of the release step (`main.release.ts`, M14b).
 *
 *   pnpm db:migrate
 */

import { databaseConfig, loadDatabaseEnv, requireUrl } from '../config.js';
import { runMigrations } from '../migrations.js';

loadDatabaseEnv();
const config = databaseConfig();
const ownerUrl = requireUrl(config, 'DATABASE_OWNER_URL', 'pnpm db:migrate');

const { total, milliseconds } = await runMigrations(ownerUrl);
console.log(`db:migrate — ${total} migration(s) applied in total (${milliseconds} ms).`);
