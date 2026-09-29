import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { approvalRequests } from '../approvals/index.js';
import { primaryId, timestamps } from '../columns.js';
import { fileObjects } from '../files/index.js';
import { journals } from '../ledger/index.js';
import { branches, locations, organizations } from '../org/index.js';
import { couriers, deliveryZones, orders } from '../orders/index.js';
import { walletAccounts } from '../wallets/index.js';

/**
 * Couriers: accounts, parcels, status history and settlements (architecture §9, §20,
 * §21; M12).
 *
 * M10 owns `sales.couriers` — the party row a receivable is booked against — and this
 * schema wraps tables *around* it rather than replacing it (D-171): an account with
 * credentials, a consignment per parcel, an append-only event log, the raw webhook
 * deliveries, the returns a warehouse received and inspected, and the settlements that
 * finally move the cash.
 *
 * ## What is deliberately absent
 *
 * **No credential is stored in a readable column.** `courier_accounts.credentials` is
 * `bytea` holding AES-256-GCM ciphertext, and nothing in this schema, in a backup, in
 * a `pg_dump` or in a support engineer's `select *` shows an API key (invariant 10,
 * §25). The key id is stored beside it so a rotation can find the rows it has to
 * re-encrypt, and a fingerprint so an operator can confirm *which* key is configured
 * without ever seeing it.
 *
 * **No cost column anywhere.** A return receipt records how many units came back
 * sellable and how many damaged; what they were worth is `sales.order_lines`'
 * `dispatch_unit_cost_poisha`, which the orders module owns. Copying it here would put
 * purchase cost in a fourth place (invariant 5 allows three: supply, inventory,
 * ledger) and would give every reader of a returns screen a cost field to leak.
 *
 * **No balance column.** "How much is this courier holding" is Σ over
 * `ledger.journal_lines` for the `courier_receivable` account with that courier as the
 * party — derived on read, like a wallet's balance, for the same reason: a maintained
 * column drifts the first time a journal posts by a path that forgot to update it, and
 * nobody finds out until a courier disputes a statement.
 *
 * Every table is tenant-scoped — `org_id NOT NULL`, indexed, RLS ENABLE and FORCE from
 * `tenantTableSql()` in migration 0049 — and every foreign key between two tenant
 * tables carries `org_id` on both sides (D-047).
 */
export const courier = pgSchema('courier');

/**
 * Ciphertext, as a column type.
 *
 * A named type rather than a bare `bytea` so the intent travels with the column: every
 * read of one of these has to go through `decryptCredentials`, and a reviewer seeing
 * `encrypted('credentials')` knows a plaintext write is a bug rather than a style
 * choice. Drizzle needs the driver mapping spelled out because `postgres` hands back a
 * `Uint8Array` and takes a `Buffer`.
 */
const encrypted = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => Buffer.from(value as unknown as Uint8Array),
  toDriver: (value) => value,
});

/**
 * §9's twelve normalized statuses.
 *
 * An enum rather than text because the mapping table in
 * `packages/domain/src/courier/status.ts` is the only thing allowed to produce one,
 * and a text column would let a raw courier word be written straight through — which
 * is exactly the bug the normalization exists to prevent. The raw word lives beside it
 * in `raw_status`, which §9 requires for `unknown` and which this schema keeps for
 * every status, because the mapping is the thing most likely to turn out wrong.
 */
export const parcelStatus = courier.enum('parcel_status', [
  'booked',
  'pickup_pending',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'hold',
  'delivered',
  'partial_delivered',
  'return_in_transit',
  'returned_to_merchant',
  'cancelled',
  'unknown',
]);

/**
 * Where a consignment stands with *us*, as opposed to where the parcel is.
 *
 * Separate from `parcel_status` because the two fail independently: a booking can be
 * `failed` while the parcel status is still `booked` from a previous attempt, and
 * collapsing them would make "the courier refused this parcel" indistinguishable from
 * "the courier has not picked it up yet" — the first needs a human today, the second
 * needs nobody.
 */
export const bookingState = courier.enum('booking_state', [
  /** Enqueued, not yet attempted. */
  'pending',
  'booked',
  /** Every retry spent. §20's dead letter, and `delivery.booking_failed`. */
  'failed',
  'cancelled',
]);

export const consignmentEventSource = courier.enum('consignment_event_source', [
  'webhook',
  'poll',
  /** A person set the status because the courier's sync has not caught up (§9). */
  'manual',
]);

/**
 * A settlement's life. `imported` → `pending_approval` → `posted`, or `rejected`.
 *
 * `imported` is not `pending_approval`: an import with exceptions must be looked at
 * before anybody is asked to approve it, and a status that conflated the two would put
 * a checker's name on a batch nobody had reconciled.
 */
export const settlementStatus = courier.enum('settlement_status', [
  'imported',
  'pending_approval',
  'posted',
  'rejected',
]);

/** Why a statement row is or is not going to post. §9's exceptions report. */
export const settlementMatch = courier.enum('settlement_match', [
  'matched',
  'unmatched',
  'amount_mismatch',
  'duplicate',
  'already_settled',
]);

/**
 * One courier account per org, with its credentials encrypted (M12's first bullet).
 *
 * `courier_id` points at M10's party row, so the receivable this account settles and
 * the party the ledger books against are the same row by construction. One account per
 * courier per org: two sets of credentials for one courier would make "which key
 * booked this parcel" unanswerable when one of them is revoked.
 *
 * `verified` is the honesty flag. §21 and D-006 require every adapter to be built from
 * the courier's official documentation; where that documentation could not be obtained
 * the adapter is marked UNVERIFIED in decisions.md and this column says so per
 * account, so an operator enabling it is making a decision rather than discovering one.
 */
