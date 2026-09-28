import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every query the courier module runs (architecture §5, §9).
 *
 * Raw SQL, parameterized, in one file, as every other module's repository is. The rule it
 * exists to make checkable is the tenancy one: every statement here filters on `org_id`
 * even though RLS already does, because a statement that forgot would be a statement
 * relying on a policy for correctness rather than for defence — and the day somebody runs
 * one of these as `erp_owner` in a script, the policy is what is missing.
 *
 * Nothing here reads another module's tables. The two exceptions a reader will look for —
 * `ledger.accounts` for a posting account, and `sales.orders` for an address to send the
 * courier — are on ports (`ledger-read.port.ts`, `orders.port.ts`) precisely so they are
 * not here.
 */

export interface CourierAccountRow extends Record<string, unknown> {
  readonly id: string;
  readonly courier_id: string;
  readonly courier_code: string;
  readonly provider_code: string;
  readonly label: string;
  readonly mode: 'sandbox' | 'live';
  readonly base_url: string | null;
  readonly credentials: Buffer | null;
  readonly credentials_key_id: string | null;
  readonly credentials_fingerprint: string | null;
  readonly webhook_secret: Buffer | null;
  readonly supports_webhook: boolean;
  readonly poll_after_hours: number;
  readonly settlement_wallet_id: string | null;
  readonly verified: boolean;
  readonly is_active: boolean;
}

/**
 * The account, with its courier's code joined on.
 *
 * `sales.couriers.code` is joined rather than trusted to equal `provider_code`: M10 owns
 * the party row and M12 owns the account, so the two *can* disagree — an org that
 * registered its courier as `own_rider` and then attached Steadfast credentials to it.
 * The adapter is resolved by `provider_code`, and the join is what lets a screen show
 * both when they differ instead of quietly using one.
 */
const ACCOUNT_COLUMNS = sql`
  a.id, a.courier_id, c.code as courier_code, a.provider_code, a.label, a.mode, a.base_url,
  a.credentials, a.credentials_key_id, a.credentials_fingerprint, a.webhook_secret,
  a.supports_webhook, a.poll_after_hours, a.settlement_wallet_id, a.verified, a.is_active
`;

export async function accountById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CourierAccountRow | undefined> {
  const rows = await tx.execute<CourierAccountRow>(sql`
    select ${ACCOUNT_COLUMNS}
    from courier.courier_accounts a
    join sales.couriers c on c.org_id = a.org_id and c.id = a.courier_id
    where a.org_id = ${orgId} and a.id = ${id}
  `);
  return rows[0];
}

export async function accountByCourier(
  tx: Tx,
  orgId: string,
  courierId: string,
): Promise<CourierAccountRow | undefined> {
  const rows = await tx.execute<CourierAccountRow>(sql`
    select ${ACCOUNT_COLUMNS}
    from courier.courier_accounts a
    join sales.couriers c on c.org_id = a.org_id and c.id = a.courier_id
    where a.org_id = ${orgId} and a.courier_id = ${courierId}
  `);
  return rows[0];
}

export async function listAccounts(
  tx: Tx,
  orgId: string,
  options: { includeInactive: boolean },
): Promise<CourierAccountRow[]> {
  const rows = await tx.execute<CourierAccountRow>(sql`
    select ${ACCOUNT_COLUMNS}
    from courier.courier_accounts a
    join sales.couriers c on c.org_id = a.org_id and c.id = a.courier_id
    where a.org_id = ${orgId}
      and (${options.includeInactive} or a.is_active)
    order by a.label
  `);
  return [...rows];
}

export interface NewCourierAccount {
  readonly orgId: string;
  readonly courierId: string;
  readonly providerCode: string;
  readonly label: string;
  readonly mode: 'sandbox' | 'live';
  readonly baseUrl: string | null;
  readonly credentials: Buffer | null;
  readonly credentialsKeyId: string | null;
  readonly credentialsFingerprint: string | null;
  readonly webhookSecret: Buffer | null;
  readonly supportsWebhook: boolean;
  readonly pollAfterHours: number;
  readonly settlementWalletId: string | null;
  readonly verified: boolean;
  readonly isActive: boolean;
}

/**
 * Insert or update the org's one account for a courier.
 *
 * An upsert on `(org_id, courier_id)` rather than an insert that fails, because setting up
 * a courier is a form somebody re-submits — new keys arrive, a webhook secret is rotated,
 * the sandbox becomes live — and each of those is an update to the same account. The
 * credential columns are only overwritten when new ones were supplied, so re-saving the
 * form to change a label does not wipe the keys.
 */
