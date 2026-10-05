import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The SQL behind campaign links and the website's tracking (M35b, D-551, D-552).
 *
 * Its own schema's tables only; the catalog (categories, products) and the orders are asked
 * through their modules' interfaces. Every statement runs inside the caller's `withOrg()`.
 */

const bytes = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(value as Uint8Array);

// --- campaign links -------------------------------------------------------------------------

export interface CustomLinkRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly base_type: 'category' | 'shop' | 'custom';
  readonly category_id: string | null;
  readonly custom_path: string | null;
  readonly highlight_product_ids: string[];
  readonly banner: unknown;
  readonly modal: unknown;
  readonly is_active: boolean;
  readonly views: string | number | bigint;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

const LINK_COLUMNS = sql`id, code, title, base_type, category_id, custom_path,
  highlight_product_ids, banner, modal, is_active, views, created_at, updated_at`;

export async function customLinks(tx: Tx, orgId: string): Promise<CustomLinkRow[]> {
  const rows = await tx.execute<CustomLinkRow>(sql`
    select ${LINK_COLUMNS} from storefront.custom_links
    where org_id = ${orgId} order by created_at desc, id
  `);
  return [...rows];
}

export async function customLinkById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CustomLinkRow | undefined> {
  const rows = await tx.execute<CustomLinkRow>(sql`
    select ${LINK_COLUMNS} from storefront.custom_links where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function customLinkByCode(
  tx: Tx,
  orgId: string,
  code: string,
): Promise<CustomLinkRow | undefined> {
  const rows = await tx.execute<CustomLinkRow>(sql`
    select ${LINK_COLUMNS} from storefront.custom_links where org_id = ${orgId} and code = ${code}
  `);
  return rows[0];
}

export interface CustomLinkValues {
  readonly title: string;
  readonly baseType: 'category' | 'shop' | 'custom';
  readonly categoryId: string | null;
  readonly customPath: string | null;
  readonly highlightProductIds: readonly string[];
  readonly banner: unknown;
  readonly modal: unknown;
  readonly isActive: boolean;
}

/** Inserts under a fresh code; null when the code was taken (the caller draws another). */
export async function insertCustomLink(
  tx: Tx,
  input: CustomLinkValues & {
    readonly orgId: string;
    readonly code: string;
    readonly actor: string;
  },
): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into storefront.custom_links
      (org_id, code, title, base_type, category_id, custom_path, highlight_product_ids, banner,
       modal, is_active, created_by, updated_by)
    values (${input.orgId}, ${input.code}, ${input.title}, ${input.baseType}, ${input.categoryId},
            ${input.customPath}, ${`{${input.highlightProductIds.join(',')}}`}::uuid[],
            ${JSON.stringify(input.banner)}::jsonb, ${JSON.stringify(input.modal)}::jsonb,
            ${input.isActive}, ${input.actor}, ${input.actor})
    on conflict (org_id, code) do nothing
    returning id
  `);
  return rows[0]?.id ?? null;
}

export async function updateCustomLink(
  tx: Tx,
  input: CustomLinkValues & { readonly orgId: string; readonly id: string; readonly actor: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.custom_links
    set title = ${input.title}, base_type = ${input.baseType}, category_id = ${input.categoryId},
        custom_path = ${input.customPath},
        highlight_product_ids = ${`{${input.highlightProductIds.join(',')}}`}::uuid[],
        banner = ${JSON.stringify(input.banner)}::jsonb, modal = ${JSON.stringify(input.modal)}::jsonb,
        is_active = ${input.isActive}, updated_by = ${input.actor}, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id}
    returning id
  `);
  return rows.length === 1;
}

export async function deleteCustomLink(tx: Tx, orgId: string, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from storefront.custom_links where org_id = ${orgId} and id = ${id} returning id
  `);
  return rows.length === 1;
}