export const courierAccounts = courier.table(
  'courier_accounts',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** M10's party row (D-171). The receivable's `party_id`. */
    courierId: uuid('courier_id').notNull(),
    /** Which adapter to resolve: `steadfast`, `fake`. Matches `sales.couriers.code`. */
    providerCode: text('provider_code').notNull(),
    /** For people: "Steadfast (live)", "Steadfast sandbox". */
    label: text('label').notNull(),
    /**
     * `sandbox` or `live`.
     *
     * Stored rather than inferred from the base URL, because the acceptance check that
     * matters here — "a live sandbox smoke test runs if credentials exist" — needs to
     * know which of the two a set of credentials is, and a URL is a string an operator
     * can paste wrong.
     */
    mode: text('mode').notNull().default('sandbox'),
    /** Overrides the adapter's default. Null in every ordinary installation. */
    baseUrl: text('base_url'),
    /**
     * AES-256-GCM ciphertext of the adapter's credential object.
     *
     * Nullable so an account can exist before its keys arrive, which is the normal
     * order of events — the client applies for API access after the brand is set up —
     * and `is_active` is what stops a keyless account being used.
     */
    credentials: encrypted('credentials'),
    /** Which key encrypted it, so a rotation knows what it still has to re-wrap. */
    credentialsKeyId: text('credentials_key_id'),
    /**
     * A short, non-reversible digest of the plaintext.
     *
     * So an operator can confirm the key in the vault is the key in the database
     * without either of them ever being displayed. Truncated on purpose: a full hash of
     * a low-entropy secret is a secret.
     */
    credentialsFingerprint: text('credentials_fingerprint'),
    /** The shared secret a webhook must present. Ciphertext, same treatment. */
    webhookSecret: encrypted('webhook_secret'),
    /** False when this courier has no webhook, so §9's polling fallback is the only sync. */
    supportsWebhook: boolean('supports_webhook').notNull().default(false),
    /** §9: "parcels with no update for N hours get polled." */
    pollAfterHours: smallint('poll_after_hours').notNull().default(6),
    /** Where a settlement's net lands. Nullable until the brand says which account. */
    settlementWalletId: uuid('settlement_wallet_id'),
    /** False for an adapter built from anything other than the courier's own docs. */
    verified: boolean('verified').notNull().default(false),
    isActive: boolean('is_active').notNull().default(false),
    ...timestamps,
  },
  (table) => [
    unique('courier_accounts_org_id_id_key').on(table.orgId, table.id),
    index('courier_accounts_org_idx').on(table.orgId),
    uniqueIndex('courier_accounts_org_courier_idx').on(table.orgId, table.courierId),
    foreignKey({
      name: 'courier_accounts_org_id_courier_id_fk',
      columns: [table.orgId, table.courierId],
      foreignColumns: [couriers.orgId, couriers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'courier_accounts_org_id_settlement_wallet_id_fk',
      columns: [table.orgId, table.settlementWalletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    check(
      'courier_accounts_provider_format',
      sql`${table.providerCode} ~ '^[a-z][a-z0-9_]{1,31}$'`,
    ),
    check('courier_accounts_mode', sql`${table.mode} in ('sandbox', 'live')`),
    check('courier_accounts_poll_window', sql`${table.pollAfterHours} between 1 and 168`),
    /*
     * A key id without ciphertext, or ciphertext without a key id, is an account
     * nothing can decrypt. Enforced here rather than trusted to the service because
     * the symptom otherwise appears at the first booking attempt, as five retries and
     * a dead-lettered job, hours after somebody saved the form.
     */
    check(
      'courier_accounts_credentials_have_key',
      sql`(${table.credentials} is null) = (${table.credentialsKeyId} is null)`,
    ),
    /*
     * An active account must be able to authenticate. The `fake` provider is exempt:
     * it has no credentials by design, and it is what every test and every local
     * development run books against.
     */
    check(
      'courier_accounts_active_has_credentials',
      sql`${table.isActive} = false or ${table.credentials} is not null or ${table.providerCode} = 'fake'`,
    ),
  ],
);

/**
 * One parcel with one courier (§9).
 *
 * One row per (order, courier account) rather than one per order: an order rebooked
 * with a different courier after the first refused it is two parcels, and the first
 * one's consignment number still appears on the first courier's statement. The unique
 * index is on `(org_id, courier_account_id, consignment_no)` — the courier's own key —
 * so two rows can never claim the same parcel, and `consignment_no` is null until the
 * booking succeeds.
 *
 * `collected_poisha` is the figure the settlement matcher compares the statement
 * against, and it is here for a precise reason: §7's delivery journal debits courier
 * receivable with *what the courier reported collecting*, so this column and that
 * debit are the same number by construction. Matching against `cod_amount_poisha`
 * instead — what we asked for — would flag every haggled-down delivery as a mismatch.
 */
export const consignments = courier.table(
  'consignments',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    courierAccountId: uuid('courier_account_id').notNull(),
    /** Denormalised from the account so the receivable's party is on this row (§7). */
    courierId: uuid('courier_id').notNull(),
    /** The branch the order belongs to, for row scope. Null for an org-level order. */
    branchId: uuid('branch_id'),
    /** The courier's own id. Null until it accepts the parcel. */
    consignmentNo: text('consignment_no'),
    trackingCode: text('tracking_code'),
    /** Our reference as the courier echoes it back: the order number. */
    reference: text('reference').notNull(),

    bookingState: bookingState('booking_state').notNull().default('pending'),
    /** Attempts made, so the dead-letter alert can say how hard we tried. */
    bookingAttempts: smallint('booking_attempts').notNull().default(0),
    /** The last refusal's code, for the operator reading `delivery.booking_failed`. */
    bookingFailureCode: text('booking_failure_code'),
    /** Never a courier's raw error body: it quotes the address we sent (invariant 10). */
    bookingFailureMessage: text('booking_failure_message'),

    status: parcelStatus('status').notNull().default('booked'),
    /** §9: keep the raw status, always. */
    rawStatus: text('raw_status'),

    /** What we asked the rider to collect. */
    codAmountPoisha: bigint('cod_amount_poisha', { mode: 'bigint' }).notNull(),
    /** What the courier reported collecting. Null until delivered or partly delivered. */
    collectedPoisha: bigint('collected_poisha', { mode: 'bigint' }),

    bookedAt: timestamp('booked_at', { withTimezone: true, mode: 'date' }),
    /** When a person confirmed the rider physically took it (M12's handover bullet). */
    handoverConfirmedAt: timestamp('handover_confirmed_at', { withTimezone: true, mode: 'date' }),
    handoverConfirmedBy: text('handover_confirmed_by'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    returnedAt: timestamp('returned_at', { withTimezone: true, mode: 'date' }),
    /** When the courier last told us anything, for §20's staleness poll. */
    lastStatusAt: timestamp('last_status_at', { withTimezone: true, mode: 'date' }),
    /** When we last asked, whether or not anything had changed. */
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true, mode: 'date' }),

    /** The settlement that closed this consignment's money. */
    settlementId: uuid('settlement_id'),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),

    /**
     * The order's delivery zone when the parcel was booked (M15).
     *
     * Copied at booking, from the orders module's port, so the performance report can
     * group by zone without reading `sales.orders` (invariant 12). A copy, not a live
     * link: the report is about where the parcel was *sent*, and an order whose zone is
     * edited afterwards should not move last month's delivery rate. Null for a parcel
     * booked before M15, which the report shows as its own row rather than guessing.
     */
    deliveryZoneId: uuid('delivery_zone_id'),
    /**
     * When the parcel's status last actually *changed* (M15's stuck-parcel queue).
     *
     * Separate from `last_status_at`, which moves on every event: a poller asking a
     * courier every six hours hears `in_transit` every six hours, and measured against
     * `last_status_at` a parcel stuck in transit for three weeks looked like one the
     * courier spoke about this morning. This column moves only when the status does, so
     * "no status change in N days" can be asked honestly.
     */
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true, mode: 'date' }),

    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('consignments_org_id_id_key').on(table.orgId, table.id),
    index('consignments_org_idx').on(table.orgId),
    uniqueIndex('consignments_org_account_no_idx')
      .on(table.orgId, table.courierAccountId, table.consignmentNo)
      .where(sql`${table.consignmentNo} is not null`),
    index('consignments_org_order_idx').on(table.orgId, table.orderId),
    index('consignments_org_status_idx').on(table.orgId, table.status),
    /*
     * The polling job's working set (§20: "every 30 min for stale active parcels").
     *
     * A partial index over the non-terminal statuses, because the whole point is that
     * the query stays proportional to the parcels still moving rather than to every
     * parcel the brand has ever shipped. Without it, month three of production turns a
     * half-hourly cron into a full scan of the table.
     */
    index('consignments_org_active_idx')
      .on(table.orgId, table.lastStatusAt)
      .where(
        sql`${table.status} not in ('delivered', 'partial_delivered', 'returned_to_merchant', 'cancelled')`,
      ),
    /** The settlement matcher's candidate query: delivered, not yet settled. */
    index('consignments_org_unsettled_idx')
      .on(table.orgId, table.courierId, table.deliveredAt)
      .where(sql`${table.settlementId} is null`),
    /*
     * `settlement_id` has no foreign key here, and the migration adds it with an ALTER.
     *
     * The two tables reference each other — a consignment names the settlement that
     * closed it, and a settlement line names the consignment it covers — so one of the
     * two constraints has to be created after both tables exist. Declaring it here
     * would also make this module's two table definitions circular in TypeScript, which
     * Drizzle resolves only with an explicit return type on one of them.
     */
    foreignKey({
      name: 'consignments_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'consignments_org_id_courier_account_id_fk',
      columns: [table.orgId, table.courierAccountId],
      foreignColumns: [courierAccounts.orgId, courierAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'consignments_org_id_courier_id_fk',
      columns: [table.orgId, table.courierId],
      foreignColumns: [couriers.orgId, couriers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'consignments_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'consignments_org_id_delivery_zone_id_fk',
      columns: [table.orgId, table.deliveryZoneId],
      foreignColumns: [deliveryZones.orgId, deliveryZones.id],
    }).onDelete('restrict'),
    /** The performance report's window: parcels booked between two dates. */
    index('consignments_org_booked_idx').on(table.orgId, table.bookedAt),
    check('consignments_cod_not_negative', sql`${table.codAmountPoisha} >= 0`),
    check('consignments_cod_bounded', sql`${table.codAmountPoisha} <= 9000000000000000`),
    check(
      'consignments_collected_not_negative',
      sql`${table.collectedPoisha} is null or ${table.collectedPoisha} >= 0`,
    ),
    check(
      'consignments_booked_has_number',
      sql`${table.bookingState} <> 'booked' or (${table.consignmentNo} is not null and ${table.bookedAt} is not null)`,
    ),
    check(
      'consignments_settled_has_settlement',
      sql`(${table.settlementId} is null) = (${table.settledAt} is null)`,
    ),
  ],
);