export async function upsertAccount(tx: Tx, input: NewCourierAccount): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into courier.courier_accounts
      (org_id, courier_id, provider_code, label, mode, base_url, credentials,
       credentials_key_id, credentials_fingerprint, webhook_secret, supports_webhook,
       poll_after_hours, settlement_wallet_id, verified, is_active)
    values (
      ${input.orgId}, ${input.courierId}, ${input.providerCode}, ${input.label},
      ${input.mode}, ${input.baseUrl}, ${input.credentials}, ${input.credentialsKeyId},
      ${input.credentialsFingerprint}, ${input.webhookSecret}, ${input.supportsWebhook},
      ${input.pollAfterHours}, ${input.settlementWalletId}::uuid, ${input.verified},
      ${input.isActive}
    )
    on conflict (org_id, courier_id) do update set
      provider_code = excluded.provider_code,
      label = excluded.label,
      mode = excluded.mode,
      base_url = excluded.base_url,
      credentials = coalesce(excluded.credentials, courier.courier_accounts.credentials),
      credentials_key_id = coalesce(excluded.credentials_key_id, courier.courier_accounts.credentials_key_id),
      credentials_fingerprint = coalesce(excluded.credentials_fingerprint, courier.courier_accounts.credentials_fingerprint),
      webhook_secret = coalesce(excluded.webhook_secret, courier.courier_accounts.webhook_secret),
      supports_webhook = excluded.supports_webhook,
      poll_after_hours = excluded.poll_after_hours,
      settlement_wallet_id = excluded.settlement_wallet_id,
      verified = excluded.verified,
      is_active = excluded.is_active,
      updated_at = now()
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('courier account upsert returned no id');
  return id;
}

export interface ConsignmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly org_id: string;
  readonly order_id: string;
  readonly courier_account_id: string;
  readonly courier_id: string;
  readonly branch_id: string | null;
  readonly consignment_no: string | null;
  readonly tracking_code: string | null;
  readonly reference: string;
  readonly booking_state: 'pending' | 'booked' | 'failed' | 'cancelled';
  readonly booking_attempts: number;
  readonly booking_failure_code: string | null;
  readonly booking_failure_message: string | null;
  readonly status: string;
  readonly raw_status: string | null;
  readonly cod_amount_poisha: string;
  readonly collected_poisha: string | null;
  readonly booked_at: string | null;
  readonly handover_confirmed_at: string | null;
  readonly handover_confirmed_by: string | null;
  readonly delivered_at: string | null;
  readonly returned_at: string | null;
  readonly last_status_at: string | null;
  readonly last_polled_at: string | null;
  readonly settlement_id: string | null;
  readonly settled_at: string | null;
}

const CONSIGNMENT_COLUMNS = sql`
  id, org_id, order_id, courier_account_id, courier_id, branch_id, consignment_no,
  tracking_code, reference, booking_state, booking_attempts, booking_failure_code,
  booking_failure_message, status, raw_status, cod_amount_poisha, collected_poisha,
  booked_at, handover_confirmed_at, handover_confirmed_by, delivered_at, returned_at,
  last_status_at, last_polled_at, settlement_id, settled_at
`;

