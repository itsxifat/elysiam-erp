import { randomUUID } from 'node:crypto';

import { seedAccountId } from '@elysium/db';
import { addDays, type IsoDate } from '@elysium/domain';
import postgres, { type TransactionSql } from 'postgres';

/**
 * A brand's working data, written into a real brand database the way its own modules leave
 * it: rollup days, posted journals, orders, a catalog with stock, staff and a campaign.
 *
 * Written as the brand's `erp_owner` inside the brand org's context (FORCE RLS binds the
 * owner too, so every row goes through the same policies the app's do). The amounts scale
 * with `scale`, so two brands seeded with different scales give different figures, and
 * the overview test can tell a sum from a copy.
 */

export interface BrandFixture {
  readonly orgId: string;
  readonly courierId: string;
}

const ORDER_PREFIX: Record<number, string> = { 1: 'TA', 2: 'TB', 3: 'TC' };

async function postJournal(
  tx: TransactionSql,
  orgId: string,
  businessDate: string,
  lines: readonly {
    readonly account: string;
    readonly debit?: bigint;
    readonly credit?: bigint;
    readonly branchId?: string | null;
    readonly partyType?: string | null;
    readonly partyId?: string | null;
  }[],
): Promise<void> {
  const sourceId = randomUUID();
  const [journal] = await tx<{ id: string }[]>`
    insert into ledger.journals
      (org_id, business_date, source_type, source_id, idempotency_key, content_hash, created_by,
       created_txid)
    values (${orgId}, ${businessDate}::date, 'fixture', ${sourceId},
            ${`fixture:${sourceId}:posted`}, 'fixture', 'usr_fixture', '1'::xid8)
    returning id
  `;
  if (journal === undefined) throw new Error('journal insert returned nothing');
  for (const [index, line] of lines.entries()) {
    await tx`
      insert into ledger.journal_lines
        (org_id, journal_id, line_no, account_id, branch_id, party_type, party_id,
         debit_poisha, credit_poisha)
      values (${orgId}, ${journal.id}, ${index + 1}, ${seedAccountId(orgId, line.account)},
              ${line.branchId ?? null}::uuid, ${line.partyType ?? null}::ledger.party_type,
              ${line.partyId ?? null}::uuid, ${(line.debit ?? 0n).toString()},
              ${(line.credit ?? 0n).toString()})
    `;
  }
}

/** Rollup days ending `today`, a few in the month before, all scaled. */
export function fixtureDays(today: IsoDate, scale: number) {
  const days: {
    date: IsoDate;
    placed: number;
    confirmed: number;
    delivered: number;
    returned: number;
    cancelled: number;
    revenue: bigint;
    gross: bigint;
    spend: bigint;
    pickups: number;
    pickupSeconds: number;
    outsideDelivered: number;
    outsideReturned: number;
  }[] = [];
  for (let back = 0; back < 40; back += 1) {
    const date = addDays(today, -back);
    const k = back + 1;
    days.push({
      date,
      placed: (10 + (k % 7)) * scale,
      confirmed: (8 + (k % 5)) * scale,
      delivered: (6 + (k % 4)) * scale,
      returned: (k % 3) * scale,
      cancelled: k % 2,
      revenue: BigInt((6 + (k % 4)) * scale) * 145_050n,
      gross: BigInt((6 + (k % 4)) * scale) * 52_525n,
      spend: BigInt(scale) * BigInt(30_000 + k * 1_000),
      pickups: 5 * scale,
      pickupSeconds: 5 * scale * (90 + k),
      outsideDelivered: k % 4,
      outsideReturned: k % 2,
    });
  }
  return days;
}

