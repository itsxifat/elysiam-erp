import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from '../columns.js';
import { organizations } from '../org/index.js';

/**
 * Fraud signals (architecture §5 exception 1, §10; M13).
 *
 * ## This schema holds the system's only deliberate cross-org tables
 *
 * Every other table in this repository carries `org_id` and FORCE RLS, and that is
 * invariant 4. Two tables here do not, by design: `fraud.phone_signals` and
 * `fraud.provider_checks`. A buyer who takes delivery of an Oura parcel and refuses
 * the identical Orvo one is one person doing one thing, and five brands each
 * discovering it separately is five brands each paying for it. So the counts are
 * shared. They are listed in `GLOBAL_TABLES` in `packages/db/src/rls.ts`, which is
 * what stops M01's tenancy guard treating them as an oversight.
 *
 * The safety of that exception is not a policy — it is the **column list**. These
 * two tables can hold counters, an HMAC and a timestamp, and there is nowhere in
 * them for an order number, a customer name, an address, an amount, a brand or a
 * user id to be stored. An org reading them therefore learns "this number has
 * eleven completed orders and four came back" and cannot learn whose. A policy can
 * be widened in a migration nobody reads closely; a column that does not exist
 * cannot leak.
 *
 * The phone itself is never here either. The key is `HMAC-SHA256(server_secret,
 * e164)` (§10), computed by `apps/server/src/modules/fraud/phone-hash.ts`. A plain
 * SHA-256 of an eleven-digit number is not a hash at all — the whole Bangladeshi
 * mobile space is about a billion candidates, which a laptop enumerates in
 * minutes — so the key is what makes a stolen backup of this table useless.
 *
 * ## The four tenant tables, and why the cross-org ones are not enough
 *
 * `rules`, `phone_flags`, `overrides` and `order_phones` are ordinary tenant tables
 * with `org_id` and FORCE RLS (migration 0046). They hold the parts that are
 * genuinely one brand's business: its band thresholds, the *reason* an agent wrote
 * when flagging a number, the *reason* an org_admin wrote when overriding a block,
 * and which of its own orders was assessed against which hash.
 *
 * That split is the design rather than a convenience. `phone_signals.manual_flags`
 * carries only `{at, severity}` per flag — enough for the score, and no more —
 * because the text an Elysium agent typed about a buyer is Elysium's and must not
 * appear in Oura's badge. The same buyer, the same hash, two different amounts of
 * detail depending on who is asking.
 */
export const fraud = pgSchema('fraud');

/**
 * The 64 lowercase hex characters of an HMAC-SHA256, and nothing else.
 *
 * Checked in the database rather than only in the service because this column is the
 * identity of a row that five orgs write to. A truncated or upper-cased hash
 * silently becomes a *second* person: the counts split across two rows, both look
 * plausible, and the badge reads "new customer" for somebody with nine returns.
 * There is no way to detect that afterwards, because the input cannot be recovered
 * to compare.
 */
const HASH_PATTERN = "~ '^[0-9a-f]{64}$'";

/**
 * What every brand knows about one phone number, together (§10, §5 exception 1).
 *
 * Maintained from order events, not computed on read: the desk must render the badge
 * inside 300 ms (§10, check 4) and the honest `count(*)` version would scan every
 * order every brand ever took for that buyer. The counters are the cache and the
 * order events are the source, so a rebuild is always possible from
 * `sales.order_events` per org.
 *
 * `orders_total` counts orders that reached **confirmed**, not carts. A pending order
 * abandoned before the desk pressed confirm says nothing about whether somebody pays
 * for parcels, and counting it would let a competitor lower a buyer's score by
 * filling in a landing-page form ten times.
 */
export const phoneSignals = fraud.table(
  'phone_signals',
  {
    /** `HMAC-SHA256(server_secret, e164)`. The only form the number exists in here. */
    phoneHash: text('phone_hash').primaryKey(),
    ordersTotal: integer('orders_total').notNull().default(0),
    delivered: integer('delivered').notNull().default(0),
    returned: integer('returned').notNull().default(0),
    cancelled: integer('cancelled').notNull().default(0),
    /** The most recent return or cancellation in any brand. Drives the recency penalty. */
    lastIncidentAt: timestamp('last_incident_at', { withTimezone: true, mode: 'date' }),
    /**
     * One entry per standing manual flag: `{"at": "…", "severity": 1}`.
     *
     * Aggregate only. The reason text and the agent who wrote it stay in
     * `fraud.phone_flags`, which is tenant-scoped — an org reading this array learns
     * that somebody, somewhere, flagged the number, which is all the score needs.
     * The count is `jsonb_array_length(manual_flags)` rather than a second column,
     * so there is one source of truth and no counter to drift.
     */
    manualFlags: jsonb('manual_flags')
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check('phone_signals_hash_shape', sql`${table.phoneHash} ${sql.raw(HASH_PATTERN)}`),
    // Counters are only ever incremented by an event that happened, so a negative
    // value means the maintenance path double-decremented — which would raise the
    // score of the buyer it was supposed to lower.
    check(
      'phone_signals_counts_non_negative',
      sql`${table.ordersTotal} >= 0 and ${table.delivered} >= 0 and ${table.returned} >= 0 and ${table.cancelled} >= 0`,
    ),
    check('phone_signals_flags_is_array', sql`jsonb_typeof(${table.manualFlags}) = 'array'`),
  ],
);

