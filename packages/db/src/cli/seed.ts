/**
 * Seed the five orgs, their HQ branches, warehouse locations and charts of
 * accounts.
 *
 * Safe to run repeatedly: every insert is an upsert on a natural key and the
 * ids are derived, so a second run changes nothing.
 *
 *   pnpm db:seed
 */

import { closeDatabase } from '../client.js';
import { seedGeography } from '../seed/geography.js';
import { seedOrganizations } from '../seed/index.js';

try {
  const geography = await seedGeography();
  console.log(
    `db:seed — ${geography.divisions} divisions, ${geography.districts} districts, ` +
      `${geography.thanas} thanas (${geography.source}).`,
  );

  const result = await seedOrganizations();
  console.log(
    `db:seed — ${result.organizations} organizations, ` +
      `${result.branches} branches, ${result.locations} locations, ${result.accounts} accounts.`,
  );
} finally {
  await closeDatabase();
}