export async function consignmentById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ConsignmentRow | undefined> {
  const rows = await tx.execute<ConsignmentRow>(sql`
    select ${CONSIGNMENT_COLUMNS} from courier.consignments
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

/*
 * A note on timestamps.
 *
 * Every `*_at` on these row types is a **string**, not a `Date`. `tx.execute` runs raw SQL, so
 * the driver hands back PostgreSQL's own text for a `timestamptz` rather than the `Date`
 * Drizzle's query builder would map it to. Typing them as `Date` compiled perfectly and threw
 * `toISOString is not a function` at the first caller — so they are strings here and are
 * converted where a caller genuinely needs an instant.
 */

/**
 * The consignment, locked for this transaction.
 *
 * Every path that changes one takes this first, for the reason
 * `TransitionsService.orderForUpdate` takes its own: a webhook and a poll arriving at the
 * same second both read `shipped`, both decide to deliver, and both perform their effects
 * before one of their updates loses. The dedupe index catches the second *insert*, but by
 * then the second transition has already been attempted — and the attempt is what posts a
 * journal. The lock makes read-decide-write one unit.
 */
export async function consignmentForUpdate(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<ConsignmentRow | undefined> {
  const rows = await tx.execute<ConsignmentRow>(sql`
    select ${CONSIGNMENT_COLUMNS} from courier.consignments
    where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

export async function consignmentByNumber(
  tx: Tx,
  orgId: string,
  courierAccountId: string,
  consignmentNo: string,
): Promise<ConsignmentRow | undefined> {
  const rows = await tx.execute<ConsignmentRow>(sql`
    select ${CONSIGNMENT_COLUMNS} from courier.consignments
    where org_id = ${orgId}
      and courier_account_id = ${courierAccountId}
      and consignment_no = ${consignmentNo}
    for update
  `);
  return rows[0];
}

/** The live parcel for an order, if it has one. */
export async function consignmentByOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<ConsignmentRow | undefined> {
  const rows = await tx.execute<ConsignmentRow>(sql`
    select ${CONSIGNMENT_COLUMNS} from courier.consignments
    where org_id = ${orgId} and order_id = ${orderId}
    order by created_at desc
    limit 1
  `);
  return rows[0];
}

export interface NewConsignment {
  readonly orgId: string;
  readonly orderId: string;
  readonly courierAccountId: string;
  readonly courierId: string;
  readonly branchId: string | null;
  readonly reference: string;
  readonly codAmountPoisha: bigint;
  readonly createdBy: string;
}

export async function insertConsignment(tx: Tx, input: NewConsignment): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into courier.consignments
      (org_id, order_id, courier_account_id, courier_id, branch_id, reference,
       booking_state, status, cod_amount_poisha, created_by)
    values (
      ${input.orgId}, ${input.orderId}, ${input.courierAccountId}, ${input.courierId},
      ${input.branchId}::uuid, ${input.reference}, 'pending', 'booked',
      ${input.codAmountPoisha.toString()}, ${input.createdBy}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('consignment insert returned no id');
  return id;
}

/**
 * Record a successful booking.
 *
 * Conditional on the row still being `pending` or already `booked` with this same
 * consignment number, which makes the write idempotent: a job that booked the parcel,
 * lost its acknowledgement and ran again gets the same number back from the courier
 * (§9's idempotency) and this update becomes a no-op rather than a second `booked_at`.
 */
export async function markBooked(
  tx: Tx,
  input: {
    orgId: string;
    consignmentId: string;
    consignmentNo: string;
    trackingCode: string | null;
    rawStatus: string | null;
    status: string;
    at: Date;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update courier.consignments set
      booking_state = 'booked',
      consignment_no = ${input.consignmentNo},
      tracking_code = ${input.trackingCode},
      raw_status = coalesce(${input.rawStatus}, raw_status),
      status = ${input.status}::courier.parcel_status,
      booked_at = coalesce(booked_at, ${input.at.toISOString()}::timestamptz),
      last_status_at = coalesce(last_status_at, ${input.at.toISOString()}::timestamptz),
      booking_failure_code = null,
      booking_failure_message = null,
      updated_at = now()
    where org_id = ${input.orgId}
      and id = ${input.consignmentId}
      and (booking_state = 'pending'
           or (booking_state = 'booked' and consignment_no = ${input.consignmentNo}))
    returning id
  `);
  return rows.length > 0;
}

/**
 * Record an attempt that did not work.
 *
 * `booking_attempts` is incremented on every attempt, successful or not, so the
 * dead-letter alert can say how hard we tried. `failed` is only set by the dead-letter
 * handler: an attempt that will be retried leaves the row `pending`, because a row
 * marked `failed` between retries would show an order as un-bookable while a retry was
 * still queued.
 */
export async function recordBookingAttempt(
  tx: Tx,
  input: {
    orgId: string;
    consignmentId: string;
    code: string;
    message: string;
    exhausted: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    update courier.consignments set
      booking_attempts = booking_attempts + 1,
      booking_failure_code = ${input.code},
      booking_failure_message = ${input.message},
      booking_state = case when ${input.exhausted} then 'failed'::courier.booking_state
                           else booking_state end,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.consignmentId}
  `);
}

export async function markCancelled(tx: Tx, orgId: string, consignmentId: string): Promise<void> {
  await tx.execute(sql`
    update courier.consignments set
      booking_state = 'cancelled',
      status = 'cancelled',
      updated_at = now()
    where org_id = ${orgId} and id = ${consignmentId}
  `);
}

/**
 * Where the courier says the parcel is. Tracking only — no money.
 *
 * Split from {@link recordConsignmentOutcome} deliberately. This half is true whatever the
 * order is doing, so it is written for every event the courier sends; the money half is only
 * true once §7's journal exists, and writing the two together was a real defect — see the
 * comment on `recordConsignmentOutcome`.
 */
export async function applyConsignmentStatus(
  tx: Tx,
  input: {
    orgId: string;
    consignmentId: string;
    status: string;
    rawStatus: string;
    occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    update courier.consignments set
      status = ${input.status}::courier.parcel_status,
      raw_status = ${input.rawStatus},
      last_status_at = ${input.occurredAt.toISOString()}::timestamptz,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.consignmentId}
  `);
}

/**
 * What the courier collected, and when the parcel arrived or came back.
 *
 * **Called only after the order's transition has actually run**, because these three columns
 * are the money half of a consignment. `settlementCandidates` reports `collected_poisha` as
 * what the courier owes us for this parcel, and the matching debit on `courier_receivable`
 * comes from §7's delivery journal — which only exists if the transition happened. Writing
 * the figure without the journal makes the consignment a matchable settlement candidate whose
 * credit has no debit behind it, which drives the courier's balance negative and shows up
 * only as a variance in the reconciliation report. That is precisely what happens for a
 * `delivered` event arriving at an order that is not `shipped`: a late webhook after a return,
 * or a parcel whose order never shipped.
 *
 * `coalesce(collected_poisha, …)` rather than an overwrite, and migration 0051 refuses the
 * overwrite as well: the figure is what the journal debited, so a later event that changed it
 * would leave the matcher comparing a statement against a number the ledger does not hold —
 * a mismatch on every line of an otherwise perfect statement.
 */
export async function recordConsignmentOutcome(
  tx: Tx,
  input: {
    orgId: string;
    consignmentId: string;
    occurredAt: Date;
    collectedPoisha: bigint | null;
    delivered: boolean;
    returned: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    update courier.consignments set
      collected_poisha = coalesce(collected_poisha, ${input.collectedPoisha === null ? null : input.collectedPoisha.toString()}),
      delivered_at = case when ${input.delivered} then coalesce(delivered_at, ${input.occurredAt.toISOString()}::timestamptz) else delivered_at end,
      returned_at = case when ${input.returned} then coalesce(returned_at, ${input.occurredAt.toISOString()}::timestamptz) else returned_at end,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.consignmentId}
  `);
}

export async function confirmHandover(
  tx: Tx,
  input: { orgId: string; consignmentId: string; at: Date; by: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update courier.consignments set
      handover_confirmed_at = ${input.at.toISOString()}::timestamptz,
      handover_confirmed_by = ${input.by},
      updated_at = now()
    where org_id = ${input.orgId}
      and id = ${input.consignmentId}
      and handover_confirmed_at is null
    returning id
  `);
  return rows.length > 0;
}

export async function markPolled(
  tx: Tx,
  orgId: string,
  consignmentId: string,
  at: Date,
): Promise<void> {
  await tx.execute(sql`
    update courier.consignments set last_polled_at = ${at.toISOString()}::timestamptz
    where org_id = ${orgId} and id = ${consignmentId}
  `);
}

/**
 * Parcels §20's poll should ask about: active, booked, and quiet for too long.
 *
 * "Quiet" is measured against `last_status_at` **and** `last_polled_at`, because a parcel
 * the courier has nothing new to say about would otherwise be polled every thirty minutes
 * forever — and §20 says the poll "respects courier rate limits". Ordered oldest-first so
 * a backlog drains rather than starving its own tail.
 */
export async function staleConsignments(
  tx: Tx,
  orgId: string,
  limit: number,
): Promise<ConsignmentRow[]> {
  const rows = await tx.execute<ConsignmentRow>(sql`
    select ${CONSIGNMENT_COLUMNS} from courier.consignments c
    where c.org_id = ${orgId}
      and c.booking_state = 'booked'
      and c.consignment_no is not null
      and c.status not in ('delivered', 'partial_delivered', 'returned_to_merchant', 'cancelled')
      and coalesce(c.last_polled_at, c.last_status_at, c.booked_at)
          < now() - make_interval(hours => (
              select poll_after_hours from courier.courier_accounts
              where org_id = c.org_id and id = c.courier_account_id
            ))
    order by coalesce(c.last_polled_at, c.last_status_at, c.booked_at)
    limit ${limit}
  `);
  return [...rows];
}

export interface NewConsignmentEvent {
  readonly orgId: string;
  readonly consignmentId: string;
  readonly source: 'webhook' | 'poll' | 'manual';
  readonly status: string;
  readonly rawStatus: string;
  readonly occurredAt: Date;
  readonly businessDate: string;
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly webhookDeliveryId: string | null;
  readonly appliedTrigger: string | null;
  readonly orderFromStatus: string | null;
  readonly orderToStatus: string | null;
}

/**
 * Record one courier event, or recognise it as one we already have.
 *
 * `on conflict do nothing` on the dedupe index, and the boolean it returns is **the**
 * answer to acceptance check 3: `false` means this exact event has been seen, so the
 * caller returns without transitioning anything and without posting anything. The
 * duplicate never reaches the state machine at all, which matters beyond correctness —
 * a second attempt would be refused by the machine, but the refusal would be logged as a
 * failure and eventually dead-letter a perfectly healthy webhook.
 */
export async function insertConsignmentEvent(
  tx: Tx,
  input: NewConsignmentEvent,
): Promise<{ id: string } | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into courier.consignment_events
      (org_id, consignment_id, source, status, raw_status, occurred_at, business_date,
       dedupe_key, payload, webhook_delivery_id, applied_trigger, order_from_status,
       order_to_status)
    values (
      ${input.orgId}, ${input.consignmentId}, ${input.source}::courier.consignment_event_source,
      ${input.status}::courier.parcel_status, ${input.rawStatus},
      ${input.occurredAt.toISOString()}::timestamptz,
      ${input.businessDate}, ${input.dedupeKey}, ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.webhookDeliveryId}::uuid, ${input.appliedTrigger}, ${input.orderFromStatus},
      ${input.orderToStatus}
    )
    on conflict (org_id, dedupe_key) do nothing
    returning id
  `);
  return rows[0];
}

export interface ConsignmentEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly source: string;
  readonly status: string;
  readonly raw_status: string;
  readonly occurred_at: string;
  readonly business_date: string;
  readonly applied_trigger: string | null;
  readonly order_from_status: string | null;
  readonly order_to_status: string | null;
}

