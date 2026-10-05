import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Every SQL statement the storefront module runs (M33).
 *
 * Its own schema, `storefront`, plus the two global ones every module may read (§5
 * exception 5): `org` for the brand's name and locations, `ref` for districts and thanas.
 * Nothing from `catalog`, `inventory`, `sales` or `files` — those are asked through their
 * modules' interfaces (invariant 12, `module-boundaries.test.ts`).
 *
 * Every statement runs inside the caller's `withOrg()` transaction; the explicit `org_id`
 * filters are for the planner and the reader, RLS is the control.
 */

// --- settings --------------------------------------------------------------------------------

export interface SettingsRow extends Record<string, unknown> {
  readonly site_name: string;
  readonly logo_file_id: string | null;
  readonly site_info: unknown;
  readonly social: unknown;
  readonly announcement: unknown;
  readonly promo_banner: unknown;
  readonly testimonials: unknown;
  readonly shipping: unknown;
  readonly payments: unknown;
  readonly updated_at: Date | string;
}

export async function settingsOf(tx: Tx, orgId: string): Promise<SettingsRow | undefined> {
  const rows = await tx.execute<SettingsRow>(sql`
    select site_name, logo_file_id, site_info, social, announcement, promo_banner, testimonials,
           shipping, payments, updated_at
    from storefront.settings where org_id = ${orgId}
  `);
  return rows[0];
}

/**
 * Write the whole settings row (the service merged the sections first), creating it on the
 * first save. Locked by the caller (`lockSettings`), so two sections saved at once by two
 * people do not overwrite each other's merge.
 */
export async function upsertSettings(
  tx: Tx,
  orgId: string,
  input: {
    readonly siteName: string;
    readonly logoFileId: string | null;
    readonly siteInfo: unknown;
    readonly social: unknown;
    readonly announcement: unknown;
    readonly promoBanner: unknown;
    readonly testimonials: unknown;
    readonly shipping: unknown;
    readonly payments: unknown;
    readonly updatedBy: string;
  },
): Promise<void> {
  const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
  await tx.execute(sql`
    insert into storefront.settings
      (org_id, site_name, logo_file_id, site_info, social, announcement, promo_banner,
       testimonials, shipping, payments, updated_by)
    values (${orgId}, ${input.siteName}, ${input.logoFileId}, ${json(input.siteInfo)},
            ${json(input.social)}, ${json(input.announcement)}, ${json(input.promoBanner)},
            ${json(input.testimonials)}, ${json(input.shipping)}, ${json(input.payments)},
            ${input.updatedBy})
    on conflict (org_id) do update set
      site_name = excluded.site_name,
      logo_file_id = excluded.logo_file_id,
      site_info = excluded.site_info,
      social = excluded.social,
      announcement = excluded.announcement,
      promo_banner = excluded.promo_banner,
      testimonials = excluded.testimonials,
      shipping = excluded.shipping,
      payments = excluded.payments,
      updated_by = excluded.updated_by,
      updated_at = now()
  `);
}

