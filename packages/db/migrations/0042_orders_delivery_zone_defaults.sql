-- D-009's placeholder delivery zones and charges, per org (M10; architecture §9).
--
-- D-009 is still OPEN: the client has not confirmed real charges, and CLAUDE.md's rule
-- for that case is to implement the ASSUMED default behind configuration and carry on.
-- So the three zones go in with the figures D-009 names — Inside Dhaka ৳60, Dhaka
-- suburbs ৳100, Outside Dhaka ৳120 — every one of them editable per org, and the
-- district mapping is seeded rather than hard-coded so an org can carve out the thanas
-- its own rider covers.
--
-- This is a migration rather than a line in `pnpm db:seed` for one reason: an org with no
-- zones cannot take an order at all, and a system where order entry works only after
-- somebody remembered to run a seed is a system that will be found broken on a Friday.
-- It is idempotent on `(org_id, code)`, so a re-run adds nothing and never overwrites a
-- charge an org has since changed.
--
-- ## Why the DO block sets `app.org_id`
--
-- `sales.*` has RLS ENABLE **and FORCE** (0040), so the table's owner — `erp_owner`, the
-- role that runs migrations — is subject to the isolation policy like everybody else.
-- That is exactly what FORCE is for, and it means an INSERT here with no org context
-- matches nothing and is refused. Setting the context per org inside the loop is how a
-- migration writes tenant rows without a hole in the policy: `set_config(..., true)` is
-- transaction-local, so it is gone the moment this migration commits.

DO $$
DECLARE
  org_row record;
  zone_inside uuid;
  zone_suburb uuid;
  zone_outside uuid;
  courier_own uuid;
  suburb_districts int[] := ARRAY[41, 43, 48, 46, 40];  -- Gazipur, Narayanganj, Munshiganj, Manikganj, Narsingdi
  dhaka_district int := 47;
BEGIN
  FOR org_row IN SELECT id, slug FROM "org"."organizations" ORDER BY slug LOOP
    PERFORM set_config('app.org_id', org_row.id::text, true);

    /*
     * One courier to start with: the brand's own rider.
     *
     * Every delivery journal names a courier on the receivable (§7), so an org needs at
     * least one party row before it can deliver anything. `own_rider` is the honest
     * default — it is how a Dhaka order actually goes out on day one — and M12 adds
     * Steadfast, Pathao and RedX beside it with their credentials and adapters.
     */
    INSERT INTO "sales"."couriers" (org_id, code, name)
    VALUES (org_row.id, 'own_rider', 'Own rider')
    ON CONFLICT (org_id, code) DO NOTHING;

    SELECT id INTO courier_own
    FROM "sales"."couriers"
    WHERE org_id = org_row.id AND code = 'own_rider';

    INSERT INTO "sales"."delivery_zones"
      (org_id, code, name_en, name_bn, charge_poisha, default_courier_id, position)
    VALUES
      (org_row.id, 'inside_dhaka',  'Inside Dhaka',  'ঢাকার ভিতরে',  6000,  courier_own, 1),
      (org_row.id, 'dhaka_suburbs', 'Dhaka suburbs', 'ঢাকার পার্শ্ববর্তী এলাকা', 10000, courier_own, 2),
      (org_row.id, 'outside_dhaka', 'Outside Dhaka', 'ঢাকার বাইরে',  12000, courier_own, 3)
    ON CONFLICT (org_id, code) DO NOTHING;

    SELECT id INTO zone_inside  FROM "sales"."delivery_zones" WHERE org_id = org_row.id AND code = 'inside_dhaka';
    SELECT id INTO zone_suburb  FROM "sales"."delivery_zones" WHERE org_id = org_row.id AND code = 'dhaka_suburbs';
    SELECT id INTO zone_outside FROM "sales"."delivery_zones" WHERE org_id = org_row.id AND code = 'outside_dhaka';

    /*
     * Every district mapped, district-wide (`thana_id` null), so no address can be
     * entered that has no charge.
     *
     * An unmapped district is the failure worth designing against: order entry would
     * either refuse a legitimate Sylhet address or quietly price it at zero, and the
     * second is the one nobody notices until the courier invoice arrives.
     */
    INSERT INTO "sales"."delivery_zone_areas" (org_id, zone_id, district_id, thana_id)
    SELECT
      org_row.id,
      CASE
        WHEN d.id = dhaka_district THEN zone_inside
        WHEN d.id = ANY(suburb_districts) THEN zone_suburb
        ELSE zone_outside
      END,
      d.id,
      NULL
    FROM "ref"."districts" d
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- Leave no org context behind for whatever statement runs next in this transaction.
  PERFORM set_config('app.org_id', '', true);
END;
$$;