/** The tracking timeline for one parcel, oldest first (M12's tracking bullet). */
export async function consignmentTimeline(
  tx: Tx,
  orgId: string,
  consignmentId: string,
): Promise<ConsignmentEventRow[]> {
  const rows = await tx.execute<ConsignmentEventRow>(sql`
    select id, source, status, raw_status, occurred_at, business_date, applied_trigger,
           order_from_status, order_to_status
    from courier.consignment_events
    where org_id = ${orgId} and consignment_id = ${consignmentId}
    order by occurred_at, created_at
  `);
  return [...rows];
}

/**
 * Store a webhook body we have verified, or recognise a retransmission.
 *
 * Returns the row id and whether it is new. A retransmission returns the original's id
 * with `created: false`, so the caller answers 200 — a courier that got a 4xx for
 * sending the same body twice would keep sending it, faster.
 */
export async function insertWebhookDelivery(
  tx: Tx,
  input: {
    orgId: string;
    courierAccountId: string;
    providerCode: string;
    bodyHash: string;
    body: unknown;
    headers: Record<string, string>;
  },
): Promise<{ id: string; created: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into courier.webhook_deliveries
      (org_id, courier_account_id, provider_code, body_hash, body, headers)
    values (
      ${input.orgId}, ${input.courierAccountId}, ${input.providerCode}, ${input.bodyHash},
      ${JSON.stringify(input.body)}::jsonb, ${JSON.stringify(input.headers)}::jsonb
    )
    on conflict (org_id, courier_account_id, body_hash) do nothing
    returning id
  `);
  const id = inserted[0]?.id;
  if (id !== undefined) return { id, created: true };

  const existing = await tx.execute<{ id: string }>(sql`
    select id from courier.webhook_deliveries
    where org_id = ${input.orgId}
      and courier_account_id = ${input.courierAccountId}
      and body_hash = ${input.bodyHash}
  `);
  const found = existing[0]?.id;
  if (found === undefined) throw new Error('webhook delivery neither inserted nor found');
  return { id: found, created: false };
}

export async function markWebhookProcessed(
  tx: Tx,
  input: { orgId: string; id: string; eventCount: number; error: string | null },
): Promise<void> {
  await tx.execute(sql`
    update courier.webhook_deliveries set
      processed_at = now(), event_count = ${input.eventCount}, process_error = ${input.error}
    where org_id = ${input.orgId} and id = ${input.id} and processed_at is null
  `);
}

export interface NewReturnReceipt {
  readonly orgId: string;
  readonly consignmentId: string;
  readonly orderId: string;
  readonly branchId: string | null;
  readonly locationId: string;
  readonly damagedLocationId: string | null;
  readonly receivedAt: Date;
  readonly businessDate: string;
  readonly receivedBy: string;
  readonly reason: string;
  readonly inspectionNote: string | null;
}

export async function insertReturnReceipt(tx: Tx, input: NewReturnReceipt): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into courier.return_receipts
      (org_id, consignment_id, order_id, branch_id, location_id, damaged_location_id,
       received_at, business_date, received_by, reason, inspection_note)
    values (
      ${input.orgId}, ${input.consignmentId}, ${input.orderId}, ${input.branchId}::uuid,
      ${input.locationId}, ${input.damagedLocationId}::uuid,
      ${input.receivedAt.toISOString()}::timestamptz,
      ${input.businessDate}, ${input.receivedBy}, ${input.reason}, ${input.inspectionNote}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('return receipt insert returned no id');
  return id;
}

export async function insertReturnReceiptLines(
  tx: Tx,
  orgId: string,
  receiptId: string,
  lines: readonly { skuId: string; sellableQty: number; damagedQty: number }[],
): Promise<void> {
  for (const line of lines) {
    await tx.execute(sql`
      insert into courier.return_receipt_lines
        (org_id, receipt_id, sku_id, sellable_qty, damaged_qty)
      values (${orgId}, ${receiptId}, ${line.skuId}, ${line.sellableQty}, ${line.damagedQty})
    `);
  }
}

export async function setReturnReceiptJournal(
  tx: Tx,
  orgId: string,
  receiptId: string,
  journalId: string | null,
): Promise<void> {
  await tx.execute(sql`
    update courier.return_receipts set journal_id = ${journalId}::uuid, updated_at = now()
    where org_id = ${orgId} and id = ${receiptId}
  `);
}

export async function returnReceiptFor(
  tx: Tx,
  orgId: string,
  consignmentId: string,
): Promise<{ id: string } | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from courier.return_receipts
    where org_id = ${orgId} and consignment_id = ${consignmentId}
  `);
  return rows[0];
}

