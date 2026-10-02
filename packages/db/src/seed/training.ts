import { sql } from 'drizzle-orm';

import { withSystem } from '../client.js';
import { seedDeliveryZones } from './delivery-zones.js';
import { seedAccountId, seedChartOfAccounts } from './ledger.js';
import { deterministicUuid, seedOrgId } from './orgs.js';

/**
 * The training org's set-up (M14a, D-223): everything a brand has before its migration.
 *
 * A brand arrives at its data migration with a chart, a warehouse, its wallets, its
 * suppliers, its couriers and a size attribute already set up in the console; the
 * importers then bring in what it *holds*. The training org gets the same starting point
 * here, as a seed — idempotent, deterministic ids, run as `erp_owner` like `db:seed` —
 * and `pnpm demo:org` then runs the anonymised sample files through the real importers
 * and the real opening post, so the demo's stock and money arrive the way a brand's do.
 *
 * `is_training` marks it, and the two consolidated cross-org reads leave it out, so its
 * practice money never reaches a super admin's group totals.
 */

export const TRAINING_ORG_SLUG = 'training';

const NAMESPACE = 'elysium-erp/training';

export function trainingOrgId(): string {
  return seedOrgId(TRAINING_ORG_SLUG);
}

const SIZES = [
  ['S', 'S'],
  ['M', 'M'],
  ['L', 'L'],
  ['XL', 'XL'],
] as const;

const SUPPLIERS = [
  ['DEMO-FAB', 'Demo Fabrics'],
  ['DEMO-TAIL', 'Demo Tailoring'],
] as const;

/** The training org itself, flagged `is_training`, then its set-up. Returns its id. */
export async function seedTrainingOrg(): Promise<string> {
  const orgId = trainingOrgId();

  await withSystem(async (tx) => {
    await tx.execute(sql`
      insert into org.organizations (id, slug, legal_name, display_name, brand, is_training)
      values (${orgId}, ${TRAINING_ORG_SLUG}, 'Training (demo data)', 'Training',
              ${JSON.stringify({
                accent: { hue: 200, chroma: 0.05 },
                logoFileId: null,
                logoDarkFileId: null,
                legalName: 'Training (demo data)',
                address: null,
                vatNo: null,
                invoiceFooter: null,
              })}::jsonb, true)
      on conflict (slug) do update set is_training = true, updated_at = now()
    `);
  });

  await seedDemoSetUp(orgId);
  return orgId;
}

/**
 * What a brand has set up before its migration, for the demo's sample files: an HQ
 * branch, a warehouse and a showroom, the chart, three wallets, a courier, two suppliers
 * and a size attribute. Idempotent. Exported for the M14a database tests, which run the
 * same sample files through a seeded brand.
 */
export async function seedDemoSetUp(orgId: string): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into org.branches (id, org_id, code, name, kind)
        values (${deterministicUuid(NAMESPACE, `${orgId}:branch:HQ`)}, ${orgId}, 'HQ',
                'Head Office', 'hq'::org.branch_kind)
        on conflict (org_id, code) do nothing
      `);
      const branchRows = await tx.execute<{ id: string }>(
        sql`select id from org.branches where org_id = ${orgId} and code = 'HQ'`,
      );
      const branchId = branchRows[0]?.id ?? null;
      for (const [code, name, kind] of [
        ['WH-01', 'Main Warehouse', 'warehouse'],
        ['SR-01', 'Showroom', 'showroom'],
      ] as const) {
        await tx.execute(sql`
          insert into org.locations (id, org_id, branch_id, code, name, kind)
          values (${deterministicUuid(NAMESPACE, `${orgId}:location:${code}`)}, ${orgId},
                  ${branchId}::uuid,
                  ${code}, ${name}, ${kind}::org.location_kind)
          on conflict (org_id, code) do nothing
        `);
      }
    },
    { orgId },
  );

  await seedChartOfAccounts(orgId);
  await seedDeliveryZones([orgId]);

  const branchId = await withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(
        sql`select id from org.branches where org_id = ${orgId} and code = 'HQ'`,
      );
      return rows[0]?.id ?? null;
    },
    { orgId },
  );

  await withSystem(
    async (tx) => {
      // Hand cash at HQ, the bank and bKash: the wallets the sample balance file names.
      for (const [code, branch, provider] of [
        ['1010-HQ', branchId, null],
        ['1100', null, 'Demo Bank'],
        ['1110', null, 'bKash'],
      ] as const) {
        await tx.execute(sql`
          insert into wallets.wallets (org_id, ledger_account_id, branch_id, provider)
          values (${orgId}, ${seedAccountId(orgId, code)}, ${branch}::uuid, ${provider})
          on conflict (org_id, ledger_account_id) do nothing
        `);
      }

      await tx.execute(sql`
        insert into sales.couriers (org_id, code, name)
        values (${orgId}, 'steadfast', 'Steadfast')
        on conflict (org_id, code) do nothing
      `);

      for (const [code, name] of SUPPLIERS) {
        await tx.execute(sql`
          insert into supply.suppliers (org_id, code, name)
          values (${orgId}, ${code}, ${name})
          on conflict (org_id, code) do nothing
        `);
      }

      const attributeId = deterministicUuid(NAMESPACE, `${orgId}:attribute:SIZE`);
      await tx.execute(sql`
        insert into catalog.attributes (id, org_id, code, name, kind, is_variant, position)
        values (${attributeId}, ${orgId}, 'SIZE', 'Size', 'size', true, 0)
        on conflict (org_id, code) do nothing
      `);
      const attributeRows = await tx.execute<{ id: string }>(
        sql`select id from catalog.attributes where org_id = ${orgId} and code = 'SIZE'`,
      );
      const sizeId = attributeRows[0]?.id ?? attributeId;
      for (const [index, [code, label]] of SIZES.entries()) {
        await tx.execute(sql`
          insert into catalog.attribute_values (org_id, attribute_id, code, label, position)
          values (${orgId}, ${sizeId}, ${code}, ${label}, ${index})
          on conflict (org_id, attribute_id, code) do nothing
        `);
      }
    },
    { orgId },
  );
}
