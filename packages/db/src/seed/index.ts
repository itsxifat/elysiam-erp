import { sql } from 'drizzle-orm';

import { withSystem } from '../client.js';
import { branches, locations, organizations } from '../schema/org/index.js';
import { seedDeliveryZones } from './delivery-zones.js';
import { seedChartOfAccounts } from './ledger.js';
import { deterministicUuid, SEED_ORGS, seedOrgId, type SeedOrg } from './orgs.js';

/**
 * Seed the five orgs (or one, for a brand's own ERP: D-470), each with an HQ branch, a
 * warehouse location, its chart of accounts with a hand-cash wallet, and its delivery
 * zones (M03).
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

export interface SeedOptions {
  /**
   * Seed only these brands, by slug (D-470, M31). A brand's ERP runs on a database of its
   * own, so its seed writes that one brand: `pnpm db:seed --brand <slug>` or
   * `SEED_BRANDS=<slug>`. Absent means all five, the many-brand mode of the tests and local
   * development.
   */
  readonly brands?: readonly string[] | undefined;
}

/** The brands a seed run writes: all five, or the named ones. An unknown slug throws. */
export function seedOrgsFor(brands: readonly string[] | undefined): readonly SeedOrg[] {
  if (brands === undefined) return SEED_ORGS;
  const unknown = brands.filter((slug) => !SEED_ORGS.some((org) => org.slug === slug));
  if (unknown.length > 0 || brands.length === 0) {
    throw new Error(
      `db:seed: no brand with the slug ${unknown.join(', ') || '(none given)'}. ` +
        `Known slugs: ${SEED_ORGS.map((org) => org.slug).join(', ')}.`,
    );
  }
  return SEED_ORGS.filter((org) => brands.includes(org.slug));
}

/**
 * `--brand <slug>` (repeatable) or `SEED_BRANDS=<slug>[,<slug>]`; undefined when neither.
 * The command line wins over the environment.
 */
export function seedBrandsFrom(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string[] | undefined {
  const fromArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--brand') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('db:seed: --brand needs a slug, e.g. --brand oura-lifestyle.');
      }
      fromArgs.push(value);
      index += 1;
    } else if (arg.startsWith('--brand=')) {
      fromArgs.push(arg.slice('--brand='.length));
    }
  }
  if (fromArgs.length > 0) return fromArgs;
  const fromEnv = (env.SEED_BRANDS ?? '')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : undefined;
}

export async function seedOrganizations(options: SeedOptions = {}): Promise<SeedResult> {
  const orgs = seedOrgsFor(options.brands);
  // organizations is global (§5 exception 5), so it needs no org context.
  await withSystem(async (tx) => {
    for (const org of orgs) {
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

  for (const org of orgs) {
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
  for (const org of orgs) {
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
  await seedDeliveryZones(orgs.map((org) => seedOrgId(org.slug)));

  totals.organizations = await withSystem(async (tx) => {
    const rows = await tx.execute<{ count: string }>(
      sql`select count(*) as count from org.organizations`,
    );
    return Number(rows[0]?.count ?? 0);
  });

  for (const org of orgs) {
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
export { seedTrainingOrg, TRAINING_ORG_SLUG, trainingOrgId } from './training.js';