/**
 * One provider's cached answer for one phone (§10, §5 exception 1).
 *
 * Keyed by `(phone_hash, provider)` so a second provider is a row rather than a
 * migration. `fetched_at` is the TTL clock — 72 hours by default (§10) — and it is a
 * column rather than an in-process cache because the desk is served by several API
 * instances and a per-process map would mean one throttle budget per replica.
 *
 * `raw` holds the **numbers the provider sent and nothing else**. The adapter strips
 * its response to scalars before it gets here, which is not tidiness: this table is
 * readable by every org, so a provider that started returning a name or an address
 * would otherwise put one brand's customer detail in front of the other four. It is
 * never selected into an API response by any route.
 */
export const providerChecks = fraud.table(
  'provider_checks',
  {
    phoneHash: text('phone_hash').notNull(),
    /** `steadfast`, and whatever §10's "others" turns out to be. */
    provider: text('provider').notNull(),
    total: integer('total').notNull().default(0),
    delivered: integer('delivered').notNull().default(0),
    returnedOrCancelled: integer('returned_or_cancelled').notNull().default(0),
    /**
     * The delivery ratio as the provider reports it, or computed from its counts
     * when it reports only counts.
     *
     * Stored rather than always derived because some providers publish a ratio that
     * is not `delivered / total` — they exclude in-flight parcels — and recomputing
     * it would quietly contradict the number the provider's own dashboard shows,
     * which is the number a supervisor will read out on the phone.
     */
    ratio: numeric('ratio', { precision: 5, scale: 4 }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    raw: jsonb('raw'),
  },
  (table) => [
    primaryKey({ columns: [table.phoneHash, table.provider] }),
    check('provider_checks_hash_shape', sql`${table.phoneHash} ${sql.raw(HASH_PATTERN)}`),
    check(
      'provider_checks_counts_non_negative',
      sql`${table.total} >= 0 and ${table.delivered} >= 0 and ${table.returnedOrCancelled} >= 0`,
    ),
    check(
      'provider_checks_ratio_range',
      sql`${table.ratio} is null or (${table.ratio} >= 0 and ${table.ratio} <= 1)`,
    ),
    // The staleness sweep asks "which rows are older than the TTL", which is the
    // whole table without this.
    index('provider_checks_fetched_at_idx').on(table.fetchedAt),
  ],
);

/**
 * One org's score bands (D-011), plus how it wants providers used.
 *
 * One row per org — `unique(org_id)` — because a second row would make "what does
 * this brand block at" a question with two answers and no tie-breaker. An org with
 * no row gets D-011's defaults from the domain, so the table is configuration rather
 * than a prerequisite: fraud checking works on a fresh org before anybody opens the
 * settings screen.
 */
export const fraudRules = fraud.table(
  'rules',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    allowMin: smallint('allow_min').notNull().default(70),
    warnMin: smallint('warn_min').notNull().default(40),
    requireAdvanceMin: smallint('require_advance_min').notNull().default(20),
    /**
     * Whether this org pays for provider lookups.
     *
     * Per org rather than global because the lookups are metered and the five brands
     * are five companies with five budgets. Off means the score is internal-only and
     * says so on the badge — the same path check 3's timeout takes, which is why
     * there is one code for both.
     */
    providerEnabled: boolean('provider_enabled').notNull().default(false),
    /**
     * How long a provider answer is trusted, in minutes. §10's default is 72 hours.
     *
     * Per org for the same reason as the switch: a brand that checks a thousand
     * numbers a day and one that checks twenty do not want the same bill, and the
     * only lever on a metered lookup is how long the last one counts for.
     */
    providerTtlMinutes: integer('provider_ttl_minutes').notNull().default(4320),
    ...timestamps,
  },
  (table) => [
    unique('rules_org_id_key').on(table.orgId),
    unique('rules_org_id_id_key').on(table.orgId, table.id),
    // The same rule `assertBands` enforces in the domain, in the database, because a
    // row written by a future admin screen or a migration would otherwise be able to
    // delete a band: `warn_min = allow_min` reads as configured and behaves as never.
    check(
      'rules_bands_decrease',
      sql`${table.allowMin} > ${table.warnMin} and ${table.warnMin} > ${table.requireAdvanceMin}`,
    ),
    check(
      'rules_bands_in_range',
      sql`${table.allowMin} <= 100 and ${table.requireAdvanceMin} >= 0`,
    ),
    check('rules_provider_ttl_positive', sql`${table.providerTtlMinutes} > 0`),
  ],
);

