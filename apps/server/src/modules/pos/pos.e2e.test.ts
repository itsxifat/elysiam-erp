import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { businessDate, addDays, poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APP_DOMAIN,
  ORG_A,
  ORG_B,
  ORIGIN,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import {
  makeLocation,
  seedProductWithSkus,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { seedWallet, type SeededWallet } from '../wallets/wallets.testing.js';
import { describeRoutes } from '../../platform/auth/route-map.js';
import { routeKey } from '../../platform/auth/route-matrix.manifest.js';
import { POS_ROUTE_FIXTURES, POS_ROUTE_KEYS, preparePosFixtures } from './pos.route-fixtures.js';

/**
 * Who may use a till, what they may see, and what the database refuses (M23).
 *
 * `pos.db.test.ts` proves the money and the stock. This suite proves the edges
 * around them: the role matrix on the routes, branch scope, tenant isolation,
 * D-014's cost strip on the branch dashboard, the CSRF check on the sync, the
 * branch day close through M08's own closing, and migration 0070's triggers.
 */

let harness: HttpHarness;
let inventory: InventoryApi;
let cashier: RoleClient;
let manager: RoleClient;
let branchId = '';
let otherBranchId = '';
let showroomId = '';
let skus: SeededSku[] = [];
let handCash: SeededWallet;
let bank: SeededWallet;
let registerId = '';
let shiftId = '';
let seq = 0;
/** A sale posted while the shift was open, for the immutability checks at the end. */
let postedSaleId = '';

const PRICE = 150_000;
const UNIT_COST = 90_000;

beforeAll(async () => {
  harness = await startHttpHarness('pos-e2e');
  inventory = harness.app.get<InventoryApi>(INVENTORY_API, { strict: false });

  [branchId, otherBranchId] = await withSystem(
    async (tx) => {
      const hq = await tx.execute<{ id: string }>(
        sql`select id from org.branches where org_id = ${ORG_A} and code = 'HQ'`,
      );
      const other = await tx.execute<{ id: string }>(sql`
        insert into org.branches (org_id, code, name, kind)
        values (${ORG_A}, 'DHN', 'Dhanmondi showroom', 'showroom')
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      return [hq[0]?.id ?? '', other[0]?.id ?? ''];
    },
    { orgId: ORG_A },
  );
  showroomId = await makeLocation(ORG_A, {
    code: 'E2E-SHR',
    name: 'Gulshan showroom',
    kind: 'showroom',
    branchId,
  });
  ({ skus } = await seedProductWithSkus(ORG_A, 'pose2e', 2));
  handCash = await seedWallet(ORG_A, '1010-HQ', { provider: 'Till' });
  bank = await seedWallet(ORG_A, '1100', { provider: 'Bank' });

  const actor = { orgId: ORG_A, userId: 'usr_pos_e2e' };
  await withOrg(actor, (tx) =>
    inventory.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: showroomId,
      branchId,
      occurredAt: new Date(),
      lines: [{ skuId: skus[0]!.id, qty: 10, unitCostPoisha: poisha(UNIT_COST) }],
    }),
  );

  cashier = await harness.asRole('branch_manager', ORG_A, { branchIds: [branchId] });
  manager = await harness.asRole('branch_manager', ORG_A, { branchIds: [branchId] });

  const created = await cashier.client.request('POST', '/v1/pos/registers', {
    body: {
      branchId,
      locationId: showroomId,
      code: 'E2E1',
      name: 'Gulshan till',
      cashWalletId: handCash.id,
      cardWalletId: bank.id,
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  registerId = (JSON.parse(created.body) as { id: string }).id;

  shiftId = randomUUID();
  const opened = await cashier.client.request('POST', '/v1/pos/shifts', {
    body: { shiftId, registerId, openingFloatPoisha: '500000' },
  });
  expect(opened.statusCode, opened.body).toBe(201);
}, 600_000);

afterAll(async () => {
  await harness?.close();
}, 120_000);

function cashSale(sku: SeededSku, qty = 1, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const net = PRICE * qty;
  return {
    kind: 'sale' as const,
    id: randomUUID(),
    registerId,
    shiftId,
    receiptNo: `E2E1-1-${String(seq).padStart(4, '0')}`,
    occurredAt: new Date().toISOString(),
    lines: [{ lineNo: 1, skuId: sku.id, qty, unitPricePoisha: String(PRICE), discountPoisha: '0' }],
    tenders: [{ tender: 'cash' as const, amountPoisha: String(net) }],
    totals: { grossPoisha: String(net), discountPoisha: '0', netPoisha: String(net) },
    ...overrides,
  };
}

interface Result {
  outcome: string;
  replayed: boolean;
  reviewItemId: string | null;
  error: { code: string; message: string } | null;
}

async function sync(client: RoleClient, documents: unknown[]) {
  const response = await client.client.request('POST', '/v1/pos/sync', { body: { documents } });
  return {
    status: response.statusCode,
    results: (JSON.parse(response.body) as { results?: Result[] }).results ?? [],
  };
}

describe('who may use the till', () => {
  it('refuses roles with no wallet grant at the guard', async () => {
    for (const role of ['sales', 'warehouse', 'hr', 'marketing'] as const) {
      const person = await harness.asRole(role, ORG_A);
      expect((await person.client.request('GET', '/v1/pos/registers')).statusCode, role).toBe(403);
      expect((await sync(person, [cashSale(skus[0]!)])).status, role).toBe(403);
    }
  });

  it('hides another branch’s register from a branch manager, and refuses their sales on it', async () => {
    const elsewhere = await harness.asRole('branch_manager', ORG_A, { branchIds: [otherBranchId] });
    const list = await elsewhere.client.request('GET', '/v1/pos/registers');
    expect((JSON.parse(list.body) as { items: unknown[] }).items).toEqual([]);
    expect(
      (await elsewhere.client.request('GET', `/v1/pos/registers/${registerId}/session`)).statusCode,
    ).toBe(404);

    const document = cashSale(skus[0]!);
    const { results } = await sync(elsewhere, [document]);
    expect(results[0]?.outcome).toBe('rejected');
    const stored = await withSystem(
      async (tx) =>
        (await tx.execute(sql`select 1 from pos.sales where id = ${document.id}`)).length,
      { orgId: ORG_A },
    );
    expect(stored).toBe(0);
  });

  it('refuses a sale sent by someone other than the cashier whose shift it is', async () => {
    const { results } = await sync(manager, [cashSale(skus[0]!)]);
    expect(results[0]).toMatchObject({ outcome: 'rejected' });
    expect(results[0]?.error?.message).toMatch(/cashier whose shift/);
  });

  it('refuses a second open shift on the same register, and replays the first open', async () => {
    const second = await manager.client.request('POST', '/v1/pos/shifts', {
      body: { shiftId: randomUUID(), registerId, openingFloatPoisha: '0' },
    });
    expect(second.statusCode).toBe(409);
    const replay = await cashier.client.request('POST', '/v1/pos/shifts', {
      body: { shiftId, registerId, openingFloatPoisha: '500000' },
    });
    expect(replay.statusCode).toBe(201);
    expect(JSON.parse(replay.body)).toMatchObject({ id: shiftId, shiftNo: 1 });
  });

  it('refuses the sync without the CSRF header, like any other mutation', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/v1/pos/sync',
      headers: {
        host: APP_DOMAIN,
        origin: ORIGIN,
        cookie: cashier.client.cookieHeader(),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ documents: [cashSale(skus[0]!)] }),
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('a bad document', () => {
  it('is refused whole when its totals do not match its lines, and the rest of the queue goes through', async () => {
    const forged = cashSale(skus[0]!, 1, {
      totals: { grossPoisha: '150000', discountPoisha: '0', netPoisha: '100' },
      tenders: [{ tender: 'cash', amountPoisha: '100' }],
    });
    const good = cashSale(skus[0]!);
    const { status, results } = await sync(cashier, [forged, good]);
    expect(status).toBe(200);
    expect(results.map((r) => r.outcome)).toEqual(['rejected', 'posted']);
  });

  it('cannot pay into a tender the register does not take', async () => {
    const document = cashSale(skus[0]!, 1, {
      tenders: [{ tender: 'bkash', amountPoisha: String(PRICE) }],
    });
    const { results } = await sync(cashier, [document]);
    expect(results[0]?.outcome).toBe('rejected');
    expect(results[0]?.error?.message).toMatch(/does not take bkash/);
  });
});

describe('tenant isolation', () => {
  it('shows another org nothing, and RLS agrees', async () => {
    const outsider = await harness.asRole('org_admin', ORG_B);
    const list = await outsider.client.request('GET', '/v1/pos/registers');
    expect((JSON.parse(list.body) as { items: unknown[] }).items).toEqual([]);
    expect(
      (await outsider.client.request('GET', `/v1/pos/registers/${registerId}/session`)).statusCode,
    ).toBe(404);

    const visible = await withOrg({ orgId: ORG_B, userId: 'usr_guard' }, async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select (select count(*) from pos.registers) + (select count(*) from pos.sales)
             + (select count(*) from pos.shifts) + (select count(*) from pos.sale_lines) as n
      `);
      return Number(rows[0]?.n ?? -1);
    });
    expect(visible).toBe(0);

    // Org B cannot take an id org A already used and read what is behind it.
    const mine = cashSale(skus[0]!);
    await sync(cashier, [mine]);
    expect((await outsider.client.request('GET', `/v1/pos/sales/${mine.id}`)).statusCode).toBe(404);
  });
});

