import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the orders module runs (tenancy rules: raw SQL lives in
 * repositories, parameterised, never built by string interpolation).
 *
 * All of it runs inside a caller's `withOrg()` transaction. Two statements here carry
 * more than their weight and are worth reading before the rest:
 *
 * * **`nextOrderNumber`** is one atomic upsert. The counter is read and incremented in a
 *   single statement so two agents confirming orders in the same second serialise on the
 *   row lock and get different numbers. A `select max(order_no)` version passes every
 *   single-threaded test and hands the same number to both of them on a busy evening,
 *   where the unique index turns it into a failed confirmation the agent cannot explain.
 * * **`setStatus`** carries `and status = $expected` in its WHERE. That is the optimistic
 *   lock behind invariant 7: the domain decided the move from a row it read, and this is
 *   what refuses the write if the row moved in between. Zero rows updated is
 *   `ORDER_TRANSITION_INVALID`, which is the same answer the domain and migration 0041's
 *   trigger give — deliberately, because which layer notices depends on concurrency.
 */

// --- customers ----------------------------------------------------------------

export interface CustomerRow extends Record<string, unknown> {
  readonly id: string;
  readonly phone_e164: string;
  readonly name: string;
  readonly birthday: string | null;
  readonly anniversary: string | null;
  readonly gender: string | null;
  readonly age_band: string | null;
  readonly profession: string | null;
  readonly tags: unknown;
  readonly notes: string | null;
  readonly orders_total: number;
  readonly delivered_count: number;
  readonly returned_count: number;
  readonly cancelled_count: number;
  readonly ltv_poisha: string;
  readonly first_order_at: string | null;
  readonly last_order_at: string | null;
}

/**
 * Timestamps come back as **text**, not as `Date`.
 *
 * Raw `tx.execute(sql\`…\`)` hands the driver's own representation straight through, and for
 * `timestamptz` that is a string. Typing these as `Date` compiles and then throws
 * `row.created_at.toISOString is not a function` at runtime, which is how this was found.
 * Callers that need a `Date` construct one; callers that are serialising a response
 * normalise to ISO 8601 (§23), which is what `isoOf` in `orders.service.ts` does.
 */

const CUSTOMER_COLUMNS = sql`c.id, c.phone_e164, c.name, c.birthday, c.anniversary, c.gender,
  c.age_band, c.profession, c.tags, c.notes, c.orders_total, c.delivered_count,
  c.returned_count, c.cancelled_count, c.ltv_poisha, c.first_order_at, c.last_order_at`;

export async function customerByPhone(
  tx: Tx,
  orgId: string,
  phoneE164: string,
): Promise<CustomerRow | undefined> {
  const rows = await tx.execute<CustomerRow>(sql`
    select ${CUSTOMER_COLUMNS} from sales.customers c
    where c.org_id = ${orgId} and c.phone_e164 = ${phoneE164}
  `);
  return rows[0];
}

/** Of these phones, the ones already a buyer of this org (M14a's customers importer). */
export async function existingBuyerPhones(
  tx: Tx,
  orgId: string,
  phones: readonly string[],
): Promise<string[]> {
  if (phones.length === 0) return [];
  const rows = await tx.execute<{ phone_e164: string }>(sql`
    select phone_e164 from sales.customers
    where org_id = ${orgId} and phone_e164 = any (${sql.param([...phones])}::text[])
  `);
  return rows.map((row) => row.phone_e164);
}

/** Buyers with their imported history, one statement per slice (M14a, D-218). */
export async function insertImportedBuyers(
  tx: Tx,
  orgId: string,
  buyers: readonly {
    readonly phoneE164: string;
    readonly name: string;
    readonly delivered: number;
    readonly returned: number;
    readonly cancelled: number;
    readonly spentPoisha: bigint;
  }[],
): Promise<void> {
  if (buyers.length === 0) return;
  await tx.execute(sql`
    insert into sales.customers
      (org_id, phone_e164, name, orders_total, delivered_count, returned_count, cancelled_count,
       ltv_poisha)
    values ${sql.join(
      buyers.map(
        (buyer) =>
          sql`(${orgId}, ${buyer.phoneE164}, ${buyer.name},
               ${buyer.delivered + buyer.returned + buyer.cancelled}, ${buyer.delivered},
               ${buyer.returned}, ${buyer.cancelled}, ${buyer.spentPoisha.toString()}::bigint)`,
      ),
      sql`, `,
    )}
  `);
}

export async function customerById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<CustomerRow | undefined> {
  const rows = await tx.execute<CustomerRow>(sql`
    select ${CUSTOMER_COLUMNS} from sales.customers c
    where c.org_id = ${orgId} and c.id = ${id}
  `);
  return rows[0];
}

export async function insertCustomer(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly phoneE164: string;
    readonly name: string;
    readonly birthday: string | null;
    readonly anniversary: string | null;
    readonly gender: string | null;
    readonly ageBand: string | null;
    readonly profession: string | null;
    readonly tags: readonly string[];
    readonly notes: string | null;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.customers
      (org_id, phone_e164, name, birthday, anniversary, gender, age_band, profession, tags, notes)
    values (${input.orgId}, ${input.phoneE164}, ${input.name}, ${input.birthday}::date,
            ${input.anniversary}::date, ${input.gender}, ${input.ageBand}, ${input.profession},
            ${JSON.stringify(input.tags)}::jsonb, ${input.notes})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('sales.customers insert returned no id');
  return id;
}

