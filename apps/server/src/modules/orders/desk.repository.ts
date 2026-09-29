import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The order desk's reads (M11; architecture §9, §24).
 *
 * Kept apart from `orders.repository.ts` because every statement here is a *read made for
 * a screen* — the duplicate banner, the timeline, the address list, the agent picker — and
 * none of them may ever be used to decide a transition. The statements that move an order
 * stay in the file whose header says so.
 *
 * Three of these touch tables this module does not own, and each says why at the function.
 * The rule they follow is the one the rest of this codebase follows (`investors`,
 * `approvals`): **identity and reference data may be read, another module's business data
 * may not**. `iam.memberships` and `iam.users` say who a person is; `ref.*` says where a
 * thana is; `audit.audit_log` is the platform's record of what happened to *our* row.
 * Nothing here reads `catalog.*`, `inventory.*` or `ledger.*` — those go through their
 * `*.api.ts` (invariant 12).
 */

export interface DuplicateRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_no: string;
  readonly status: string;
  readonly created_at: string;
  /** Whether the caller's §6 scope reaches this order. */
  readonly visible: boolean;
  readonly sku_ids: readonly string[];
}

/**
 * Orders for this number, containing any of these SKUs, in the last 24 hours.
 *
 * **Across the whole brand, not only the caller's rows**, and that is the feature rather
 * than a leak: the duplicate that costs money is the one a *different* agent took from the
 * same buyer on WhatsApp twenty minutes ago, and a check narrowed to §6's `own` scope would
 * never see it. What crosses the scope is bounded instead — the caller learns an order
 * number, a status and a time, and learns which rows it may open (`visible`); the service
 * drops the id of every row it may not.
 *
 * Cancelled orders are excluded: a cancel is how the desk already resolved the duplicate,
 * and warning on it again would be warning about the fix.
 *
 * `now() - interval '24 hours'` is a rolling window, not a business date, deliberately: an
 * order taken at 23:50 is a duplicate of one taken at 00:10 the same night.
 */
export async function recentDuplicates(
  tx: Tx,
  orgId: string,
  input: { readonly phoneE164: string; readonly skuIds: readonly string[]; readonly scope: SQL },
): Promise<DuplicateRow[]> {
  const rows = await tx.execute<DuplicateRow>(sql`
    select o.id, o.order_no, o.status::text as status, o.created_at,
           (${input.scope}) as visible,
           array_agg(distinct l.sku_id::text) as sku_ids
    from sales.orders o
    join sales.order_lines l on l.org_id = o.org_id and l.order_id = o.id
    where o.org_id = ${orgId}
      and o.ship_phone_e164 = ${input.phoneE164}
      and o.created_at > now() - interval '24 hours'
      and o.status <> 'cancelled'
      and l.sku_id = any (${sql.param([...input.skuIds])}::uuid[])
    group by o.id
    order by o.created_at desc
    limit 20
  `);
  return [...rows];
}

export interface OrderAuditRow extends Record<string, unknown> {
  readonly id: string;
  readonly action: string;
  readonly actor_user_id: string | null;
  readonly created_at: string;
}

/**
 * What the audit log says happened to one order, for the detail screen's timeline.
 *
 * **The action, the actor and the time — never `before` or `after`.** §6 gives
 * `read AuditLog` to org_admin alone, and the payloads are that permission's content: a
 * sales agent may see that an order was edited and by whom, which is a fact about a row
 * they can already open, but not the redacted diff an auditor reads. The payload columns
 * are not selected, so there is nothing for a later change to the view to leak.
 *
 * Both spellings of the entity type, because both exist: this module writes `order`, and
 * M12's booking writes `Order` (the subject name). The index on
 * `(org_id, entity_type, entity_id)` serves an `in` list as well as it serves equality.
 */