describe('the branch dashboard (D-014)', () => {
  it('gives a branch manager revenue without cost, and a cost role the margin', async () => {
    const today = businessDate(new Date());
    const path = `/v1/pos/branches/${branchId}/summary?from=${today}&to=${today}`;

    const asManager = JSON.parse((await manager.client.request('GET', path)).body) as Record<
      string,
      unknown
    >;
    expect(Number(asManager.salesCount)).toBeGreaterThan(0);
    expect(BigInt(asManager.netSalesPoisha as string) > 0n).toBe(true);
    expect(asManager).not.toHaveProperty('cogsPoisha');
    expect(asManager).not.toHaveProperty('grossProfitPoisha');
    expect(JSON.stringify(asManager)).not.toMatch(/cost/i);

    const admin = await harness.asRole('org_admin', ORG_A);
    const asAdmin = JSON.parse((await admin.client.request('GET', path)).body) as Record<
      string,
      string
    >;
    expect(BigInt(asAdmin.cogsPoisha!)).toBe(BigInt(asAdmin.salesCount!) * BigInt(UNIT_COST));
    expect(BigInt(asAdmin.grossProfitPoisha!)).toBe(
      BigInt(asAdmin.netRevenuePoisha!) - BigInt(asAdmin.cogsPoisha!),
    );
  });

  it('never sends a unit cost on a receipt', async () => {
    const document = cashSale(skus[0]!);
    const { results } = await sync(cashier, [document]);
    expect(results[0]?.outcome).toBe('posted');
    postedSaleId = document.id;
    const admin = await harness.asRole('org_admin', ORG_A);
    for (const person of [cashier, admin]) {
      const body = (await person.client.request('GET', `/v1/pos/sales/${document.id}`)).body;
      expect(body).not.toMatch(/unitCost|cogs/i);
    }
  });

  it('serves the offline price list without cost, with what the shelf holds', async () => {
    const response = await cashier.client.request(
      'GET',
      `/v1/pos/registers/${registerId}/price-list`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const { items } = JSON.parse(response.body) as {
      items: { id: string; pricePoisha: string; available: number }[];
    };
    const first = items.find((item) => item.id === skus[0]!.id);
    expect(first?.pricePoisha).toBe(String(PRICE));
    expect(first?.available).toBeGreaterThan(0);
    expect(response.body).not.toMatch(/cost|wac/i);
  });
});

describe('a held sale, voided', () => {
  it('stays out of the books and out of the drawer, and the till is told', async () => {
    const document = cashSale(skus[1]!); // never stocked
    const { results } = await sync(cashier, [document]);
    expect(results[0]?.outcome).toBe('held');

    const before = JSON.parse(
      (await cashier.client.request('GET', `/v1/pos/shifts/${shiftId}`)).body,
    ) as {
      drawer: { expectedCashPoisha: string };
    };
    const voided = await manager.client.request(
      'POST',
      `/v1/pos/reviews/${results[0]!.reviewItemId!}/resolve`,
      {
        body: { action: 'void', note: 'rung up by mistake' },
      },
    );
    expect(JSON.parse(voided.body)).toMatchObject({ outcome: 'voided' });
    const after = JSON.parse(
      (await cashier.client.request('GET', `/v1/pos/shifts/${shiftId}`)).body,
    ) as {
      drawer: { expectedCashPoisha: string };
    };
    expect(BigInt(before.drawer.expectedCashPoisha) - BigInt(after.drawer.expectedCashPoisha)).toBe(
      BigInt(PRICE),
    );

    const again = await sync(cashier, [document]);
    expect(again.results[0]).toMatchObject({ outcome: 'voided', replayed: true });

    // Resolved is final.
    const twice = await manager.client.request(
      'POST',
      `/v1/pos/reviews/${results[0]!.reviewItemId!}/resolve`,
      {
        body: { action: 'post', note: 'changed my mind' },
      },
    );
    expect(twice.statusCode).toBe(409);
  });
});

describe('the branch day close, through M08’s closing', () => {
  it('raises M08’s closing_variance approval when the count differs, and balances when it agrees', async () => {
    const today = businessDate(new Date());
    const yesterday = addDays(today, -1);

    // Yesterday: nothing was posted to hand cash, so ৳10 counted is ৳10 over.
    const over = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: {
        closingId: randomUUID(),
        businessDate: yesterday,
        counts: [{ walletId: handCash.id, countedPoisha: '1000' }],
      },
    });
    expect(over.statusCode, over.body).toBe(201);
    const overBody = JSON.parse(over.body) as {
      wallets: { status: string; variancePoisha: string; approvalId: string | null }[];
    };
    expect(overBody.wallets[0]).toMatchObject({
      status: 'pending_approval',
      variancePoisha: '1000',
    });
    const approval = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ type: string; status: string }>(sql`
            select type, status from approvals.approval_requests where id = ${overBody.wallets[0]!.approvalId}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(approval).toMatchObject({ type: 'closing_variance', status: 'pending' });

    // Today is refused while the shift is open…
    const closingId = randomUUID();
    const expected = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ balance: string }>(sql`
            select coalesce(sum(debit_poisha - credit_poisha), 0)::text as balance
            from ledger.journal_lines where org_id = ${ORG_A} and account_id = ${handCash.ledgerAccountId}
          `)
        )[0]?.balance ?? '0',
      { orgId: ORG_A },
    );
    const body = {
      closingId,
      businessDate: today,
      counts: [{ walletId: handCash.id, countedPoisha: expected }],
    };
    expect(
      (await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, { body }))
        .statusCode,
    ).toBe(409);

    // …and goes through once it is counted and closed.
    const shift = JSON.parse(
      (await cashier.client.request('GET', `/v1/pos/shifts/${shiftId}`)).body,
    ) as {
      drawer: { expectedCashPoisha: string };
    };
    const closedShift = await cashier.client.request('POST', `/v1/pos/shifts/${shiftId}/close`, {
      body: { countedCashPoisha: shift.drawer.expectedCashPoisha },
    });
    expect(closedShift.statusCode, closedShift.body).toBe(200);

    const closed = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body,
    });
    expect(closed.statusCode, closed.body).toBe(201);
    expect((JSON.parse(closed.body) as { wallets: { status: string }[] }).wallets[0]?.status).toBe(
      'balanced',
    );

    // The same close again is the same close; a different one for the day is refused.
    const replay = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body,
    });
    expect(replay.statusCode).toBe(201);
    const other = await manager.client.request('POST', `/v1/pos/branches/${branchId}/closings`, {
      body: { ...body, closingId: randomUUID() },
    });
    expect(other.statusCode).toBe(409);

    const count = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from wallets.closings
            where org_id = ${ORG_A} and wallet_id = ${handCash.id} and business_date = ${today}
          `)
        )[0]?.n,
      { orgId: ORG_A },
    );
    expect(count).toBe(1);
  });
});