/**
 * A hand-written flag against a phone number, with the reason and the author (§10).
 *
 * Tenant-scoped on purpose. The *fact* of a flag crosses orgs, through
 * `phone_signals.manual_flags`; the sentence an agent typed does not. "Abused our
 * delivery rider" is a note about a person written by one company, and putting it in
 * a table every brand can read would make this schema the thing it was built to
 * avoid.
 *
 * Cleared rather than deleted. A flag that turned out to be wrong is part of why a
 * buyer was blocked for a fortnight, and the row is the only record of that.
 */
export const phoneFlags = fraud.table(
  'phone_flags',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    phoneHash: text('phone_hash').notNull(),
    /** 1 today. Room for a graded flag without a migration. */
    severity: smallint('severity').notNull().default(1),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    clearedAt: timestamp('cleared_at', { withTimezone: true, mode: 'date' }),
    clearedBy: text('cleared_by'),
    clearedReason: text('cleared_reason'),
    ...timestamps,
  },
  (table) => [
    unique('phone_flags_org_id_id_key').on(table.orgId, table.id),
    // The lookup path reads "does this org have a standing flag on this hash", which
    // is asked on every confirm.
    index('phone_flags_org_hash_idx').on(table.orgId, table.phoneHash),
    check('phone_flags_hash_shape', sql`${table.phoneHash} ${sql.raw(HASH_PATTERN)}`),
    check('phone_flags_reason_length', sql`length(${table.reason}) between 3 and 500`),
    check('phone_flags_severity_range', sql`${table.severity} between 1 and 3`),
    // Cleared is all three columns or none: a `cleared_at` with no author is a flag
    // that stopped applying and nobody is answerable for it.
    check(
      'phone_flags_cleared_together',
      sql`(${table.clearedAt} is null and ${table.clearedBy} is null and ${table.clearedReason} is null)
        or (${table.clearedAt} is not null and ${table.clearedBy} is not null and ${table.clearedReason} is not null)`,
    ),
  ],
);

/**
 * An org_admin's override of a `block`, with the reason (M13 check 5, §10).
 *
 * Append-only, and there is a trigger in 0047 as well as the absent grant. This row
 * is the evidence that somebody with the authority to do it decided to sell to a
 * buyer the system refused — which is exactly the record that becomes interesting
 * when the parcel comes back. A row that could be edited afterwards would be worth
 * nothing.
 *
 * The audit log gets the same fact through `AuditService.record` in the same
 * transaction. Both, not either: the audit log is the one place a reviewer looks for
 * "who did what", and this table is what the order desk and the fraud report read
 * without needing `read AuditLog`.
 *
 * No foreign key to `sales.orders`, deliberately. Invariant 12 keeps modules out of
 * each other's tables, and a constraint is a dependency the schema cannot opt out
 * of: it would mean this module's migrations could not be applied without the orders
 * module's, and a fraud test would need an order desk to make a row.
 */
export const fraudOverrides = fraud.table(
  'overrides',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    phoneHash: text('phone_hash').notNull(),
    /** The score as it stood when the override was given. Frozen, not looked up later. */
    trustScore: smallint('trust_score').notNull(),
    reason: text('reason').notNull(),
    decidedBy: text('decided_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    unique('overrides_org_id_id_key').on(table.orgId, table.id),
    index('overrides_org_order_idx').on(table.orgId, table.orderId),
    check('overrides_hash_shape', sql`${table.phoneHash} ${sql.raw(HASH_PATTERN)}`),
    check('overrides_reason_length', sql`length(${table.reason}) between 10 and 500`),
    check('overrides_score_range', sql`${table.trustScore} between 0 and 100`),
  ],
);

/**
 * Which hash one of this org's orders was assessed against (M13).
 *
 * The reason this table exists is invariant 12. `phone_signals` is maintained from
 * order events, and an order event carries an id and a status — never a phone
 * number, because §19 forbids a payload field no recipient needs and a phone number
 * in a socket payload is a privacy leak. So the subscriber has to get from an order
 * id to a hash, and the two ways to do that are reading `sales.orders` (another
 * module's table, which invariant 12 forbids) or keeping this row.
 *
 * It is written by the confirm guard, which sees the phone anyway because it is
 * scoring it. That has a consequence worth stating: an order that never reached the
 * guard has no row here and contributes nothing to the counters. That is the right
 * behaviour rather than a gap — `orders_total` counts confirmed orders, and an order
 * nobody confirmed says nothing about whether the buyer pays for parcels.
 */
export const orderPhones = fraud.table(
  'order_phones',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id').notNull(),
    phoneHash: text('phone_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.orderId] }),
    check('order_phones_hash_shape', sql`${table.phoneHash} ${sql.raw(HASH_PATTERN)}`),
  ],
);
