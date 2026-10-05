import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Every SQL statement the marketplace module runs (M35b, D-553, D-556).
 *
 * Its own schema, `marketplace`, and the shared geography in `ref` (§5). The catalog, the
 * stock, the orders and the website's settings are asked through their modules' interfaces
 * (invariant 12). Every statement runs inside the caller's `withOrg()`.
 */

const bytes = (value: unknown): Buffer | null =>
  value === null || value === undefined ? null : Buffer.from(value as Uint8Array);

// --- settings -------------------------------------------------------------------------------

export interface NcomSettingsRow extends Record<string, unknown> {
  readonly enabled: boolean;
  readonly accept_orders: boolean;
  readonly include_drafts: boolean;
  readonly allow_search: boolean;
  readonly allow_categories: boolean;
  readonly allow_reserve: boolean;
  readonly default_weight_grams: number;
  readonly public_base_url: string;
  readonly base_url: string;
  readonly connector_key_id: string;
  readonly order_key_id: string;
  readonly connector_secret_sealed: Buffer | null;
  readonly connector_secret_fingerprint: string | null;
  readonly order_secret_sealed: Buffer | null;
  readonly order_secret_fingerprint: string | null;
  readonly api_key_sealed: Buffer | null;
  readonly api_key_fingerprint: string | null;
  readonly webhook_secret_sealed: Buffer | null;
  readonly webhook_secret_fingerprint: string | null;
  readonly key_id: string | null;
  readonly last_request_at: Date | string | null;
  readonly last_request_kind: string | null;
  readonly request_counts: unknown;
  readonly last_refusal_reason: string | null;
  readonly last_refusal_at: Date | string | null;
  readonly last_order_at: Date | string | null;
  readonly orders_received: number;
  readonly last_webhook_at: Date | string | null;
  readonly updated_at: Date | string;
}

export async function settingsOf(tx: Tx, orgId: string): Promise<NcomSettingsRow | undefined> {
  const rows = await tx.execute<NcomSettingsRow>(sql`
    select enabled, accept_orders, include_drafts, allow_search, allow_categories, allow_reserve,
           default_weight_grams, public_base_url, base_url, connector_key_id, order_key_id,
           connector_secret_sealed, connector_secret_fingerprint, order_secret_sealed,
           order_secret_fingerprint, api_key_sealed, api_key_fingerprint, webhook_secret_sealed,
           webhook_secret_fingerprint, key_id, last_request_at, last_request_kind,
           request_counts, last_refusal_reason, last_refusal_at, last_order_at, orders_received,
           last_webhook_at, updated_at
    from marketplace.ncom_settings where org_id = ${orgId}
  `);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    ...row,
    connector_secret_sealed: bytes(row.connector_secret_sealed),
    order_secret_sealed: bytes(row.order_secret_sealed),
    api_key_sealed: bytes(row.api_key_sealed),
    webhook_secret_sealed: bytes(row.webhook_secret_sealed),
  };
}

export interface SealedValue {
  readonly sealed: Buffer;
  readonly fingerprint: string;
}

type SecretColumn = 'connector_secret' | 'order_secret' | 'api_key' | 'webhook_secret';