export async function updateCustomer(
  tx: Tx,
  orgId: string,
  id: string,
  patch: {
    readonly name?: string | undefined;
    /** A date sets it, `null` clears it, undefined leaves it alone. */
    readonly birthday?: string | null | undefined;
    readonly anniversary?: string | null | undefined;
    readonly gender?: string | undefined;
    readonly ageBand?: string | undefined;
    readonly profession?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly notes?: string | undefined;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.customers set
      name = coalesce(${patch.name ?? null}, name),
      birthday = ${patch.birthday === undefined ? sql`birthday` : sql`${patch.birthday}::date`},
      anniversary = ${
        patch.anniversary === undefined ? sql`anniversary` : sql`${patch.anniversary}::date`
      },
      gender = coalesce(${patch.gender ?? null}, gender),
      age_band = coalesce(${patch.ageBand ?? null}, age_band),
      profession = coalesce(${patch.profession ?? null}, profession),
      tags = coalesce(${patch.tags === undefined ? null : JSON.stringify(patch.tags)}::jsonb, tags),
      notes = coalesce(${patch.notes ?? null}, notes),
      updated_at = now()
    where org_id = ${orgId} and id = ${id}
    returning id
  `);
  return rows.length > 0;
}

export async function listCustomers(
  tx: Tx,
  orgId: string,
  filters: { readonly q: string | undefined; readonly limit: number; readonly offset: number },
): Promise<CustomerRow[]> {
  /*
   * One predicate covering both a phone fragment and a name fragment.
   *
   * `ILIKE '%x%'` on both columns, served by the trigram indexes in migration 0043. A
   * digits-only search is matched against the phone and a text search against the name,
   * but both are tried either way: a buyer saved as "01712345678 Afsana" is a real thing
   * a tired agent types, and refusing to look in the other column would make that buyer
   * unfindable by the number that is written in their own name field.
   */
  const pattern = filters.q === undefined ? undefined : `%${filters.q}%`;
  const rows = await tx.execute<CustomerRow>(sql`
    select ${CUSTOMER_COLUMNS} from sales.customers c
    where c.org_id = ${orgId}
      and ${pattern === undefined ? sql`true` : sql`(c.phone_e164 ilike ${pattern} or c.name ilike ${pattern})`}
    order by c.last_order_at desc nulls last, c.created_at desc
    limit ${filters.limit} offset ${filters.offset}
  `);
  return [...rows];
}

export interface AddressRow extends Record<string, unknown> {
  readonly id: string;
  readonly label: string | null;
  readonly district_id: number;
  readonly thana_id: number;
  readonly area: string | null;
  readonly address_line: string;
  readonly is_default: boolean;
}

export async function listAddresses(
  tx: Tx,
  orgId: string,
  customerId: string,
): Promise<AddressRow[]> {
  const rows = await tx.execute<AddressRow>(sql`
    select a.id, a.label, a.district_id, a.thana_id, a.area, a.address_line, a.is_default
    from sales.customer_addresses a
    where a.org_id = ${orgId} and a.customer_id = ${customerId}
    order by a.is_default desc, a.created_at
  `);
  return [...rows];
}

export async function insertAddress(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly customerId: string;
    readonly label: string | null;
    readonly districtId: number;
    readonly thanaId: number;
    readonly area: string | null;
    readonly addressLine: string;
    readonly isDefault: boolean;
  },
): Promise<string> {
  if (input.isDefault) {
    // One default per buyer, and the partial unique index enforces it — so the previous
    // default is cleared first rather than relying on the insert to fail and be retried.
    await tx.execute(sql`
      update sales.customer_addresses set is_default = false, updated_at = now()
      where org_id = ${input.orgId} and customer_id = ${input.customerId} and is_default
    `);
  }
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.customer_addresses
      (org_id, customer_id, label, district_id, thana_id, area, address_line, is_default)
    values (${input.orgId}, ${input.customerId}, ${input.label}, ${input.districtId},
            ${input.thanaId}, ${input.area}, ${input.addressLine}, ${input.isDefault})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('sales.customer_addresses insert returned no id');
  return id;
}

/**
 * Move a buyer's counters after a transition (§9's buyer stats).
 *
 * All of it in one statement with `greatest(…, 0)` on the decrements: an order that is
 * cancelled twice — a retried job, a double-clicked button — must not drive the count
 * negative, and the CHECK would refuse the write, which would roll back the cancel
 * itself. Clamping here is the one place where absorbing a double is right, because the
 * counters are a cache and the order's own status is the record.
 */
export async function bumpCustomerStats(
  tx: Tx,
  orgId: string,
  customerId: string,
  delta: {
    readonly orders?: number;
    readonly delivered?: number;
    readonly returned?: number;
    readonly cancelled?: number;
    readonly ltvPoisha?: bigint;
    /** A `Date`, or the text a row handed back — both reach here from real callers. */
    readonly orderedAt?: Date | string;
  },
): Promise<void> {
  // Bound as text with a cast, for the reason `setStatus` explains at length.
  const orderedAt = delta.orderedAt === undefined ? null : new Date(delta.orderedAt).toISOString();
  await tx.execute(sql`
    update sales.customers set
      orders_total = greatest(orders_total + ${delta.orders ?? 0}, 0),
      delivered_count = greatest(delivered_count + ${delta.delivered ?? 0}, 0),
      returned_count = greatest(returned_count + ${delta.returned ?? 0}, 0),
      cancelled_count = greatest(cancelled_count + ${delta.cancelled ?? 0}, 0),
      ltv_poisha = greatest(ltv_poisha + ${(delta.ltvPoisha ?? 0n).toString()}::bigint, 0),
      first_order_at = coalesce(first_order_at, ${orderedAt}::timestamptz),
      last_order_at = greatest(coalesce(last_order_at, to_timestamp(0)),
                               coalesce(${orderedAt}::timestamptz, to_timestamp(0))),
      updated_at = now()
    where org_id = ${orgId} and id = ${customerId}
  `);
}

// --- delivery zones and couriers ---------------------------------------------

export interface ZoneRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name_en: string;
  readonly name_bn: string;
  readonly charge_poisha: string;
  readonly default_courier_id: string | null;
  readonly position: number;
  readonly is_active: boolean;
}

const ZONE_COLUMNS = sql`z.id, z.code, z.name_en, z.name_bn, z.charge_poisha,
  z.default_courier_id, z.position, z.is_active`;

export async function listZones(tx: Tx, orgId: string): Promise<ZoneRow[]> {
  const rows = await tx.execute<ZoneRow>(sql`
    select ${ZONE_COLUMNS} from sales.delivery_zones z
    where z.org_id = ${orgId} order by z.position, z.code
  `);
  return [...rows];
}

export async function zoneById(tx: Tx, orgId: string, id: string): Promise<ZoneRow | undefined> {
  const rows = await tx.execute<ZoneRow>(sql`
    select ${ZONE_COLUMNS} from sales.delivery_zones z
    where z.org_id = ${orgId} and z.id = ${id}
  `);
  return rows[0];
}

/**
 * The zone that covers an address (§9).
 *
 * A thana row beats a district row, which is what `order by thana_id nulls last` says:
 * an org maps "Outside Dhaka" across a whole district and then carves out the two thanas
 * its own rider covers, and the carve-out has to win. Sorting the other way would price
 * every order in that district at the district rate and the carve-outs would be dead
 * rows nobody noticed.
 */
export async function zoneForArea(
  tx: Tx,
  orgId: string,
  districtId: number,
  thanaId: number | null,
): Promise<ZoneRow | undefined> {
  const rows = await tx.execute<ZoneRow>(sql`
    select ${ZONE_COLUMNS}
    from sales.delivery_zone_areas a
    join sales.delivery_zones z on z.org_id = a.org_id and z.id = a.zone_id
    where a.org_id = ${orgId}
      and a.district_id = ${districtId}
      and (a.thana_id is null or a.thana_id = ${thanaId})
      and z.is_active
    order by a.thana_id nulls last
    limit 1
  `);
  return rows[0];
}

export async function upsertZone(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly code: string;
    readonly nameEn: string;
    readonly nameBn: string;
    readonly chargePoisha: bigint;
    readonly defaultCourierId: string | null;
    readonly position: number;
    readonly isActive: boolean;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.delivery_zones
      (org_id, code, name_en, name_bn, charge_poisha, default_courier_id, position, is_active)
    values (${input.orgId}, ${input.code}, ${input.nameEn}, ${input.nameBn},
            ${input.chargePoisha.toString()}::bigint, ${input.defaultCourierId}::uuid,
            ${input.position}, ${input.isActive})
    on conflict (org_id, code) do update set
      name_en = excluded.name_en,
      name_bn = excluded.name_bn,
      charge_poisha = excluded.charge_poisha,
      default_courier_id = excluded.default_courier_id,
      position = excluded.position,
      is_active = excluded.is_active,
      updated_at = now()
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('sales.delivery_zones upsert returned no id');
  return id;
}

export interface CourierRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly is_active: boolean;
}

export async function listCouriers(tx: Tx, orgId: string): Promise<CourierRow[]> {
  const rows = await tx.execute<CourierRow>(sql`
    select id, code, name, is_active from sales.couriers
    where org_id = ${orgId} order by code
  `);
  return [...rows];
}

/**
 * The couriers these ids name, for `OrdersApi.courierParties`.
 *
 * Unknown ids are simply absent: the caller is naming rows it already holds a
 * foreign key to, and one id that has since been removed must not blank a page.
 */
export async function couriersByIds(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<CourierRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<CourierRow>(sql`
    select id, code, name, is_active from sales.couriers
    where org_id = ${orgId} and id = any (${sql.param([...ids])}::uuid[])
  `);
  return [...rows];
}

export async function couriersByCodes(
  tx: Tx,
  orgId: string,
  codes: readonly string[],
): Promise<CourierRow[]> {
  if (codes.length === 0) return [];
  const rows = await tx.execute<CourierRow>(sql`
    select id, code, name, is_active from sales.couriers
    where org_id = ${orgId} and code = any (${sql.param([...codes])}::text[])
  `);
  return [...rows];
}

export async function defaultCourier(tx: Tx, orgId: string): Promise<CourierRow | undefined> {
  const rows = await tx.execute<CourierRow>(sql`
    select id, code, name, is_active from sales.couriers
    where org_id = ${orgId} and is_active order by code limit 1
  `);
  return rows[0];
}

// --- order numbering ----------------------------------------------------------

/**
 * The next sequence for `(org, period)`, in one statement.
 *
 * `on conflict do update set last_no = last_no + 1 returning last_no` is the whole of the
 * concurrency control. Two transactions running this against the same row serialise on
 * the row lock; the second one's `excluded` is discarded and it increments the committed
 * value, so it gets a different number. Reading the counter and then updating it would
 * hand both the same number, and the unique index on `order_no` would fail one of them —
 * as a 500 in the middle of a phone call.
 */
export async function nextOrderNumber(tx: Tx, orgId: string, period: string): Promise<number> {
  const rows = await tx.execute<{ last_no: number }>(sql`
    insert into sales.order_counters (org_id, period, last_no)
    values (${orgId}, ${period}, 1)
    on conflict (org_id, period) do update set last_no = sales.order_counters.last_no + 1,
      updated_at = now()
    returning last_no
  `);
  const next = rows[0]?.last_no;
  if (next === undefined) throw new Error('sales.order_counters upsert returned no sequence');
  return next;
}

export async function orgSlug(tx: Tx, orgId: string): Promise<string> {
  const rows = await tx.execute<{ slug: string }>(sql`
    select slug from org.organizations where id = ${orgId}
  `);
  const slug = rows[0]?.slug;
  if (slug === undefined) throw new Error(`no organization ${orgId}`);
  return slug;
}

/**
 * The org's courier booking trigger (§9's `orders.courier_booking`).
 *
 * Returns the raw setting; the caller decides what an unrecognised value means. A brand
 * that has never chosen has no row, and the transition service reads that as `manual` —
 * the only default that cannot book a parcel somebody did not ask for.
 */
export async function courierBookingSetting(tx: Tx, orgId: string): Promise<string | null> {
  const rows = await tx.execute<{ value: unknown }>(sql`
    select value from org.settings where org_id = ${orgId} and key = 'orders.courier_booking'
  `);
  const value = rows[0]?.value;
  return typeof value === 'string' ? value : null;
}

export async function orderNumberPrefix(tx: Tx, orgId: string): Promise<string | null> {
  const rows = await tx.execute<{ value: unknown }>(sql`
    select value from org.settings where org_id = ${orgId} and key = 'orders.number_prefix'
  `);
  const value = rows[0]?.value;
  return typeof value === 'string' ? value : null;
}

// --- orders -------------------------------------------------------------------

export interface OrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly branch_id: string | null;
  readonly order_no: string;
  readonly channel: string;
  readonly source: unknown;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly customer_phone: string;
  readonly ship_name: string;
  readonly ship_phone_e164: string;
  readonly ship_district_id: number;
  readonly ship_thana_id: number;
  readonly ship_area: string | null;
  readonly ship_address_line: string;
  readonly delivery_zone_id: string | null;
  readonly courier_id: string | null;
  readonly location_id: string | null;
  readonly items_poisha: string;
  readonly discount_poisha: string;
  readonly delivery_charge_poisha: string;
  readonly advance_paid_poisha: string;
  readonly cod_amount_poisha: string;
  readonly status: string;
  readonly hold_reason: string | null;
  readonly assigned_to: string | null;
  readonly created_by: string;
  readonly confirmed_at: string | null;
  readonly packed_at: string | null;
  readonly handed_over_at: string | null;
  readonly delivered_at: string | null;
  readonly returned_at: string | null;
  readonly cancelled_at: string | null;
  readonly cancel_reason: string | null;
  readonly reseller_id: string | null;
  readonly exchange_of_order_id: string | null;
  /** The promo code that priced this order, when one did (M16). */
  readonly promo_code_id: string | null;
  /** When a website checkout reserved its stock (M34, D-532); null for every other order. */
  readonly stock_held_at: string | null;
  readonly notes: string | null;
  readonly created_at: string;
}

const ORDER_COLUMNS = sql`o.id, o.branch_id, o.order_no, o.channel::text as channel, o.source,
  o.customer_id, c.name as customer_name, c.phone_e164 as customer_phone,
  o.ship_name, o.ship_phone_e164, o.ship_district_id, o.ship_thana_id, o.ship_area,
  o.ship_address_line, o.delivery_zone_id, o.courier_id, o.location_id,
  o.items_poisha, o.discount_poisha, o.delivery_charge_poisha, o.advance_paid_poisha,
  o.cod_amount_poisha, o.status::text as status, o.hold_reason, o.assigned_to, o.created_by,
  o.confirmed_at, o.packed_at, o.handed_over_at, o.delivered_at, o.returned_at,
  o.cancelled_at, o.cancel_reason, o.reseller_id, o.exchange_of_order_id, o.promo_code_id,
  o.stock_held_at, o.notes, o.created_at`;

export async function insertOrder(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly branchId: string | null;
    readonly orderNo: string;
    readonly channel: string;
    readonly source: unknown;
    readonly customerId: string;
    readonly shipName: string;
    readonly shipPhoneE164: string;
    readonly shipDistrictId: number;
    readonly shipThanaId: number;
    readonly shipArea: string | null;
    readonly shipAddressLine: string;
    readonly deliveryZoneId: string | null;
    readonly courierId: string | null;
    readonly locationId: string | null;
    readonly itemsPoisha: bigint;
    readonly discountPoisha: bigint;
    readonly deliveryChargePoisha: bigint;
    readonly advancePaidPoisha: bigint;
    readonly codAmountPoisha: bigint;
    readonly promoCodeId: string | null;
    readonly assignedTo: string | null;
    readonly createdBy: string;
    readonly notes: string | null;
    readonly exchangeOfOrderId: string | null;
    /** Set when the caller reserves the stock in this transaction (M34, D-532). */
    readonly stockHeldAt?: Date | null;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.orders (
      org_id, branch_id, order_no, channel, source, customer_id,
      ship_name, ship_phone_e164, ship_district_id, ship_thana_id, ship_area, ship_address_line,
      delivery_zone_id, courier_id, location_id,
      items_poisha, discount_poisha, delivery_charge_poisha, advance_paid_poisha, cod_amount_poisha,
      promo_code_id, assigned_to, created_by, notes, exchange_of_order_id, stock_held_at
    ) values (
      ${input.orgId}, ${input.branchId}::uuid, ${input.orderNo},
      ${input.channel}::sales.order_channel, ${JSON.stringify(input.source)}::jsonb,
      ${input.customerId},
      ${input.shipName}, ${input.shipPhoneE164}, ${input.shipDistrictId}, ${input.shipThanaId},
      ${input.shipArea}, ${input.shipAddressLine},
      ${input.deliveryZoneId}::uuid, ${input.courierId}::uuid, ${input.locationId}::uuid,
      ${input.itemsPoisha.toString()}::bigint, ${input.discountPoisha.toString()}::bigint,
      ${input.deliveryChargePoisha.toString()}::bigint, ${input.advancePaidPoisha.toString()}::bigint,
      ${input.codAmountPoisha.toString()}::bigint,
      ${input.promoCodeId}::uuid, ${input.assignedTo}, ${input.createdBy}, ${input.notes},
      ${input.exchangeOfOrderId}::uuid, ${input.stockHeldAt?.toISOString() ?? null}::timestamptz
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('sales.orders insert returned no id');
  return id;
}

export async function insertOrderLine(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly skuId: string;
    readonly skuCode: string;
    readonly productName: string;
    readonly qty: number;
    readonly unitPricePoisha: bigint;
    readonly discountPoisha: bigint;
    readonly position: number;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.order_lines
      (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
       discount_poisha, position)
    values (${input.orgId}, ${input.orderId}, ${input.skuId}, ${input.skuCode},
            ${input.productName}, ${input.qty}, ${input.unitPricePoisha.toString()}::bigint,
            ${input.discountPoisha.toString()}::bigint, ${input.position})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('sales.order_lines insert returned no id');
  return id;
}

export async function orderById(tx: Tx, orgId: string, id: string): Promise<OrderRow | undefined> {
  const rows = await tx.execute<OrderRow>(sql`
    select ${ORDER_COLUMNS}
    from sales.orders o
    join sales.customers c on c.org_id = o.org_id and c.id = o.customer_id
    where o.org_id = ${orgId} and o.id = ${id}
  `);
  return rows[0];
}

/**
 * The same row, locked for the duration of the transaction.
 *
 * Every transition reads the order, asks the domain, and writes the new status. Without
 * the lock, two transitions read the same `pending` and both pass the domain's check;
 * the conditional UPDATE then saves one of them and the other's *effects* — a
 * reservation, a journal — may already have been performed. `for update` makes the read
 * and the decision one unit, so the second caller waits and then sees the moved row.
 */
export async function orderForUpdate(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<OrderRow | undefined> {
  const locked = await tx.execute<{ id: string }>(sql`
    select id from sales.orders where org_id = ${orgId} and id = ${id} for update
  `);
  if (locked.length === 0) return undefined;
  return orderById(tx, orgId, id);
}

/**
 * The same lock, narrowed to the rows the caller's permission scope reaches (§6).
 *
 * Every HTTP path into an order goes through this rather than through
 * `orderForUpdate`: the scope has to be part of the *statement*, because §6's sales cell
 * is "own orders **plus** the unassigned queue" and that is a predicate, not a filter
 * applied afterwards. Passing it in as SQL is also what marks the request's scope as
 * applied, which `ScopeInterceptor` refuses a response without.
 *
 * A row outside the scope comes back as `undefined`, and the caller answers 404 — the
 * same answer a row in another org gets from RLS, so the error cannot be used to find
 * out which orders exist.
 */
export async function lockOrderInScope(
  tx: Tx,
  orgId: string,
  id: string,
  scope: SQL,
): Promise<OrderRow | undefined> {
  const locked = await tx.execute<{ id: string }>(sql`
    select o.id from sales.orders o
    where o.org_id = ${orgId} and o.id = ${id} and ${scope}
    for update
  `);
  if (locked.length === 0) return undefined;
  return orderById(tx, orgId, id);
}

/** The same, without the lock: for a read that is only going to render something. */
export async function orderByIdInScope(
  tx: Tx,
  orgId: string,
  id: string,
  scope: SQL,
): Promise<OrderRow | undefined> {
  const rows = await tx.execute<OrderRow>(sql`
    select ${ORDER_COLUMNS}
    from sales.orders o
    join sales.customers c on c.org_id = o.org_id and c.id = o.customer_id
    where o.org_id = ${orgId} and o.id = ${id} and ${scope}
  `);
  return rows[0];
}

/**
 * The courier the parcel actually went with, recorded at handover.
 *
 * Separate from `updateOrderCommercials` because a handover happens *at* `packed`, which
 * that function refuses — and rightly: it rewrites amounts, and a packed order's amounts
 * are already on a printed invoice. The courier is not an amount; it is who is holding
 * the parcel, and §7's receivable is per courier, so it has to be right at the moment
 * the delivery posts.
 */
export async function setOrderCourier(
  tx: Tx,
  input: { readonly orgId: string; readonly orderId: string; readonly courierId: string },
): Promise<void> {
  await tx.execute(sql`
    update sales.orders set courier_id = ${input.courierId}::uuid, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.orderId}
      and status in ('pending', 'confirmed', 'on_hold', 'packed')
  `);
}

export interface OrderLineRow extends Record<string, unknown> {
  readonly id: string;
  readonly sku_id: string;
  readonly sku_code: string;
  readonly product_name: string;
  readonly qty: number;
  readonly unit_price_poisha: string;
  readonly discount_poisha: string;
  readonly delivered_qty: number;
  readonly returned_qty: number;
  readonly reseller_price_poisha: string | null;
  readonly dispatch_unit_cost_poisha: string | null;
  readonly position: number;
}

export async function orderLines(tx: Tx, orgId: string, orderId: string): Promise<OrderLineRow[]> {
  const rows = await tx.execute<OrderLineRow>(sql`
    select l.id, l.sku_id, l.sku_code, l.product_name, l.qty, l.unit_price_poisha,
           l.discount_poisha, l.delivered_qty, l.returned_qty, l.reseller_price_poisha,
           l.dispatch_unit_cost_poisha, l.position
    from sales.order_lines l
    where l.org_id = ${orgId} and l.order_id = ${orderId}
    order by l.position, l.created_at
  `);
  return [...rows];
}

/**
 * The date filter is an Asia/Dhaka calendar comparison, not a UTC one (invariant 8).
 *
 * `withOrg` sets the `app.*` GUCs and no session `TimeZone`, so `'2026-09-25'::date` is
 * midnight **UTC** — six in the morning in Dhaka. Comparing `created_at` against it filed
 * every order taken between midnight and 6 a.m. Dhaka under the previous day, which is a
 * whole shift of the order desk's evening work disappearing from the day it belongs to.
 * `sales.orders` has no `business_date` column, so the conversion happens here.
 */
export async function listOrders(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly status: string | undefined;
    readonly customerId: string | undefined;
    readonly q: string | undefined;
    readonly from: string | undefined;
    readonly to: string | undefined;
    readonly limit: number;
    readonly offset: number;
    /** M11's list filters. Each narrows; none of them can widen `scope`. */
    readonly channel?: string | undefined;
    readonly assignedTo?: string | undefined;
    readonly zoneId?: string | undefined;
  },
): Promise<OrderRow[]> {
  const pattern = filters.q === undefined ? undefined : `%${filters.q}%`;
  const rows = await tx.execute<OrderRow>(sql`
    select ${ORDER_COLUMNS}
    from sales.orders o
    join sales.customers c on c.org_id = o.org_id and c.id = o.customer_id
    where o.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.status === undefined ? sql`true` : sql`o.status = ${filters.status}::sales.order_status`}
      and ${filters.customerId === undefined ? sql`true` : sql`o.customer_id = ${filters.customerId}`}
      and ${filters.channel === undefined ? sql`true` : sql`o.channel = ${filters.channel}::sales.order_channel`}
      and ${filters.assignedTo === undefined ? sql`true` : sql`o.assigned_to = ${filters.assignedTo}`}
      and ${filters.zoneId === undefined ? sql`true` : sql`o.delivery_zone_id = ${filters.zoneId}::uuid`}
      and ${
        pattern === undefined
          ? sql`true`
          : sql`(o.order_no ilike ${pattern} or o.ship_phone_e164 ilike ${pattern} or c.name ilike ${pattern})`
      }
      and ${
        filters.from === undefined
          ? sql`true`
          : sql`(o.created_at at time zone 'Asia/Dhaka')::date >= ${filters.from}::date`
      }
      and ${
        filters.to === undefined
          ? sql`true`
          : sql`(o.created_at at time zone 'Asia/Dhaka')::date <= ${filters.to}::date`
      }
    order by o.created_at desc
    limit ${filters.limit} offset ${filters.offset}
  `);
  return [...rows];
}

/**
 * Move the status, but only from the one the caller decided against.
 *
 * Returns false when zero rows matched, which means the order moved between the read and
 * this write. The caller reports `ORDER_TRANSITION_INVALID` — the same code the domain
 * and migration 0041's trigger raise, because a client must not have to care which of
 * the three noticed.
 */
export async function setStatus(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly expected: string;
    readonly next: string;
    readonly actorUserId: string | null;
    readonly reason: string | null;
    readonly at: Date;
  },
): Promise<boolean> {
  /*
   * The timestamp is bound as text with an explicit cast, like every other timestamp in
   * this codebase's repositories.
   *
   * postgres.js refuses a `Date` bound to a parameter it has typed `timestamptz` from the
   * surrounding SQL, and the refusal is a `TypeError` from inside the driver's byte writer
   * — five frames from anything that names a column. `toISOString()` is Asia/Dhaka-safe
   * because it is UTC either way; the business *date* is computed separately by the domain
   * (invariant 8).
   */
  const at = input.at.toISOString();
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.orders set
      status = ${input.next}::sales.order_status,
      hold_reason = case when ${input.next} = 'on_hold' then ${input.reason}
                         when ${input.next} = 'confirmed' then null
                         else hold_reason end,
      confirmed_by = case when ${input.next} = 'confirmed' and confirmed_by is null
                          then ${input.actorUserId} else confirmed_by end,
      confirmed_at = case when ${input.next} = 'confirmed' and confirmed_at is null
                          then ${at}::timestamptz else confirmed_at end,
      packed_at = case when ${input.next} = 'packed' then ${at}::timestamptz else packed_at end,
      handed_over_at = case when ${input.next} = 'shipped' then ${at}::timestamptz else handed_over_at end,
      delivered_at = case when ${input.next} in ('delivered', 'partially_delivered')
                          then ${at}::timestamptz else delivered_at end,
      returned_at = case when ${input.next} = 'returned' then ${at}::timestamptz else returned_at end,
      cancelled_at = case when ${input.next} = 'cancelled' then ${at}::timestamptz else cancelled_at end,
      cancel_reason = case when ${input.next} = 'cancelled' then ${input.reason} else cancel_reason end,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.orderId}
      and status = ${input.expected}::sales.order_status
    returning id
  `);
  return rows.length > 0;
}

