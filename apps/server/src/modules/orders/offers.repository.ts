import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Auto-assign's SQL (M41, D-715 to D-717): the brand's workflow settings, the offers, and the
 * per-person counts the engine weighs. `sales` is this module's own schema.
 *
 * Every statement runs in the caller's `withOrg` transaction, so RLS bounds it to the brand.
 * The concurrency control is in the statements, not around them: one live offer per order and
 * per person is two partial unique indexes, an answer is a conditional UPDATE on `status =
 * 'offered'`, and accepting is one statement that takes the order only while it is unassigned.
 */

export interface WorkflowSettingsRow extends Record<string, unknown> {
  readonly auto_assign: boolean;
  readonly offer_seconds: number;
  readonly max_open: number;
  readonly updated_by: string;
  readonly updated_at: Date | string;
}

export async function settingsOf(tx: Tx, orgId: string): Promise<WorkflowSettingsRow | undefined> {
  const rows = await tx.execute<WorkflowSettingsRow>(sql`
    select auto_assign, offer_seconds, max_open, updated_by, updated_at
    from sales.workflow_settings where org_id = ${orgId}
  `);
  return rows[0];
}

export async function saveSettings(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly autoAssign: boolean;
    readonly offerSeconds: number;
    readonly maxOpen: number;
    readonly updatedBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into sales.workflow_settings (org_id, auto_assign, offer_seconds, max_open, updated_by)
    values (${input.orgId}, ${input.autoAssign}, ${input.offerSeconds}, ${input.maxOpen},
            ${input.updatedBy})
    on conflict (org_id) do update set
      auto_assign = excluded.auto_assign,
      offer_seconds = excluded.offer_seconds,
      max_open = excluded.max_open,
      updated_by = excluded.updated_by,
      updated_at = now()
  `);
}

export interface OfferRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string;
  readonly user_id: string;
  readonly status: string;
  readonly offered_at: Date | string;
  readonly expires_at: Date | string;
  readonly responded_at: Date | string | null;
}

const OFFER_COLUMNS = sql`f.id, f.order_id, f.user_id, f.status, f.offered_at, f.expires_at,
  f.responded_at`;

/**
 * Offer an order to one person until `now + seconds`, unless the order or the person already
 * holds a live offer (the two partial unique indexes). Null when the insert lost that race.
 */
export async function insertOffer(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly userId: string;
    readonly seconds: number;
  },
): Promise<OfferRow | undefined> {
  const rows = await tx.execute<OfferRow>(sql`
    insert into sales.order_offers as f (org_id, order_id, user_id, status, offered_at, expires_at)
    values (${input.orgId}, ${input.orderId}, ${input.userId}, 'offered', now(),
            now() + make_interval(secs => ${input.seconds}))
    on conflict do nothing
    returning ${OFFER_COLUMNS}
  `);
  return rows[0];
}

export async function offerById(tx: Tx, orgId: string, id: string): Promise<OfferRow | undefined> {
  const rows = await tx.execute<OfferRow>(sql`
    select ${OFFER_COLUMNS} from sales.order_offers f where f.org_id = ${orgId} and f.id = ${id}
  `);
  return rows[0];
}

/** The order's live offer, unexpired. */
export async function liveOfferFor(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<OfferRow | undefined> {
  const rows = await tx.execute<OfferRow>(sql`
    select ${OFFER_COLUMNS} from sales.order_offers f
    where f.org_id = ${orgId} and f.order_id = ${orderId} and f.status = 'offered'
      and f.expires_at > now()
  `);
  return rows[0];
}

/**
 * Accept: one statement that takes the order for the person and answers the offer, only while
 * the offer is live and the order is still pending and nobody's (check 3). A concurrent claim or
 * a second accept waits on the row locks and then matches nothing, so exactly one wins.
 */
export async function acceptOffer(
  tx: Tx,
  input: { readonly orgId: string; readonly offerId: string; readonly userId: string },
): Promise<{ order_id: string } | undefined> {
  const rows = await tx.execute<{ order_id: string }>(sql`
    with live as (
      select f.id, f.order_id
      from sales.order_offers f
      join sales.orders o on o.org_id = f.org_id and o.id = f.order_id
      where f.org_id = ${input.orgId} and f.id = ${input.offerId}
        and f.user_id = ${input.userId}
        and f.status = 'offered' and f.expires_at > now()
        and o.status = 'pending' and o.assigned_to is null
      for update of f, o
    ),
    taken as (
      update sales.orders o
      set assigned_to = ${input.userId}, assigned_at = now(), updated_at = now()
      from live
      where o.org_id = ${input.orgId} and o.id = live.order_id and o.assigned_to is null
      returning o.id
    )
    update sales.order_offers f
    set status = 'accepted', responded_at = now(), updated_at = now()
    from live, taken
    where f.org_id = ${input.orgId} and f.id = live.id and taken.id = live.order_id
    returning f.order_id
  `);
  return rows[0];
}

/** Answer a live offer with something other than yes. The person's own, unless `anyone`. */
export async function closeOffer(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly offerId: string;
    readonly status: 'declined' | 'expired' | 'withdrawn';
    /** Only the offered person may decline; expiry and withdrawal are the system's. */
    readonly userId?: string;
    /** For an expiry: only once the deadline has passed. */
    readonly onlyIfOverdue?: boolean;
  },
): Promise<OfferRow | undefined> {
  const rows = await tx.execute<OfferRow>(sql`
    update sales.order_offers f
    set status = ${input.status}, responded_at = now(), updated_at = now()
    where f.org_id = ${input.orgId} and f.id = ${input.offerId} and f.status = 'offered'
      and ${input.userId === undefined ? sql`true` : sql`f.user_id = ${input.userId}`}
      and ${input.onlyIfOverdue === true ? sql`f.expires_at <= now()` : sql`true`}
    returning ${OFFER_COLUMNS}
  `);
  return rows[0];
}

/** Withdraw the order's live offers: it was taken another way, or left the queue. */
export async function withdrawOffersOf(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<OfferRow[]> {
  const rows = await tx.execute<OfferRow>(sql`
    update sales.order_offers f
    set status = 'withdrawn', responded_at = now(), updated_at = now()
    where f.org_id = ${orgId} and f.order_id = ${orderId} and f.status = 'offered'
    returning ${OFFER_COLUMNS}
  `);
  return [...rows];
}

/** Every live offer past its deadline, oldest first: what the sweep expires. */
export async function overdueOffers(tx: Tx, orgId: string, limit: number): Promise<OfferRow[]> {
  const rows = await tx.execute<OfferRow>(sql`
    select ${OFFER_COLUMNS} from sales.order_offers f
    where f.org_id = ${orgId} and f.status = 'offered' and f.expires_at <= now()
    order by f.expires_at
    limit ${limit}
  `);
  return [...rows];
}

/** Every live offer in the brand, unexpired. */
export async function liveOffers(tx: Tx, orgId: string): Promise<OfferRow[]> {
  const rows = await tx.execute<OfferRow>(sql`
    select ${OFFER_COLUMNS} from sales.order_offers f
    where f.org_id = ${orgId} and f.status = 'offered' and f.expires_at > now()
  `);
  return [...rows];
}

/** People who declined this order or let an offer of it expire. */
export async function declinedBy(tx: Tx, orgId: string, orderId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ user_id: string }>(sql`
    select distinct user_id from sales.order_offers
    where org_id = ${orgId} and order_id = ${orderId} and status in ('declined', 'expired')
  `);
  return new Set([...rows].map((row) => row.user_id));
}

/** When each person was last offered anything. */
export async function lastOfferedAt(tx: Tx, orgId: string): Promise<Map<string, Date>> {
  const rows = await tx.execute<{ user_id: string; at: Date | string }>(sql`
    select user_id, max(offered_at) as at from sales.order_offers
    where org_id = ${orgId} and offered_at > now() - interval '1 day'
    group by user_id
  `);
  return new Map([...rows].map((row) => [row.user_id, new Date(row.at)]));
}

/** Each owner's open orders: pending or on hold (D-716). */
export async function openLoads(tx: Tx, orgId: string): Promise<Map<string, number>> {
  const rows = await tx.execute<{ assigned_to: string; open: number }>(sql`
    select assigned_to, count(*)::int as open from sales.orders
    where org_id = ${orgId} and assigned_to is not null
      and status in ('pending', 'on_hold')
    group by assigned_to
  `);
  return new Map([...rows].map((row) => [row.assigned_to, row.open]));
}

/** Each person's confirmations today, by Asia/Dhaka's calendar (invariant 8). */
export async function confirmedToday(tx: Tx, orgId: string): Promise<Map<string, number>> {
  const rows = await tx.execute<{ confirmed_by: string; confirmed: number }>(sql`
    select confirmed_by, count(*)::int as confirmed from sales.orders
    where org_id = ${orgId} and confirmed_by is not null
      and (confirmed_at at time zone 'Asia/Dhaka')::date = (now() at time zone 'Asia/Dhaka')::date
    group by confirmed_by
  `);
  return new Map([...rows].map((row) => [row.confirmed_by, row.confirmed]));
}

/** New orders nobody holds and nobody is being offered, oldest first: the queue auto-assign works. */
export async function waitingOrders(tx: Tx, orgId: string, limit: number): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select o.id from sales.orders o
    where o.org_id = ${orgId} and o.status = 'pending' and o.assigned_to is null
      and not exists (
        select 1 from sales.order_offers f
        where f.org_id = o.org_id and f.order_id = o.id and f.status = 'offered'
          and f.expires_at > now()
      )
    order by o.created_at
    limit ${limit}
  `);
  return [...rows].map((row) => row.id);
}

