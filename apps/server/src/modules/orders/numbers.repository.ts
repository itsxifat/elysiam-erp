import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The SQL behind a buyer's numbers and the people one number names (M48, D-870 to D-889).
 *
 * All of it runs inside a caller's `withOrg()` transaction, against `sales.customer_phones` and
 * the orders module's own tables (invariant 12: the numbers belong to the module that owns the
 * buyer). `customers.phone_e164` is the primary number's copy: every statement here that can
 * change which number is primary is followed, in the same transaction, by `syncPrimaryCopy`.
 */

export interface PhoneRow extends Record<string, unknown> {
  readonly id: string;
  readonly customer_id: string;
  readonly phone_e164: string;
  readonly rank: number;
  readonly kind: string;
  readonly relation: string;
  readonly note: string | null;
  readonly source: string;
  readonly added_by_user_id: string | null;
  readonly added_at: string;
  readonly retired_at: string | null;
  readonly retired_by_user_id: string | null;
  readonly retire_reason: string | null;
  readonly retire_note: string | null;
}

const PHONE_COLUMNS = sql`p.id, p.customer_id, p.phone_e164, p.rank, p.kind, p.relation, p.note,
  p.source, p.added_by_user_id, p.added_at, p.retired_at, p.retired_by_user_id, p.retire_reason,
  p.retire_note`;

/** A person's numbers: those in use by rank, then the retired ones, newest retired first. */
export async function phonesOf(tx: Tx, orgId: string, customerId: string): Promise<PhoneRow[]> {
  const rows = await tx.execute<PhoneRow>(sql`
    select ${PHONE_COLUMNS} from sales.customer_phones p
    where p.org_id = ${orgId} and p.customer_id = ${customerId}
    order by (p.retired_at is not null), p.rank, p.retired_at desc, p.added_at
  `);
  return [...rows];
}