export async function assignOrder(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly assignedTo: string;
    /** Set for a claim: only an order nobody holds may be taken from the queue. */
    readonly onlyIfUnassigned: boolean;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.orders set assigned_to = ${input.assignedTo}, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.orderId}
      and ${input.onlyIfUnassigned ? sql`assigned_to is null` : sql`true`}
    returning id
  `);
  return rows.length > 0;
}

export async function setLineDispatchCost(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly skuId: string;
    readonly unitCostPoisha: bigint;
  },
): Promise<void> {
  await tx.execute(sql`
    update sales.order_lines
    set dispatch_unit_cost_poisha = ${input.unitCostPoisha.toString()}::bigint, updated_at = now()
    where org_id = ${input.orgId} and order_id = ${input.orderId} and sku_id = ${input.skuId}
  `);
}

export async function setLineFulfilment(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly skuId: string;
    readonly deliveredQty?: number;
    readonly returnedQty?: number;
  },
): Promise<void> {
  await tx.execute(sql`
    update sales.order_lines set
      delivered_qty = coalesce(${input.deliveredQty ?? null}, delivered_qty),
      returned_qty = coalesce(${input.returnedQty ?? null}, returned_qty),
      updated_at = now()
    where org_id = ${input.orgId} and order_id = ${input.orderId} and sku_id = ${input.skuId}
  `);
}

/**
 * Rewrite an order's commercial terms, in one statement, and only before dispatch.
 *
 * `and status in ('pending', 'confirmed', 'on_hold')` is not belt and braces for the
 * trigger in 0041 — the trigger freezes the *lines*, and this freezes the order's own
 * amounts. Without it an edit could change the COD of a parcel already with a courier,
 * and the rider would collect a figure the invoice in the box does not show.
 *
 * All five amounts move together because `orders_cod_matches_formula` re-derives the COD
 * from the other four: updating them one at a time is not a slower version of this, it
 * is a statement the database refuses.
 */
export async function updateOrderCommercials(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly itemsPoisha: bigint;
    readonly discountPoisha: bigint;
    readonly deliveryChargePoisha: bigint;
    readonly advancePaidPoisha: bigint;
    readonly codAmountPoisha: bigint;
    readonly shipName: string;
    readonly shipPhoneE164: string;
    readonly shipDistrictId: number;
    readonly shipThanaId: number;
    readonly shipArea: string | null;
    readonly shipAddressLine: string;
    readonly deliveryZoneId: string | null;
    readonly courierId: string | null;
    readonly locationId: string | null;
    readonly notes: string | null;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.orders set
      items_poisha = ${input.itemsPoisha.toString()}::bigint,
      discount_poisha = ${input.discountPoisha.toString()}::bigint,
      delivery_charge_poisha = ${input.deliveryChargePoisha.toString()}::bigint,
      advance_paid_poisha = ${input.advancePaidPoisha.toString()}::bigint,
      cod_amount_poisha = ${input.codAmountPoisha.toString()}::bigint,
      ship_name = ${input.shipName},
      ship_phone_e164 = ${input.shipPhoneE164},
      ship_district_id = ${input.shipDistrictId},
      ship_thana_id = ${input.shipThanaId},
      ship_area = ${input.shipArea},
      ship_address_line = ${input.shipAddressLine},
      delivery_zone_id = ${input.deliveryZoneId}::uuid,
      courier_id = ${input.courierId}::uuid,
      location_id = ${input.locationId}::uuid,
      notes = ${input.notes},
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.orderId}
      and status in ('pending', 'confirmed', 'on_hold')
    returning id
  `);
  return rows.length > 0;
}