/**
 * Every status a courier ever reported, append-only (§9's dedupe rule).
 *
 * `dedupe_key` is `(courier, consignment, status, occurred_at)` per §9, built by
 * `statusDedupeKey` in the domain so the webhook path and the polling path produce
 * identical keys for identical facts. The unique index on it is **the** enforcement
 * behind acceptance check 3: a duplicate webhook cannot insert, so the transition it
 * would have driven is never attempted. The state machine refusing the second
 * transition and the ledger's idempotency key are the two layers behind it, and all
 * three are wanted — the first is the only one that also stops the second attempt
 * being logged as a failure.
 *
 * Append-only in the grants (0049): an event is what the courier said at a moment, and
 * a row that could be edited afterwards is a row that cannot settle an argument.
 */
export const consignmentEvents = courier.table(
  'consignment_events',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    consignmentId: uuid('consignment_id').notNull(),
    source: consignmentEventSource('source').notNull(),
    status: parcelStatus('status').notNull(),
    /** Exactly what the courier said (§9). */
    rawStatus: text('raw_status').notNull(),
    /** When the courier says it happened, not when we heard. */
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Asia/Dhaka calendar date of `occurred_at` (invariant 8), for reports. */
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    /**
     * The courier's own payload for this event, less anything identifying.
     *
     * Stored because a mapping that turns out wrong can only be corrected against the
     * original, and because a courier disputing what it told us is a real conversation.
     * The service strips the recipient's name, phone and address before it gets here:
     * §19 and invariant 10 both apply to a jsonb column as much as to a log line.
     */
    payload: jsonb('payload').notNull().default({}),
    /** The webhook delivery this came out of, when it was a webhook. */
    webhookDeliveryId: uuid('webhook_delivery_id'),
    /** §9's trigger this event drove, or null when it was tracking only. */
    appliedTrigger: text('applied_trigger'),
    orderFromStatus: text('order_from_status'),
    orderToStatus: text('order_to_status'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('consignment_events_org_id_id_key').on(table.orgId, table.id),
    index('consignment_events_org_idx').on(table.orgId),
    /*
     * §9's dedupe, as a constraint rather than a check the service performs.
     *
     * Per org and not per consignment, because the key already contains the courier's
     * consignment number: making the index wider would let the same event insert twice
     * if a renumbering had produced two consignment rows, which is precisely when a
     * double transition would be hardest to explain.
     */
    uniqueIndex('consignment_events_org_dedupe_idx').on(table.orgId, table.dedupeKey),
    index('consignment_events_org_consignment_idx').on(
      table.orgId,
      table.consignmentId,
      table.occurredAt,
    ),
    foreignKey({
      name: 'consignment_events_org_id_consignment_id_fk',
      columns: [table.orgId, table.consignmentId],
      foreignColumns: [consignments.orgId, consignments.id],
    }).onDelete('restrict'),
  ],
);