/**
 * The consignments a statement could be settling: this courier's, delivered or returned,
 * and not yet settled.
 *
 * `returned_to_merchant` is included and it is easy to leave out. A returned parcel owes
 * us nothing, but the courier still charges a return fee — §7 books it to Return charges
 * against the receivable — so a candidate set of delivered parcels only would make every
 * return line in the statement an `unmatched` exception a person had to clear by hand.
 *
 * `receivable_poisha` is `collected_poisha` and not `cod_amount_poisha`. §7's delivery
 * journal debits courier receivable with what the courier *reported collecting*, so this
 * is the figure the statement must agree with; comparing against what we asked for would
 * flag every haggled-down delivery.
 */
export interface SettlementCandidateRow extends Record<string, unknown> {
  readonly consignment_id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly consignment_no: string;
  readonly receivable_poisha: string;
  readonly settled: boolean;
}

export async function settlementCandidates(
  tx: Tx,
  orgId: string,
  courierId: string,
): Promise<SettlementCandidateRow[]> {
  const rows = await tx.execute<SettlementCandidateRow>(sql`
    select c.id as consignment_id,
           c.order_id,
           c.reference as order_no,
           coalesce(c.consignment_no, '') as consignment_no,
           coalesce(c.collected_poisha, 0)::text as receivable_poisha,
           (c.settlement_id is not null) as settled
    from courier.consignments c
    where c.org_id = ${orgId}
      and c.courier_id = ${courierId}
      and c.status in ('delivered', 'partial_delivered', 'returned_to_merchant')
    order by c.delivered_at nulls last, c.returned_at nulls last
  `);
  return [...rows];
}