/** A per-brand lock for a settings save: a transaction-scoped advisory lock. */
export async function lockSettings(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`storefront.settings:${orgId}`}, 0))`,
  );
}

export async function webLocationIds(tx: Tx, orgId: string): Promise<string[]> {
  const rows = await tx.execute<{ location_id: string }>(sql`
    select w.location_id from storefront.web_locations w
    join org.locations l on l.org_id = w.org_id and l.id = w.location_id
    where w.org_id = ${orgId} and l.is_active
    order by l.code
  `);
  return rows.map((row) => row.location_id);
}

export async function replaceWebLocations(
  tx: Tx,
  orgId: string,
  locationIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`delete from storefront.web_locations where org_id = ${orgId}`);
  if (locationIds.length === 0) return;
  await tx.execute(sql`
    insert into storefront.web_locations (org_id, location_id)
    select ${orgId}, id from unnest(${sql.param([...locationIds])}::uuid[]) as id
  `);
}

// --- the brand and its places (org, global) --------------------------------------------------

export async function orgName(tx: Tx, orgId: string): Promise<string | undefined> {
  const rows = await tx.execute<{ name: string }>(sql`
    select display_name as name from org.organizations where id = ${orgId}
  `);
  return rows[0]?.name;
}

export interface LocationRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly is_active: boolean;
}

/** The places stock can be sold from: warehouses and showrooms, as §9's orders allow. */
export async function sellingLocations(tx: Tx, orgId: string): Promise<LocationRow[]> {
  const rows = await tx.execute<LocationRow>(sql`
    select id, code, name, kind::text as kind, is_active from org.locations
    where org_id = ${orgId} and kind in ('warehouse', 'showroom')
    order by kind desc, code
  `);
  return [...rows];
}

// --- hero slides -----------------------------------------------------------------------------

export interface HeroSlideRow extends Record<string, unknown> {
  readonly id: string;
  readonly desktop_file_id: string;
  readonly mobile_file_id: string | null;
  readonly link: string;
  readonly alt_text: string | null;
  readonly position: number;
  readonly is_active: boolean;
}

const HERO_COLUMNS = sql`id, desktop_file_id, mobile_file_id, link, alt_text, position, is_active`;

export async function heroSlides(tx: Tx, orgId: string): Promise<HeroSlideRow[]> {
  const rows = await tx.execute<HeroSlideRow>(sql`
    select ${HERO_COLUMNS} from storefront.hero_slides
    where org_id = ${orgId} order by position, created_at
  `);
  return [...rows];
}

export interface HeroSlideInput {
  readonly desktopFileId: string;
  readonly mobileFileId: string | null;
  readonly link: string;
  readonly altText: string | null;
  readonly isActive: boolean;
}

export async function insertHeroSlide(
  tx: Tx,
  orgId: string,
  input: HeroSlideInput,
): Promise<HeroSlideRow> {
  const rows = await tx.execute<HeroSlideRow>(sql`
    insert into storefront.hero_slides
      (org_id, desktop_file_id, mobile_file_id, link, alt_text, is_active, position)
    values (${orgId}, ${input.desktopFileId}, ${input.mobileFileId}, ${input.link},
            ${input.altText}, ${input.isActive},
            coalesce((select max(position) + 1 from storefront.hero_slides where org_id = ${orgId}), 0))
    returning ${HERO_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The hero slide insert returned no row.');
  return row;
}

export async function updateHeroSlide(
  tx: Tx,
  orgId: string,
  id: string,
  input: HeroSlideInput,
): Promise<HeroSlideRow | undefined> {
  const rows = await tx.execute<HeroSlideRow>(sql`
    update storefront.hero_slides set
      desktop_file_id = ${input.desktopFileId}, mobile_file_id = ${input.mobileFileId},
      link = ${input.link}, alt_text = ${input.altText}, is_active = ${input.isActive},
      updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning ${HERO_COLUMNS}
  `);
  return rows[0];
}

export async function deleteHeroSlide(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from storefront.hero_slides where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

/**
 * Write an order: one statement joined on a VALUES list (the catalog's image reorder), so
 * the order is one fact. Returns how many rows moved; the service refuses a list that is
 * not exactly the brand's slides.
 */
export async function reorderHeroSlides(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.hero_slides h set position = ordered.position, updated_at = now()
    from (values ${sql.join(
      ids.map((id, index) => sql`(${id}::uuid, ${index}::integer)`),
      sql`, `,
    )}) as ordered(id, position)
    where h.org_id = ${orgId} and h.id = ordered.id
    returning h.id
  `);
  return rows.length;
}

// --- the menu --------------------------------------------------------------------------------

export interface NavItemRow extends Record<string, unknown> {
  readonly id: string;
  readonly parent_id: string | null;
  readonly kind: 'link' | 'category' | 'dropdown';
  readonly label: string | null;
  readonly href: string | null;
  readonly category_id: string | null;
  readonly highlighted: boolean;
  readonly is_active: boolean;
  readonly position: number;
}

const NAV_COLUMNS = sql`id, parent_id, kind, label, href, category_id, highlighted, is_active,
  position`;

export async function navItems(tx: Tx, orgId: string): Promise<NavItemRow[]> {
  const rows = await tx.execute<NavItemRow>(sql`
    select ${NAV_COLUMNS} from storefront.nav_items
    where org_id = ${orgId} order by parent_id nulls first, position, created_at
  `);
  return [...rows];
}

/** Serialise menu edits per brand: the shape rules are checked across rows. */
export async function lockNav(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`storefront.nav:${orgId}`}, 0))`,
  );
}

export interface NavItemInput {
  readonly parentId: string | null;
  readonly kind: 'link' | 'category' | 'dropdown';
  readonly label: string | null;
  readonly href: string | null;
  readonly categoryId: string | null;
  readonly highlighted: boolean;
  readonly isActive: boolean;
}