/**
 * Raw webhook bodies, stored before they are processed (§9).
 *
 * §9's order is deliberate: "verify authenticity … store the raw payload … process in
 * a job". Verification comes first here too, and only verified deliveries are stored —
 * a row in a tenant table is a row somebody wrote into that tenant's data, and
 * accepting unauthenticated bodies would make this table a place anyone on the
 * internet could fill up on a brand's behalf. Rejected deliveries are counted and
 * logged, never persisted here.
 *
 * `body_hash` collapses literal retransmissions, which every courier does when our
 * acknowledgement is slow. It is not the same thing as `consignment_events.dedupe_key`
 * and neither replaces the other: this one stops one identical HTTP body being stored
 * twice, that one stops one status being applied twice however it reached us.
 */
export const webhookDeliveries = courier.table(
  'webhook_deliveries',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    courierAccountId: uuid('courier_account_id').notNull(),
    providerCode: text('provider_code').notNull(),
    /** sha256 of the exact bytes, so a retransmission is recognised. */
    bodyHash: text('body_hash').notNull(),
    body: jsonb('body').notNull(),
    /**
     * A small allow-list of headers: content-type, user-agent, the courier's request id.
     *
     * An allow-list and not a redaction pass, because the header that must never land
     * here is `Authorization` — the courier's bearer token, which is also *our* stored
     * secret — and a deny-list is one forgotten spelling away from writing it into
     * every backup (invariant 10).
     */
    headers: jsonb('headers').notNull().default({}),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    /** How many normalized events the adapter got out of this body. */
    eventCount: smallint('event_count').notNull().default(0),
    /** Redacted before it gets here. */
    processError: text('process_error'),
  },
  (table) => [
    unique('webhook_deliveries_org_id_id_key').on(table.orgId, table.id),
    index('webhook_deliveries_org_idx').on(table.orgId),
    uniqueIndex('webhook_deliveries_org_account_hash_idx').on(
      table.orgId,
      table.courierAccountId,
      table.bodyHash,
    ),
    index('webhook_deliveries_org_received_idx').on(table.orgId, table.receivedAt),
    foreignKey({
      name: 'webhook_deliveries_org_id_courier_account_id_fk',
      columns: [table.orgId, table.courierAccountId],
      foreignColumns: [courierAccounts.orgId, courierAccounts.id],
    }).onDelete('restrict'),
  ],
);

/**
 * A parcel received back and inspected (M12's returns bullet, §7, §8).
 *
 * The inspection is the point: §7 sends sellable units and damaged units to the same
 * inventory account and *different locations*, and "writing them off is a separate step
 * that needs approval". So this row names both locations and its lines carry both
 * quantities, and nothing here writes stock — `INVENTORY_API.receiveCustomerReturn`
 * does, in the same transaction, which is what keeps the movements and the journal from
 * being two modules' opinions.
 *
 * One receipt per consignment, enforced by a unique index: a parcel is received once,
 * and a second receipt would put its units back on a shelf twice.
 */