/**
 * Remove every line, so the edit can write the new set.
 *
 * Delete-and-reinsert rather than a diff, because `order_lines_org_order_sku_idx` makes
 * a SKU appear at most once per order: a diff would have to decide, for each SKU,
 * whether it is new, changed or gone, and get all three right against a unique index.
 * The trigger in 0041 refuses the DELETE once the order has shipped, which is the real
 * guard — this function cannot be used to rewrite a dispatched parcel.
 */
export async function deleteOrderLines(tx: Tx, orgId: string, orderId: string): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    delete from sales.order_lines
    where org_id = ${orgId} and order_id = ${orderId}
    returning id
  `);
  return rows.length;
}

/**
 * Put an advance against an order: the liability grows and the COD shrinks.
 *
 * `and cod_amount_poisha >= amount` is §9's "the domain rejects a negative COD", said in
 * SQL. Zero rows updated means the buyer has offered more than the order is worth, and
 * the caller refuses rather than letting the rider hand money back at the door — the
 * remainder belongs in `customer_advance` as a store credit, which is what the exchange
 * flow does with it.
 */
export async function applyAdvance(
  tx: Tx,
  input: { readonly orgId: string; readonly orderId: string; readonly amountPoisha: bigint },
): Promise<boolean> {
  const amount = input.amountPoisha.toString();
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.orders set
      advance_paid_poisha = advance_paid_poisha + ${amount}::bigint,
      cod_amount_poisha = cod_amount_poisha - ${amount}::bigint,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.orderId}
      and cod_amount_poisha >= ${amount}::bigint
      and status in ('pending', 'confirmed', 'on_hold', 'packed')
    returning id
  `);
  return rows.length > 0;
}

