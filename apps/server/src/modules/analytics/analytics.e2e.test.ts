import { MEMBERSHIP_ROLES, type MembershipRole } from '@elysium/contracts';
import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedEmployee } from '../hr/hr.testing.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { seedCustomer } from '../orders/orders.testing.js';
import { FakeNarrativeProvider, NARRATIVE_PROVIDER } from './providers/narrative.provider.js';

/**
 * Analytics over HTTP (M24).
 *
 * - **Check 2: leaderboard visibility follows D-023.** Rollups are written for every brand
 *   with raw figures nobody could mistake for anything else (revenue ৳9,876,543.21). An
 *   org admin sees every brand's normalized metrics and ranks, their own brand's raw
 *   figures, and **no other brand's raw figure anywhere in the response**; Super Admin sees
 *   everything; every other role is refused by the guard.
 * - **Check 4, the server's half:** with the narrative flag on, the prompt the provider
 *   receives — read back from the fake — carries none of the buyer's, the agent's or the
 *   campaign's names or numbers, though all of them are in the brand's data and the
 *   dashboard shows the agent's name.
 * - The rest of the module's routes, once each: the dashboard, the consolidated view kept
 *   to Super Admin, insights, the refresh and the export.
 */

const ORG_C = SEED_ORG_IDS.orvo ?? '';
const JULY = '2026-07';
const ORG_B_REVENUE = '987654321';
const ORG_B_SPEND = '55555555';
const ORG_B_PREVIOUS = '123456789';

let harness: HttpHarness;
let superAdmin: RoleClient;
let adminA: RoleClient;
let adminB: RoleClient;

interface BoardRow {
  readonly visibility: 'full' | 'normalized';
  readonly orgId: string;
  readonly orgName: string;
  readonly rank: number;
  readonly compositeBps: number;
  readonly metrics: Record<string, string | null>;
  readonly ranks: Record<string, number | null>;
  readonly raw?: {
    readonly current: { readonly deliveredRevenuePoisha: string; readonly spendPoisha: string };
  };
}

const body = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