/** A person's numbers in use, by rank, locked for the caller's change when asked. */
export async function activePhonesOf(
  tx: Tx,
  orgId: string,
  customerId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<PhoneRow[]> {
  const rows = await tx.execute<PhoneRow>(sql`
    select ${PHONE_COLUMNS} from sales.customer_phones p
    where p.org_id = ${orgId} and p.customer_id = ${customerId} and p.retired_at is null
    order by p.rank, p.added_at
    ${options.forUpdate === true ? sql`for update` : sql``}
  `);
  return [...rows];
}

export async function insertPhone(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly phoneE164: string;
    readonly rank: number;
    readonly kind: string;
    readonly relation: string;
    readonly note: string | null;
    readonly source: string;
    readonly addedByUserId: string | null;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.customer_phones
      (org_id, customer_id, phone_e164, rank, kind, relation, note, source, added_by_user_id)
    values (${input.orgId}, ${input.customerId}, ${input.phoneE164}, ${input.rank}, ${input.kind},
            ${input.relation}, ${input.note}, ${input.source}, ${input.addedByUserId})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('sales.customer_phones insert returned no id');
  return id;
}

/** A number's kind, relation and note; undefined leaves each as it is. */
export async function updatePhoneDetails(
  tx: Tx,
  orgId: string,
  phoneId: string,
  patch: {
    readonly kind?: string | undefined;
    readonly relation?: string | undefined;
    /** A note sets it; undefined leaves it. A note cannot be cleared (D-871). */
    readonly note?: string | undefined;
  },
): Promise<void> {
  await tx.execute(sql`
    update sales.customer_phones set
      kind = coalesce(${patch.kind ?? null}, kind),
      relation = coalesce(${patch.relation ?? null}, relation),
      note = coalesce(${patch.note ?? null}, note),
      updated_at = now()
    where org_id = ${orgId} and id = ${phoneId}
  `);
}

/**
 * Rank a person's numbers in use 1, 2, 3… in this order (D-872).
 *
 * Two statements, because the one-primary index is checked row by row: every rank moves out of
 * the way first (no row is rank 1 in between), then each takes its place.
 */
export async function renumber(
  tx: Tx,
  orgId: string,
  customerId: string,
  idsInOrder: readonly string[],
): Promise<void> {
  if (idsInOrder.length === 0) return;
  await tx.execute(sql`
    update sales.customer_phones set rank = rank + 100000, updated_at = now()
    where org_id = ${orgId} and customer_id = ${customerId} and retired_at is null
  `);
  await tx.execute(sql`
    update sales.customer_phones p set rank = v.rank, updated_at = now()
    from (select * from unnest(${sql.param([...idsInOrder])}::uuid[])
          with ordinality as t(id, rank)) v
    where p.org_id = ${orgId} and p.customer_id = ${customerId} and p.id = v.id
  `);
}

export async function retirePhone(
  tx: Tx,
  orgId: string,
  phoneId: string,
  input: { readonly byUserId: string; readonly reason: string; readonly note: string | null },
): Promise<void> {
  await tx.execute(sql`
    update sales.customer_phones set
      retired_at = now(),
      retired_by_user_id = ${input.byUserId},
      retire_reason = ${input.reason},
      retire_note = ${input.note},
      updated_at = now()
    where org_id = ${orgId} and id = ${phoneId} and retired_at is null
  `);
}

/** `customers.phone_e164` follows the rank-1 number in use (D-870). */
export async function syncPrimaryCopy(tx: Tx, orgId: string, customerId: string): Promise<void> {
  await tx.execute(sql`
    update sales.customers c set phone_e164 = p.phone_e164, updated_at = now()
    from sales.customer_phones p
    where c.org_id = ${orgId} and c.id = ${customerId}
      and p.org_id = c.org_id and p.customer_id = c.id and p.rank = 1 and p.retired_at is null
      and c.phone_e164 <> p.phone_e164
  `);
}

/** One person a number names now (D-875): never a merged record, never a retired number. */
export interface CandidateRow extends Record<string, unknown> {
  readonly customer_id: string;
  readonly name: string;
  readonly phone_id: string;
  readonly rank: number;
  readonly kind: string;
  readonly relation: string;
  readonly note: string | null;
  readonly added_at: string;
  readonly last_order_at: string | null;
  readonly orders_total: number;
  readonly delivered_count: number;
  readonly returned_count: number;
  readonly cancelled_count: number;
}

export async function candidatesByPhone(
  tx: Tx,
  orgId: string,
  phoneE164: string,
): Promise<CandidateRow[]> {
  const rows = await tx.execute<CandidateRow>(sql`
    select c.id as customer_id, c.name, p.id as phone_id, p.rank, p.kind, p.relation, p.note,
           p.added_at, c.last_order_at, c.orders_total, c.delivered_count, c.returned_count,
           c.cancelled_count
    from sales.customer_phones p
    join sales.customers c on c.org_id = p.org_id and c.id = p.customer_id
    where p.org_id = ${orgId} and p.phone_e164 = ${phoneE164} and p.retired_at is null
      and c.merged_into_customer_id is null
    order by c.last_order_at desc nulls last, p.rank, p.added_at
    limit 50
  `);
  return [...rows];
}

/** Of these phones, the ones some buyer of the brand uses now (M14a's importer skips them). */
export async function phonesInUse(
  tx: Tx,
  orgId: string,
  phones: readonly string[],
): Promise<string[]> {
  if (phones.length === 0) return [];
  const rows = await tx.execute<{ phone_e164: string }>(sql`
    select distinct p.phone_e164 from sales.customer_phones p
    join sales.customers c on c.org_id = p.org_id and c.id = p.customer_id
    where p.org_id = ${orgId} and p.retired_at is null and c.merged_into_customer_id is null
      and p.phone_e164 = any (${sql.param([...phones])}::text[])
  `);
  return rows.map((row) => row.phone_e164);
}

/** The first number of buyers just imported (M14a): rank 1, their own, from the import. */
export async function insertImportedPhones(tx: Tx, orgId: string): Promise<void> {
  await tx.execute(sql`
    insert into sales.customer_phones (org_id, customer_id, phone_e164, rank, source)
    select c.org_id, c.id, c.phone_e164, 1, 'import'
    from sales.customers c
    where c.org_id = ${orgId}
      and not exists (select 1 from sales.customer_phones p
                      where p.org_id = c.org_id and p.customer_id = c.id)
  `);
}

// --- merge (D-884, D-885) --------------------------------------------------------------------

export interface MergeCustomerRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly notes: string | null;
  readonly tags: unknown;
  readonly birthday: string | null;
  readonly anniversary: string | null;
  readonly gender: string | null;
  readonly age_band: string | null;
  readonly profession: string | null;
  readonly pinned_note: string | null;
  readonly pinned_note_by_user_id: string | null;
  readonly pinned_note_at: string | null;
  readonly orders_total: number;
  readonly delivered_count: number;
  readonly returned_count: number;
  readonly cancelled_count: number;
  readonly ltv_poisha: string;
  readonly first_order_at: string | null;
  readonly last_order_at: string | null;
  readonly merged_into_customer_id: string | null;
}