export async function waitingCount(tx: Tx, orgId: string): Promise<number> {
  const rows = await tx.execute<{ waiting: number }>(sql`
    select count(*)::int as waiting from sales.orders
    where org_id = ${orgId} and status = 'pending' and assigned_to is null
  `);
  return rows[0]?.waiting ?? 0;
}

export interface OfferCardRow extends OfferRow {
  readonly order_no: string;
  readonly cod_amount_poisha: string;
  readonly ship_district_id: number;
  readonly ship_thana_id: number;
  readonly ship_area: string | null;
  readonly item_count: number;
}

/** The person's live offers with what the offer card shows. Selling figures only. */
export async function offerCardsFor(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<OfferCardRow[]> {
  const rows = await tx.execute<OfferCardRow>(sql`
    select ${OFFER_COLUMNS}, o.order_no, o.cod_amount_poisha::text as cod_amount_poisha,
           o.ship_district_id, o.ship_thana_id, o.ship_area,
           (select coalesce(sum(l.qty), 0)::int from sales.order_lines l
             where l.org_id = o.org_id and l.order_id = o.id) as item_count
    from sales.order_offers f
    join sales.orders o on o.org_id = f.org_id and o.id = f.order_id
    where f.org_id = ${orgId} and f.user_id = ${userId} and f.status = 'offered'
      and f.expires_at > now()
    order by f.offered_at
  `);
  return [...rows];
}

/** The brands whose auto-assign is on, for the sweep. `sales` is RLS-bound, so per brand. */
export async function autoAssignOn(tx: Tx, orgId: string): Promise<boolean> {
  const rows = await tx.execute<{ on: boolean }>(sql`
    select auto_assign as on from sales.workflow_settings where org_id = ${orgId}
  `);
  return rows[0]?.on === true;
}