/** One more view of a live link; false when there is no such live link. */
export async function countCustomLinkView(tx: Tx, orgId: string, code: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update storefront.custom_links set views = views + 1
    where org_id = ${orgId} and code = ${code} and is_active
    returning id
  `);
  return rows.length === 1;
}

/** A district's English name, for a purchase's city (the shared geography, §5). */
export async function districtName(tx: Tx, districtId: number): Promise<string | null> {
  const rows = await tx.execute<{ name_en: string }>(sql`
    select name_en from ref.districts where id = ${districtId}
  `);
  return rows[0]?.name_en ?? null;
}

// --- tracking settings ----------------------------------------------------------------------

export interface TrackingSettingsRow extends Record<string, unknown> {
  readonly meta_pixel_enabled: boolean;
  readonly meta_capi_enabled: boolean;
  readonly meta_pixel_id: string;
  readonly meta_dataset_id: string;
  readonly meta_api_version: string;
  readonly meta_token_sealed: Buffer | null;
  readonly meta_token_fingerprint: string | null;
  readonly meta_test_event_code: string;
  readonly default_country_code: string;
  readonly ga4_client_enabled: boolean;
  readonly ga4_mp_enabled: boolean;
  readonly ga4_measurement_id: string;
  readonly ga4_secret_sealed: Buffer | null;
  readonly ga4_secret_fingerprint: string | null;
  readonly key_id: string | null;
  readonly proxy: unknown;
  readonly test_mode: boolean;
  readonly events: unknown;
  readonly log_retention_days: number;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export async function trackingSettings(
  tx: Tx,
  orgId: string,
): Promise<TrackingSettingsRow | undefined> {
  const rows = await tx.execute<TrackingSettingsRow>(sql`
    select meta_pixel_enabled, meta_capi_enabled, meta_pixel_id, meta_dataset_id, meta_api_version,
           meta_token_sealed, meta_token_fingerprint, meta_test_event_code, default_country_code,
           ga4_client_enabled, ga4_mp_enabled, ga4_measurement_id, ga4_secret_sealed,
           ga4_secret_fingerprint, key_id, proxy, test_mode, events, log_retention_days,
           updated_by, updated_at
    from storefront.tracking_settings where org_id = ${orgId}
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    ...row,
    meta_token_sealed: bytes(row.meta_token_sealed),
    ga4_secret_sealed: bytes(row.ga4_secret_sealed),
  };
}

export interface SealedSecret {
  readonly sealed: Buffer;
  readonly fingerprint: string;
}