/** One month of `analytics.daily_org` for a brand, on its first day. */
async function seedMonth(
  orgId: string,
  date: string,
  figures: {
    delivered: number;
    returned: number;
    cancelled: number;
    revenue: string;
    spend: string;
    pickups: number;
    pickupSeconds: number;
  },
): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into analytics.daily_org
          (org_id, business_date, orders_placed, orders_confirmed, orders_delivered,
           orders_returned, orders_cancelled, delivered_revenue_poisha, gross_profit_poisha,
           spend_poisha, pickup_count, pickup_seconds)
        values (${orgId}, ${date}::date, ${figures.delivered + 10}, ${figures.delivered + 5},
                ${figures.delivered}, ${figures.returned}, ${figures.cancelled}, ${figures.revenue},
                ${BigInt(figures.revenue) / 3n}, ${figures.spend}, ${figures.pickups},
                ${figures.pickupSeconds})
      `);
    },
    { orgId },
  );
}

async function makeSuperAdmin(client: RoleClient): Promise<RoleClient> {
  await withSystem(async (tx) => {
    await tx.execute(sql`update iam.users set is_super_admin = true where id = ${client.userId}`);
  });
  return client;
}

beforeAll(async () => {
  harness = await startHttpHarness('analytics-e2e');
  superAdmin = await makeSuperAdmin(await harness.asRole('org_admin', ORG_A));
  adminA = await harness.asRole('org_admin', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);

  // June and July for three brands: B grows hugely, A modestly, C is flat.
  await seedMonth(ORG_A, '2026-06-01', {
    delivered: 100,
    returned: 10,
    cancelled: 5,
    revenue: '10000000',
    spend: '2000000',
    pickups: 50,
    pickupSeconds: 15_000,
  });
  await seedMonth(ORG_A, '2026-07-01', {
    delivered: 110,
    returned: 12,
    cancelled: 4,
    revenue: '12000000',
    spend: '2400000',
    pickups: 60,
    pickupSeconds: 12_000,
  });
  await seedMonth(ORG_B, '2026-06-01', {
    delivered: 300,
    returned: 20,
    cancelled: 10,
    revenue: ORG_B_PREVIOUS,
    spend: '30000000',
    pickups: 100,
    pickupSeconds: 60_000,
  });
  await seedMonth(ORG_B, '2026-07-01', {
    delivered: 900,
    returned: 30,
    cancelled: 20,
    revenue: ORG_B_REVENUE,
    spend: ORG_B_SPEND,
    pickups: 400,
    pickupSeconds: 80_000,
  });
  await seedMonth(ORG_C, '2026-07-01', {
    delivered: 50,
    returned: 25,
    cancelled: 5,
    revenue: '5000000',
    spend: '5000000',
    pickups: 20,
    pickupSeconds: 40_000,
  });
}, 600_000);

afterAll(async () => {
  await harness?.close();
}, 120_000);

describe('check 2: leaderboard visibility follows D-023', () => {
  it('shows an org admin every brand’s normalized metrics and ranks, and only their own raw figures', async () => {
    const response = await adminA.client.request('GET', `/v1/analytics/leaderboard?month=${JULY}`);
    expect(response.statusCode, response.body).toBe(200);
    const board = body<{ rows: BoardRow[] }>(response);

    const own = board.rows.find((row) => row.orgId === ORG_A);
    const peer = board.rows.find((row) => row.orgId === ORG_B);
    expect(own?.visibility).toBe('full');
    expect(own?.raw?.current.deliveredRevenuePoisha).toBe('12000000');
    expect(peer?.visibility).toBe('normalized');
    expect(peer?.orgName).toBeTruthy();

    // A peer row carries the allow-list and nothing else.
    for (const row of board.rows.filter((entry) => entry.orgId !== ORG_A)) {
      expect(Object.keys(row).sort()).toEqual(
        [
          'compositeBps',
          'metrics',
          'orgId',
          'orgName',
          'rank',
          'ranks',
          'scores',
          'visibility',
        ].sort(),
      );
    }

    // The peer's normalized figures are there: revenue up 700%, ranked first on growth.
    expect(peer?.metrics.revenueGrowth).toBe('70000');
    expect(peer?.ranks.revenueGrowth).toBe(1);

    // And its raw figures are nowhere in the response, in any field.
    for (const raw of [ORG_B_REVENUE, ORG_B_SPEND, ORG_B_PREVIOUS]) {
      expect(response.body).not.toContain(raw);
    }
  });

  it('is the same rule from the other side: B’s admin sees A normalized', async () => {
    const response = await adminB.client.request('GET', `/v1/analytics/leaderboard?month=${JULY}`);
    expect(response.statusCode, response.body).toBe(200);
    const rows = body<{ rows: BoardRow[] }>(response).rows;
    expect(rows.find((row) => row.orgId === ORG_B)?.visibility).toBe('full');
    expect(rows.find((row) => row.orgId === ORG_A)?.visibility).toBe('normalized');
    expect(response.body).not.toContain('"12000000"');
    expect(response.body).toContain(ORG_B_REVENUE);
  });

  it('shows Super Admin every brand’s raw figures', async () => {
    const response = await superAdmin.client.request(
      'GET',
      `/v1/analytics/leaderboard?month=${JULY}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const rows = body<{ rows: BoardRow[] }>(response).rows;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((row) => row.visibility === 'full')).toBe(true);
    expect(rows.find((row) => row.orgId === ORG_B)?.raw?.current.deliveredRevenuePoisha).toBe(
      ORG_B_REVENUE,
    );
  });

  it('refuses every other role at the guard', async () => {
    const others = MEMBERSHIP_ROLES.filter((role) => role !== 'org_admin');
    expect(others.length).toBeGreaterThan(5);
    for (const role of others) {
      const client = await harness.asRole(role, ORG_A);
      const response = await client.client.request(
        'GET',
        `/v1/analytics/leaderboard?month=${JULY}`,
      );
      expect(response.statusCode, `${role}: ${response.body}`).toBe(403);
      expect(response.body).not.toContain(ORG_B_REVENUE);
    }
  });

  it('ranks by the composite, with the weights it used', async () => {
    const response = await superAdmin.client.request(
      'GET',
      `/v1/analytics/leaderboard?month=${JULY}`,
    );
    const board = body<{ rows: BoardRow[]; weights: Record<string, number> }>(response);
    expect(board.weights.revenueGrowth).toBe(3);
    const ranks = board.rows.map((row) => row.rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const composites = board.rows.map((row) => row.compositeBps);
    expect(composites).toEqual([...composites].sort((a, b) => b - a));
  });
});