/** Both records, locked in id order so two merges of the same pair take turns. */
export async function lockForMerge(
  tx: Tx,
  orgId: string,
  ids: readonly [string, string],
): Promise<MergeCustomerRow[]> {
  const rows = await tx.execute<MergeCustomerRow>(sql`
    select c.id, c.name, c.notes, c.tags, c.birthday::text as birthday,
           c.anniversary::text as anniversary, c.gender, c.age_band, c.profession,
           c.pinned_note, c.pinned_note_by_user_id, c.pinned_note_at, c.orders_total,
           c.delivered_count, c.returned_count, c.cancelled_count, c.ltv_poisha::text as ltv_poisha,
           c.first_order_at, c.last_order_at, c.merged_into_customer_id
    from sales.customers c
    where c.org_id = ${orgId} and c.id = any (${sql.param([...ids])}::uuid[])
    order by c.id
    for update
  `);
  return [...rows];
}

/** The kept record takes the other's details, counters and pinned note (if it has none). */
export async function absorbCustomer(
  tx: Tx,
  orgId: string,
  input: {
    readonly keptId: string;
    readonly mergedId: string;
    readonly notes: string | null;
    readonly tags: readonly string[];
    readonly takePinned: boolean;
  },
): Promise<void> {
  await tx.execute(sql`
    update sales.customers k set
      notes = ${input.notes},
      tags = ${JSON.stringify(input.tags)}::jsonb,
      birthday = coalesce(k.birthday, m.birthday),
      anniversary = coalesce(k.anniversary, m.anniversary),
      gender = coalesce(k.gender, m.gender),
      age_band = coalesce(k.age_band, m.age_band),
      profession = coalesce(k.profession, m.profession),
      pinned_note = case when ${input.takePinned} then m.pinned_note else k.pinned_note end,
      pinned_note_by_user_id = case when ${input.takePinned} then m.pinned_note_by_user_id
                                    else k.pinned_note_by_user_id end,
      pinned_note_at = case when ${input.takePinned} then m.pinned_note_at else k.pinned_note_at end,
      orders_total = k.orders_total + m.orders_total,
      delivered_count = k.delivered_count + m.delivered_count,
      returned_count = k.returned_count + m.returned_count,
      cancelled_count = k.cancelled_count + m.cancelled_count,
      ltv_poisha = k.ltv_poisha + m.ltv_poisha,
      first_order_at = least(k.first_order_at, m.first_order_at),
      last_order_at = greatest(k.last_order_at, m.last_order_at),
      updated_at = now()
    from sales.customers m
    where k.org_id = ${orgId} and k.id = ${input.keptId}
      and m.org_id = k.org_id and m.id = ${input.mergedId}
  `);
}

/** The merged record: marked, its counters given away, kept for whatever still names it. */
export async function markMerged(
  tx: Tx,
  orgId: string,
  input: { readonly mergedId: string; readonly keptId: string; readonly byUserId: string },
): Promise<void> {
  await tx.execute(sql`
    update sales.customers set
      merged_into_customer_id = ${input.keptId},
      merged_at = now(),
      merged_by_user_id = ${input.byUserId},
      orders_total = 0, delivered_count = 0, returned_count = 0, cancelled_count = 0,
      ltv_poisha = 0,
      updated_at = now()
    where org_id = ${orgId} and id = ${input.mergedId}
  `);
}

/** Move the orders module's own rows from one record to the other (D-885). Counts moved. */
export async function repointSales(
  tx: Tx,
  orgId: string,
  fromId: string,
  toId: string,
): Promise<{ readonly orders: number; readonly addresses: number }> {
  const orders = await tx.execute<{ id: string }>(sql`
    update sales.orders set customer_id = ${toId}, updated_at = now()
    where org_id = ${orgId} and customer_id = ${fromId}
    returning id
  `);
  await tx.execute(sql`
    update sales.orders set recipient_customer_id = ${toId}, updated_at = now()
    where org_id = ${orgId} and recipient_customer_id = ${fromId}
  `);
  // The kept record's default address stays the default; the other's join as saved ones.
  const addresses = await tx.execute<{ id: string }>(sql`
    update sales.customer_addresses a set
      customer_id = ${toId},
      is_default = a.is_default and not exists (
        select 1 from sales.customer_addresses k
        where k.org_id = a.org_id and k.customer_id = ${toId} and k.is_default
      ),
      updated_at = now()
    where a.org_id = ${orgId} and a.customer_id = ${fromId}
    returning a.id
  `);
  return { orders: orders.length, addresses: addresses.length };
}