export async function upsertTrackingSettings(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly metaPixelEnabled: boolean;
    readonly metaCapiEnabled: boolean;
    readonly metaPixelId: string;
    readonly metaDatasetId: string;
    readonly metaApiVersion: string;
    readonly metaTestEventCode: string;
    readonly defaultCountryCode: string;
    readonly ga4ClientEnabled: boolean;
    readonly ga4MpEnabled: boolean;
    readonly ga4MeasurementId: string;
    readonly proxy: unknown;
    readonly testMode: boolean;
    readonly events: unknown;
    readonly logRetentionDays: number;
    /** Undefined keeps the stored secret, null removes it. */
    readonly metaToken: SealedSecret | null | undefined;
    readonly ga4Secret: SealedSecret | null | undefined;
    readonly keyId: string | null;
    readonly updatedBy: string;
  },
): Promise<void> {
  const token = input.metaToken;
  const secret = input.ga4Secret;
  const sealedNow =
    (token !== undefined && token !== null) || (secret !== undefined && secret !== null);
  await tx.execute(sql`
    insert into storefront.tracking_settings
      (org_id, meta_pixel_enabled, meta_capi_enabled, meta_pixel_id, meta_dataset_id,
       meta_api_version, meta_test_event_code, default_country_code, ga4_client_enabled,
       ga4_mp_enabled, ga4_measurement_id, proxy, test_mode, events, log_retention_days,
       meta_token_sealed, meta_token_fingerprint, ga4_secret_sealed, ga4_secret_fingerprint,
       key_id, updated_by)
    values (${input.orgId}, ${input.metaPixelEnabled}, ${input.metaCapiEnabled},
            ${input.metaPixelId}, ${input.metaDatasetId}, ${input.metaApiVersion},
            ${input.metaTestEventCode}, ${input.defaultCountryCode}, ${input.ga4ClientEnabled},
            ${input.ga4MpEnabled}, ${input.ga4MeasurementId}, ${JSON.stringify(input.proxy)}::jsonb,
            ${input.testMode}, ${JSON.stringify(input.events)}::jsonb, ${input.logRetentionDays},
            ${token?.sealed ?? null}, ${token?.fingerprint ?? null}, ${secret?.sealed ?? null},
            ${secret?.fingerprint ?? null},
            ${sealedNow ? input.keyId : null},
            ${input.updatedBy})
    on conflict (org_id) do update set
      meta_pixel_enabled = excluded.meta_pixel_enabled,
      meta_capi_enabled = excluded.meta_capi_enabled,
      meta_pixel_id = excluded.meta_pixel_id,
      meta_dataset_id = excluded.meta_dataset_id,
      meta_api_version = excluded.meta_api_version,
      meta_test_event_code = excluded.meta_test_event_code,
      default_country_code = excluded.default_country_code,
      ga4_client_enabled = excluded.ga4_client_enabled,
      ga4_mp_enabled = excluded.ga4_mp_enabled,
      ga4_measurement_id = excluded.ga4_measurement_id,
      proxy = excluded.proxy,
      test_mode = excluded.test_mode,
      events = excluded.events,
      log_retention_days = excluded.log_retention_days,
      meta_token_sealed = ${token === undefined ? sql`storefront.tracking_settings.meta_token_sealed` : sql`excluded.meta_token_sealed`},
      meta_token_fingerprint = ${token === undefined ? sql`storefront.tracking_settings.meta_token_fingerprint` : sql`excluded.meta_token_fingerprint`},
      ga4_secret_sealed = ${secret === undefined ? sql`storefront.tracking_settings.ga4_secret_sealed` : sql`excluded.ga4_secret_sealed`},
      ga4_secret_fingerprint = ${secret === undefined ? sql`storefront.tracking_settings.ga4_secret_fingerprint` : sql`excluded.ga4_secret_fingerprint`},
      key_id = case
        when (${token === undefined ? sql`storefront.tracking_settings.meta_token_sealed` : sql`excluded.meta_token_sealed`}) is null
         and (${secret === undefined ? sql`storefront.tracking_settings.ga4_secret_sealed` : sql`excluded.ga4_secret_sealed`}) is null
          then null
        else coalesce(${sealedNow ? input.keyId : null}, storefront.tracking_settings.key_id)
      end,
      updated_by = excluded.updated_by,
      updated_at = now()
  `);
}

// --- tracked events -------------------------------------------------------------------------

export interface NewTrackingEvent {
  readonly orgId: string;
  readonly eventId: string;
  readonly eventName: string;
  readonly source: 'client' | 'server';
  readonly testMode: boolean;
  readonly orderId: string | null;
  readonly userMasked: unknown;
  readonly matchKeys: unknown;
  readonly customData: unknown;
  readonly valuePoisha: bigint | null;
  readonly currency: string | null;
  readonly payload: { readonly sealed: Buffer; readonly keyId: string } | null;
  readonly status: 'waiting' | 'queued' | 'skipped';
  readonly retentionDays: number;
}

/**
 * Logs one event. A server event already logged under its id (the same order's Purchase asked
 * for twice) is left as it was: null.
 */