export async function upsertSettings(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly enabled: boolean;
    readonly acceptOrders: boolean;
    readonly includeDrafts: boolean;
    readonly allowSearch: boolean;
    readonly allowCategories: boolean;
    readonly allowReserve: boolean;
    readonly defaultWeightGrams: number;
    readonly publicBaseUrl: string;
    readonly baseUrl: string;
    readonly connectorKeyId: string;
    readonly orderKeyId: string;
    /** Undefined keeps a stored secret, null removes it. */
    readonly secrets: Readonly<Record<SecretColumn, SealedValue | null | undefined>>;
    /** The key the secrets set in this call were sealed under. */
    readonly keyId: string | null;
    readonly updatedBy: string;
  },
): Promise<void> {
  const value = (column: SecretColumn) => input.secrets[column];
  const sealedCol = (column: SecretColumn) =>
    value(column) === undefined
      ? sql.raw(`marketplace.ncom_settings.${column}_sealed`)
      : sql.raw(`excluded.${column}_sealed`);
  const printCol = (column: SecretColumn) =>
    value(column) === undefined
      ? sql.raw(`marketplace.ncom_settings.${column}_fingerprint`)
      : sql.raw(`excluded.${column}_fingerprint`);
  const columns: readonly SecretColumn[] = [
    'connector_secret',
    'order_secret',
    'api_key',
    'webhook_secret',
  ];
  const anySealedAfter = sql.join(
    columns.map((column) => sql`(${sealedCol(column)}) is not null`),
    sql` or `,
  );
  const sealedNow = columns.some((column) => value(column) !== undefined && value(column) !== null);
  await tx.execute(sql`
    insert into marketplace.ncom_settings
      (org_id, enabled, accept_orders, include_drafts, allow_search, allow_categories,
       allow_reserve, default_weight_grams, public_base_url, base_url, connector_key_id,
       order_key_id, connector_secret_sealed, connector_secret_fingerprint, order_secret_sealed,
       order_secret_fingerprint, api_key_sealed, api_key_fingerprint, webhook_secret_sealed,
       webhook_secret_fingerprint, key_id, updated_by)
    values (${input.orgId}, ${input.enabled}, ${input.acceptOrders}, ${input.includeDrafts},
            ${input.allowSearch}, ${input.allowCategories}, ${input.allowReserve},
            ${input.defaultWeightGrams}, ${input.publicBaseUrl}, ${input.baseUrl},
            ${input.connectorKeyId}, ${input.orderKeyId},
            ${value('connector_secret')?.sealed ?? null}, ${value('connector_secret')?.fingerprint ?? null},
            ${value('order_secret')?.sealed ?? null}, ${value('order_secret')?.fingerprint ?? null},
            ${value('api_key')?.sealed ?? null}, ${value('api_key')?.fingerprint ?? null},
            ${value('webhook_secret')?.sealed ?? null}, ${value('webhook_secret')?.fingerprint ?? null},
            ${sealedNow ? input.keyId : null}, ${input.updatedBy})
    on conflict (org_id) do update set
      enabled = excluded.enabled,
      accept_orders = excluded.accept_orders,
      include_drafts = excluded.include_drafts,
      allow_search = excluded.allow_search,
      allow_categories = excluded.allow_categories,
      allow_reserve = excluded.allow_reserve,
      default_weight_grams = excluded.default_weight_grams,
      public_base_url = excluded.public_base_url,
      base_url = excluded.base_url,
      connector_key_id = excluded.connector_key_id,
      order_key_id = excluded.order_key_id,
      connector_secret_sealed = ${sealedCol('connector_secret')},
      connector_secret_fingerprint = ${printCol('connector_secret')},
      order_secret_sealed = ${sealedCol('order_secret')},
      order_secret_fingerprint = ${printCol('order_secret')},
      api_key_sealed = ${sealedCol('api_key')},
      api_key_fingerprint = ${printCol('api_key')},
      webhook_secret_sealed = ${sealedCol('webhook_secret')},
      webhook_secret_fingerprint = ${printCol('webhook_secret')},
      key_id = case when ${anySealedAfter}
        then coalesce(${sealedNow ? input.keyId : null}, marketplace.ncom_settings.key_id)
        else null end,
      updated_by = excluded.updated_by,
      updated_at = now()
  `);
}

/** Activity counters, folded in at most once a minute per process (never per request). */
export async function recordActivity(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly lastKind: string | null;
    readonly refusal: string | null;
  },
): Promise<void> {
  const additions = sql.join(
    Object.entries(input.counts).map(
      ([key, count]) =>
        sql`jsonb_build_object(${key}::text, coalesce((request_counts ->> ${key})::bigint, 0) + ${count})`,
    ),
    sql` || `,
  );
  await tx.execute(sql`
    update marketplace.ncom_settings set
      request_counts = request_counts ${Object.keys(input.counts).length === 0 ? sql`` : sql`|| ${additions}`},
      last_request_at = case when ${input.lastKind}::text is null then last_request_at else now() end,
      last_request_kind = coalesce(${input.lastKind}::text, last_request_kind),
      last_refusal_reason = coalesce(${input.refusal}::text, last_refusal_reason),
      last_refusal_at = case when ${input.refusal}::text is null then last_refusal_at else now() end
    where org_id = ${input.orgId}
  `);
}

export async function noteOrderReceived(tx: Tx, orgId: string, counted: boolean): Promise<void> {
  await tx.execute(sql`
    update marketplace.ncom_settings
    set last_order_at = now(), orders_received = orders_received + ${counted ? 1 : 0}
    where org_id = ${orgId}
  `);
}

export async function noteWebhook(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`
    update marketplace.ncom_settings set last_webhook_at = now() where org_id = ${orgId}
  `);
}