export async function insertNavItem(
  tx: Tx,
  orgId: string,
  input: NavItemInput,
): Promise<NavItemRow> {
  const rows = await tx.execute<NavItemRow>(sql`
    insert into storefront.nav_items
      (org_id, parent_id, kind, label, href, category_id, highlighted, is_active, position)
    values (${orgId}, ${input.parentId}, ${input.kind}, ${input.label}, ${input.href},
            ${input.categoryId}, ${input.highlighted}, ${input.isActive},
            coalesce((select max(position) + 1 from storefront.nav_items
                      where org_id = ${orgId} and parent_id is not distinct from ${input.parentId}::uuid), 0))
    returning ${NAV_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The menu item insert returned no row.');
  return row;
}

export async function updateNavItem(
  tx: Tx,
  orgId: string,
  id: string,
  input: NavItemInput,
): Promise<NavItemRow | undefined> {
  const rows = await tx.execute<NavItemRow>(sql`
    update storefront.nav_items set
      parent_id = ${input.parentId}, kind = ${input.kind}, label = ${input.label},
      href = ${input.href}, category_id = ${input.categoryId}, highlighted = ${input.highlighted},
      is_active = ${input.isActive}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning ${NAV_COLUMNS}
  `);
  return rows[0];
}

/** Delete an item; a dropdown takes its items with it (the foreign key cascades). */
export async function deleteNavItem(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from storefront.nav_items where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

export async function layoutNav(
  tx: Tx,
  orgId: string,
  items: readonly {
    readonly id: string;
    readonly parentId: string | null;
    readonly position: number;
  }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.nav_items n
    set parent_id = laid.parent_id, position = laid.position, updated_at = now()
    from (values ${sql.join(
      items.map(
        (item) => sql`(${item.id}::uuid, ${item.parentId}::uuid, ${item.position}::integer)`,
      ),
      sql`, `,
    )}) as laid(id, parent_id, position)
    where n.org_id = ${orgId} and n.id = laid.id
    returning n.id
  `);
  return rows.length;
}

// --- size charts -----------------------------------------------------------------------------

export interface SizeChartRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly columns: string[];
  readonly rows: string[][];
  readonly updated_at: Date | string;
}

const CHART_COLUMNS = sql`id, name, columns, rows, updated_at`;

export async function sizeCharts(tx: Tx, orgId: string): Promise<SizeChartRow[]> {
  const rows = await tx.execute<SizeChartRow>(sql`
    select ${CHART_COLUMNS} from storefront.size_charts where org_id = ${orgId} order by name
  `);
  return [...rows];
}

export async function sizeChartById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SizeChartRow | undefined> {
  const rows = await tx.execute<SizeChartRow>(sql`
    select ${CHART_COLUMNS} from storefront.size_charts where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function insertSizeChart(
  tx: Tx,
  orgId: string,
  input: { readonly name: string; readonly columns: readonly string[]; readonly rows: unknown },
): Promise<SizeChartRow> {
  const rows = await tx.execute<SizeChartRow>(sql`
    insert into storefront.size_charts (org_id, name, columns, rows)
    values (${orgId}, ${input.name}, ${sql.param([...input.columns])}::text[],
            ${JSON.stringify(input.rows)}::jsonb)
    returning ${CHART_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The size chart insert returned no row.');
  return row;
}

export async function updateSizeChart(
  tx: Tx,
  orgId: string,
  id: string,
  input: { readonly name: string; readonly columns: readonly string[]; readonly rows: unknown },
): Promise<SizeChartRow | undefined> {
  const rows = await tx.execute<SizeChartRow>(sql`
    update storefront.size_charts set
      name = ${input.name}, columns = ${sql.param([...input.columns])}::text[],
      rows = ${JSON.stringify(input.rows)}::jsonb, updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning ${CHART_COLUMNS}
  `);
  return rows[0];
}

export async function deleteSizeChart(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from storefront.size_charts where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

// --- site keys -------------------------------------------------------------------------------

export interface SiteKeyRow extends Record<string, unknown> {
  readonly id: string;
  readonly label: string;
  readonly key_id: string;
  readonly secret_sha256: string;
  readonly last_used_at: Date | string | null;
  readonly revoked_at: Date | string | null;
  readonly created_at: Date | string;
}

const KEY_COLUMNS = sql`id, label, key_id, secret_sha256, last_used_at, revoked_at, created_at`;

export async function siteKeys(tx: Tx, orgId: string): Promise<SiteKeyRow[]> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    select ${KEY_COLUMNS} from storefront.site_keys
    where org_id = ${orgId} order by revoked_at nulls first, created_at desc
  `);
  return [...rows];
}

export async function siteKeyByKeyId(
  tx: Tx,
  orgId: string,
  keyId: string,
): Promise<SiteKeyRow | undefined> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    select ${KEY_COLUMNS} from storefront.site_keys where org_id = ${orgId} and key_id = ${keyId}
  `);
  return rows[0];
}

export async function insertSiteKey(
  tx: Tx,
  orgId: string,
  input: {
    readonly label: string;
    readonly keyId: string;
    readonly secretSha256: string;
    readonly createdBy: string;
  },
): Promise<SiteKeyRow> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    insert into storefront.site_keys (org_id, label, key_id, secret_sha256, created_by)
    values (${orgId}, ${input.label}, ${input.keyId}, ${input.secretSha256}, ${input.createdBy})
    returning ${KEY_COLUMNS}
  `);
  const row = rows[0];
  if (row === undefined) throw new Error('The site key insert returned no row.');
  return row;
}

/** Revoke once: a second revoke finds nothing to change and says so. */
export async function revokeSiteKey(
  tx: Tx,
  orgId: string,
  id: string,
  revokedBy: string,
): Promise<SiteKeyRow | undefined> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    update storefront.site_keys set revoked_at = now(), revoked_by = ${revokedBy}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and revoked_at is null
    returning ${KEY_COLUMNS}
  `);
  return rows[0];
}