/**
 * Take a voided advance back off an order (M17, D-236): the liability shrinks and the COD
 * grows again. Only before the parcel moves, and never below zero: the same guards as
 * `applyAdvance`, the other way round.
 */
export async function unapplyAdvance(
  tx: Tx,
  input: { readonly orgId: string; readonly orderId: string; readonly amountPoisha: bigint },
): Promise<boolean> {
  const amount = input.amountPoisha.toString();
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.orders set
      advance_paid_poisha = advance_paid_poisha - ${amount}::bigint,
      cod_amount_poisha = cod_amount_poisha + ${amount}::bigint,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.orderId}
      and advance_paid_poisha >= ${amount}::bigint
      and status in ('pending', 'confirmed', 'on_hold', 'packed')
    returning id
  `);
  return rows.length > 0;
}

// --- the order's own history --------------------------------------------------

export async function insertOrderEvent(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly trigger: string;
    readonly reason: string | null;
    readonly actorUserId: string | null;
    readonly businessDate: string;
    readonly occurredAt: Date;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into sales.order_events
      (org_id, order_id, from_status, to_status, trigger, reason, actor_user_id,
       business_date, occurred_at)
    values (${input.orgId}, ${input.orderId},
            ${input.fromStatus}::sales.order_status, ${input.toStatus}::sales.order_status,
            ${input.trigger}, ${input.reason}, ${input.actorUserId},
            ${input.businessDate}::date, ${input.occurredAt.toISOString()}::timestamptz)
  `);
}

export interface OrderEventRow extends Record<string, unknown> {
  readonly id: string;
  readonly from_status: string | null;
  readonly to_status: string;
  readonly trigger: string;
  readonly reason: string | null;
  readonly actor_user_id: string | null;
  readonly occurred_at: string;
}

export async function orderEvents(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<OrderEventRow[]> {
  const rows = await tx.execute<OrderEventRow>(sql`
    select e.id, e.from_status::text as from_status, e.to_status::text as to_status,
           e.trigger, e.reason, e.actor_user_id, e.occurred_at
    from sales.order_events e
    where e.org_id = ${orgId} and e.order_id = ${orderId}
    order by e.occurred_at, e.created_at
  `);
  return [...rows];
}

// --- what other schemas this module has to ask -------------------------------

/**
 * One of the ledger accounts §7's order rules name.
 *
 * Reads `ledger.accounts` directly, which is the established pattern rather than an
 * exception: M07's inventory module resolves its four accounts the same way. Invariant
 * 12 is about who may *write* another module's tables and who decides when to post —
 * both of which stay with the ledger, because every journal here goes through
 * `LEDGER_API.post` with a posting rule from `packages/domain/src/posting`.
 */
export async function accountBySubtype(
  tx: Tx,
  orgId: string,
  subtype: string,
): Promise<{ id: string; branch_id: string | null } | undefined> {
  const rows = await tx.execute<{ id: string; branch_id: string | null }>(sql`
    select id, branch_id from ledger.accounts
    where org_id = ${orgId} and subtype = ${subtype}::ledger.account_subtype and is_active
    order by branch_id nulls first
    limit 1
  `);
  return rows[0];
}

export async function accountById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ id: string; subtype: string; branch_id: string | null } | undefined> {
  const rows = await tx.execute<{ id: string; subtype: string; branch_id: string | null }>(sql`
    select id, subtype::text as subtype, branch_id from ledger.accounts
    where org_id = ${orgId} and id = ${id} and is_active
  `);
  return rows[0];
}