export async function seedBrandFixture(input: {
  readonly ownerUrl: string;
  readonly orgId: string;
  readonly scale: number;
  readonly today: IsoDate;
  /** A prefix for order numbers, so two orgs in one database do not collide. */
  readonly orderSeries: 1 | 2 | 3;
}): Promise<BrandFixture> {
  const { orgId, scale, today } = input;
  const sql = postgres(input.ownerUrl, { max: 1, onnotice: () => undefined });
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('app.org_id', ${orgId}, true)`;
      await tx`select set_config('app.user_id', 'usr_fixture', true)`;

      const [branch] = await tx<{ id: string; code: string }[]>`
        select id::text as id, code from org.branches where org_id = ${orgId} and code = 'HQ'
      `;
      const [location] = await tx<{ id: string }[]>`
        select id::text as id from org.locations where org_id = ${orgId} order by code limit 1
      `;
      const [courier] = await tx<{ id: string }[]>`
        select id::text as id from sales.couriers where org_id = ${orgId} and code = 'steadfast'
      `;
      const [supplier] = await tx<{ id: string }[]>`
        select id::text as id from supply.suppliers where org_id = ${orgId} order by code limit 1
      `;
      if (!branch || !location || !courier || !supplier) {
        throw new Error('seedBrandFixture needs seedDemoSetUp(orgId) first');
      }

      // --- the rollups the brand's analytics job writes ---------------------------------
      const [campaign] = await tx<{ id: string }[]>`
        insert into marketing.campaigns (org_id, name, platform, created_by)
        values (${orgId}, ${`Eid drop x${String(scale)}`}, 'meta', 'usr_fixture')
        returning id::text as id
      `;
      for (const day of fixtureDays(today, scale)) {
        await tx`
          insert into analytics.daily_org
            (org_id, business_date, orders_placed, orders_confirmed, orders_delivered,
             orders_returned, orders_cancelled, delivered_revenue_poisha, gross_profit_poisha,
             delivered_outside_dhaka, returned_outside_dhaka, spend_poisha, pickup_count,
             pickup_seconds)
          values (${orgId}, ${day.date}::date, ${day.placed}, ${day.confirmed}, ${day.delivered},
                  ${day.returned}, ${day.cancelled}, ${day.revenue.toString()},
                  ${day.gross.toString()}, ${day.outsideDelivered}, ${day.outsideReturned},
                  ${day.spend.toString()}, ${day.pickups}, ${day.pickupSeconds})
        `;
        const facebookDelivered = Math.ceil(day.delivered / 2);
        for (const [channel, delivered] of [
          ['facebook', facebookDelivered],
          ['website', day.delivered - facebookDelivered],
        ] as const) {
          await tx`
            insert into analytics.daily_channel
              (org_id, business_date, channel, orders_placed, orders_confirmed, orders_delivered,
               delivered_revenue_poisha, gross_profit_poisha)
            values (${orgId}, ${day.date}::date, ${channel}, ${delivered}, ${delivered},
                    ${delivered}, ${(BigInt(delivered) * 145_050n).toString()},
                    ${(BigInt(delivered) * 52_525n).toString()})
          `;
        }
        await tx`
          insert into analytics.daily_campaign
            (org_id, business_date, campaign_id, spend_poisha, orders_confirmed,
             orders_delivered, orders_returned, delivered_revenue_poisha, placed_revenue_poisha)
          values (${orgId}, ${day.date}::date, ${campaign?.id ?? null}::uuid,
                  ${day.spend.toString()}, ${day.confirmed}, ${day.delivered}, ${day.returned},
                  ${day.revenue.toString()}, ${day.revenue.toString()})
        `;
      }

      // --- the books ------------------------------------------------------------------
      const s = BigInt(scale);
      const d = (back: number): string => addDays(today, -back);
      await postJournal(tx, orgId, d(5), [
        { account: '1100', debit: 5_000_000n * s },
        { account: '3100', credit: 5_000_000n * s },
      ]);
      await postJournal(tx, orgId, d(4), [
        { account: `1010-${branch.code}`, debit: 250_075n * s, branchId: branch.id },
        { account: '3100', credit: 250_075n * s },
      ]);
      await postJournal(tx, orgId, d(3), [
        { account: '1300', debit: 3_000_000n * s },
        { account: '2100', credit: 3_000_000n * s, partyType: 'supplier', partyId: supplier.id },
      ]);
      await postJournal(tx, orgId, d(2), [
        { account: '1110', debit: 1_200_050n * s },
        { account: '4100', credit: 1_200_050n * s },
      ]);
      await postJournal(tx, orgId, d(1), [
        { account: '1200', debit: 850_000n * s, partyType: 'courier', partyId: courier.id },
        { account: '4100', credit: 800_000n * s },
        { account: '4200', credit: 50_000n * s },
      ]);
      await postJournal(tx, orgId, d(0), [
        { account: '5300', debit: 200_000n * s },
        { account: '1100', credit: 200_000n * s },
      ]);
      await postJournal(tx, orgId, d(0), [
        { account: '4110', debit: 30_000n * s },
        { account: '1110', credit: 30_000n * s },
      ]);
      await postJournal(tx, orgId, d(0), [
        { account: '5100', debit: 400_000n * s },
        { account: '1300', credit: 400_000n * s },
      ]);
      await postJournal(tx, orgId, d(0), [
        { account: '1900', debit: 12_345n * s },
        { account: '1100', credit: 12_345n * s },
      ]);

      // --- a catalog with stock ---------------------------------------------------------
      const series = input.orderSeries;
      const [product] = await tx<{ id: string }[]>`
        insert into catalog.products (org_id, sequence, name, slug, status)
        values (${orgId}, ${900 + series}, 'Linen panjabi', ${`linen-panjabi-${String(series)}`},
                'active')
        returning id::text as id
      `;
      const skus: { id: string; code: string }[] = [];
      for (const [size, onHand, reorder] of [
        ['S', 2, 5],
        ['M', 40, 5],
        ['L', 0, 3],
      ] as const) {
        const code = `LP${String(series)}-${size}`;
        const [sku] = await tx<{ id: string }[]>`
          insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha)
          values (${orgId}, ${product?.id ?? ''}, ${code}, ${`size:${size}`}, 250000)
          returning id::text as id
        `;
        skus.push({ id: sku?.id ?? '', code });
        // Invariant 3: a level holding stock needs the movement that put it there.
        if (onHand > 0) {
          await tx`
            insert into inventory.stock_movements
              (org_id, sku_id, location_id, kind, qty_delta, unit_cost_poisha, ref_type,
               business_date, created_by, created_txid)
            values (${orgId}, ${sku?.id ?? ''}, ${location.id}, 'opening_balance', ${onHand},
                    100000, 'fixture', ${today}::date, 'usr_fixture', '1'::xid8)
          `;
        }
        await tx`
          insert into inventory.stock_levels (org_id, sku_id, location_id, on_hand, reserved,
                                              reorder_level)
          values (${orgId}, ${sku?.id ?? ''}, ${location.id}, ${onHand}, 0, ${reorder})
        `;
      }

      // --- orders -------------------------------------------------------------------------
      const [thana] = await tx<{ id: number; district_id: number }[]>`
        select id, district_id from ref.thanas order by id limit 1
      `;
      const [customer] = await tx<{ id: string }[]>`
        insert into sales.customers (org_id, phone_e164, name)
        values (${orgId}, ${`+88017${String(series)}0000001`}, 'Fixture Buyer')
        returning id::text as id
      `;
      const prefix = ORDER_PREFIX[series] ?? 'TX';
      for (const [index, status] of (
        ['pending', 'confirmed', 'shipped', 'delivered'] as const
      ).entries()) {
        const items = 250_000n * BigInt(index + 1);
        const delivery = 6_000n;
        const [order] = await tx<{ id: string }[]>`
          insert into sales.orders
            (org_id, order_no, channel, customer_id, ship_name, ship_phone_e164,
             ship_district_id, ship_thana_id, ship_address_line, courier_id, location_id,
             items_poisha, delivery_charge_poisha, cod_amount_poisha, status, created_by,
             delivered_at, created_at)
          values (${orgId}, ${`${prefix}-2610-0000${String(index + 1)}`}, 'facebook',
                  ${customer?.id ?? ''}, 'Fixture Buyer', ${`+88017${String(series)}0000001`},
                  ${thana?.district_id ?? 1}, ${thana?.id ?? 1}, 'House 1, Road 2',
                  ${courier.id}, ${location.id}, ${items.toString()}, ${delivery.toString()},
                  ${(items + delivery).toString()}, ${status}, 'usr_fixture',
                  ${status === 'delivered' ? new Date() : null},
                  ${new Date(Date.now() - (4 - index) * 60_000)})
          returning id::text as id
        `;
        const sku = skus[index % skus.length];
        await tx`
          insert into sales.order_lines
            (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
             delivered_qty)
          values (${orgId}, ${order?.id ?? ''}, ${sku?.id ?? ''}, ${sku?.code ?? ''},
                  'Linen panjabi', ${index + 1}, 250000,
                  ${status === 'delivered' ? index + 1 : 0})
        `;
      }

      // --- staff -------------------------------------------------------------------------
      for (const [code, name, status] of [
        ['E-001', 'Rahim Uddin', 'active'],
        ['E-002', 'Karima Begum', 'active'],
        ['E-003', 'Sumon Ahmed', 'suspended'],
        ['E-004', 'Old Hand', 'resigned'],
      ] as const) {
        await tx`
          insert into hr.employees (org_id, branch_id, code, full_name, designation, join_date,
                                    leave_date, status, created_by)
          values (${orgId}, ${branch.id}, ${code}, ${name}, 'Sales agent', '2025-01-01'::date,
                  ${status === 'resigned' ? '2026-01-31' : null}::date, ${status}, 'usr_fixture')
        `;
      }

      return { orgId, courierId: courier.id };
    });
  } finally {
    await sql.end();
  }
}