// --- holds ----------------------------------------------------------------------------------

export interface HoldRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_ref: string;
  readonly state: 'held' | 'released' | 'converted';
  readonly location_id: string;
  readonly lines: unknown;
  readonly held_at: Date | string;
  readonly released_at: Date | string | null;
  readonly converted_order_id: string | null;
}

const HOLD_COLUMNS = sql`id, order_ref, state, location_id, lines, held_at, released_at, converted_order_id`;

export async function holdByRef(
  tx: Tx,
  orgId: string,
  orderRef: string,
  options: { readonly lock?: boolean } = {},
): Promise<HoldRow | undefined> {
  const rows = await tx.execute<HoldRow>(sql`
    select ${HOLD_COLUMNS} from marketplace.ncom_holds
    where org_id = ${orgId} and order_ref = ${orderRef}
    ${options.lock === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

/** Claims the reference; undefined when another hold already has it (a retry or a race). */
export async function insertHold(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderRef: string;
    readonly locationId: string;
    readonly lines: unknown;
  },
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketplace.ncom_holds (org_id, order_ref, location_id, lines)
    values (${input.orgId}, ${input.orderRef}, ${input.locationId}, ${JSON.stringify(input.lines)}::jsonb)
    on conflict (org_id, order_ref) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export async function endHold(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly state: 'released' | 'converted';
    readonly convertedOrderId?: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update marketplace.ncom_holds
    set state = ${input.state}, released_at = now(),
        converted_order_id = ${input.convertedOrderId ?? null}, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and state = 'held'
    returning id
  `);
  return rows.length === 1;
}

export async function holds(
  tx: Tx,
  orgId: string,
  state: 'held' | 'released' | 'converted' | undefined,
  limit: number,
): Promise<HoldRow[]> {
  const rows = await tx.execute<HoldRow>(sql`
    select ${HOLD_COLUMNS} from marketplace.ncom_holds
    where org_id = ${orgId} ${state === undefined ? sql`` : sql`and state = ${state}`}
    order by held_at desc limit ${limit}
  `);
  return [...rows];
}