/** Move numbers to the kept record with their new ranks (the merge plan's). */
export async function movePhones(
  tx: Tx,
  orgId: string,
  input: {
    readonly fromId: string;
    readonly toId: string;
    readonly ranks: readonly { readonly id: string; readonly rank: number }[];
  },
): Promise<void> {
  const ids = input.ranks.map((entry) => entry.id);
  if (ids.length === 0) return;
  // Out of the way of the one-primary index first, on both records, as `renumber` does.
  await tx.execute(sql`
    update sales.customer_phones set rank = rank + 100000, updated_at = now()
    where org_id = ${orgId} and customer_id in (${input.fromId}, ${input.toId})
      and retired_at is null
  `);
  await tx.execute(sql`
    update sales.customer_phones p set customer_id = ${input.toId}, rank = v.rank,
      updated_at = now()
    from (select * from unnest(${sql.param(ids)}::uuid[], ${sql.param(
      input.ranks.map((entry) => entry.rank),
    )}::int[]) as t(id, rank)) v
    where p.org_id = ${orgId} and p.id = v.id
  `);
}

// --- orders: change buyer, on behalf, the shared-number check (D-878 to D-883) --------------

export interface OrderBuyerRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_no: string;
  readonly status: string;
  readonly customer_id: string;
  readonly branch_id: string | null;
  readonly created_by: string;
  readonly assigned_to: string | null;
  readonly created_at: string;
  readonly buyer_check: string | null;
  readonly discount_poisha: string;
  readonly items_poisha: string;
}

export async function lockOrderBuyer(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<OrderBuyerRow | undefined> {
  const rows = await tx.execute<OrderBuyerRow>(sql`
    select o.id, o.order_no, o.status::text as status, o.customer_id, o.branch_id, o.created_by,
           o.assigned_to, o.created_at, o.buyer_check, o.discount_poisha::text as discount_poisha,
           o.items_poisha::text as items_poisha
    from sales.orders o
    where o.org_id = ${orgId} and o.id = ${orderId}
    for update
  `);
  return rows[0];
}

/** The statuses an order has been in, from its own history (its creation is `pending`). */
export async function statusesReached(tx: Tx, orgId: string, orderId: string): Promise<string[]> {
  const rows = await tx.execute<{ status: string }>(sql`
    select distinct e.to_status::text as status from sales.order_events e
    where e.org_id = ${orgId} and e.order_id = ${orderId}
  `);
  return rows.map((row) => row.status);
}

export async function setOrderBuyer(
  tx: Tx,
  orgId: string,
  orderId: string,
  customerId: string,
): Promise<void> {
  await tx.execute(sql`
    update sales.orders set customer_id = ${customerId}, buyer_check = null, updated_at = now()
    where org_id = ${orgId} and id = ${orderId}
  `);
}

export async function clearBuyerCheck(tx: Tx, orgId: string, orderId: string): Promise<void> {
  await tx.execute(sql`
    update sales.orders set buyer_check = null, updated_at = now()
    where org_id = ${orgId} and id = ${orderId} and buyer_check is not null
  `);
}

/** After an order left a buyer: their first and last order, from the orders they still have. */
export async function refreshOrderDates(tx: Tx, orgId: string, customerId: string): Promise<void> {
  await tx.execute(sql`
    update sales.customers c set
      first_order_at = (select min(o.created_at) from sales.orders o
                        where o.org_id = c.org_id and o.customer_id = c.id),
      last_order_at = (select max(o.created_at) from sales.orders o
                       where o.org_id = c.org_id and o.customer_id = c.id),
      updated_at = now()
    where c.org_id = ${orgId} and c.id = ${customerId}
  `);
}

/** Whether this number is one the person uses now. */
export async function personUsesPhone(
  tx: Tx,
  orgId: string,
  customerId: string,
  phoneE164: string,
): Promise<boolean> {
  const rows = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from sales.customer_phones p
      where p.org_id = ${orgId} and p.customer_id = ${customerId}
        and p.phone_e164 = ${phoneE164} and p.retired_at is null
    ) as found
  `);
  return rows[0]?.found === true;
}

/** Whether an actor id is a person's (a worker's `system:…` id is not), for "added by". */
export async function isPerson(tx: Tx, userId: string): Promise<boolean> {
  const rows = await tx.execute<{ found: boolean }>(sql`
    select exists (select 1 from iam.users u where u.id = ${userId}) as found
  `);
  return rows[0]?.found === true;
}