/**
 * Where an order fulfils from, when the caller named no location.
 *
 * The org's first active warehouse, by code. A convention rather than a setting because
 * four of the five brands have exactly one, and the fifth names the location on the
 * order — which is the whole reason `orders.location_id` exists (D-172).
 */
export async function defaultFulfilmentLocation(
  tx: Tx,
  orgId: string,
  branchId: string | null,
): Promise<{ id: string; branch_id: string | null } | undefined> {
  const rows = await tx.execute<{ id: string; branch_id: string | null }>(sql`
    select id, branch_id from org.locations
    where org_id = ${orgId} and is_active and kind = 'warehouse'
      and (${branchId}::uuid is null or branch_id = ${branchId}::uuid or branch_id is null)
    order by (branch_id is not distinct from ${branchId}::uuid) desc, code
    limit 1
  `);
  return rows[0];
}

/**
 * What kind of place a location is, so an order cannot ship from the wrong one.
 *
 * `org.locations` has four kinds (§8) and only two of them are places an order goes out
 * from. The composite foreign key on `orders.location_id` keeps the id inside the org and
 * says nothing about the kind — so without this an order could reserve and dispatch from the
 * `damaged` shelf, which is precisely how damaged stock gets sold without the write-off
 * approval that the return path is careful to preserve.
 */
