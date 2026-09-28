import { sql } from 'drizzle-orm';
import type { Tx } from '@elysium/db';

/**
 * Every statement that touches the `fraud` schema (architecture §5, §10).
 *
 * Raw parameterised SQL in a repository, as `.claude/rules` requires. Two things here
 * are unlike every other repository in this codebase and both are worth naming:
 *
 * 1. **Two of these tables have no `org_id`.** `phone_signals` and `provider_checks`
 *    are §5's first cross-org exception. The statements against them therefore have no
 *    org predicate, deliberately — adding one would be a tenant filter on a table with
 *    nothing to filter, and the isolation that matters is the column list in migration
 *    0045, which has nowhere to put anything that identifies a brand or a buyer.
 * 2. **Every call still runs inside `withOrg()`.** Not because the cross-org tables
 *    need it, but because the same transaction also writes `order_phones`, `overrides`
 *    and the audit row — and those are tenant tables. Reaching the cross-org tables
 *    through the *analytics* role instead would be wrong twice over: invariant 4 says
 *    only the analytics module uses it, and it cannot write.
 *
 * The one read the whole milestone is judged on is `readSignals`: it returns counts and
 * timestamps. There is no select in this file that can return an order, a customer, a
 * name or an amount belonging to another org, because there is no column holding one.
 */

/**
 * A timestamp column, as a `Date`.
 *
 * `tx.execute` with a raw `sql` template hands back what the driver decoded, and for
 * `timestamptz` that is a string rather than a `Date` — unlike a Drizzle query builder
 * read, which applies the column's mode. Every date leaving this file goes through here,
 * because the failure without it is `lastIncidentAt.getTime is not a function` deep inside
 * the pure score function, which is the last place anybody would look for a driver detail.
 */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/** The same, for a column that is `not null`. */
function requireDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The cross-org counters for one hash, as the score wants them. */
export interface SignalRow {
  readonly ordersTotal: number;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  readonly lastIncidentAt: Date | null;
  readonly manualFlagCount: number;
  readonly updatedAt: Date;
}

/**
 * Read one hash's cross-org counters.
 *
 * Returns `null` for a number nobody has seen, rather than a row of zeroes. The two are
 * different facts and the score says different things about them — "no history" versus
 * "history, all of it empty" — and a zero row would also mean a `select` that creates
 * data, which is the sort of thing that turns a read endpoint into a write.
 *
 * `manual_flag_count` is derived from the jsonb array rather than stored beside it, so
 * there is one source of truth and no counter to drift out of step with the flags it
 * counts.
 */
export async function readSignals(tx: Tx, phoneHash: string): Promise<SignalRow | null> {
  const rows = await tx.execute<{
    orders_total: number;
    delivered: number;
    returned: number;
    cancelled: number;
    last_incident_at: Date | string | null;
    manual_flag_count: number;
    updated_at: Date | string;
  }>(sql`
    select
      orders_total,
      delivered,
      returned,
      cancelled,
      last_incident_at,
      jsonb_array_length(manual_flags) as manual_flag_count,
      updated_at
    from fraud.phone_signals
    where phone_hash = ${phoneHash}
  `);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    ordersTotal: Number(row.orders_total),
    delivered: Number(row.delivered),
    returned: Number(row.returned),
    cancelled: Number(row.cancelled),
    lastIncidentAt: toDate(row.last_incident_at),
    manualFlagCount: Number(row.manual_flag_count),
    updatedAt: requireDate(row.updated_at),
  };
}

export interface ProviderCheckRow {
  readonly provider: string;
  readonly total: number;
  readonly delivered: number;
  readonly returnedOrCancelled: number;
  readonly fetchedAt: Date;
}

/**
 * Cached provider answers for one hash that are still inside the TTL.
 *
 * The TTL is applied in SQL rather than in TypeScript so a stale row is simply not
 * returned. Filtering after the fact is the shape where somebody later reads the array
 * without the filter, and a three-month-old provider answer presented as current is
 * worse than none.
 *
 * `raw` is not selected. It exists for a human debugging a disagreement with a
 * provider, and nothing that serves a request has any use for it — see the note on the
 * column in migration 0045.
 */