describe('the consolidated view is Super Admin’s', () => {
  it('refuses an org admin, though the guard admits them to the subject', async () => {
    const response = await adminA.client.request(
      'GET',
      '/v1/analytics/consolidated?from=2026-07-01&to=2026-07-31',
    );
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('FORBIDDEN');
    expect(response.body).not.toContain(ORG_B_REVENUE);
  });

  it('gives Super Admin every brand and the group total, through the analytics role', async () => {
    const response = await superAdmin.client.request(
      'GET',
      '/v1/analytics/consolidated?from=2026-07-01&to=2026-07-31',
    );
    expect(response.statusCode, response.body).toBe(200);
    const view = body<{
      brands: { orgId: string; deliveredRevenuePoisha: string; grossProfitPoisha: string }[];
      group: { deliveredRevenuePoisha: string };
    }>(response);
    const total = view.brands.reduce(
      (sum, brand) => sum + BigInt(brand.deliveredRevenuePoisha),
      0n,
    );
    expect(view.group.deliveredRevenuePoisha).toBe(total.toString());
    expect(view.brands.find((brand) => brand.orgId === ORG_B)?.deliveredRevenuePoisha).toBe(
      ORG_B_REVENUE,
    );
    expect(view.brands[0]?.grossProfitPoisha).toBeDefined();
  });
});

