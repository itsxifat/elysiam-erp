import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The marketing module's SQL (M18). Every statement names `marketing.*` and nothing else:
 * order facts come through `ORDERS_API`, promo campaigns through `PROMO_API`, products
 * through `CATALOG_API` (invariant 12, `module-boundaries.test.ts`).
 *
 * Every query runs inside the caller's `withOrg`, so RLS is the floor; the explicit
 * `org_id = …` is the index's leading column and says what the query is about.
 */

// --- campaigns and their external ids ----------------------------------------------

export interface CampaignRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly product_ids: unknown;
  readonly starts_on: string | null;
  readonly ends_on: string | null;
  readonly status: string;
  readonly origin: string;
  readonly created_at: Date;
}

export interface RefRow extends Record<string, unknown> {
  readonly id: string;
  readonly campaign_id: string;
  readonly kind: 'meta_campaign' | 'meta_ad' | 'utm_campaign';
  readonly value: string;
}

const CAMPAIGN_COLUMNS = sql`id, name, platform, product_ids, starts_on::text as starts_on,
  ends_on::text as ends_on, status, origin, created_at`;

export async function listCampaigns(
  tx: Tx,
  orgId: string,
  status: string | undefined,
): Promise<CampaignRow[]> {
  const rows = await tx.execute<CampaignRow>(sql`
    select ${CAMPAIGN_COLUMNS} from marketing.campaigns
    where org_id = ${orgId} ${status === undefined ? sql`` : sql`and status = ${status}`}
    order by status, created_at desc
  `);
  return [...rows];
}