export async function locationKind(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<{ kind: string; branch_id: string | null } | undefined> {
  const rows = await tx.execute<{ kind: string; branch_id: string | null }>(sql`
    select kind::text as kind, branch_id from org.locations
    where org_id = ${orgId} and id = ${id} and is_active
  `);
  return rows[0];
}

/** The `damaged` shelf, for units that came back unsellable (§8). */
export async function damagedLocation(tx: Tx, orgId: string): Promise<{ id: string } | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from org.locations
    where org_id = ${orgId} and is_active and kind = 'damaged' order by code limit 1
  `);
  return rows[0];
}

export async function areaNames(
  tx: Tx,
  districtId: number,
  thanaId: number,
): Promise<
  { district_en: string; district_bn: string; thana_en: string; thana_bn: string } | undefined
> {
  const rows = await tx.execute<{
    district_en: string;
    district_bn: string;
    thana_en: string;
    thana_bn: string;
  }>(sql`
    select d.name_en as district_en, d.name_bn as district_bn,
           t.name_en as thana_en, t.name_bn as thana_bn
    from ref.thanas t join ref.districts d on d.id = t.district_id
    where t.id = ${thanaId} and d.id = ${districtId}
  `);
  return rows[0];
}

/** The org's brand block, for the documents in §22. */
export async function orgBrand(
  tx: Tx,
  orgId: string,
): Promise<{ display_name: string; legal_name: string; brand: unknown } | undefined> {
  const rows = await tx.execute<{ display_name: string; legal_name: string; brand: unknown }>(sql`
    select display_name, legal_name, brand from org.organizations where id = ${orgId}
  `);
  return rows[0];
}

// --- M18: what the marketing module may know about orders -------------------------------

export interface MarketingFactRow extends Record<string, unknown> {
  readonly id: string;
  readonly channel: string;
  readonly status: string;
  readonly source: unknown;
  readonly promo_code_id: string | null;
  readonly items_poisha: string;
  readonly discount_poisha: string;
  readonly delivery_charge_poisha: string;
  readonly confirmed_at: Date | null;
  readonly delivered_at: Date | null;
  readonly returned_at: Date | null;
}

/**
 * Every order confirmed, delivered or returned on an Asia/Dhaka date in `[from, to]`.
 *
 * The three dates are §11's period membership (D-255); the comparison is a Dhaka calendar
 * one for the reason `listOrders` gives. No phone, no name, no cost.
 */
export async function marketingFactRows(
  tx: Tx,
  orgId: string,
  period: { readonly from: string; readonly to: string },
): Promise<MarketingFactRow[]> {
  const inPeriod = (column: SQL) =>
    sql`(${column} is not null and (${column} at time zone 'Asia/Dhaka')::date between ${period.from}::date and ${period.to}::date)`;
  const rows = await tx.execute<MarketingFactRow>(sql`
    select o.id, o.channel::text as channel, o.status::text as status, o.source,
           o.promo_code_id, o.items_poisha::text, o.discount_poisha::text,
           o.delivery_charge_poisha::text, o.confirmed_at, o.delivered_at, o.returned_at
    from sales.orders o
    where o.org_id = ${orgId}
      and (${inPeriod(sql`o.confirmed_at`)} or ${inPeriod(sql`o.delivered_at`)}
           or ${inPeriod(sql`o.returned_at`)})
    order by o.id
  `);
  return [...rows];
}

/** What delivered revenue needs from an order's line: quantities and prices, no cost. */
export interface RevenueLineRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly qty: number;
  readonly unit_price_poisha: string;
  readonly discount_poisha: string;
  readonly delivered_qty: number;
}

/**
 * The lines of several orders at once, for delivered revenue (M18's dashboard).
 *
 * The ids travel as one array parameter: a period can hold more delivered orders than
 * PostgreSQL's 65,535 bind parameters, which one parameter per id would hit.
 */
export async function linesForOrders(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<RevenueLineRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.execute<RevenueLineRow>(sql`
    select l.order_id, l.qty, l.unit_price_poisha, l.discount_poisha, l.delivered_qty
    from sales.order_lines l
    where l.org_id = ${orgId}
      and l.order_id = any (${sql.param([...orderIds])}::uuid[])
    order by l.order_id, l.position, l.created_at
  `);
  return [...rows];
}

// --- M20: what each agent's orders came to, per Dhaka day ------------------------

export interface ConfirmedCountRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly business_date: string;
  readonly n: number;
}

/**
 * Orders each agent confirmed, per Asia/Dhaka day (D-272).
 *
 * `confirmed_by` is set once, by the transition that confirmed the order, so it is the
 * agent who did the work rather than whoever holds the order now. An order cancelled after
 * it was confirmed counts for nobody: a target on confirmed orders would otherwise pay for
 * confirming an order and cancelling it a minute later.
 */
export async function confirmedCounts(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<ConfirmedCountRow[]> {
  const rows = await tx.execute<ConfirmedCountRow>(sql`
    select o.confirmed_by as user_id,
           (o.confirmed_at at time zone 'Asia/Dhaka')::date::text as business_date,
           count(*)::int as n
    from sales.orders o
    where o.org_id = ${orgId}
      and o.confirmed_by is not null
      and o.status <> 'cancelled'
      and o.confirmed_at >= (${from}::date::timestamp at time zone 'Asia/Dhaka')
      and o.confirmed_at < ((${to}::date + 1)::timestamp at time zone 'Asia/Dhaka')
    group by 1, 2
  `);
  return [...rows];
}

export interface DeliveredOrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly user_id: string;
  readonly business_date: string;
  readonly discount_poisha: string;
  readonly delivery_charge_poisha: string;
}

/**
 * Orders confirmed by an agent and delivered, in full or in part, inside the range (D-272).
 *
 * Dated by the delivery, not the confirmation: a delivered-orders target is about what
 * reached a buyer this month. A partial delivery that later came back keeps its delivered
 * units (`delivered_qty`), which is what the revenue journal recognised.
 */
export async function deliveredOrders(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<DeliveredOrderRow[]> {
  const rows = await tx.execute<DeliveredOrderRow>(sql`
    select o.id, o.confirmed_by as user_id,
           (o.delivered_at at time zone 'Asia/Dhaka')::date::text as business_date,
           o.discount_poisha::text as discount_poisha,
           o.delivery_charge_poisha::text as delivery_charge_poisha
    from sales.orders o
    where o.org_id = ${orgId}
      and o.confirmed_by is not null
      and o.delivered_at >= (${from}::date::timestamp at time zone 'Asia/Dhaka')
      and o.delivered_at < ((${to}::date + 1)::timestamp at time zone 'Asia/Dhaka')
      and exists (
        select 1 from sales.order_lines l
        where l.org_id = o.org_id and l.order_id = o.id and l.delivered_qty > 0
      )
  `);
  return [...rows];
}

export interface DeliveredLineRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly qty: number;
  readonly unit_price_poisha: string;
  readonly discount_poisha: string;
  readonly delivered_qty: number;
}

/**
 * The lines of those orders, for `computePartialDelivery`. Prices only, never a cost.
 *
 * One array parameter, as `linesForOrders` does: a month can hold more delivered orders
 * than PostgreSQL's 65,535 bind parameters.
 */
export async function linesOfOrders(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<DeliveredLineRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.execute<DeliveredLineRow>(sql`
    select l.order_id, l.qty, l.unit_price_poisha::text as unit_price_poisha,
           l.discount_poisha::text as discount_poisha, l.delivered_qty
    from sales.order_lines l
    where l.org_id = ${orgId}
      and l.order_id = any (${sql.param([...orderIds])}::uuid[])
    order by l.order_id, l.position
  `);
  return [...rows];
}

// --- M24: what the analytics rollup is built from ---------------------------------

export interface AnalyticsFactRow extends Record<string, unknown> {
  readonly id: string;
  readonly channel: string;
  readonly branch_id: string | null;
  readonly discount_poisha: string;
  readonly delivery_charge_poisha: string;
  readonly created_on: string;
  readonly confirmed_on: string | null;
  readonly delivered_on: string | null;
  readonly returned_on: string | null;
  readonly cancelled_on: string | null;
  readonly outside_dhaka: boolean;
}

/**
 * Every order that had something happen inside the range, with the Dhaka day of each
 * thing (D-321): created, confirmed, delivered (in full or in part), returned, and
 * cancelled — the last only for an order that had been confirmed first.
 *
 * "Outside Dhaka" is the ship-to district, not the brand's delivery zones: zones are each
 * brand's own configuration, and a rule that compares brands needs one definition.
 */
export async function analyticsFactRows(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
): Promise<AnalyticsFactRow[]> {
  const start = sql`(${from}::date::timestamp at time zone 'Asia/Dhaka')`;
  const end = sql`((${to}::date + 1)::timestamp at time zone 'Asia/Dhaka')`;
  const within = (column: SQL) => sql`(${column} >= ${start} and ${column} < ${end})`;
  const day = (column: SQL) => sql`(${column} at time zone 'Asia/Dhaka')::date::text`;
  const rows = await tx.execute<AnalyticsFactRow>(sql`
    select o.id, o.channel::text as channel, o.branch_id,
           o.discount_poisha::text as discount_poisha,
           o.delivery_charge_poisha::text as delivery_charge_poisha,
           ${day(sql`o.created_at`)} as created_on,
           ${day(sql`o.confirmed_at`)} as confirmed_on,
           ${day(sql`o.delivered_at`)} as delivered_on,
           ${day(sql`o.returned_at`)} as returned_on,
           case when o.confirmed_at is not null then ${day(sql`o.cancelled_at`)} end
             as cancelled_on,
           o.ship_district_id is distinct from
             (select d.id from ref.districts d where d.name_en = 'Dhaka') as outside_dhaka
    from sales.orders o
    where o.org_id = ${orgId}
      and (${within(sql`o.created_at`)} or ${within(sql`o.confirmed_at`)}
           or ${within(sql`o.delivered_at`)} or ${within(sql`o.returned_at`)}
           or ${within(sql`o.cancelled_at`)})
    order by o.id
  `);
  return [...rows];
}

export interface AnalyticsLineRow extends DeliveredLineRow {
  /** Purchase cost (invariant 5), read here only to derive gross profit. */
  readonly dispatch_unit_cost_poisha: string | null;
}

/** The lines of those orders: prices for revenue, dispatch cost for gross profit. */
export async function analyticsLines(
  tx: Tx,
  orgId: string,
  orderIds: readonly string[],
): Promise<AnalyticsLineRow[]> {
  if (orderIds.length === 0) return [];
  const rows = await tx.execute<AnalyticsLineRow>(sql`
    select l.order_id, l.qty, l.unit_price_poisha::text as unit_price_poisha,
           l.discount_poisha::text as discount_poisha, l.delivered_qty,
           l.dispatch_unit_cost_poisha::text as dispatch_unit_cost_poisha
    from sales.order_lines l
    where l.org_id = ${orgId}
      and l.order_id = any (${sql.param([...orderIds])}::uuid[])
    order by l.order_id, l.position
  `);
  return [...rows];
}

export interface TopSkuRow extends Record<string, unknown> {
  readonly sku_id: string;
  readonly sku_code: string;
  readonly product_name: string;
  readonly units: number;
}

/** The SKUs with the most units delivered inside the range, by delivery date (M24). */
export async function topSkus(
  tx: Tx,
  orgId: string,
  from: string,
  to: string,
  limit: number,
): Promise<TopSkuRow[]> {
  const rows = await tx.execute<TopSkuRow>(sql`
    select l.sku_id, l.sku_code, min(l.product_name) as product_name,
           sum(l.delivered_qty)::int as units
    from sales.order_lines l
    join sales.orders o on o.org_id = l.org_id and o.id = l.order_id
    where l.org_id = ${orgId}
      and l.delivered_qty > 0
      and o.delivered_at >= (${from}::date::timestamp at time zone 'Asia/Dhaka')
      and o.delivered_at < ((${to}::date + 1)::timestamp at time zone 'Asia/Dhaka')
    group by l.sku_id, l.sku_code
    order by units desc, l.sku_code
    limit ${limit}
  `);
  return [...rows];
}

/** The largest value a Postgres `integer` holds; the geography ids are `integer`. */
const INT4_MAX = 2_147_483_647;

/**
 * Whether a district and a thana exist and the thana lies in the district (M30, D2).
 *
 * The schemas only say "a positive integer". An id the reference data does not have used to
 * reach the insert and fail its foreign key, or overflow `integer`, as a 500. That was a
 * 500 any landing-page visitor could cause, and the driver's error quoted the row it refused
 * (name, phone, address) into the log. A thana from another district was accepted and
 * priced at the claimed district's delivery charge.
 */
export async function areaExists(tx: Tx, districtId: number, thanaId: number): Promise<boolean> {
  if (districtId > INT4_MAX || thanaId > INT4_MAX) return false;
  const rows = await tx.execute<{ ok: boolean }>(sql`
    select exists (
      select 1 from ref.thanas t where t.id = ${thanaId} and t.district_id = ${districtId}
    ) as ok
  `);
  return rows[0]?.ok === true;
}

/**
 * A buyer's orders that were not cancelled (M35a, D-543): what a first-order-only discount
 * asks. A cancelled order never was a purchase, so a buyer whose only order was cancelled
 * is still on their first.
 */
export async function standingOrderCount(
  tx: Tx,
  orgId: string,
  customerId: string,
  excludingOrderId: string | null = null,
): Promise<number> {
  const rows = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from sales.orders
    where org_id = ${orgId} and customer_id = ${customerId} and status <> 'cancelled'
      and ${excludingOrderId === null ? sql`true` : sql`id <> ${excludingOrderId}`}
  `);
  return rows[0]?.n ?? 0;
}

// --- M34: the website's questions (through `OrdersApi`) --------------------------------------