export async function readProviderChecks(
  tx: Tx,
  phoneHash: string,
  ttlMinutes: number,
): Promise<ProviderCheckRow[]> {
  const rows = await tx.execute<{
    provider: string;
    total: number;
    delivered: number;
    returned_or_cancelled: number;
    fetched_at: Date | string;
  }>(sql`
    select provider, total, delivered, returned_or_cancelled, fetched_at
    from fraud.provider_checks
    where phone_hash = ${phoneHash}
      and fetched_at > now() - make_interval(mins => ${ttlMinutes}::int)
    order by provider
  `);

  return [...rows].map((row) => ({
    provider: row.provider,
    total: Number(row.total),
    delivered: Number(row.delivered),
    returnedOrCancelled: Number(row.returned_or_cancelled),
    fetchedAt: requireDate(row.fetched_at),
  }));
}

/** Store or refresh one provider's answer. `fetched_at` moving is what restarts the TTL. */
export async function upsertProviderCheck(
  tx: Tx,
  input: {
    readonly phoneHash: string;
    readonly provider: string;
    readonly total: number;
    readonly delivered: number;
    readonly returnedOrCancelled: number;
    readonly ratio: number | null;
    readonly raw: Readonly<Record<string, number | boolean | string>>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into fraud.provider_checks (
      phone_hash, provider, total, delivered, returned_or_cancelled, ratio, fetched_at, raw
    ) values (
      ${input.phoneHash}, ${input.provider}, ${input.total}, ${input.delivered},
      ${input.returnedOrCancelled}, ${input.ratio}, now(), ${JSON.stringify(input.raw)}::jsonb
    )
    on conflict (phone_hash, provider) do update set
      total = excluded.total,
      delivered = excluded.delivered,
      returned_or_cancelled = excluded.returned_or_cancelled,
      ratio = excluded.ratio,
      fetched_at = excluded.fetched_at,
      raw = excluded.raw
  `);
}

/**
 * What an order outcome does to the cross-org counters.
 *
 * `confirmed` is the only one that moves `orders_total`: an order nobody confirmed says
 * nothing about whether the buyer pays for parcels, and counting pending ones would let
 * anybody lower a stranger's score by filling in a landing-page form ten times.
 */
export type OrderOutcome = 'confirmed' | 'delivered' | 'returned' | 'cancelled';

/**
 * Apply one order outcome to a hash's counters, creating the row if needed.
 *
 * A single `insert … on conflict do update` rather than a read then a write. Five orgs'
 * workers write this row and the dispatcher delivers at least once, so two concurrent
 * updates for the same buyer are ordinary rather than exotic — and read-then-write would
 * lose one of them silently, which is the same shape invariant 3 forbids for stock.
 * Postgres serialises the conflicting insert, so `delivered = phone_signals.delivered + 1`
 * is computed against the committed value.
 *
 * `last_incident_at` moves only for a return or a cancellation, and only forwards:
 * `greatest(…)` so a redelivered event from a week ago cannot make an old incident look
 * recent. `at` is the event's own instant rather than `now()` for the same reason — the
 * recency penalty should describe when the parcel came back, not when the worker got
 * round to it.
 */
export async function applyOrderOutcome(
  tx: Tx,
  input: { readonly phoneHash: string; readonly outcome: OrderOutcome; readonly at: Date },
): Promise<void> {
  const isIncident = input.outcome === 'returned' || input.outcome === 'cancelled';
  /*
   * ISO string with an explicit cast, not a `Date`. postgres.js refuses a Date as a bind
   * parameter through drizzle's `sql` template — it wants a string or a Buffer — and the
   * failure is a `TypeError` from deep inside the driver rather than anything that names
   * the column. Every other repository in this codebase does the same (`orders.repository`
   * line 979); the cast is what keeps the comparison a timestamptz one rather than a text
   * one.
   */
  const at = input.at.toISOString();

  await tx.execute(sql`
    insert into fraud.phone_signals (
      phone_hash, orders_total, delivered, returned, cancelled, last_incident_at, updated_at
    ) values (
      ${input.phoneHash},
      ${input.outcome === 'confirmed' ? 1 : 0},
      ${input.outcome === 'delivered' ? 1 : 0},
      ${input.outcome === 'returned' ? 1 : 0},
      ${input.outcome === 'cancelled' ? 1 : 0},
      ${isIncident ? sql`${at}::timestamptz` : sql`null`},
      now()
    )
    on conflict (phone_hash) do update set
      orders_total = fraud.phone_signals.orders_total + ${input.outcome === 'confirmed' ? 1 : 0},
      delivered = fraud.phone_signals.delivered + ${input.outcome === 'delivered' ? 1 : 0},
      returned = fraud.phone_signals.returned + ${input.outcome === 'returned' ? 1 : 0},
      cancelled = fraud.phone_signals.cancelled + ${input.outcome === 'cancelled' ? 1 : 0},
      last_incident_at = ${
        isIncident
          ? sql`greatest(fraud.phone_signals.last_incident_at, ${at}::timestamptz)`
          : sql`fraud.phone_signals.last_incident_at`
      },
      updated_at = now()
  `);
}

/**
 * Add or remove one aggregate entry in `manual_flags`.
 *
 * The array holds `{at, severity}` and nothing else — no org, no author, no reason —
 * because it is read by four brands that did not write it. Removing is by position of
 * the first matching entry rather than by an id, because there is no id: an id would be
 * a key back to the tenant row, which is the correlation this design exists to prevent.
 */
export async function adjustManualFlags(
  tx: Tx,
  input: {
    readonly phoneHash: string;
    readonly direction: 'add' | 'remove';
    readonly severity: number;
    readonly at: Date;
  },
): Promise<void> {
  if (input.direction === 'add') {
    const entry = JSON.stringify({ at: input.at.toISOString(), severity: input.severity });
    await tx.execute(sql`
      insert into fraud.phone_signals (phone_hash, manual_flags, updated_at)
      values (${input.phoneHash}, jsonb_build_array(${entry}::jsonb), now())
      on conflict (phone_hash) do update set
        manual_flags = fraud.phone_signals.manual_flags || jsonb_build_array(${entry}::jsonb),
        updated_at = now()
    `);
    return;
  }

  /*
   * Remove the first entry of this severity, keeping the rest in order.
   *
   * `- index` on a jsonb array needs the position, which is why this is a subquery
   * rather than a `-` on a value: two flags raised in the same millisecond with the same
   * severity are identical as values, so removing "the value" would remove both and one
   * org clearing its flag would clear another's.
   */
  await tx.execute(sql`
    update fraud.phone_signals set
      manual_flags = coalesce((
        select jsonb_agg(entry order by ordinality)
        from (
          select entry, ordinality,
                 row_number() over (
                   partition by (entry ->> 'severity') order by ordinality
                 ) as rank
          from jsonb_array_elements(manual_flags) with ordinality as t(entry, ordinality)
        ) as numbered
        where not ((entry ->> 'severity') = ${String(input.severity)} and rank = 1)
      ), '[]'::jsonb),
      updated_at = now()
    where phone_hash = ${input.phoneHash}
  `);
}

/* ------------------------------------------------------------------------- *
 * The tenant tables. Every statement below carries `org_id`, and RLS carries
 * it again — the predicate is there so a bug is a zero-row update rather than
 * a policy violation with a stack trace in it.
 * ------------------------------------------------------------------------- */

export interface OrgRulesRow {
  readonly allowMin: number;
  readonly warnMin: number;
  readonly requireAdvanceMin: number;
  readonly providerEnabled: boolean;
  readonly providerTtlMinutes: number;
}

/** One org's bands, or `null` to mean "use D-011's defaults". */
export async function readRules(tx: Tx, orgId: string): Promise<OrgRulesRow | null> {
  const rows = await tx.execute<{
    allow_min: number;
    warn_min: number;
    require_advance_min: number;
    provider_enabled: boolean;
    provider_ttl_minutes: number;
  }>(sql`
    select allow_min, warn_min, require_advance_min, provider_enabled, provider_ttl_minutes
    from fraud.rules
    where org_id = ${orgId}
  `);

  const row = rows[0];
  if (row === undefined) return null;

  return {
    allowMin: Number(row.allow_min),
    warnMin: Number(row.warn_min),
    requireAdvanceMin: Number(row.require_advance_min),
    providerEnabled: row.provider_enabled,
    providerTtlMinutes: Number(row.provider_ttl_minutes),
  };
}

export async function upsertRules(tx: Tx, orgId: string, input: OrgRulesRow): Promise<OrgRulesRow> {
  await tx.execute(sql`
    insert into fraud.rules (
      org_id, allow_min, warn_min, require_advance_min, provider_enabled, provider_ttl_minutes
    ) values (
      ${orgId}, ${input.allowMin}, ${input.warnMin}, ${input.requireAdvanceMin},
      ${input.providerEnabled}, ${input.providerTtlMinutes}
    )
    on conflict (org_id) do update set
      allow_min = excluded.allow_min,
      warn_min = excluded.warn_min,
      require_advance_min = excluded.require_advance_min,
      provider_enabled = excluded.provider_enabled,
      provider_ttl_minutes = excluded.provider_ttl_minutes,
      updated_at = now()
  `);
  return input;
}

export interface FlagRow {
  readonly id: string;
  readonly severity: number;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly clearedAt: Date | null;
}

/** This org's own flags on a hash, reasons included — they never leave the org. */
export async function readFlags(tx: Tx, orgId: string, phoneHash: string): Promise<FlagRow[]> {
  const rows = await tx.execute<{
    id: string;
    severity: number;
    reason: string;
    created_by: string;
    created_at: Date | string;
    cleared_at: Date | string | null;
  }>(sql`
    select id, severity, reason, created_by, created_at, cleared_at
    from fraud.phone_flags
    where org_id = ${orgId} and phone_hash = ${phoneHash}
    order by created_at desc
  `);

  return [...rows].map((row) => ({
    id: row.id,
    severity: Number(row.severity),
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: requireDate(row.created_at),
    clearedAt: toDate(row.cleared_at),
  }));
}

export async function insertFlag(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly phoneHash: string;
    readonly severity: number;
    readonly reason: string;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into fraud.phone_flags (org_id, phone_hash, severity, reason, created_by)
    values (${input.orgId}, ${input.phoneHash}, ${input.severity}, ${input.reason}, ${input.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('insertFlag(): insert returned nothing');
  return id;
}

/** Clear one standing flag. Returns its severity, so the aggregate can be adjusted. */
export async function clearFlag(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly flagId: string;
    readonly clearedBy: string;
    readonly reason: string;
  },
): Promise<{ readonly phoneHash: string; readonly severity: number } | null> {
  const rows = await tx.execute<{ phone_hash: string; severity: number }>(sql`
    update fraud.phone_flags set
      cleared_at = now(), cleared_by = ${input.clearedBy}, cleared_reason = ${input.reason},
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.flagId} and cleared_at is null
    returning phone_hash, severity
  `);

  const row = rows[0];
  return row === undefined ? null : { phoneHash: row.phone_hash, severity: Number(row.severity) };
}

export async function insertOverride(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly phoneHash: string;
    readonly trustScore: number;
    readonly reason: string;
    readonly decidedBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into fraud.overrides (org_id, order_id, phone_hash, trust_score, reason, decided_by)
    values (
      ${input.orgId}, ${input.orderId}, ${input.phoneHash}, ${input.trustScore},
      ${input.reason}, ${input.decidedBy}
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('insertOverride(): insert returned nothing');
  return id;
}

export interface OverrideRow {
  readonly id: string;
  readonly orderId: string;
  readonly trustScore: number;
  readonly reason: string;
  readonly decidedBy: string;
  readonly createdAt: Date;
}

export async function readOverrides(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<OverrideRow[]> {
  const rows = await tx.execute<{
    id: string;
    order_id: string;
    trust_score: number;
    reason: string;
    decided_by: string;
    created_at: Date | string;
  }>(sql`
    select id, order_id, trust_score, reason, decided_by, created_at
    from fraud.overrides
    where org_id = ${orgId} and order_id = ${orderId}
    order by created_at desc
  `);

  return [...rows].map((row) => ({
    id: row.id,
    orderId: row.order_id,
    trustScore: Number(row.trust_score),
    reason: row.reason,
    decidedBy: row.decided_by,
    createdAt: requireDate(row.created_at),
  }));
}

/**
 * Remember which hash an order was assessed against.
 *
 * `on conflict do nothing`, because the guard runs again whenever the desk re-checks an
 * order and the mapping cannot change (0047 refuses an update). Idempotent by
 * construction rather than by the caller checking first.
 */
export async function rememberOrderPhone(
  tx: Tx,
  input: { readonly orgId: string; readonly orderId: string; readonly phoneHash: string },
): Promise<void> {
  await tx.execute(sql`
    insert into fraud.order_phones (org_id, order_id, phone_hash)
    values (${input.orgId}, ${input.orderId}, ${input.phoneHash})
    on conflict (org_id, order_id) do nothing
  `);
}

/**
 * The hash an order was assessed against, or `null`.
 *
 * This is the lookup that keeps invariant 12 intact. `order.status_changed` carries an
 * id and a status — never a phone number, because §19 forbids a payload field no
 * recipient needs — so the subscriber has to get from an order id to a hash somehow, and
 * the alternative to this row is reading `sales.orders`, which is another module's
 * table.
 */
export async function findOrderPhone(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<string | null> {
  const rows = await tx.execute<{ phone_hash: string }>(sql`
    select phone_hash from fraud.order_phones
    where org_id = ${orgId} and order_id = ${orderId}
  `);
  return rows[0]?.phone_hash ?? null;
}