export async function campaignById(
  tx: Tx,
  orgId: string,
  id: string,
  lock = false,
): Promise<CampaignRow | undefined> {
  const rows = await tx.execute<CampaignRow>(sql`
    select ${CAMPAIGN_COLUMNS} from marketing.campaigns
    where org_id = ${orgId} and id = ${id} ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function insertCampaign(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly name: string;
    readonly platform: string;
    readonly productIds: readonly string[];
    readonly startsOn: string | null;
    readonly endsOn: string | null;
    readonly origin: 'manual' | 'meta_import';
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketing.campaigns
      (org_id, name, platform, product_ids, starts_on, ends_on, origin, created_by)
    values (${input.orgId}, ${input.name}, ${input.platform},
            ${JSON.stringify(input.productIds)}::jsonb, ${input.startsOn}::date,
            ${input.endsOn}::date, ${input.origin}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a campaign returned no id');
  return id;
}

export async function updateCampaign(
  tx: Tx,
  orgId: string,
  id: string,
  patch: {
    readonly name: string;
    readonly platform: string;
    readonly productIds: readonly string[];
    readonly startsOn: string | null;
    readonly endsOn: string | null;
    readonly status: string;
  },
): Promise<void> {
  await tx.execute(sql`
    update marketing.campaigns
    set name = ${patch.name}, platform = ${patch.platform},
        product_ids = ${JSON.stringify(patch.productIds)}::jsonb,
        starts_on = ${patch.startsOn}::date, ends_on = ${patch.endsOn}::date,
        status = ${patch.status}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function listRefs(tx: Tx, orgId: string): Promise<RefRow[]> {
  const rows = await tx.execute<RefRow>(sql`
    select id, campaign_id, kind, value from marketing.campaign_refs
    where org_id = ${orgId}
    order by kind, value
  `);
  return [...rows];
}

/** The id of the ref, or undefined when the value already names a campaign (any campaign). */
export async function insertRef(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly campaignId: string;
    readonly kind: string;
    readonly value: string;
    readonly createdBy: string;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketing.campaign_refs (org_id, campaign_id, kind, value, created_by)
    values (${input.orgId}, ${input.campaignId}, ${input.kind}, ${input.value}, ${input.createdBy})
    on conflict (org_id, kind, value) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function refOwner(
  tx: Tx,
  orgId: string,
  kind: string,
  value: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ campaign_id: string }>(sql`
    select campaign_id from marketing.campaign_refs
    where org_id = ${orgId} and kind = ${kind} and value = ${value}
  `);
  return rows[0]?.campaign_id;
}

export async function deleteRef(
  tx: Tx,
  orgId: string,
  campaignId: string,
  refId: string,
): Promise<RefRow | undefined> {
  const rows = await tx.execute<RefRow>(sql`
    delete from marketing.campaign_refs
    where org_id = ${orgId} and campaign_id = ${campaignId} and id = ${refId}
    returning id, campaign_id, kind, value
  `);
  return rows[0];
}

// --- spend -------------------------------------------------------------------------

export interface SpendRow extends Record<string, unknown> {
  readonly id: string;
  readonly campaign_id: string;
  readonly spend_date: string;
  readonly amount_poisha: string;
  readonly source: 'manual' | 'meta';
  readonly note: string | null;
  readonly entered_by: string;
  readonly updated_at: Date;
}

export async function spendInPeriod(
  tx: Tx,
  orgId: string,
  filter: { readonly from: string; readonly to: string; readonly campaignId?: string | undefined },
): Promise<SpendRow[]> {
  const rows = await tx.execute<SpendRow>(sql`
    select id, campaign_id, spend_date::text as spend_date, amount_poisha::text as amount_poisha,
           source, note, entered_by, updated_at
    from marketing.ad_spend
    where org_id = ${orgId}
      and spend_date between ${filter.from}::date and ${filter.to}::date
      ${filter.campaignId === undefined ? sql`` : sql`and campaign_id = ${filter.campaignId}`}
    order by spend_date desc, campaign_id
  `);
  return [...rows];
}

export async function spendFor(
  tx: Tx,
  orgId: string,
  campaignId: string,
  spendDate: string,
): Promise<SpendRow | undefined> {
  const rows = await tx.execute<SpendRow>(sql`
    select id, campaign_id, spend_date::text as spend_date, amount_poisha::text as amount_poisha,
           source, note, entered_by, updated_at
    from marketing.ad_spend
    where org_id = ${orgId} and campaign_id = ${campaignId} and spend_date = ${spendDate}::date
  `);
  return rows[0];
}

/**
 * A person's figure for a day: inserts, or replaces whatever was there — an imported
 * figure included, because the person is correcting it (D-252).
 */
export async function upsertManualSpend(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly campaignId: string;
    readonly spendDate: string;
    readonly amountPoisha: bigint;
    readonly note: string | null;
    readonly enteredBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketing.ad_spend
      (org_id, campaign_id, spend_date, amount_poisha, source, note, entered_by)
    values (${input.orgId}, ${input.campaignId}, ${input.spendDate}::date, ${input.amountPoisha},
            'manual', ${input.note}, ${input.enteredBy})
    on conflict (org_id, campaign_id, spend_date) do update
      set amount_poisha = excluded.amount_poisha, source = 'manual', note = excluded.note,
          entered_by = excluded.entered_by, updated_at = now()
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('upserting spend returned no id');
  return id;
}

/**
 * An imported figure for a day: inserts, or replaces an earlier *import* of the same
 * day. A figure a person entered is left alone (D-252), which is the `where` — so a rerun
 * or an overlapping range replaces rather than adds (M18 check 2).
 *
 * Returns what happened, so the import can report it.
 */
export async function upsertImportedSpend(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly campaignId: string;
    readonly spendDate: string;
    readonly amountPoisha: bigint;
    readonly enteredBy: string;
  },
): Promise<'written' | 'kept_manual'> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketing.ad_spend
      (org_id, campaign_id, spend_date, amount_poisha, source, entered_by)
    values (${input.orgId}, ${input.campaignId}, ${input.spendDate}::date, ${input.amountPoisha},
            'meta', ${input.enteredBy})
    on conflict (org_id, campaign_id, spend_date) do update
      set amount_poisha = excluded.amount_poisha, entered_by = excluded.entered_by,
          updated_at = now()
      where marketing.ad_spend.source = 'meta'
    returning id
  `);
  return rows.length > 0 ? 'written' : 'kept_manual';
}

/**
 * Imported figures in `[from, to]` that this import did not write, set to zero.
 *
 * Meta's answer for a range is the whole account's spend for those days, so an imported
 * figure it no longer supports is stale — most often because a Meta campaign id was moved
 * to another campaign, and its spend has just been written there. Zero rather than delete,
 * because a figure is never deleted (0083). Figures a person entered are not touched.
 *
 * `written` lists the (campaign, day) pairs this import wrote or kept as manual. Returns
 * how many figures were zeroed.
 */
export async function zeroStaleImports(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly from: string;
    readonly to: string;
    readonly written: readonly { readonly campaignId: string; readonly spendDate: string }[];
    readonly enteredBy: string;
  },
): Promise<number> {
  // The days travel as text: drizzle's postgres driver passes a `date[]` parameter through
  // unserialised, where `text[]` is serialised as an array.
  const kept =
    input.written.length === 0
      ? sql``
      : sql`and not exists (
          select 1
          from unnest(${sql.param(input.written.map((row) => row.campaignId))}::uuid[],
                      ${sql.param(input.written.map((row) => row.spendDate))}::text[])
            as w(campaign_id, spend_date)
          where w.campaign_id = s.campaign_id and w.spend_date::date = s.spend_date
        )`;
  const rows = await tx.execute<{ id: string }>(sql`
    update marketing.ad_spend s
    set amount_poisha = 0, entered_by = ${input.enteredBy}, updated_at = now()
    where s.org_id = ${input.orgId} and s.source = 'meta' and s.amount_poisha <> 0
      and s.spend_date between ${input.from}::date and ${input.to}::date
      ${kept}
    returning s.id
  `);
  return rows.length;
}

/**
 * Names of Meta campaigns with spend a person typed in `[from, to]` that are not mapped to
 * any Meta campaign id. The import refuses to run over them: it cannot tell which Meta
 * campaign that spend belongs to, so it would write the same taka a second time under a
 * campaign of its own (D-254).
 */
export async function unmappedManualMetaSpend(
  tx: Tx,
  orgId: string,
  range: { readonly from: string; readonly to: string },
): Promise<string[]> {
  const rows = await tx.execute<{ name: string }>(sql`
    select c.name
    from marketing.campaigns c
    where c.org_id = ${orgId} and c.platform = 'meta'
      and exists (
        select 1 from marketing.ad_spend s
        where s.org_id = c.org_id and s.campaign_id = c.id and s.source = 'manual'
          and s.amount_poisha > 0
          and s.spend_date between ${range.from}::date and ${range.to}::date
      )
      and not exists (
        select 1 from marketing.campaign_refs r
        where r.org_id = c.org_id and r.campaign_id = c.id and r.kind = 'meta_campaign'
      )
    order by c.name
  `);
  return [...rows].map((row) => row.name);
}

// --- leads -------------------------------------------------------------------------

export interface LeadRow extends Record<string, unknown> {
  readonly id: string;
  readonly phone_e164: string;
  readonly name: string | null;
  readonly channel: string;
  readonly campaign_id: string | null;
  readonly sku_id: string | null;
  readonly size: string | null;
  readonly age_band: string | null;
  readonly profession: string | null;
  readonly status: string;
  readonly notes: string | null;
  readonly created_at: Date;
}

const LEAD_COLUMNS = sql`id, phone_e164, name, channel, campaign_id, sku_id, size, age_band,
  profession, status, notes, created_at`;

export async function listLeads(
  tx: Tx,
  orgId: string,
  filter: { readonly status?: string | undefined; readonly limit: number },
): Promise<LeadRow[]> {
  const rows = await tx.execute<LeadRow>(sql`
    select ${LEAD_COLUMNS} from marketing.leads
    where org_id = ${orgId}
      ${filter.status === undefined ? sql`` : sql`and status = ${filter.status}`}
    order by created_at desc, id
    limit ${filter.limit}
  `);
  return [...rows];
}

export async function leadById(tx: Tx, orgId: string, id: string): Promise<LeadRow | undefined> {
  const rows = await tx.execute<LeadRow>(sql`
    select ${LEAD_COLUMNS} from marketing.leads where org_id = ${orgId} and id = ${id} for update
  `);
  return rows[0];
}

export interface LeadValues {
  readonly name: string | null;
  readonly campaignId: string | null;
  readonly skuId: string | null;
  readonly size: string | null;
  readonly ageBand: string | null;
  readonly profession: string | null;
  readonly status: string;
  readonly notes: string | null;
}

export async function insertLead(
  tx: Tx,
  input: LeadValues & {
    readonly orgId: string;
    readonly phoneE164: string;
    readonly channel: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketing.leads
      (org_id, phone_e164, name, channel, campaign_id, sku_id, size, age_band, profession,
       status, notes, created_by)
    values (${input.orgId}, ${input.phoneE164}, ${input.name}, ${input.channel},
            ${input.campaignId}, ${input.skuId}, ${input.size}, ${input.ageBand},
            ${input.profession}, ${input.status}, ${input.notes}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting a lead returned no id');
  return id;
}

export async function updateLead(
  tx: Tx,
  orgId: string,
  id: string,
  values: LeadValues,
): Promise<void> {
  await tx.execute(sql`
    update marketing.leads
    set name = ${values.name}, campaign_id = ${values.campaignId}, sku_id = ${values.skuId},
        size = ${values.size}, age_band = ${values.ageBand}, profession = ${values.profession},
        status = ${values.status}, notes = ${values.notes}, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/** Every lead created on a Dhaka date in the period, or every lead when there is none. */
export async function leadsForSegments(
  tx: Tx,
  orgId: string,
  period: { readonly from?: string | undefined; readonly to?: string | undefined },
): Promise<LeadRow[]> {
  const dhaka = sql`(created_at at time zone 'Asia/Dhaka')::date`;
  const rows = await tx.execute<LeadRow>(sql`
    select ${LEAD_COLUMNS} from marketing.leads
    where org_id = ${orgId}
      ${period.from === undefined ? sql`` : sql`and ${dhaka} >= ${period.from}::date`}
      ${period.to === undefined ? sql`` : sql`and ${dhaka} <= ${period.to}::date`}
  `);
  return [...rows];
}

// --- the Meta link -----------------------------------------------------------------

export interface ConnectionRow extends Record<string, unknown> {
  readonly id: string;
  readonly ad_account_id: string | null;
  readonly pixel_id: string | null;
  readonly token: Buffer | Uint8Array | null;
  readonly token_key_id: string | null;
  readonly token_fingerprint: string | null;
  readonly spend_import_enabled: boolean;
  readonly capi_enabled: boolean;
  readonly send_name_and_city: boolean;
  readonly test_event_code: string | null;
  readonly last_import_at: Date | null;
  readonly last_import_status: string | null;
  readonly last_import_error: string | null;
  readonly updated_at: Date;
}

export async function connection(
  tx: Tx,
  orgId: string,
  lock = false,
): Promise<ConnectionRow | undefined> {
  const rows = await tx.execute<ConnectionRow>(sql`
    select id, ad_account_id, pixel_id, token, token_key_id, token_fingerprint,
           spend_import_enabled, capi_enabled, send_name_and_city, test_event_code,
           last_import_at, last_import_status, last_import_error, updated_at
    from marketing.meta_connections
    where org_id = ${orgId} ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export interface ConnectionValues {
  readonly adAccountId: string | null;
  readonly pixelId: string | null;
  readonly token: Buffer | null;
  readonly tokenKeyId: string | null;
  readonly tokenFingerprint: string | null;
  readonly spendImportEnabled: boolean;
  readonly capiEnabled: boolean;
  readonly sendNameAndCity: boolean;
  readonly testEventCode: string | null;
}

export async function saveConnection(
  tx: Tx,
  orgId: string,
  values: ConnectionValues,
  updatedBy: string,
): Promise<void> {
  await tx.execute(sql`
    insert into marketing.meta_connections
      (org_id, ad_account_id, pixel_id, token, token_key_id, token_fingerprint,
       spend_import_enabled, capi_enabled, send_name_and_city, test_event_code, updated_by)
    values (${orgId}, ${values.adAccountId}, ${values.pixelId}, ${values.token},
            ${values.tokenKeyId}, ${values.tokenFingerprint}, ${values.spendImportEnabled},
            ${values.capiEnabled}, ${values.sendNameAndCity}, ${values.testEventCode},
            ${updatedBy})
    on conflict (org_id) do update
      set ad_account_id = excluded.ad_account_id, pixel_id = excluded.pixel_id,
          token = excluded.token, token_key_id = excluded.token_key_id,
          token_fingerprint = excluded.token_fingerprint,
          spend_import_enabled = excluded.spend_import_enabled,
          capi_enabled = excluded.capi_enabled, send_name_and_city = excluded.send_name_and_city,
          test_event_code = excluded.test_event_code, updated_by = excluded.updated_by,
          updated_at = now()
  `);
}

export async function recordImport(
  tx: Tx,
  orgId: string,
  outcome: { readonly status: 'ok' | 'failed'; readonly error: string | null; readonly at: Date },
): Promise<void> {
  await tx.execute(sql`
    update marketing.meta_connections
    set last_import_at = ${outcome.at.toISOString()}::timestamptz, last_import_status = ${outcome.status},
        last_import_error = ${outcome.error}
    where org_id = ${orgId}
  `);
}

// --- the conversion log ------------------------------------------------------------

export interface CapiRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string;
  readonly event_name: string;
  readonly event_id: string;
  readonly status: 'queued' | 'sent' | 'failed' | 'skipped';
  readonly attempts: number;
  readonly payload: unknown;
  readonly value_poisha: string | null;
  readonly event_time: Date | null;
  readonly response: unknown;
  readonly last_error: string | null;
  readonly sent_at: Date | null;
  readonly created_at: Date;
}

const CAPI_COLUMNS = sql`id, order_id, event_name, event_id, status, attempts, payload,
  value_poisha::text as value_poisha, event_time, response, last_error, sent_at, created_at`;

/** The row for this order's Purchase, written once; undefined when it already existed. */
export async function insertCapiEvent(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketing.capi_events (org_id, order_id, event_name, event_id)
    values (${orgId}, ${orderId}, 'Purchase', ${orderId})
    on conflict (org_id, order_id, event_name) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function capiEventById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CapiRow | undefined> {
  const rows = await tx.execute<CapiRow>(sql`
    select ${CAPI_COLUMNS} from marketing.capi_events
    where org_id = ${orgId} and id = ${id} for update
  `);
  return rows[0];
}

export async function listCapiEvents(
  tx: Tx,
  orgId: string,
  filter: { readonly status?: string | undefined; readonly limit: number },
): Promise<CapiRow[]> {
  const rows = await tx.execute<CapiRow>(sql`
    select ${CAPI_COLUMNS} from marketing.capi_events
    where org_id = ${orgId}
      ${filter.status === undefined ? sql`` : sql`and status = ${filter.status}`}
    order by created_at desc, id
    limit ${filter.limit}
  `);
  return [...rows];
}

/** The payload about to be sent, recorded before the send so the log shows what went out. */
export async function stageCapiPayload(
  tx: Tx,
  orgId: string,
  id: string,
  staged: { readonly payload: unknown; readonly valuePoisha: bigint; readonly eventTime: Date },
): Promise<void> {
  await tx.execute(sql`
    update marketing.capi_events
    set payload = ${JSON.stringify(staged.payload)}::jsonb, value_poisha = ${staged.valuePoisha},
        event_time = ${staged.eventTime.toISOString()}::timestamptz, attempts = attempts + 1, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function finishCapiEvent(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: {
    readonly status: 'sent' | 'failed' | 'skipped';
    readonly response: unknown;
    readonly error: string | null;
    readonly sentAt: Date | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update marketing.capi_events
    set status = ${outcome.status},
        response = ${outcome.response === null ? null : JSON.stringify(outcome.response)}::jsonb,
        last_error = ${outcome.error},
        sent_at = ${outcome.sentAt === null ? null : outcome.sentAt.toISOString()}::timestamptz,
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}
