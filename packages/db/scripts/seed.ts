/**
 * Seed the five orgs, their HQ branches and warehouse locations.
 *
 * Safe to run repeatedly: every insert is an upsert on a natural key and the
 * ids are derived, so a second run changes nothing.
 *
 *   pnpm db:seed
 */

import { closeDatabase } from '../src/client.js';
import { seedOrganizations } from '../src/seed/index.js';

try {
  const result = await seedOrganizations();
  console.log(
    `db:seed — ${result.organizations} organizations, ` +
      `${result.branches} branches, ${result.locations} locations.`,
  );
} finally {
  await closeDatabase();
}