export async function holdById(tx: Tx, orgId: string, id: string): Promise<HoldRow | undefined> {
  const rows = await tx.execute<HoldRow>(sql`
    select ${HOLD_COLUMNS} from marketplace.ncom_holds where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

// --- handed-over orders ---------------------------------------------------------------------

export interface NcomOrderRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly ncom_order_id: string;
  readonly ncom_order_number: string;
  readonly idempotency_key: string;
  readonly revision: number;
  readonly last_inbound_key: string | null;
  readonly store_name: string;
  readonly page_title: string;
  readonly offer_label: string;
  readonly foreign_items: unknown;
  readonly foreign_poisha: string | number | bigint;
  readonly warnings: unknown;
  readonly stock_held: boolean;
  readonly received_at: Date | string;
}

const ORDER_COLUMNS = sql`order_id, ncom_order_id, ncom_order_number, idempotency_key, revision,
  last_inbound_key, store_name, page_title, offer_label, foreign_items, foreign_poisha, warnings,
  stock_held, received_at`;

export async function ncomOrderByKey(
  tx: Tx,
  orgId: string,
  idempotencyKey: string,
): Promise<NcomOrderRow | undefined> {
  const rows = await tx.execute<NcomOrderRow>(sql`
    select ${ORDER_COLUMNS} from marketplace.ncom_orders
    where org_id = ${orgId} and idempotency_key = ${idempotencyKey}
  `);
  return rows[0];
}

export async function ncomOrderByNcomId(
  tx: Tx,
  orgId: string,
  ncomOrderId: string,
): Promise<NcomOrderRow | undefined> {
  const rows = await tx.execute<NcomOrderRow>(sql`
    select ${ORDER_COLUMNS} from marketplace.ncom_orders
    where org_id = ${orgId} and ncom_order_id = ${ncomOrderId}
    for update
  `);
  return rows[0];
}

export async function ncomOrderByOrderId(
  tx: Tx,
  orgId: string,
  orderId: string,
  options: { readonly lock?: boolean } = {},
): Promise<NcomOrderRow | undefined> {
  const rows = await tx.execute<NcomOrderRow>(sql`
    select ${ORDER_COLUMNS} from marketplace.ncom_orders
    where org_id = ${orgId} and order_id = ${orderId}
    ${options.lock === true ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function insertNcomOrder(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly ncomOrderId: string;
    readonly ncomOrderNumber: string;
    readonly idempotencyKey: string;
    readonly storeName: string;
    readonly storeUrl: string;
    readonly pageTitle: string;
    readonly pageUrl: string;
    readonly offerKey: string;
    readonly offerLabel: string;
    readonly offerPricePoisha: bigint | null;
    readonly regularPricePoisha: bigint | null;
    readonly discountCode: string;
    readonly foreignItems: unknown;
    readonly foreignPoisha: bigint;
    readonly warnings: readonly string[];
    readonly stockHeld: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into marketplace.ncom_orders
      (org_id, order_id, ncom_order_id, ncom_order_number, idempotency_key, store_name, store_url,
       page_title, page_url, offer_key, offer_label, offer_price_poisha, regular_price_poisha,
       discount_code, foreign_items, foreign_poisha, warnings, stock_held)
    values (${input.orgId}, ${input.orderId}, ${input.ncomOrderId}, ${input.ncomOrderNumber},
            ${input.idempotencyKey}, ${input.storeName}, ${input.storeUrl}, ${input.pageTitle},
            ${input.pageUrl}, ${input.offerKey}, ${input.offerLabel}, ${input.offerPricePoisha},
            ${input.regularPricePoisha}, ${input.discountCode},
            ${JSON.stringify(input.foreignItems)}::jsonb, ${input.foreignPoisha},
            ${JSON.stringify(input.warnings)}::jsonb, ${input.stockHeld})
  `);
}

export async function applyInbound(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly revision: number;
    readonly key: string;
    readonly warnings?: readonly string[];
    readonly foreignItems?: unknown;
    readonly foreignPoisha?: bigint;
  },
): Promise<void> {
  await tx.execute(sql`
    update marketplace.ncom_orders set
      revision = ${input.revision}, last_inbound_key = ${input.key},
      warnings = ${input.warnings === undefined ? sql`warnings` : sql`${JSON.stringify(input.warnings)}::jsonb`},
      foreign_items = ${input.foreignItems === undefined ? sql`foreign_items` : sql`${JSON.stringify(input.foreignItems)}::jsonb`},
      foreign_poisha = ${input.foreignPoisha === undefined ? sql`foreign_poisha` : sql`${input.foreignPoisha}`},
      updated_at = now()
    where org_id = ${input.orgId} and order_id = ${input.orderId}
  `);
}

export async function bumpRevision(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<{ base: number; revision: number } | undefined> {
  const rows = await tx.execute<{ revision: number }>(sql`
    update marketplace.ncom_orders set revision = revision + 1, updated_at = now()
    where org_id = ${orgId} and order_id = ${orderId}
    returning revision
  `);
  const revision = rows[0]?.revision;
  return revision === undefined ? undefined : { base: revision - 1, revision };
}

export async function ncomOrders(tx: Tx, orgId: string, limit: number): Promise<NcomOrderRow[]> {
  const rows = await tx.execute<NcomOrderRow>(sql`
    select ${ORDER_COLUMNS} from marketplace.ncom_orders
    where org_id = ${orgId} order by received_at desc limit ${limit}
  `);
  return [...rows];
}

// --- the outbox -----------------------------------------------------------------------------

export interface OutboxRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string;
  readonly topic: string;
  readonly idempotency_key: string;
  readonly base_revision: number;
  readonly revision: number;
  readonly payload_sealed: Buffer | null;
  readonly status: 'pending' | 'delivered' | 'refused' | 'failed';
  readonly attempts: number;
  readonly next_attempt_at: Date | string | null;
  readonly status_code: number | null;
  readonly error: string | null;
  readonly delivered_at: Date | string | null;
  readonly created_at: Date | string;
}

const OUTBOX_COLUMNS = sql`id, order_id, topic, idempotency_key, base_revision, revision,
  payload_sealed, status, attempts, next_attempt_at, status_code, error, delivered_at, created_at`;

export async function insertOutbox(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly topic: 'order.updated' | 'order.cancelled';
    readonly idempotencyKey: string;
    readonly sourceEventId: string | null;
    readonly baseRevision: number;
    readonly revision: number;
    readonly payload: { readonly sealed: Buffer; readonly keyId: string };
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into marketplace.ncom_outbox
      (org_id, order_id, topic, idempotency_key, source_event_id, base_revision, revision,
       payload_sealed, key_id, next_attempt_at)
    values (${input.orgId}, ${input.orderId}, ${input.topic}, ${input.idempotencyKey},
            ${input.sourceEventId}, ${input.baseRevision}, ${input.revision},
            ${input.payload.sealed}, ${input.payload.keyId}, now())
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('an outbox message was not written');
  return id;
}

/** Whether an outbox event already queued its message (a redelivered event). */
export async function queuedByEvent(tx: Tx, orgId: string, eventId: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from marketplace.ncom_outbox where org_id = ${orgId} and source_event_id = ${eventId}
  `);
  return rows.length > 0;
}

/** An order's waiting messages, oldest first, locked: one sender per order at a time. */
export async function pendingForOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<OutboxRow[]> {
  const rows = await tx.execute<OutboxRow>(sql`
    select ${OUTBOX_COLUMNS} from marketplace.ncom_outbox
    where org_id = ${orgId} and order_id = ${orderId} and status = 'pending'
    order by revision, created_at
    for update
  `);
  return [...rows].map((row) => ({ ...row, payload_sealed: bytes(row.payload_sealed) }));
}

export async function recordDelivery(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly status: 'pending' | 'delivered' | 'refused' | 'failed';
    readonly statusCode: number | null;
    readonly error: string | null;
    readonly retryAfterSeconds: number | null;
  },
): Promise<void> {
  const ending = input.status !== 'pending';
  await tx.execute(sql`
    update marketplace.ncom_outbox set
      status = ${input.status},
      attempts = attempts + 1,
      status_code = ${input.statusCode},
      error = ${input.error},
      next_attempt_at = ${
        input.retryAfterSeconds === null
          ? null
          : sql`now() + make_interval(secs => ${input.retryAfterSeconds})`
      },
      delivered_at = ${input.status === 'delivered' ? sql`now()` : null},
      payload_sealed = ${ending ? null : sql`payload_sealed`},
      key_id = ${ending ? null : sql`key_id`},
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'pending'
  `);
}

/** Orders with a message whose backoff has elapsed: the sweep's work. */
export async function dueOrders(tx: Tx, orgId: string, limit: number): Promise<string[]> {
  const rows = await tx.execute<{ order_id: string }>(sql`
    select order_id from marketplace.ncom_outbox
    where org_id = ${orgId} and status = 'pending' and next_attempt_at <= now()
    group by order_id order by min(next_attempt_at) limit ${limit}
  `);
  return [...rows].map((row) => row.order_id);
}

export async function outboxOf(tx: Tx, orgId: string, limit: number): Promise<OutboxRow[]> {
  const rows = await tx.execute<OutboxRow>(sql`
    select id, order_id, topic, idempotency_key, base_revision, revision, null::bytea as payload_sealed,
           status, attempts, next_attempt_at, status_code, error, delivered_at, created_at
    from marketplace.ncom_outbox where org_id = ${orgId}
    order by created_at desc limit ${limit}
  `);
  return [...rows];
}

// --- webhooks -------------------------------------------------------------------------------

/** Claims an event id; false when it was claimed before (a retry). */
/** Drops webhook claims older than 90 days, long past any redelivery (migration 0122). */
export async function purgeEvents(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.execute<{ event_id: string }>(sql`
    delete from marketplace.ncom_events
    where org_id = ${orgId} and received_at < now() - interval '90 days'
    returning event_id
  `);
  return rows.length;
}

export async function claimEvent(
  tx: Tx,
  orgId: string,
  eventId: string,
  topic: string,
): Promise<boolean> {
  const rows = await tx.execute<{ event_id: string }>(sql`
    insert into marketplace.ncom_events (org_id, event_id, topic)
    values (${orgId}, ${eventId}, ${topic})
    on conflict do nothing
    returning event_id
  `);
  return rows.length === 1;
}

// --- geography (ref, shared) ----------------------------------------------------------------

export async function districts(
  tx: Tx,
): Promise<{ id: number; name_en: string; name_bn: string }[]> {
  const rows = await tx.execute<{ id: number; name_en: string; name_bn: string }>(sql`
    select id, name_en, name_bn from ref.districts order by id
  `);
  return [...rows];
}

export async function thanasOf(
  tx: Tx,
  districtId: number,
): Promise<{ id: number; name_en: string; name_bn: string }[]> {
  const rows = await tx.execute<{ id: number; name_en: string; name_bn: string }>(sql`
    select id, name_en, name_bn from ref.thanas where district_id = ${districtId} order by id
  `);
  return [...rows];
}