describe('what the database refuses (migration 0070)', () => {
  /** Run as `erp_owner` and return every message on the error's cause chain. */
  async function refusal(
    work: (tx: Parameters<Parameters<typeof withSystem>[0]>[0]) => Promise<unknown>,
  ): Promise<string> {
    try {
      await withSystem(work, { orgId: ORG_A });
      return 'no refusal';
    } catch (error) {
      let text = '';
      for (let current: unknown = error; current instanceof Error; current = current.cause) {
        text += ` ${current.message}`;
      }
      return text;
    }
  }

  it('a register whose cash tender is not this branch’s hand cash', async () => {
    expect(
      await refusal((tx) =>
        tx.execute(sql`
          insert into pos.registers (org_id, branch_id, location_id, code, name, cash_wallet_id, created_by)
          values (${ORG_A}, ${branchId}, ${showroomId}, 'BAD1', 'Bad', ${bank.id}, 'usr_x')
        `),
      ),
    ).toMatch(/POS_REGISTER_INVALID/);
  });

  it('a posted sale edited, a tender rewritten, a sale deleted — even as the owner role', async () => {
    // Posted earlier, while the shift was still open: a sale sent now would be held.
    const document = { id: postedSaleId };
    expect(
      await refusal((tx) =>
        tx.execute(
          sql`update pos.sales set net_poisha = 1, gross_poisha = 1 where id = ${document.id}`,
        ),
      ),
    ).toMatch(/POS_RECORD_IMMUTABLE/);
    expect(
      await refusal((tx) =>
        tx.execute(
          sql`update pos.sale_tenders set amount_poisha = 1 where sale_id = ${document.id}`,
        ),
      ),
    ).toMatch(/POS_RECORD_IMMUTABLE/);
    expect(
      await refusal((tx) => tx.execute(sql`delete from pos.sales where id = ${document.id}`)),
    ).toMatch(/POS_RECORD_IMMUTABLE/);
    expect(
      await refusal((tx) =>
        tx.execute(
          sql`update pos.sale_lines set unit_cost_poisha = 1 where sale_id = ${document.id}`,
        ),
      ),
    ).toMatch(/POS_RECORD_IMMUTABLE/);
  });

  it('the application role holds no DELETE on any pos table', async () => {
    const rows = await withSystem(async (tx) =>
      tx.execute<{ table_name: string }>(sql`
        select c.relname as table_name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'pos' and c.relkind = 'r'
          and (has_table_privilege('erp_app', c.oid, 'DELETE') or has_table_privilege('erp_app', c.oid, 'TRUNCATE')
               or not c.relrowsecurity or not c.relforcerowsecurity)
      `),
    );
    expect(rows.map((row) => row.table_name)).toEqual([]);
  });
});

describe('the route-matrix fixtures (D-070)', () => {
  it('name every POS route, each declaring an ability, and none of them fault', async () => {
    const live = describeRoutes(harness.app).filter((route) => route.path.startsWith('/v1/pos'));
    expect(live.map(routeKey).sort()).toEqual([...POS_ROUTE_KEYS].sort());
    expect(live.filter((route) => route.ability === null)).toEqual([]);

    // Driven as an org-wide role: whatever a handler answers, it is not the guard
    // refusing and it is not a fault.
    await preparePosFixtures();
    const admin = await harness.asRole('org_admin', ORG_A);
    for (const [key, fixture] of Object.entries(POS_ROUTE_FIXTURES)) {
      const call = await fixture();
      const response = await admin.client.request(key.split(' ')[0] ?? 'GET', call.url, {
        ...(call.body === undefined ? {} : { body: call.body }),
      });
      expect(response.statusCode, `${key}: ${response.body}`).not.toBe(403);
      expect(response.statusCode, `${key}: ${response.body}`).toBeLessThan(500);
    }
  });
});