export interface NewSettlement {
  readonly orgId: string;
  readonly courierAccountId: string;
  readonly courierId: string;
  readonly branchId: string | null;
  readonly reference: string | null;
  readonly settlementDate: string;
  readonly fileObjectId: string | null;
  readonly walletId: string;
  readonly fileGrossPoisha: bigint;
  readonly fileChargesPoisha: bigint;
  readonly fileNetPoisha: bigint;
  readonly fileRowCount: number;
  readonly matchedGrossPoisha: bigint;
  readonly matchedChargesPoisha: bigint;
  readonly matchedDeliveryChargesPoisha: bigint;
  readonly matchedReturnChargesPoisha: bigint;
  readonly matchedOtherChargesPoisha: bigint;
  readonly matchedNetPoisha: bigint;
  readonly matchedRowCount: number;
  readonly exceptionCount: number;
  readonly importedBy: string;
}

export async function insertSettlement(tx: Tx, input: NewSettlement): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into courier.settlements
      (org_id, courier_account_id, courier_id, branch_id, reference, settlement_date,
       file_object_id, wallet_id, file_gross_poisha, file_charges_poisha, file_net_poisha,
       file_row_count, matched_gross_poisha, matched_charges_poisha,
       matched_delivery_charges_poisha, matched_return_charges_poisha,
       matched_other_charges_poisha, matched_net_poisha, matched_row_count,
       exception_count, imported_by)
    values (
      ${input.orgId}, ${input.courierAccountId}, ${input.courierId}, ${input.branchId}::uuid,
      ${input.reference}, ${input.settlementDate}, ${input.fileObjectId}::uuid,
      ${input.walletId}, ${input.fileGrossPoisha.toString()},
      ${input.fileChargesPoisha.toString()}, ${input.fileNetPoisha.toString()},
      ${input.fileRowCount}, ${input.matchedGrossPoisha.toString()},
      ${input.matchedChargesPoisha.toString()},
      ${input.matchedDeliveryChargesPoisha.toString()},
      ${input.matchedReturnChargesPoisha.toString()},
      ${input.matchedOtherChargesPoisha.toString()}, ${input.matchedNetPoisha.toString()},
      ${input.matchedRowCount}, ${input.exceptionCount}, ${input.importedBy}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('settlement insert returned no id');
  return id;
}

export async function insertSettlementLines(
  tx: Tx,
  orgId: string,
  settlementId: string,
  lines: readonly {
    rowNo: number;
    consignmentNo: string;
    reference: string | null;
    match: string;
    consignmentId: string | null;
    orderId: string | null;
    codCollectedPoisha: bigint;
    deliveryChargePoisha: bigint;
    returnChargePoisha: bigint;
    otherChargePoisha: bigint;
    netPoisha: bigint;
    expectedPoisha: bigint | null;
    note: string | null;
  }[],
): Promise<void> {
  for (const line of lines) {
    await tx.execute(sql`
      insert into courier.settlement_lines
        (org_id, settlement_id, row_no, consignment_no, reference, match, consignment_id,
         order_id, cod_collected_poisha, delivery_charge_poisha, return_charge_poisha,
         other_charge_poisha, net_poisha, expected_poisha, note)
      values (
        ${orgId}, ${settlementId}, ${line.rowNo}, ${line.consignmentNo}, ${line.reference},
        ${line.match}::courier.settlement_match, ${line.consignmentId}::uuid,
        ${line.orderId}::uuid, ${line.codCollectedPoisha.toString()},
        ${line.deliveryChargePoisha.toString()}, ${line.returnChargePoisha.toString()},
        ${line.otherChargePoisha.toString()}, ${line.netPoisha.toString()},
        ${line.expectedPoisha === null ? null : line.expectedPoisha.toString()}, ${line.note}
      )
    `);
  }
}