/** The buyer this E.164 phone names in the brand, or undefined. */
export async function buyerIdByPhone(
  tx: Tx,
  orgId: string,
  phoneE164: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from sales.customers where org_id = ${orgId} and phone_e164 = ${phoneE164}
  `);
  return rows[0]?.id;
}

/** Order headers by id, for the website's order list and view: selling-side money only. */
export interface ShopperOrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_no: string;
  readonly channel: string;
  readonly status: string;
  readonly customer_id: string;
  readonly ship_name: string;
  readonly ship_phone_e164: string;
  readonly ship_district_id: number;
  readonly ship_thana_id: number;
  readonly ship_area: string | null;
  readonly ship_address_line: string;
  readonly items_poisha: string;
  readonly discount_poisha: string;
  readonly delivery_charge_poisha: string;
  readonly advance_paid_poisha: string;
  readonly cod_amount_poisha: string;
  readonly courier_id: string | null;
  readonly created_at: string;
  readonly confirmed_at: string | null;
  readonly handed_over_at: string | null;
  readonly delivered_at: string | null;
  readonly returned_at: string | null;
  readonly cancelled_at: string | null;
  readonly line_count: number;
  readonly unit_count: number;
  readonly district_en: string | null;
  readonly district_bn: string | null;
  readonly thana_en: string | null;
  readonly thana_bn: string | null;
}

export async function shopperOrderRows(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<ShopperOrderRow[]> {
  if (ids.length === 0) return [];
  return tx.execute<ShopperOrderRow>(sql`
    select o.id, o.order_no, o.channel::text as channel, o.status::text as status, o.customer_id,
           o.ship_name, o.ship_phone_e164, o.ship_district_id, o.ship_thana_id, o.ship_area,
           o.ship_address_line, o.items_poisha::text as items_poisha,
           o.discount_poisha::text as discount_poisha,
           o.delivery_charge_poisha::text as delivery_charge_poisha,
           o.advance_paid_poisha::text as advance_paid_poisha,
           o.cod_amount_poisha::text as cod_amount_poisha, o.courier_id,
           o.created_at, o.confirmed_at, o.handed_over_at, o.delivered_at, o.returned_at,
           o.cancelled_at,
           (select count(*)::int from sales.order_lines l
             where l.org_id = o.org_id and l.order_id = o.id) as line_count,
           (select coalesce(sum(l.qty), 0)::int from sales.order_lines l
             where l.org_id = o.org_id and l.order_id = o.id) as unit_count,
           d.name_en as district_en, d.name_bn as district_bn,
           t.name_en as thana_en, t.name_bn as thana_bn
    from sales.orders o
    left join ref.districts d on d.id = o.ship_district_id
    left join ref.thanas t on t.id = o.ship_thana_id
    where o.org_id = ${orgId} and o.id = any (${sql.param([...ids])}::uuid[])
  `);
}

/** What packing needs of orders (M35b, D-554, D-555): the scope columns and the note too. */
export interface PackingOrderRow extends ShopperOrderRow {
  readonly notes: string | null;
  readonly branch_id: string | null;
  readonly created_by: string;
  readonly assigned_to: string | null;
}

export async function packingOrderRows(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<PackingOrderRow[]> {
  if (ids.length === 0) return [];
  return tx.execute<PackingOrderRow>(sql`
    select o.id, o.order_no, o.channel::text as channel, o.status::text as status, o.customer_id,
           o.ship_name, o.ship_phone_e164, o.ship_district_id, o.ship_thana_id, o.ship_area,
           o.ship_address_line, o.items_poisha::text as items_poisha,
           o.discount_poisha::text as discount_poisha,
           o.delivery_charge_poisha::text as delivery_charge_poisha,
           o.advance_paid_poisha::text as advance_paid_poisha,
           o.cod_amount_poisha::text as cod_amount_poisha, o.courier_id,
           o.created_at, o.confirmed_at, o.handed_over_at, o.delivered_at, o.returned_at,
           o.cancelled_at, o.notes, o.branch_id, o.created_by, o.assigned_to,
           (select count(*)::int from sales.order_lines l
             where l.org_id = o.org_id and l.order_id = o.id) as line_count,
           (select coalesce(sum(l.qty), 0)::int from sales.order_lines l
             where l.org_id = o.org_id and l.order_id = o.id) as unit_count,
           d.name_en as district_en, d.name_bn as district_bn,
           t.name_en as thana_en, t.name_bn as thana_bn
    from sales.orders o
    left join ref.districts d on d.id = o.ship_district_id
    left join ref.thanas t on t.id = o.ship_thana_id
    where o.org_id = ${orgId} and o.id = any (${sql.param([...ids])}::uuid[])
  `);
}

export interface PackingLineRow extends Record<string, unknown> {
  readonly order_id: string;
  readonly sku_id: string;
  readonly sku_code: string;
  readonly product_name: string;
  readonly qty: number;
  readonly returned_qty: number;
  readonly unit_price_poisha: string;
}

/** The lines of several orders as packing sees them, in each order's own order. No cost. */
export async function packingLines(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<PackingLineRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<PackingLineRow>(sql`
    select l.order_id, l.sku_id, l.sku_code, l.product_name, l.qty, l.returned_qty,
           l.unit_price_poisha::text as unit_price_poisha
    from sales.order_lines l
    where l.org_id = ${orgId} and l.order_id = any (${sql.param([...ids])}::uuid[])
    order by l.order_id, l.position, l.created_at
  `);
  return [...rows];
}

/** An order's id by its number, or undefined. */
export async function orderIdByNo(
  tx: Tx,
  orgId: string,
  orderNo: string,
): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from sales.orders where org_id = ${orgId} and order_no = ${orderNo}
  `);
  return rows[0]?.id;
}

export interface RetentionFactRow extends Record<string, unknown> {
  readonly id: string;
  readonly status: string;
  readonly status_since: Date | string | null;
}

/**
 * When each order reached its current status (M38b, D-612): the latest history row into that
 * status, else the status's own column. For the packing video's retention.
 */
export async function retentionFacts(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<RetentionFactRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<RetentionFactRow>(sql`
    select o.id, o.status::text as status,
           coalesce(
             (select max(e.occurred_at) from sales.order_events e
               where e.org_id = o.org_id and e.order_id = o.id and e.to_status = o.status),
             case o.status
               when 'delivered' then o.delivered_at
               when 'partially_delivered' then o.delivered_at
               when 'returned' then o.returned_at
               when 'cancelled' then o.cancelled_at
               else null
             end
           ) as status_since
    from sales.orders o
    where o.org_id = ${orgId} and o.id = any (${sql.param([...ids])}::uuid[])
  `);
  return [...rows];
}

/** Of these orders, the ones inside a scope fragment over `o` (M38b). */
export async function orderIdsInScope(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
  scope: SQL,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<{ id: string }>(sql`
    select o.id from sales.orders o
    where o.org_id = ${orgId} and o.id = any (${sql.param([...ids])}::uuid[]) and ${scope}
  `);
  return rows.map((row) => row.id);
}

// --- M42: what the inbox asks of a buyer and an order (D-740, D-742) -----------------------

export interface RecentOrderRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_no: string;
  readonly status: string;
  readonly channel: string;
  readonly cod_amount_poisha: string;
  readonly created_at: string | Date;
}

/** A buyer's newest orders within a viewer's order scope (the inbox panel's list, D-740). */
export async function recentOrdersOfCustomer(
  tx: Tx,
  orgId: string,
  customerId: string,
  limit: number,
  scope: SQL,
): Promise<RecentOrderRow[]> {
  const rows = await tx.execute<RecentOrderRow>(sql`
    select o.id, o.order_no, o.status::text as status, o.channel::text as channel,
           o.cod_amount_poisha::text as cod_amount_poisha, o.created_at
    from sales.orders o
    where o.org_id = ${orgId} and o.customer_id = ${customerId} and ${scope}
    order by o.created_at desc
    limit ${limit}
  `);
  return [...rows];
}

/**
 * A buyer the viewer may open (D-740), by `CustomersService.assertVisible`'s rule: an order of
 * theirs in the viewer's order scope, or no order at all yet.
 */
export async function customerReachableIn(
  tx: Tx,
  orgId: string,
  customerId: string,
  scope: SQL,
): Promise<boolean> {
  const rows = await tx.execute<{ reachable: boolean }>(sql`
    select (
      exists (select 1 from sales.orders o
              where o.org_id = c.org_id and o.customer_id = c.id and ${scope})
      or not exists (select 1 from sales.orders o
                     where o.org_id = c.org_id and o.customer_id = c.id)
    ) as reachable
    from sales.customers c
    where c.org_id = ${orgId} and c.id = ${customerId}
  `);
  return rows[0]?.reachable === true;
}

/** The buyer of an order and the inbox conversation its `source` names, if any (D-742). */
export async function inboxOriginOf(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<
  { customer_id: string; phone_e164: string; inbox_conversation_id: string | null } | undefined
> {
  const rows = await tx.execute<{
    customer_id: string;
    phone_e164: string;
    inbox_conversation_id: string | null;
  }>(sql`
    select o.customer_id, c.phone_e164, o.source ->> 'inboxConversationId' as inbox_conversation_id
    from sales.orders o
    join sales.customers c on c.org_id = o.org_id and c.id = o.customer_id
    where o.org_id = ${orgId} and o.id = ${orderId}
  `);
  return rows[0];
}