export const returnReceipts = courier.table(
  'return_receipts',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    consignmentId: uuid('consignment_id').notNull(),
    orderId: uuid('order_id').notNull(),
    branchId: uuid('branch_id'),
    /** Where sellable units go back. */
    locationId: uuid('location_id').notNull(),
    /** Where damaged units go (§7's `damaged` location). Null when none were damaged. */
    damagedLocationId: uuid('damaged_location_id'),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull(),
    businessDate: date('business_date', { mode: 'string' }).notNull(),
    receivedBy: text('received_by').notNull(),
    /** §9 requires a reason on `→ returned`. */
    reason: text('reason').notNull(),
    inspectionNote: text('inspection_note'),
    /** §7's `Dr Inventory / Cr Goods in transit`. Null when the units cost nothing. */
    journalId: uuid('journal_id'),
    ...timestamps,
  },
  (table) => [
    unique('return_receipts_org_id_id_key').on(table.orgId, table.id),
    index('return_receipts_org_idx').on(table.orgId),
    uniqueIndex('return_receipts_org_consignment_idx').on(table.orgId, table.consignmentId),
    index('return_receipts_org_date_idx').on(table.orgId, table.businessDate),
    foreignKey({
      name: 'return_receipts_org_id_consignment_id_fk',
      columns: [table.orgId, table.consignmentId],
      foreignColumns: [consignments.orgId, consignments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'return_receipts_org_id_order_id_fk',
      columns: [table.orgId, table.orderId],
      foreignColumns: [orders.orgId, orders.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'return_receipts_org_id_location_id_fk',
      columns: [table.orgId, table.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'return_receipts_org_id_damaged_location_id_fk',
      columns: [table.orgId, table.damagedLocationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'return_receipts_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'return_receipts_org_id_journal_id_fk',
      columns: [table.orgId, table.journalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
  ],
);

/**
 * What came back, per SKU, split by the inspector's verdict.
 *
 * Quantities only — there is no cost column here, and that is not an omission. The
 * value a returned unit re-enters stock at is the cost its dispatch movement recorded
 * (§8), which lives on `sales.order_lines.dispatch_unit_cost_poisha`; copying it here
 * would put purchase cost in a place invariant 5 does not allow and would add a field
 * for a returns screen to leak to a role without `read:cost`.
 */
export const returnReceiptLines = courier.table(
  'return_receipt_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    receiptId: uuid('receipt_id').notNull(),
    skuId: uuid('sku_id').notNull(),
    sellableQty: integer('sellable_qty').notNull().default(0),
    damagedQty: integer('damaged_qty').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('return_receipt_lines_org_id_id_key').on(table.orgId, table.id),
    index('return_receipt_lines_org_idx').on(table.orgId),
    uniqueIndex('return_receipt_lines_receipt_sku_idx').on(
      table.orgId,
      table.receiptId,
      table.skuId,
    ),
    foreignKey({
      name: 'return_receipt_lines_org_id_receipt_id_fk',
      columns: [table.orgId, table.receiptId],
      foreignColumns: [returnReceipts.orgId, returnReceipts.id],
    }).onDelete('cascade'),
    check('return_receipt_lines_sellable_not_negative', sql`${table.sellableQty} >= 0`),
    check('return_receipt_lines_damaged_not_negative', sql`${table.damagedQty} >= 0`),
    // A line that received nothing is a line somebody left blank, and it would produce
    // a movement of zero units.
    check(
      'return_receipt_lines_received_something',
      sql`${table.sellableQty} + ${table.damagedQty} > 0`,
    ),
  ],
);

/**
 * One courier statement, imported (§9's settlement import; D-037).
 *
 * The two date columns are D-037 in a table. `settlement_date` is the courier's own
 * date and is **never** overwritten; `posting_business_date` is where the journals
 * actually landed, which differs whenever the statement's month was already closed.
 * One column carrying both would lose exactly the fact the decision exists to keep:
 * which month's cash a journal dated the first of the next month actually settled.
 *
 * Every `*_poisha` total is stored rather than recomputed on read, and this is the one
 * place in the schema where that is right: the file totals are what the courier
 * asserted, the matched totals are what we agreed to, and both are evidence in a
 * dispute. Recomputing them later would recompute them from our current data, which is
 * the thing under dispute.
 */
export const settlements = courier.table(
  'settlements',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    courierAccountId: uuid('courier_account_id').notNull(),
    courierId: uuid('courier_id').notNull(),
    branchId: uuid('branch_id'),
    /** The courier's own statement number, when it has one. */
    reference: text('reference'),
    /** D-037's reference field: the statement's own date, never rewritten. */
    settlementDate: date('settlement_date', { mode: 'string' }).notNull(),
    /** Where the journals posted. Null until posting. Equals `settlement_date` normally. */
    postingBusinessDate: date('posting_business_date', { mode: 'string' }),
    /** True when D-037 moved it forward out of a closed period. */
    deferredFromClosedPeriod: boolean('deferred_from_closed_period').notNull().default(false),

    status: settlementStatus('status').notNull().default('imported'),
    /** The uploaded sheet, purpose `settlement-sheet` (§22). */
    fileObjectId: uuid('file_object_id'),
    /** Where the net lands (§7's W). Fixed at import, so the checker sees it. */
    walletId: uuid('wallet_id').notNull(),

    /** What the courier's file said, in total, over every row. */
    fileGrossPoisha: bigint('file_gross_poisha', { mode: 'bigint' }).notNull(),
    fileChargesPoisha: bigint('file_charges_poisha', { mode: 'bigint' }).notNull(),
    fileNetPoisha: bigint('file_net_poisha', { mode: 'bigint' }).notNull(),
    fileRowCount: integer('file_row_count').notNull(),

    /** What matched, and therefore what posts. */
    matchedGrossPoisha: bigint('matched_gross_poisha', { mode: 'bigint' }).notNull(),
    matchedChargesPoisha: bigint('matched_charges_poisha', { mode: 'bigint' }).notNull(),
    matchedDeliveryChargesPoisha: bigint('matched_delivery_charges_poisha', {
      mode: 'bigint',
    }).notNull(),
    matchedReturnChargesPoisha: bigint('matched_return_charges_poisha', {
      mode: 'bigint',
    }).notNull(),
    matchedOtherChargesPoisha: bigint('matched_other_charges_poisha', {
      mode: 'bigint',
    }).notNull(),
    matchedNetPoisha: bigint('matched_net_poisha', { mode: 'bigint' }).notNull(),
    matchedRowCount: integer('matched_row_count').notNull(),
    exceptionCount: integer('exception_count').notNull(),

    /** The `settlement_posting` request. §9: approval before posting. */
    approvalRequestId: uuid('approval_request_id'),
    /** §7's "Courier charges (from settlement)". */
    chargesJournalId: uuid('charges_journal_id'),
    /** §7's "COD settlement received". */
    cashJournalId: uuid('cash_journal_id'),

    importedBy: text('imported_by').notNull(),
    postedAt: timestamp('posted_at', { withTimezone: true, mode: 'date' }),
    rejectedReason: text('rejected_reason'),
    /**
     * How the statement arrived: a person uploaded a file, or the fetch job asked the
     * courier's API (M15).
     */
    source: text('source').notNull().default('upload'),
    /**
     * sha256 of the fetched statement's canonical form (`canonicalStatement` in the domain),
     * for an API-fetched batch only.
     *
     * The unique index below is what makes the fetch idempotent: every scheduled fetch asks
     * again about a window it has already seen, and the second copy of a statement must
     * neither create a second batch nor — through that batch's approval — post twice. The
     * courier's own reference already has a unique index; this one holds for a statement
     * that carries none.
     */
    sourceFingerprint: text('source_fingerprint'),
    ...timestamps,
  },
  (table) => [
    unique('settlements_org_id_id_key').on(table.orgId, table.id),
    uniqueIndex('settlements_org_account_fingerprint_idx')
      .on(table.orgId, table.courierAccountId, table.sourceFingerprint)
      // A rejected batch releases its fingerprint: rejecting is how a person says "import this
      // again once the exceptions are fixed", and a rejected batch holding the key made the
      // statement unfetchable for good (M15 ledger audit M4).
      .where(sql`${table.sourceFingerprint} is not null and ${table.status} <> 'rejected'`),
    check('settlements_source', sql`${table.source} in ('upload', 'api')`),
    /*
     * An API batch always carries its fingerprint, and an upload never does. A fetched batch
     * without one would slip past the idempotency index; an upload with one would make a
     * person's re-upload of a corrected file collide with the fetch that found the first.
     */
    check(
      'settlements_fingerprint_iff_api',
      sql`(${table.source} = 'api') = (${table.sourceFingerprint} is not null)`,
    ),
    index('settlements_org_idx').on(table.orgId),
    index('settlements_org_courier_date_idx').on(
      table.orgId,
      table.courierId,
      table.settlementDate,
    ),
    index('settlements_org_status_idx').on(table.orgId, table.status),
    /*
     * One import per statement, when the courier numbers them.
     *
     * The commonest real mistake in this flow is importing the same sheet twice — two
     * accountants, one shared inbox — and without this the second import would match
     * nothing (every consignment already settled) but would still sit there as a batch
     * somebody might approve. Nulls are distinct by default, so an unnumbered statement
     * is not constrained, which is correct: those are matched by hand anyway.
     */
    uniqueIndex('settlements_org_courier_reference_idx')
      .on(table.orgId, table.courierAccountId, table.reference)
      // M15: rejected batches excluded, for the reason the fingerprint index gives.
      .where(sql`${table.reference} is not null and ${table.status} <> 'rejected'`),
    foreignKey({
      name: 'settlements_org_id_courier_account_id_fk',
      columns: [table.orgId, table.courierAccountId],
      foreignColumns: [courierAccounts.orgId, courierAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'settlements_org_id_courier_id_fk',
      columns: [table.orgId, table.courierId],
      foreignColumns: [couriers.orgId, couriers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'settlements_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'settlements_org_id_wallet_id_fk',
      columns: [table.orgId, table.walletId],
      foreignColumns: [walletAccounts.orgId, walletAccounts.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'settlements_org_id_file_object_id_fk',
      columns: [table.orgId, table.fileObjectId],
      foreignColumns: [fileObjects.orgId, fileObjects.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'settlements_org_id_approval_request_id_fk',
      columns: [table.orgId, table.approvalRequestId],
      foreignColumns: [approvalRequests.orgId, approvalRequests.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'settlements_org_id_charges_journal_id_fk',
      columns: [table.orgId, table.chargesJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'settlements_org_id_cash_journal_id_fk',
      columns: [table.orgId, table.cashJournalId],
      foreignColumns: [journals.orgId, journals.id],
    }).onDelete('restrict'),
    check(
      'settlements_row_counts_sane',
      sql`${table.fileRowCount} >= 0
        and ${table.matchedRowCount} >= 0
        and ${table.exceptionCount} >= 0
        and ${table.matchedRowCount} + ${table.exceptionCount} = ${table.fileRowCount}`,
    ),
    /*
     * The matched charges have to add up to their own breakdown.
     *
     * Three columns and their total is one column too many, and the reason to keep it
     * is §7: the charges journal debits Courier charges with delivery + other and
     * Return charges with returns, so the breakdown *is* the journal. A total that
     * disagreed with its parts would post a journal that balanced and split the expense
     * wrongly between two P&L lines, which no report would flag.
     */
    check(
      'settlements_charges_add_up',
      sql`${table.matchedChargesPoisha} = ${table.matchedDeliveryChargesPoisha} + ${table.matchedReturnChargesPoisha} + ${table.matchedOtherChargesPoisha}`,
    ),
    /** Gross = charges + net, over the matched rows. The identity check 5 rests on. */
    check(
      'settlements_matched_gross_is_charges_plus_net',
      sql`${table.matchedGrossPoisha} = ${table.matchedChargesPoisha} + ${table.matchedNetPoisha}`,
    ),
    check(
      'settlements_no_backdating',
      sql`${table.postingBusinessDate} is null or ${table.postingBusinessDate} >= ${table.settlementDate}`,
    ),
    check(
      'settlements_deferred_has_later_date',
      sql`${table.deferredFromClosedPeriod} = false
          or ${table.postingBusinessDate} is null
          or ${table.postingBusinessDate} > ${table.settlementDate}`,
    ),
    /*
     * Posted means posted: a date, a time, and at least one journal.
     *
     * §9 requires approval before posting, and a row marked `posted` with no journal is
     * how that requirement would quietly stop being true — the screen would show the
     * batch as done and the books would not have moved.
     */
    check(
      'settlements_posted_has_journal',
      sql`${table.status} <> 'posted'
          or (${table.postedAt} is not null
              and ${table.postingBusinessDate} is not null
              and (${table.chargesJournalId} is not null or ${table.cashJournalId} is not null))`,
    ),
    check(
      'settlements_rejected_has_reason',
      sql`${table.status} <> 'rejected' or ${table.rejectedReason} is not null`,
    ),
  ],
);

/**
 * One row of a courier's statement, with what the matcher made of it (§9).
 *
 * The exceptions report is `where match <> 'matched'` over this table, which is why the
 * verdict and the note are columns rather than something computed at read time: an
 * exception a person cleared last week has to still say what it said then, and a
 * verdict recomputed against today's data would silently reclassify itself the moment
 * the underlying consignment changed.
 */
export const settlementLines = courier.table(
  'settlement_lines',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    settlementId: uuid('settlement_id').notNull(),
    /** 1-based, so an exception can be found in the sheet a person is holding. */
    rowNo: integer('row_no').notNull(),
    consignmentNo: text('consignment_no').notNull(),
    /** Our reference as the file echoed it. */
    reference: text('reference'),
    match: settlementMatch('match').notNull(),
    consignmentId: uuid('consignment_id'),
    orderId: uuid('order_id'),

    codCollectedPoisha: bigint('cod_collected_poisha', { mode: 'bigint' }).notNull(),
    deliveryChargePoisha: bigint('delivery_charge_poisha', { mode: 'bigint' }).notNull(),
    returnChargePoisha: bigint('return_charge_poisha', { mode: 'bigint' }).notNull(),
    otherChargePoisha: bigint('other_charge_poisha', { mode: 'bigint' }).notNull(),
    /** Collection minus every charge. Negative on a returned parcel, which is fine. */
    netPoisha: bigint('net_poisha', { mode: 'bigint' }).notNull(),
    /** What our books expect for this consignment. Null when we found no consignment. */
    expectedPoisha: bigint('expected_poisha', { mode: 'bigint' }),
    /** Why it is an exception, in words an accountant can act on. Null when matched. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('settlement_lines_org_id_id_key').on(table.orgId, table.id),
    index('settlement_lines_org_idx').on(table.orgId),
    uniqueIndex('settlement_lines_settlement_row_idx').on(
      table.orgId,
      table.settlementId,
      table.rowNo,
    ),
    /** The exceptions report. Partial, because most rows are not exceptions. */
    index('settlement_lines_org_exceptions_idx')
      .on(table.orgId, table.settlementId)
      .where(sql`${table.match} <> 'matched'`),
    foreignKey({
      name: 'settlement_lines_org_id_settlement_id_fk',
      columns: [table.orgId, table.settlementId],
      foreignColumns: [settlements.orgId, settlements.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'settlement_lines_org_id_consignment_id_fk',
      columns: [table.orgId, table.consignmentId],
      foreignColumns: [consignments.orgId, consignments.id],
    }).onDelete('restrict'),
    check('settlement_lines_row_no_positive', sql`${table.rowNo} > 0`),
    check(
      'settlement_lines_charges_not_negative',
      sql`${table.deliveryChargePoisha} >= 0 and ${table.returnChargePoisha} >= 0 and ${table.otherChargePoisha} >= 0`,
    ),
    check('settlement_lines_cod_not_negative', sql`${table.codCollectedPoisha} >= 0`),
    /** The row's own arithmetic, so a bad importer cannot write an inconsistent row. */
    check(
      'settlement_lines_net_is_gross_less_charges',
      sql`${table.netPoisha} = ${table.codCollectedPoisha} - ${table.deliveryChargePoisha} - ${table.returnChargePoisha} - ${table.otherChargePoisha}`,
    ),
    check(
      'settlement_lines_matched_has_consignment',
      sql`${table.match} <> 'matched' or (${table.consignmentId} is not null and ${table.orderId} is not null)`,
    ),
    check(
      'settlement_lines_exception_has_note',
      sql`${table.match} = 'matched' or ${table.note} is not null`,
    ),
  ],
);

/**
 * Zone → courier rules (M15; §9 "Delivery zones and charges").
 *
 * §9 gives each zone one default courier. These rules refine it: a COD band, a failover
 * order, a zone-specific exception. `selectCourier` in the domain reads them in priority
 * order and takes the first whose conditions match and whose courier can book — so two
 * rules for one zone at different priorities is the failover, not a conflict.
 *
 * Configuration, not evidence, and the one table in this schema a row may be deleted from:
 * the set is replaced as a whole when an operator saves it, and the audit row written with
 * that save records the whole set before and after. Keeping superseded rules as rows would
 * leave a table whose `is_active` meant two different things.
 */
export const selectionRules = courier.table(
  'selection_rules',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    /** Lower first. */
    priority: integer('priority').notNull(),
    /** Null matches every zone. */
    deliveryZoneId: uuid('delivery_zone_id'),
    /** Inclusive bounds on the parcel's COD. Null means unbounded on that side. */
    minCodPoisha: bigint('min_cod_poisha', { mode: 'bigint' }),
    maxCodPoisha: bigint('max_cod_poisha', { mode: 'bigint' }),
    /** M10's party row, the courier this rule sends parcels with. */
    courierId: uuid('courier_id').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Why the rule exists, for the next person who wonders. */
    note: text('note'),
    createdBy: text('created_by').notNull(),
    ...timestamps,
  },
  (table) => [
    unique('selection_rules_org_id_id_key').on(table.orgId, table.id),
    index('selection_rules_org_idx').on(table.orgId),
    index('selection_rules_org_priority_idx').on(table.orgId, table.priority),
    foreignKey({
      name: 'selection_rules_org_id_delivery_zone_id_fk',
      columns: [table.orgId, table.deliveryZoneId],
      foreignColumns: [deliveryZones.orgId, deliveryZones.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'selection_rules_org_id_courier_id_fk',
      columns: [table.orgId, table.courierId],
      foreignColumns: [couriers.orgId, couriers.id],
    }).onDelete('restrict'),
    check('selection_rules_priority_range', sql`${table.priority} between 0 and 10000`),
    check(
      'selection_rules_cod_not_negative',
      sql`(${table.minCodPoisha} is null or ${table.minCodPoisha} >= 0) and (${table.maxCodPoisha} is null or ${table.maxCodPoisha} >= 0)`,
    ),
    /*
     * A band whose bounds are reversed matches nothing, and the parcel falls through to the
     * zone default — which looks exactly like the rule working. Refused at the row.
     */
    check(
      'selection_rules_cod_band_ordered',
      sql`${table.minCodPoisha} is null or ${table.maxCodPoisha} is null or ${table.minCodPoisha} <= ${table.maxCodPoisha}`,
    ),
  ],
);

/**
 * A note a person added while chasing a stuck parcel (M15's escalation note).
 *
 * Append-only: "called Pathao's hub on the 12th, they say it is at Mirpur" is a record of
 * what somebody did, and the value of the trail is that it cannot be tidied afterwards —
 * which is also what a courier dispute about a missing COD is settled with.
 */
export const consignmentEscalations = courier.table(
  'consignment_escalations',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    consignmentId: uuid('consignment_id').notNull(),
    note: text('note').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('consignment_escalations_org_id_id_key').on(table.orgId, table.id),
    index('consignment_escalations_org_idx').on(table.orgId),
    index('consignment_escalations_org_consignment_idx').on(
      table.orgId,
      table.consignmentId,
      table.createdAt,
    ),
    foreignKey({
      name: 'consignment_escalations_org_id_consignment_id_fk',
      columns: [table.orgId, table.consignmentId],
      foreignColumns: [consignments.orgId, consignments.id],
    }).onDelete('restrict'),
    check(
      'consignment_escalations_note_length',
      sql`char_length(${table.note}) between 1 and 1000`,
    ),
  ],
);

/**
 * One run of the settlement fetch for one courier account (M15).
 *
 * The fetch runs unattended, so a statement it could not import — nothing matched, charges
 * above collections, a reference already imported with different rows — has no person
 * looking at a screen to tell. This row is where it says so: one per run, append-only,
 * listing every statement it saw and what became of it. Without it a refused statement
 * would simply not exist anywhere, which for a statement is money in the bank that the
 * books never hear about.
 */
export const settlementFetchRuns = courier.table(
  'settlement_fetch_runs',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    courierAccountId: uuid('courier_account_id').notNull(),
    /** The window asked about, from this Asia/Dhaka date. */
    sinceDate: date('since_date', { mode: 'string' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }).notNull(),
    statementsSeen: integer('statements_seen').notNull(),
    statementsCreated: integer('statements_created').notNull(),
    statementsDuplicate: integer('statements_duplicate').notNull(),
    statementsRefused: integer('statements_refused').notNull(),
    /** One entry per statement: reference, fingerprint, outcome, code, settlement id. */
    outcomes: jsonb('outcomes').notNull().default([]),
    /** The run itself failed — the courier did not answer. Never a courier's raw body. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('settlement_fetch_runs_org_id_id_key').on(table.orgId, table.id),
    index('settlement_fetch_runs_org_idx').on(table.orgId),
    index('settlement_fetch_runs_org_account_idx').on(
      table.orgId,
      table.courierAccountId,
      table.startedAt,
    ),
    foreignKey({
      name: 'settlement_fetch_runs_org_id_courier_account_id_fk',
      columns: [table.orgId, table.courierAccountId],
      foreignColumns: [courierAccounts.orgId, courierAccounts.id],
    }).onDelete('restrict'),
    check(
      'settlement_fetch_runs_counts_add_up',
      sql`${table.statementsSeen} >= 0 and ${table.statementsCreated} >= 0
        and ${table.statementsDuplicate} >= 0 and ${table.statementsRefused} >= 0
        and ${table.statementsCreated} + ${table.statementsDuplicate} + ${table.statementsRefused} = ${table.statementsSeen}`,
    ),
  ],
);
