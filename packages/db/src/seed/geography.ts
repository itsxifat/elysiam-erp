import { sql } from 'drizzle-orm';

import { withSystem } from '../client.js';
import { districts, divisions, thanas } from '../schema/ref/index.js';
import geography from './data/bd-geo.json' with { type: 'json' };

/**
 * Bangladesh administrative geography (architecture §5 exception 5).
 *
 * The data is vendored at `data/bd-geo.json` rather than fetched, so a seed
 * never depends on a network or on someone else's repository staying up. Its
 * provenance is recorded in the file: compiled from the official `*.gov.bd`
 * division, district and upazila portals (D-045).
 *
 * These names are not invented. A delivery system that ships to a place name
 * nobody recognises produces mis-routed parcels and a zone table the operations
 * team stops trusting, so the choice was between a sourced dataset and seeding
 * nothing. Note that a courier's own coverage list is the real authority for
 * where it will actually deliver; these rows are for addresses and zone
 * mapping (M10), and M12 reconciles them against each courier's areas.
 *
 * Ids come from the source rather than being generated, so a re-import is
 * idempotent and a district keeps its identity across reloads.
 */

export interface GeographySeedResult {
  readonly divisions: number;
  readonly districts: number;
  readonly thanas: number;
  readonly source: string;
}

export async function seedGeography(): Promise<GeographySeedResult> {
  await withSystem(async (tx) => {
    // Parents first: districts reference divisions, thanas reference districts.
    await tx
      .insert(divisions)
      .values(geography.divisions)
      .onConflictDoUpdate({
        target: divisions.id,
        set: { nameEn: sql`excluded.name_en`, nameBn: sql`excluded.name_bn` },
      });

    await tx
      .insert(districts)
      .values(geography.districts)
      .onConflictDoUpdate({
        target: districts.id,
        set: {
          divisionId: sql`excluded.division_id`,
          nameEn: sql`excluded.name_en`,
          nameBn: sql`excluded.name_bn`,
        },
      });

    await tx
      .insert(thanas)
      .values(geography.thanas)
      .onConflictDoUpdate({
        target: thanas.id,
        set: {
          districtId: sql`excluded.district_id`,
          nameEn: sql`excluded.name_en`,
          nameBn: sql`excluded.name_bn`,
        },
      });
  });

  return withSystem(async (tx) => {
    const rows = await tx.execute<{
      divisions: string;
      districts: string;
      thanas: string;
    }>(sql`
      select
        (select count(*) from ref.divisions) as divisions,
        (select count(*) from ref.districts) as districts,
        (select count(*) from ref.thanas) as thanas
    `);

    return {
      divisions: Number(rows[0]?.divisions ?? 0),
      districts: Number(rows[0]?.districts ?? 0),
      thanas: Number(rows[0]?.thanas ?? 0),
      source: geography.source,
    };
  });
}

/** What the vendored file claims to contain, for the seed to assert against. */
export const EXPECTED_GEOGRAPHY = {
  divisions: geography.divisions.length,
  districts: geography.districts.length,
  thanas: geography.thanas.length,
} as const;
