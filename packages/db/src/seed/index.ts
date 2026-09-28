import { sql } from 'drizzle-orm';

import { withSystem } from '../client.js';
import { branches, locations, organizations } from '../schema/org/index.js';
import { seedDeliveryZones } from './delivery-zones.js';
import { seedChartOfAccounts } from './ledger.js';
import { deterministicUuid, SEED_ORGS, seedOrgId } from './orgs.js';

/**
 * Seed the five orgs, each with an HQ branch, a warehouse location and its
 * chart of accounts (M03).
 *
 * Idempotent by construction: ids are derived from natural keys and every
 * insert is an upsert, so running it twice changes nothing. That matters more
 * than it sounds — the seed runs on every developer's machine, in CI, and
 * against the demo org, and a seed that duplicates rows on a second run is a
 * seed nobody dares re-run.
 *
 * Note that the branch and location inserts run inside `withSystem({ orgId })`.
 * erp_owner is subject to FORCE RLS like everyone else, so even the seed has to
 * declare which org it is acting for. That is deliberate: the seed exercises
 * the same policies as the application, so a broken policy breaks the seed
 * loudly instead of hiding until production.
 */

const BRANCH_NAMESPACE = 'elysium-erp/branch';
const LOCATION_NAMESPACE = 'elysium-erp/location';

export interface SeedResult {
  readonly organizations: number;
  readonly branches: number;
  readonly locations: number;
  /** Ledger accounts across every org: the template plus one hand-cash wallet per branch. */
  readonly accounts: number;
}

export async function seedOrganizations(): Promise<SeedResult> {
  // organizations is global (§5 exception 5), so it needs no org context.
  await withSystem(async (tx) => {
    for (const org of SEED_ORGS) {
      await tx
        .insert(organizations)
        .values({
          id: seedOrgId(org.slug),
          slug: org.slug,
          legalName: org.legalName,
          displayName: org.displayName,
          brand: {
            accent: { hue: org.brandHue, chroma: org.brandChroma },
            logoFileId: null,
            logoDarkFileId: null,
            legalName: org.legalName,
            address: null,
            vatNo: null,
            invoiceFooter: null,
          },
        })
        .onConflictDoUpdate({
          target: organizations.slug,
          set: {
            legalName: org.legalName,
            displayName: org.displayName,
            updatedAt: new Date(),
          },
        });
    }
  });

  for (const org of SEED_ORGS) {
    const orgId = seedOrgId(org.slug);
    const branchId = deterministicUuid(BRANCH_NAMESPACE, `${org.slug}:HQ`);

    await withSystem(
      async (tx) => {
        await tx
          .insert(branches)
          .values({
            id: branchId,
            orgId,
            code: 'HQ',
            name: `${org.displayName} Head Office`,
            kind: 'hq',
          })
          .onConflictDoUpdate({
            target: [branches.orgId, branches.code],
            set: { name: `${org.displayName} Head Office`, updatedAt: new Date() },
          });

        await tx
          .insert(locations)
          .values({
            id: deterministicUuid(LOCATION_NAMESPACE, `${org.slug}:WH-01`),
            orgId,
            branchId,
            code: 'WH-01',
            name: `${org.displayName} Main Warehouse`,
            kind: 'warehouse',
          })
          .onConflictDoUpdate({
            target: [locations.orgId, locations.code],
            set: { name: `${org.displayName} Main Warehouse`, updatedAt: new Date() },
          });
      },
      { orgId },
    );
  }

  // Counting is itself a small proof that the policies work. `organizations` is
  // global so it counts directly, but branches and locations have to be counted
  // inside each org's context — an uncontexted count returns 0, because
  // erp_owner is subject to FORCE RLS exactly like the application is.
  const totals = { organizations: 0, branches: 0, locations: 0, accounts: 0 };

  // The chart of accounts, after the branches it keeps a wallet for (§7).
  for (const org of SEED_ORGS) {
    totals.accounts += await seedChartOfAccounts(seedOrgId(org.slug));
  }

  /*
   * D-009's placeholder zones and each org's own-rider courier (M10, §9).
   *
   * Here rather than only in migration 0042, because on a fresh database that migration
   * runs before this seed exists to create the orgs and therefore writes nothing — and an
   * org with no zone and no courier cannot take an order at all. Idempotent, and it never
   * overwrites a charge an org has since edited. The count is not added to `SeedResult`:
   * the tenancy suite asserts that shape, and zones are not one of the four things it is
   * about.
   */
  await seedDeliveryZones(SEED_ORGS.map((org) => seedOrgId(org.slug)));

  totals.organizations = await withSystem(async (tx) => {
    const rows = await tx.execute<{ count: string }>(
      sql`select count(*) as count from org.organizations`,
    );
    return Number(rows[0]?.count ?? 0);
  });

  for (const org of SEED_ORGS) {
    const perOrg = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{ branches: string; locations: string }>(sql`
          select
            (select count(*) from org.branches) as branches,
            (select count(*) from org.locations) as locations
        `);
        return {
          branches: Number(rows[0]?.branches ?? 0),
          locations: Number(rows[0]?.locations ?? 0),
        };
      },
      { orgId: seedOrgId(org.slug) },
    );

    totals.branches += perOrg.branches;
    totals.locations += perOrg.locations;
  }

  return totals;
}

export { SEED_ORGS, SEED_ORG_IDS, seedOrgId, deterministicUuid } from './orgs.js';
export { ensureBranchWallets, seedAccountId, seedChartOfAccounts } from './ledger.js';
export { seedDeliveryZones, type DeliveryZoneSeedResult } from './delivery-zones.js';
export { branchCashCode, COA_TEMPLATE, type TemplateAccount } from './coa-template.js';