export async function insertTrackingEvent(tx: Tx, input: NewTrackingEvent): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into storefront.tracking_events
      (org_id, event_id, event_name, source, test_mode, order_id, user_masked, match_keys,
       custom_data, value_poisha, currency, payload_sealed, key_id, status, expires_at)
    values (${input.orgId}, ${input.eventId}, ${input.eventName}, ${input.source}, ${input.testMode},
            ${input.orderId}, ${JSON.stringify(input.userMasked)}::jsonb,
            ${JSON.stringify(input.matchKeys)}::jsonb, ${JSON.stringify(input.customData)}::jsonb,
            ${input.valuePoisha}, ${input.currency}, ${input.payload?.sealed ?? null},
            ${input.payload?.keyId ?? null}, ${input.status},
            now() + make_interval(days => ${input.retentionDays}))
    on conflict (org_id, event_id) where source = 'server' do nothing
    returning id
  `);
  return rows[0]?.id ?? null;
}

export interface TrackingEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly source: 'client' | 'server';
  readonly test_mode: boolean;
  readonly order_id: string | null;
  readonly user_masked: unknown;
  readonly match_keys: unknown;
  readonly custom_data: unknown;
  readonly value_poisha: string | number | bigint | null;
  readonly currency: string | null;
  readonly payload_sealed: Buffer | null;
  readonly key_id: string | null;
  readonly status: string;
  readonly meta: unknown;
  readonly ga4: unknown;
  readonly attempts: number;
  readonly sent_at: Date | string | null;
  readonly created_at: Date | string;
}

export async function trackingEventForUpdate(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<TrackingEventRow | undefined> {
  const rows = await tx.execute<TrackingEventRow>(sql`
    select id, event_id, event_name, source, test_mode, order_id, user_masked, match_keys,
           custom_data, value_poisha, currency, payload_sealed, key_id, status, meta, ga4,
           attempts, sent_at, created_at
    from storefront.tracking_events where org_id = ${orgId} and id = ${id}
    for update
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  return { ...row, payload_sealed: bytes(row.payload_sealed) };
}

/** The order's server Purchase while it waits for the online payment, or nothing. */
export async function waitingPurchase(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<{ id: string } | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from storefront.tracking_events
    where org_id = ${orgId} and order_id = ${orderId} and source = 'server'
      and event_name = 'Purchase' and status = 'waiting'
    for update
  `);
  return rows[0];
}

export async function markTrackingQueued(tx: Tx, orgId: string, id: string): Promise<void> {
  await tx.execute(sql`
    update storefront.tracking_events set status = 'queued', updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'waiting'
  `);
}

export async function recordTrackingResult(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly status: 'success' | 'partial' | 'error' | 'skipped';
    readonly meta: unknown;
    readonly ga4: unknown;
  },
): Promise<void> {
  await tx.execute(sql`
    update storefront.tracking_events
    set status = ${input.status}, meta = ${JSON.stringify(input.meta)}::jsonb,
        ga4 = ${JSON.stringify(input.ga4)}::jsonb, payload_sealed = null,
        attempts = attempts + 1, sent_at = now(), updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'queued'
  `);
}

export async function trackingEvents(
  tx: Tx,
  orgId: string,
  filter: {
    readonly status: string | undefined;
    readonly eventName: string | undefined;
    readonly limit: number;
    readonly before: { readonly createdAt: string; readonly id: string } | null;
  },
): Promise<TrackingEventRow[]> {
  const rows = await tx.execute<TrackingEventRow>(sql`
    select id, event_id, event_name, source, test_mode, order_id, user_masked, match_keys,
           custom_data, value_poisha, currency, null::bytea as payload_sealed, key_id, status,
           meta, ga4, attempts, sent_at, created_at
    from storefront.tracking_events
    where org_id = ${orgId}
      ${filter.status === undefined ? sql`` : sql`and status = ${filter.status}`}
      ${filter.eventName === undefined ? sql`` : sql`and event_name = ${filter.eventName}`}
      ${
        filter.before === null
          ? sql``
          : sql`and (created_at, id) < (${filter.before.createdAt}::timestamptz, ${filter.before.id}::uuid)`
      }
    order by created_at desc, id desc
    limit ${filter.limit}
  `);
  return [...rows];
}

export async function trackingStats(
  tx: Tx,
  orgId: string,
): Promise<{ status: string; count: number }[]> {
  const rows = await tx.execute<{ status: string; count: number }>(sql`
    select status, count(*)::int as count from storefront.tracking_events
    where org_id = ${orgId} and created_at > now() - interval '1 day'
    group by status order by status
  `);
  return [...rows];
}

/** Removes the brand's events past their retention; the number removed. */
export async function purgeTrackingEvents(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from storefront.tracking_events
    where org_id = ${orgId} and expires_at < now() and status not in ('waiting', 'queued')
    returning id
  `);
  return rows.length;
}