export async function orderAuditTrail(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<OrderAuditRow[]> {
  const rows = await tx.execute<OrderAuditRow>(sql`
    select a.id, a.action, a.actor_user_id, a.created_at
    from audit.audit_log a
    where a.org_id = ${orgId}
      and a.entity_type in ('order', 'Order')
      and a.entity_id = ${orderId}
    order by a.created_at
    limit 200
  `);
  return [...rows];
}

export interface AreaRow extends Record<string, unknown> {
  readonly thana_id: number;
  readonly thana_en: string;
  readonly thana_bn: string;
  readonly district_id: number;
  readonly district_en: string;
  readonly district_bn: string;
  readonly zone_id: string | null;
}

/**
 * Every thana with its district and the zone that covers it, in one read.
 *
 * All 494 of them, because the desk filters them in the browser: an autocomplete that
 * waits on a round trip per keystroke is the slowest part of a 30-second order, and the
 * whole list is a few tens of kilobytes that never changes during a shift.
 *
 * The zone is resolved exactly as `zoneForArea` resolves it — a thana row beats a district
 * row — so the charge the desk previews is the charge `create` will apply. Two resolutions
 * that could disagree would show one delivery charge and invoice another.
 */
export async function areasWithZones(tx: Tx, orgId: string): Promise<AreaRow[]> {
  const rows = await tx.execute<AreaRow>(sql`
    select t.id as thana_id, t.name_en as thana_en, t.name_bn as thana_bn,
           d.id as district_id, d.name_en as district_en, d.name_bn as district_bn,
           (
             select z.id
             from sales.delivery_zone_areas a
             join sales.delivery_zones z on z.org_id = a.org_id and z.id = a.zone_id
             where a.org_id = ${orgId}
               and a.district_id = d.id
               and (a.thana_id is null or a.thana_id = t.id)
               and z.is_active
             order by a.thana_id nulls last
             limit 1
           ) as zone_id
    from ref.thanas t
    join ref.districts d on d.id = t.district_id
    order by d.name_en, t.name_en
  `);
  return [...rows];
}

export interface AgentRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly name: string;
  readonly roles: readonly string[];
}

/**
 * The people who act on orders in this brand, for the agent filter and the timeline.
 *
 * Names and roles only. `iam.users` also holds an email and a phone number, and neither is
 * needed to put a name beside "claimed by" — so neither is selected (invariant 10).
 *
 * The roles are §6's order roles. An investor or an HR officer has no business in an order
 * list's agent picker, and listing them would be a staff directory nobody asked for.
 */
export async function orderAgents(tx: Tx, orgId: string): Promise<AgentRow[]> {
  const rows = await tx.execute<AgentRow>(sql`
    select u.id as user_id, u.name,
           array_agg(distinct m.role::text order by m.role::text) as roles
    from iam.memberships m
    join iam.users u on u.id = m.user_id
    where m.org_id = ${orgId}
      and m.is_active
      and m.role::text in ('sales', 'org_admin', 'branch_manager', 'warehouse', 'accounts')
    group by u.id, u.name
    order by u.name
    limit 500
  `);
  return [...rows];
}

/** A buyer's most recent orders, inside the caller's scope, for the desk's history strip. */
export async function recentOrdersFor(
  tx: Tx,
  orgId: string,
  customerId: string,
  scope: SQL,
): Promise<
  {
    id: string;
    order_no: string;
    status: string;
    channel: string;
    cod_amount_poisha: string;
    created_at: string;
  }[]
> {
  const rows = await tx.execute<{
    id: string;
    order_no: string;
    status: string;
    channel: string;
    cod_amount_poisha: string;
    created_at: string;
  }>(sql`
    select o.id, o.order_no, o.status::text as status, o.channel::text as channel,
           o.cod_amount_poisha, o.created_at
    from sales.orders o
    where o.org_id = ${orgId} and o.customer_id = ${customerId} and ${scope}
    order by o.created_at desc
    limit 5
  `);
  return [...rows];
}