export interface SettlementRow extends Record<string, unknown> {
  readonly id: string;
  readonly courier_account_id: string;
  readonly courier_id: string;
  readonly branch_id: string | null;
  readonly reference: string | null;
  readonly settlement_date: string;
  readonly posting_business_date: string | null;
  readonly deferred_from_closed_period: boolean;
  readonly status: 'imported' | 'pending_approval' | 'posted' | 'rejected';
  readonly file_object_id: string | null;
  readonly wallet_id: string;
  readonly file_gross_poisha: string;
  readonly file_charges_poisha: string;
  readonly file_net_poisha: string;
  readonly file_row_count: number;
  readonly matched_gross_poisha: string;
  readonly matched_charges_poisha: string;
  readonly matched_delivery_charges_poisha: string;
  readonly matched_return_charges_poisha: string;
  readonly matched_other_charges_poisha: string;
  readonly matched_net_poisha: string;
  readonly matched_row_count: number;
  readonly exception_count: number;
  readonly approval_request_id: string | null;
  readonly charges_journal_id: string | null;
  readonly cash_journal_id: string | null;
  readonly imported_by: string;
  readonly posted_at: string | null;
  readonly rejected_reason: string | null;
}

const SETTLEMENT_COLUMNS = sql`
  id, courier_account_id, courier_id, branch_id, reference, settlement_date,
  posting_business_date, deferred_from_closed_period, status, file_object_id, wallet_id,
  file_gross_poisha::text, file_charges_poisha::text, file_net_poisha::text, file_row_count,
  matched_gross_poisha::text, matched_charges_poisha::text,
  matched_delivery_charges_poisha::text, matched_return_charges_poisha::text,
  matched_other_charges_poisha::text, matched_net_poisha::text, matched_row_count,
  exception_count, approval_request_id, charges_journal_id, cash_journal_id, imported_by,
  posted_at, rejected_reason
`;

export async function settlementById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SettlementRow | undefined> {
  const rows = await tx.execute<SettlementRow>(sql`
    select ${SETTLEMENT_COLUMNS} from courier.settlements
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function settlementForUpdate(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<SettlementRow | undefined> {
  const rows = await tx.execute<SettlementRow>(sql`
    select ${SETTLEMENT_COLUMNS} from courier.settlements
    where org_id = ${orgId} and id = ${id}
    for update
  `);
  return rows[0];
}

export async function listSettlements(tx: Tx, orgId: string, where: SQL): Promise<SettlementRow[]> {
  const rows = await tx.execute<SettlementRow>(sql`
    select ${SETTLEMENT_COLUMNS} from courier.settlements
    where org_id = ${orgId} and ${where}
    order by settlement_date desc, created_at desc
    limit 200
  `);
  return [...rows];
}

export interface SettlementLineRow extends Record<string, unknown> {
  readonly id: string;
  readonly row_no: number;
  readonly consignment_no: string;
  readonly reference: string | null;
  readonly match: string;
  readonly consignment_id: string | null;
  readonly order_id: string | null;
  readonly cod_collected_poisha: string;
  readonly delivery_charge_poisha: string;
  readonly return_charge_poisha: string;
  readonly other_charge_poisha: string;
  readonly net_poisha: string;
  readonly expected_poisha: string | null;
  readonly note: string | null;
}

export async function settlementLines(
  tx: Tx,
  orgId: string,
  settlementId: string,
  options: { exceptionsOnly: boolean } = { exceptionsOnly: false },
): Promise<SettlementLineRow[]> {
  const rows = await tx.execute<SettlementLineRow>(sql`
    select id, row_no, consignment_no, reference, match, consignment_id, order_id,
           cod_collected_poisha::text, delivery_charge_poisha::text,
           return_charge_poisha::text, other_charge_poisha::text, net_poisha::text,
           expected_poisha::text, note
    from courier.settlement_lines
    where org_id = ${orgId} and settlement_id = ${settlementId}
      and (${!options.exceptionsOnly} or match <> 'matched')
    order by row_no
  `);
  return [...rows];
}

export async function attachSettlementApproval(
  tx: Tx,
  input: { orgId: string; settlementId: string; approvalRequestId: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update courier.settlements set
      status = 'pending_approval',
      approval_request_id = ${input.approvalRequestId},
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.settlementId} and status = 'imported'
    returning id
  `);
  return rows.length > 0;
}

/**
 * Mark a settlement posted, with the journals and D-037's resolved date.
 *
 * Conditional on `status = 'pending_approval'`, which is what makes the executor safe to
 * run twice: an approval decided twice (it cannot be, but the executor is also called on
 * auto-approval) finds the row already `posted` and writes nothing. The journals
 * themselves are idempotent on their keys, so the second pass posts nothing either.
 */
export async function markSettlementPosted(
  tx: Tx,
  input: {
    orgId: string;
    settlementId: string;
    postingBusinessDate: string;
    deferred: boolean;
    chargesJournalId: string | null;
    cashJournalId: string | null;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update courier.settlements set
      status = 'posted',
      posting_business_date = ${input.postingBusinessDate},
      deferred_from_closed_period = ${input.deferred},
      charges_journal_id = ${input.chargesJournalId}::uuid,
      cash_journal_id = ${input.cashJournalId}::uuid,
      posted_at = now(),
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.settlementId}
      and status = 'pending_approval'
    returning id
  `);
  return rows.length > 0;
}

export async function markSettlementRejected(
  tx: Tx,
  input: { orgId: string; settlementId: string; reason: string },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update courier.settlements set
      status = 'rejected', rejected_reason = ${input.reason}, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.settlementId}
      and status in ('imported', 'pending_approval')
    returning id
  `);
  return rows.length > 0;
}