export async function siteKeyById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SiteKeyRow | undefined> {
  const rows = await tx.execute<SiteKeyRow>(sql`
    select ${KEY_COLUMNS} from storefront.site_keys where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

/**
 * Note a key's use, at most every five minutes: a write per read would make every page a
 * shopper opens an UPDATE.
 */
export async function touchSiteKey(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update storefront.site_keys set last_used_at = now()
    where org_id = ${orgId} and id = ${id}
      and (last_used_at is null or last_used_at < now() - interval '5 minutes')
  `);
}

// --- old ids ---------------------------------------------------------------------------------

export async function legacyIds(
  tx: Tx,
  orgId: string,
  kind: string,
  legacy: readonly string[],
): Promise<Map<string, string>> {
  if (legacy.length === 0) return new Map();
  const rows = await tx.execute<{ legacy_id: string; erp_id: string }>(sql`
    select legacy_id, erp_id from storefront.legacy_ids
    where org_id = ${orgId} and kind = ${kind}
      and legacy_id = any (${sql.param([...legacy])}::text[])
  `);
  return new Map(rows.map((row) => [row.legacy_id, row.erp_id]));
}

/** The old ids these ERP rows of one kind carry (the earliest recorded, for each). */
export async function legacyIdsFor(
  tx: Tx,
  orgId: string,
  kind: string,
  erpIds: readonly string[],
): Promise<Map<string, string>> {
  if (erpIds.length === 0) return new Map();
  const rows = await tx.execute<{ legacy_id: string; erp_id: string }>(sql`
    select distinct on (erp_id) erp_id, legacy_id from storefront.legacy_ids
    where org_id = ${orgId} and kind = ${kind}
      and erp_id = any (${sql.param([...erpIds])}::uuid[])
    order by erp_id, created_at, legacy_id
  `);
  return new Map(rows.map((row) => [row.erp_id, row.legacy_id]));
}

export async function insertLegacyIds(
  tx: Tx,
  orgId: string,
  rows: readonly { readonly kind: string; readonly legacyId: string; readonly erpId: string }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await tx.execute<{ legacy_id: string }>(sql`
    insert into storefront.legacy_ids (org_id, kind, legacy_id, erp_id)
    values ${sql.join(
      rows.map((row) => sql`(${orgId}, ${row.kind}, ${row.legacyId}, ${row.erpId}::uuid)`),
      sql`, `,
    )}
    on conflict do nothing
    returning legacy_id
  `);
  return inserted.length;
}

// --- geography (ref, global) -----------------------------------------------------------------

export async function districts(
  tx: Tx,
): Promise<{ id: number; division_id: number; name_en: string; name_bn: string }[]> {
  const rows = await tx.execute<{
    id: number;
    division_id: number;
    name_en: string;
    name_bn: string;
  }>(sql`
    select id, division_id, name_en, name_bn from ref.districts order by name_en
  `);
  return [...rows];
}

export async function thanas(
  tx: Tx,
  districtId: number | null,
): Promise<{ id: number; district_id: number; name_en: string; name_bn: string }[]> {
  const rows = await tx.execute<{
    id: number;
    district_id: number;
    name_en: string;
    name_bn: string;
  }>(sql`
    select id, district_id, name_en, name_bn from ref.thanas
    where ${districtId === null ? sql`true` : sql`district_id = ${districtId}`}
    order by district_id, name_en
  `);
  return [...rows];
}
