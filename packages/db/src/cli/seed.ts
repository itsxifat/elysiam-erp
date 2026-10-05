/**
 * Seed the geography, then the five orgs (or one brand), their HQ branches, warehouse
 * locations, charts of accounts with a hand-cash wallet, and delivery zones.
 *
 * Safe to run repeatedly: every insert is an upsert on a natural key and the
 * ids are derived, so a second run changes nothing.
 *
 *   pnpm db:seed                       all five brands (tests, local development)
 *   pnpm db:seed --brand <slug>        one brand, for its own ERP's database (D-470)
 *   SEED_BRANDS=<slug> pnpm db:seed    the same, from the environment
 */

import { closeDatabase } from '../client.js';
import { seedGeography } from '../seed/geography.js';
import { seedBrandsFrom, seedOrganizations } from '../seed/index.js';

try {
  const brands = seedBrandsFrom(process.argv.slice(2), process.env);

  const geography = await seedGeography();
  console.log(
    `db:seed — ${geography.divisions} divisions, ${geography.districts} districts, ` +
      `${geography.thanas} thanas (${geography.source}).`,
  );

  const result = await seedOrganizations({ brands });
  console.log(
    `db:seed — ${result.organizations} organizations, ` +
      `${result.branches} branches, ${result.locations} locations, ${result.accounts} accounts` +
      (brands === undefined ? '.' : ` (brand: ${brands.join(', ')}).`),
  );
} finally {
  await closeDatabase();
}