/**
 * Link the matched consignments to the settlement that closed them.
 *
 * Conditional on `settlement_id is null`, so a consignment another settlement already
 * claimed is skipped rather than overwritten — migration 0051 refuses the overwrite too.
 * Returns how many were linked, which the caller compares against the matched row count:
 * a difference means somebody settled one of these between the import and the approval,
 * and the posting must not stand.
 *
 * A statement per consignment rather than one `where id = any(…)`, because building the
 * array would mean interpolating ids into SQL — which the repository rule forbids
 * outright, and rightly: the exception for "they are only uuids" is how the habit starts.
 * A settlement is a few hundred rows inside one transaction, so the round trips are not
 * the thing that makes this slow.
 */
export async function linkSettledConsignments(
  tx: Tx,
  input: { orgId: string; settlementId: string; consignmentIds: readonly string[]; at: Date },
): Promise<number> {
  let linked = 0;
  for (const consignmentId of input.consignmentIds) {
    const rows = await tx.execute<{ id: string }>(sql`
      update courier.consignments set
        settlement_id = ${input.settlementId}, settled_at = ${input.at.toISOString()}::timestamptz, updated_at = now()
      where org_id = ${input.orgId} and id = ${consignmentId} and settlement_id is null
      returning id
    `);
    linked += rows.length;
  }
  return linked;
}

/**
 * The COD reconciliation report's rows: delivered, settled and outstanding, by courier
 * (§7's reports).
 *
 * Per consignment rather than per courier, because "outstanding" has to be attributable:
 * a courier balance that is ৳40,000 too high is a question about *which parcels*, and a
 * report that gave only the total would send somebody through a month of statements by
 * hand. The caller aggregates and ages it.
 *
 * ## The date filter
 *
 * A parcel is in the report when the later-of-nothing — its delivery date, or its return date
 * when it was never delivered — is on or before `asOf`, computed in Asia/Dhaka (invariant 8).
 * A parcel with neither is excluded.
 *
 * The first version read `delivered_at is null or (delivered_at …) <= asOf`, which let *every*
 * returned parcel through whatever `asOf` was: a report re-run for last March counted parcels
 * that came back in September. The money columns were unaffected — a returned parcel's
 * collection is zero — but `deliveredCount` was inflated, which is exactly the kind of wrong
 * number that makes somebody stop trusting a reconciliation.
 */
export interface ReconciliationRow extends Record<string, unknown> {
  readonly consignment_id: string;
  readonly courier_id: string;
  readonly order_id: string;
  readonly order_no: string;
  readonly consignment_no: string | null;
  readonly status: string;
  readonly delivered_on: string | null;
  readonly collected_poisha: string;
  readonly settled: boolean;
  readonly settlement_id: string | null;
  readonly settled_on: string | null;
  readonly settled_charges_poisha: string;
  readonly settled_net_poisha: string;
}

export async function reconciliation(
  tx: Tx,
  orgId: string,
  options: { courierId?: string | undefined; asOf: string; branchWhere: SQL },
): Promise<ReconciliationRow[]> {
  const rows = await tx.execute<ReconciliationRow>(sql`
    select c.id as consignment_id,
           c.courier_id,
           c.order_id,
           c.reference as order_no,
           c.consignment_no,
           c.status::text as status,
           (c.delivered_at at time zone 'Asia/Dhaka')::date::text as delivered_on,
           coalesce(c.collected_poisha, 0)::text as collected_poisha,
           (c.settlement_id is not null) as settled,
           c.settlement_id,
           s.posting_business_date::text as settled_on,
           coalesce(l.delivery_charge_poisha + l.return_charge_poisha + l.other_charge_poisha, 0)::text
             as settled_charges_poisha,
           coalesce(l.net_poisha, 0)::text as settled_net_poisha
    from courier.consignments c
    left join courier.settlements s on s.org_id = c.org_id and s.id = c.settlement_id
    left join courier.settlement_lines l
           on l.org_id = c.org_id and l.settlement_id = c.settlement_id
          and l.consignment_id = c.id and l.match = 'matched'
    where c.org_id = ${orgId}
      and c.status in ('delivered', 'partial_delivered', 'returned_to_merchant')
      -- On or before asOf, in Asia/Dhaka. See the note above the function.
      and coalesce(
            (c.delivered_at at time zone 'Asia/Dhaka')::date,
            (c.returned_at at time zone 'Asia/Dhaka')::date
          ) <= ${options.asOf}::date
      and (${options.courierId ?? null}::uuid is null or c.courier_id = ${options.courierId ?? null}::uuid)
      and ${options.branchWhere}
    order by c.courier_id, c.delivered_at nulls last
    limit 5000
  `);
  return [...rows];
}