describe('the org dashboard, insights, refresh, export and the narrative', () => {
  const BUYER_NAME = 'Rahima Begum Chowdhury';
  const BUYER_PHONE = '+8801719876543';
  const AGENT_NAME = 'Karim Uddin Talukder';
  const CAMPAIGN_NAME = 'Karim Eid Bonanza';
  let agent: RoleClient;

  beforeAll(async () => {
    agent = await harness.asRole('sales', ORG_A);
    await seedEmployee(ORG_A, {
      code: 'AN-AGENT',
      fullName: AGENT_NAME,
      joinDate: '2026-01-01',
      userId: agent.userId,
    });
    const { skus } = await seedProductWithSkus(ORG_A, 'analyticsweb', 1);
    const customer = await seedCustomer(ORG_A, { phoneE164: BUYER_PHONE, name: BUYER_NAME });
    await withSystem(
      async (tx) => {
        const campaign = await tx.execute<{ id: string }>(sql`
          insert into marketing.campaigns (org_id, name, platform, created_by)
          values (${ORG_A}, ${CAMPAIGN_NAME}, 'meta', 'usr_analytics_e2e') returning id
        `);
        const campaignId = campaign[0]?.id ?? '';
        await tx.execute(sql`
          insert into marketing.ad_spend
            (org_id, campaign_id, spend_date, amount_poisha, source, entered_by)
          values (${ORG_A}, ${campaignId}, '2026-09-03'::date, 900000, 'manual', 'usr_analytics_e2e')
        `);
        const area = await tx.execute<{ district_id: number; thana_id: number }>(sql`
          select t.district_id, t.id as thana_id from ref.thanas t where t.district_id <> 47
          order by t.id limit 1
        `);
        for (let index = 0; index < 3; index += 1) {
          const order = await tx.execute<{ id: string }>(sql`
            insert into sales.orders (
              org_id, order_no, channel, source, customer_id, ship_name, ship_phone_e164,
              ship_district_id, ship_thana_id, ship_address_line, items_poisha, discount_poisha,
              delivery_charge_poisha, advance_paid_poisha, cod_amount_poisha, status, created_by,
              confirmed_by, created_at, confirmed_at, delivered_at)
            values (
              ${ORG_A}, ${`ANW-2609-${String(index + 1).padStart(5, '0')}`}, 'facebook',
              ${JSON.stringify({ campaignId })}::jsonb, ${customer}, ${BUYER_NAME}, ${BUYER_PHONE},
              ${area[0]?.district_id ?? 1}, ${area[0]?.thana_id ?? 1}, 'House 9, Road 4, Banani',
              300000, 0, 12000, 0, 312000, 'delivered', ${agent.userId}, ${agent.userId},
              '2026-09-02T04:00:00Z', '2026-09-02T05:00:00Z', '2026-09-04T06:00:00Z')
            returning id
          `);
          await tx.execute(sql`
            insert into sales.order_lines
              (org_id, order_id, sku_id, sku_code, product_name, qty, unit_price_poisha,
               discount_poisha, delivered_qty, returned_qty, dispatch_unit_cost_poisha, position)
            values (${ORG_A}, ${order[0]?.id ?? ''}, ${skus[0]?.id ?? ''}, ${skus[0]?.code ?? ''},
                    'Panjabi', 1, 300000, 0, 1, 0, 180000, 0)
          `);
        }
      },
      { orgId: ORG_A },
    );
  }, 300_000);

  it('recomputes a range on request, audited, for the org admin only', async () => {
    const refused = await agent.client.request('POST', '/v1/analytics/rollups/refresh', {
      body: { from: '2026-09-01', to: '2026-09-30' },
    });
    expect(refused.statusCode).toBe(403);

    const response = await adminA.client.request('POST', '/v1/analytics/rollups/refresh', {
      body: { from: '2026-09-01', to: '2026-09-30' },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(body<{ days: number }>(response).days).toBe(30);

    const audited = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from audit.audit_log
          where actor_user_id = ${adminA.userId} and action = 'analytics.rollups_refreshed'
        `),
      { orgId: ORG_A },
    );
    expect(audited[0]?.n).toBe(1);

    const tooLong = await adminA.client.request('POST', '/v1/analytics/rollups/refresh', {
      body: { from: '2026-01-01', to: '2026-09-30' },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('shows the org admin their own brand: figures, gross profit, agents by name, cash and stock', async () => {
    const response = await adminA.client.request(
      'GET',
      '/v1/analytics/dashboard?from=2026-09-01&to=2026-09-30',
    );
    expect(response.statusCode, response.body).toBe(200);
    const view = body<{
      totals: {
        ordersDelivered: number;
        deliveredRevenuePoisha: string;
        grossProfitPoisha: string;
        spendPoisha: string;
        aovPoisha: string;
        roasBps: string;
      };
      agents: { name: string | null; ordersDelivered: number }[];
      byCampaign: { name: string | null; spendPoisha: string }[];
      topSkus: { units: number }[];
      cashPoisha: string;
      stockValuePoisha: string;
      series: unknown[];
    }>(response);
    expect(view.totals).toMatchObject({
      ordersDelivered: 3,
      deliveredRevenuePoisha: '900000',
      grossProfitPoisha: '360000',
      spendPoisha: '900000',
      aovPoisha: '300000',
      roasBps: '10000',
    });
    expect(view.agents[0]).toMatchObject({ name: AGENT_NAME, ordersDelivered: 3 });
    expect(view.byCampaign[0]).toMatchObject({ name: CAMPAIGN_NAME, spendPoisha: '900000' });
    expect(view.topSkus[0]?.units).toBe(3);
    expect(view.series).toHaveLength(30);
    expect(view.cashPoisha).toMatch(/^-?\d+$/);
    expect(view.stockValuePoisha).toMatch(/^-?\d+$/);
    // Nothing of another brand's.
    expect(response.body).not.toContain(ORG_B_REVENUE);
  });

  it('refuses the dashboard to a role that does not hold it', async () => {
    for (const role of ['accounts', 'marketing', 'sales', 'branch_manager'] as const) {
      const client = await harness.asRole(role, ORG_A);
      const response = await client.client.request(
        'GET',
        '/v1/analytics/dashboard?from=2026-09-01&to=2026-09-30',
      );
      expect(response.statusCode, role).toBe(403);
    }
  });

  it('exports the daily rollup as CSV, with gross profit for a cost role, audited', async () => {
    const response = await adminA.client.request(
      'GET',
      '/v1/analytics/export?from=2026-09-01&to=2026-09-30&format=csv',
    );
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/csv');
    expect(response.headers['x-row-count']).toBe('30');
    expect(response.body).toContain('Gross profit (Tk)');
    expect(response.body).toContain('2026-09-04,0,0,3,0,0,9000.00,3600.00,0.00');

    const xlsx = await adminA.client.request(
      'GET',
      '/v1/analytics/export?from=2026-09-01&to=2026-09-30&format=xlsx',
    );
    expect(xlsx.statusCode).toBe(200);
    expect(String(xlsx.headers['content-type'])).toContain('spreadsheetml');
  });

  it('lists the insight rules that fire for the month, measured against the group', async () => {
    // Orvo's July: 50 delivered, 25 returned, 5 cancelled — 62.50% delivery success against a
    // group median of 87.30% (A 87.30%, B 94.74%, C itself) — and a mean pickup of 2,000 s.
    const adminC = await harness.asRole('org_admin', ORG_C);
    const response = await adminC.client.request('GET', `/v1/analytics/insights?month=${JULY}`);
    expect(response.statusCode, response.body).toBe(200);
    const view = body<{ items: { code: string; params: Record<string, string> }[] }>(response);
    expect(view.items.map((item) => item.code)).toEqual([
      'delivery_success_below_group',
      'slow_pickup',
    ]);
    expect(view.items[0]?.params).toEqual({
      successBps: '6250',
      medianBps: '8730',
      gapBps: '2480',
    });
    // The group median is a normalized figure; no peer's raw figure comes with it.
    expect(response.body).not.toContain(ORG_B_REVENUE);
  });

  it('answers the narrative as switched off until the brand turns the flag on', async () => {
    const response = await adminB.client.request('GET', '/v1/analytics/narrative?month=2026-09');
    expect(response.statusCode, response.body).toBe(200);
    expect(body<{ enabled: boolean }>(response).enabled).toBe(false);
  });

  it('check 4: sends the provider no buyer, agent or campaign detail, and caches the day’s text', async () => {
    const provider: unknown = harness.app.get(NARRATIVE_PROVIDER, { strict: false });
    if (!(provider instanceof FakeNarrativeProvider)) throw new Error('expected the fake');
    provider.clear();
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into org.feature_flags (org_id, key, enabled)
          values (${ORG_A}, 'analytics.llm_narrative', true)
          on conflict (org_id, key) do update set enabled = true
        `);
      },
      { orgId: ORG_A },
    );

    const first = await adminA.client.request('GET', '/v1/analytics/narrative?month=2026-09');
    expect(first.statusCode, first.body).toBe(200);
    const narrative = body<{ enabled: boolean; text: string; cached: boolean; provider: string }>(
      first,
    );
    expect(narrative).toMatchObject({ enabled: true, cached: false, provider: 'fake' });
    expect(narrative.text).toContain('delivered 3 orders');

    expect(provider.prompts).toHaveLength(1);
    const sent = `${provider.prompts[0]?.system ?? ''}\n${provider.prompts[0]?.user ?? ''}`;
    for (const personal of [
      BUYER_NAME,
      'Rahima',
      BUYER_PHONE,
      BUYER_PHONE.slice(3),
      BUYER_PHONE.slice(1),
      AGENT_NAME,
      'Karim',
      agent.userId,
      agent.email,
      'AN-AGENT',
      CAMPAIGN_NAME,
      'Banani',
      'ANW-2609',
    ]) {
      expect(sent, personal).not.toContain(personal);
    }
    // The figures did go: three delivered, ৳9,000 of revenue.
    expect(sent).toContain('"ordersDelivered":3');
    expect(sent).toContain('"deliveredRevenuePoisha":"900000"');

    const second = await adminA.client.request('GET', '/v1/analytics/narrative?month=2026-09');
    expect(body<{ cached: boolean }>(second).cached).toBe(true);
    expect(provider.prompts).toHaveLength(1);
  });
});
