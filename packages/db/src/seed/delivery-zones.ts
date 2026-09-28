import { sql } from 'drizzle-orm';

import { withSystem } from '../client.js';

/**
 * Each org's own-rider courier and D-009's placeholder delivery zones (M10, §9).
 *
 * ## Why this is in the seed and not only in a migration
 *
 * Migration 0042 writes the same rows, and on a **fresh** database it writes none: the
 * documented order is `db:bootstrap && db:migrate && db:seed`, so when 0042 runs there are
 * no organizations to loop over. It is still the right migration for an existing database,
 * where the orgs are already there — and this is what makes a new one work, because an org
 * with no zone and no courier cannot take an order at all (the delivery journal names a
 * courier, §7) and a system that works only after somebody remembered a manual step is a
 * system that will be found broken on a Friday.
 *
 * Idempotent on `(org_id, code)` like the rest of the seed, and it never overwrites a
 * charge an org has since changed: D-009 is still OPEN, so these figures are the assumed
 * defaults and the org's own edits are the real answer.
 *
 * ## Why it sets an org context
 *
 * `sales.*` has RLS ENABLE **and FORCE**, so `erp_owner` — the role the seed runs as — is
 * subject to the isolation policy like everybody else. An uncontexted insert matches
 * nothing and is refused. The seed exercising the same policies as the application is
 * deliberate: a broken policy breaks the seed loudly instead of hiding until production.
 */

/** D-009's placeholders: Inside Dhaka ৳60, Dhaka suburbs ৳100, Outside Dhaka ৳120. */
const ZONES = [
  {
    code: 'inside_dhaka',
    nameEn: 'Inside Dhaka',
    nameBn: 'ঢাকার ভিতরে',
    chargePoisha: 6000,
    position: 1,
  },
  {
    code: 'dhaka_suburbs',
    nameEn: 'Dhaka suburbs',
    nameBn: 'ঢাকার পার্শ্ববর্তী এলাকা',
    chargePoisha: 10_000,
    position: 2,
  },
  {
    code: 'outside_dhaka',
    nameEn: 'Outside Dhaka',
    nameBn: 'ঢাকার বাইরে',
    chargePoisha: 12_000,
    position: 3,
  },
] as const;

/** Gazipur, Narayanganj, Munshiganj, Manikganj, Narsingdi — as migration 0042 maps them. */
const SUBURB_DISTRICTS = [41, 43, 48, 46, 40];
const DHAKA_DISTRICT = 47;

export interface DeliveryZoneSeedResult {
  readonly couriers: number;
  readonly zones: number;
  readonly areas: number;
}

export async function seedDeliveryZones(
  orgIds: readonly string[],
): Promise<DeliveryZoneSeedResult> {
  /*
   * Skip quietly on a database that has not reached M10's migrations.
   *
   * The seed is run by the CLI, by the test harness and by the tenancy suite, and one of
   * them may be pointed at a database migrated only part of the way. Failing there would
   * make an unrelated suite fail with a message about a schema, so the absence is treated
   * as "nothing to seed yet" — which is what it is.
   */
  const present = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('sales') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (!present) return { couriers: 0, zones: 0, areas: 0 };

  const totals = { couriers: 0, zones: 0, areas: 0 };

  for (const orgId of orgIds) {
    await withSystem(
      async (tx) => {
        /*
         * One courier to start with: the brand's own rider.
         *
         * Every delivery journal names a courier on the receivable (§7), so an org needs
         * at least one party row before it can deliver anything. `own_rider` is the honest
         * default — it is how a Dhaka order actually goes out on day one — and M12 adds
         * Steadfast, Pathao and RedX beside it with their credentials and adapters.
         */
        await tx.execute(sql`
          insert into sales.couriers (org_id, code, name)
          values (${orgId}, 'own_rider', 'Own rider')
          on conflict (org_id, code) do nothing
        `);
        const courierRows = await tx.execute<{ id: string }>(sql`
          select id from sales.couriers where org_id = ${orgId} and code = 'own_rider'
        `);
        const courierId = courierRows[0]?.id ?? null;
        totals.couriers += courierId === null ? 0 : 1;

        for (const zone of ZONES) {
          await tx.execute(sql`
            insert into sales.delivery_zones
              (org_id, code, name_en, name_bn, charge_poisha, default_courier_id, position)
            values (${orgId}, ${zone.code}, ${zone.nameEn}, ${zone.nameBn},
                    ${String(zone.chargePoisha)}::bigint, ${courierId}::uuid, ${zone.position})
            on conflict (org_id, code) do nothing
          `);
        }
        totals.zones += ZONES.length;

        /*
         * Every district mapped district-wide (`thana_id` null), so no address can be
         * entered that has no charge.
         *
         * An unmapped district is the failure worth designing against: order entry would
         * either refuse a legitimate Sylhet address or quietly price it at zero, and the
         * second is the one nobody notices until the courier invoice arrives. An org that
         * wants to carve out the thanas its own rider covers adds the more specific rows,
         * which the lookup prefers.
         */
        const mapped = await tx.execute<{ id: string }>(sql`
          insert into sales.delivery_zone_areas (org_id, zone_id, district_id, thana_id)
          select ${orgId},
                 case
                   when d.id = ${DHAKA_DISTRICT} then inside.id
                   when d.id = any(${sql`array[${sql.join(
                     SUBURB_DISTRICTS.map((id) => sql`${id}`),
                     sql`, `,
                   )}]::int[]`}) then suburb.id
                   else outside.id
                 end,
                 d.id,
                 null
          from ref.districts d
          cross join (select id from sales.delivery_zones
                      where org_id = ${orgId} and code = 'inside_dhaka') inside
          cross join (select id from sales.delivery_zones
                      where org_id = ${orgId} and code = 'dhaka_suburbs') suburb
          cross join (select id from sales.delivery_zones
                      where org_id = ${orgId} and code = 'outside_dhaka') outside
          on conflict do nothing
          returning id
        `);
        totals.areas += mapped.length;
      },
      { orgId },
    );
  }

  return totals;
}
