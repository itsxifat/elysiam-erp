import { randomUUID } from 'node:crypto';

import { findCostFields } from '@elysium/contracts';
import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from './inventory.api.js';
import { InventoryModule } from './inventory.module.js';
import {
  applyInventoryMigrations,
  makeLocation,
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from './inventory.testing.js';

/**
 * Stock over HTTP (M07 acceptance checks 4 and 6).
 *
 * Check 4 is the one with teeth: *an adjustment above the threshold creates an
 * approval request, and it applies and posts only after approval*. Both halves are
 * asserted, and the first half is the one a test usually forgets — it is not enough
 * that approving works, it has to be true that **nothing happened before it**. So the
 * level and the journal count are read between the request and the decision.
 *
 * Check 6 — *sales sees available quantity with no cost or value fields* — is checked
 * with `findCostFields`, which walks the whole response rather than looking at the
 * top level. A `wacPoisha` nested inside a row is the exact bug a shallow assertion
 * misses.
 *
 * Everything runs through the real HTTP pipeline: the ability guard, the scope
 * interceptor, the serializer and the audit net, in the order `main.api.ts` mounts
 * them.
 */

let harness: HttpHarness;
let api: InventoryApi;

let admin: RoleClient;
let secondAdmin: RoleClient;
let warehouse: RoleClient;
let sales: RoleClient;
let branchManager: RoleClient;

let warehouseLocation = '';
let showroomLocation = '';
let hqBranch = '';
let otherBranch = '';
let skus: SeededSku[] = [];

beforeAll(async () => {
  harness = await startHttpHarness('inventory-e2e', { extraModules: [InventoryModule] });
  await applyInventoryMigrations();
  api = harness.app.get<InventoryApi>(INVENTORY_API);

  ({ hqBranch, otherBranch } = await branches());
  warehouseLocation = await warehouseId(ORG_A);
  showroomLocation = await makeLocation(ORG_A, {
    code: 'SHR-E2E',
    name: 'Second Showroom Floor',
    kind: 'showroom',
    branchId: otherBranch,
  });
  await makeLocation(ORG_A, { code: 'TRANSIT-E2E', name: 'In transit', kind: 'in_transit' });

  admin = await harness.asRole('org_admin', ORG_A);
  secondAdmin = await harness.asRole('org_admin', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  branchManager = await harness.asRole('branch_manager', ORG_A, { branchIds: [otherBranch] });

  ({ skus } = await seedProductWithSkus(ORG_A, 'e2e', 3));
  await setThreshold('stock_write_off', '500000');
  await setThreshold('stock_gain', '500000');
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ------------------------------------------------------------------

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

async function branches(): Promise<{ hqBranch: string; otherBranch: string }> {
  return withSystem(
    async (tx) => {
      const hq = await tx.execute<{ id: string }>(sql`
        select id from org.branches where org_id = ${ORG_A} and code = 'HQ'
      `);
      const other = await tx.execute<{ id: string }>(sql`
        insert into org.branches (org_id, code, name, kind)
        values (${ORG_A}, 'SHR-E2E', 'Second Showroom', 'showroom')
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      return { hqBranch: hq[0]?.id ?? '', otherBranch: other[0]?.id ?? '' };
    },
    { orgId: ORG_A },
  );
}

/**
 * Configure one org threshold, through the real flow.
 *
 * The first threshold for a type is itself a `threshold_change` a *second* org admin
 * has to approve (D-073), so this is two calls. Done through the API rather than by
 * writing the row: a threshold inserted behind the approvals module's back is a
 * threshold the module never agreed to, and the test would then assert against a
 * state production cannot reach.
 */
async function setThreshold(type: string, thresholdPoisha: string): Promise<void> {
  const set = await admin.client.request('PUT', '/v1/approvals/thresholds', {
    body: { type, thresholdPoisha },
  });
  expect(set.statusCode, set.body).toBe(200);
  const { approvalId } = body<{ approvalId: string | null }>(set);
  if (approvalId === null) return;
  const decided = await secondAdmin.client.request('POST', `/v1/approvals/${approvalId}/decide`, {
    body: { decision: 'approved' },
  });
  expect(decided.statusCode, decided.body).toBe(201);
}

async function receive(
  skuId: string,
  qty: number,
  unitCost: number,
  locationId = warehouseLocation,
): Promise<void> {
  const actor = { orgId: ORG_A, userId: 'usr_inventory_e2e' };
  await withOrg(actor, (tx) =>
    api.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId,
      branchId: null,
      occurredAt: new Date(),
      lines: [{ skuId, qty, unitCostPoisha: poisha(unitCost) }],
    }),
  );
}

async function onHand(skuId: string, locationId: string): Promise<number> {
  return withOrg({ orgId: ORG_A, userId: 'usr_inventory_e2e' }, async (tx) => {
    const rows = await tx.execute<{ on_hand: number }>(sql`
      select on_hand from inventory.stock_levels
      where org_id = ${ORG_A} and sku_id = ${skuId} and location_id = ${locationId}
    `);
    return rows[0]?.on_hand ?? 0;
  });
}

async function journalCount(): Promise<number> {
  return withOrg({ orgId: ORG_A, userId: 'usr_inventory_e2e' }, async (tx) => {
    const rows = await tx.execute<{ total: string }>(sql`
      select count(*)::text as total from ledger.journals
      where org_id = ${ORG_A} and source_type = 'stock_adjustment'
    `);
    return Number(rows[0]?.total ?? '0');
  });
}

function sku(index: number): string {
  const found = skus[index];
  if (found === undefined) throw new Error('the fixture seeded fewer SKUs than this test expects');
  return found.id;
}

// --- check 4 ------------------------------------------------------------------

describe('check 4: an adjustment above the threshold needs approval', () => {
  it('holds the write-off, changes nothing, then applies and posts on approval', async () => {
    const target = sku(0);
    await receive(target, 40, 50_000);
    const journalsBefore = await journalCount();

    // 20 × 50,000 = 1,000,000 poisha, above the 500,000 threshold.
    const raised = await warehouse.client.request('POST', '/v1/inventory/adjustments', {
      body: {
        locationId: warehouseLocation,
        direction: 'loss',
        reason: 'Water damage in the back room',
        lines: [{ skuId: target, qty: 20 }],
      },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    const adjustment = body<{ id: string; status: string; approvalId: string }>(raised);
    expect(adjustment.status).toBe('pending_approval');

    // Nothing has happened yet, and that is the half of check 4 worth asserting.
    expect(await onHand(target, warehouseLocation)).toBe(40);
    expect(await journalCount()).toBe(journalsBefore);

    // The warehouse raised it, so the warehouse cannot decide it. §6 gives the
    // checker role to org_admin, and maker ≠ checker is a database constraint.
    const selfDecide = await warehouse.client.request(
      'POST',
      `/v1/approvals/${adjustment.approvalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(selfDecide.statusCode).toBe(403);

    const decided = await admin.client.request(
      'POST',
      `/v1/approvals/${adjustment.approvalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(decided.statusCode, decided.body).toBe(201);

    // Now, and only now, the stock moved and the journal exists.
    expect(await onHand(target, warehouseLocation)).toBe(20);
    expect(await journalCount()).toBe(journalsBefore + 1);

    const posted = body<{ items: { id: string; status: string; journalId: string | null }[] }>(
      await admin.client.request('GET', '/v1/inventory/adjustments?status=posted'),
    );
    const row = posted.items.find((item) => item.id === adjustment.id);
    expect(row?.status).toBe('posted');
    expect(row?.journalId).not.toBeNull();

    // Dr Inventory write-off 1,000,000 / Cr Inventory 1,000,000 (§7).
    const lines = await withOrg({ orgId: ORG_A, userId: 'usr_inventory_e2e' }, async (tx) => {
      const rows = await tx.execute<{ subtype: string; debit: string; credit: string }>(sql`
        select a.subtype::text as subtype, l.debit_poisha::text as debit,
               l.credit_poisha::text as credit
        from ledger.journal_lines l
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${ORG_A} and l.journal_id = ${row?.journalId ?? ''}
        order by l.line_no
      `);
      return [...rows];
    });
    expect(lines).toEqual([
      expect.objectContaining({ subtype: 'inventory_writeoff', debit: '1000000' }),
      expect.objectContaining({ subtype: 'inventory', credit: '1000000' }),
    ]);

    // And the movement behind it carries the frozen average, not a re-derived one.
    const movement = await withOrg({ orgId: ORG_A, userId: 'usr_inventory_e2e' }, async (tx) => {
      const rows = await tx.execute<{ kind: string; qty_delta: number; unit_cost_poisha: string }>(
        sql`
          select kind::text as kind, qty_delta, unit_cost_poisha::text as unit_cost_poisha
          from inventory.stock_movements
          where org_id = ${ORG_A} and ref_id = ${adjustment.id}
        `,
      );
      return rows[0];
    });
    expect(movement).toMatchObject({
      kind: 'adjustment_loss',
      qty_delta: -20,
      unit_cost_poisha: '50000',
    });
  }, 180_000);

  it('still needs a checker below the threshold, and a branch manager may be it', async () => {
    const target = sku(1);
    await receive(target, 10, 20_000, showroomLocation);

    // 2 × 20,000 = 40,000, well under the 500,000 threshold. D-076: a branch item is
    // never auto-approved, so this is pending and the branch's own manager decides it.
    const raised = await warehouse.client.request('POST', '/v1/inventory/adjustments', {
      body: {
        locationId: showroomLocation,
        direction: 'loss',
        reason: 'Two shirts torn on the rail',
        lines: [{ skuId: target, qty: 2 }],
      },
    });
    expect(raised.statusCode, raised.body).toBe(201);
    const adjustment = body<{ id: string; status: string; approvalId: string }>(raised);
    expect(adjustment.status).toBe('pending_approval');

    const decided = await branchManager.client.request(
      'POST',
      `/v1/approvals/${adjustment.approvalId}/decide`,
      { body: { decision: 'approved' } },
    );
    expect(decided.statusCode, decided.body).toBe(201);
    expect(await onHand(target, showroomLocation)).toBe(8);
  }, 180_000);

  it('refuses a write-off larger than the stock, in front of the person raising it', async () => {
    const target = sku(2);
    await receive(target, 3, 10_000);
    const refused = await warehouse.client.request('POST', '/v1/inventory/adjustments', {
      body: {
        locationId: warehouseLocation,
        direction: 'loss',
        reason: 'Typo',
        lines: [{ skuId: target, qty: 30 }],
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(body<{ code: string }>(refused).code).toBe('STOCK_INSUFFICIENT');
  }, 60_000);

  it('refuses a branch manager raising an adjustment outside their branch', async () => {
    const refused = await branchManager.client.request('POST', '/v1/inventory/adjustments', {
      body: {
        locationId: warehouseLocation,
        direction: 'loss',
        reason: 'Not my branch',
        lines: [{ skuId: sku(0), qty: 1 }],
      },
    });
    // 404, not 403: a row outside your scope is indistinguishable from one that does
    // not exist, or the error becomes an oracle.
    expect(refused.statusCode).toBe(404);
  }, 60_000);
});

// --- check 6 ------------------------------------------------------------------

describe('check 6: sales sees availability and no cost', () => {
  it('returns quantities with no cost or value field anywhere in the payload', async () => {
    const response = await sales.client.request('GET', '/v1/inventory/stock');
    expect(response.statusCode, response.body).toBe(200);
    const payload = body<{ items: { available: number; onHand: number }[] }>(response);

    expect(payload.items.length).toBeGreaterThan(0);
    const first = payload.items[0];
    expect(typeof first?.available).toBe('number');
    expect(typeof first?.onHand).toBe('number');
    // Walks the whole structure, not just the top level.
    expect(findCostFields(payload)).toEqual([]);
  }, 60_000);

  it('gives accounts the same rows with the cost fields on them', async () => {
    const accounts = await harness.asRole('accounts', ORG_A);
    const response = await accounts.client.request('GET', '/v1/inventory/stock');
    expect(response.statusCode, response.body).toBe(200);
    const payload = body<{ items: { wacPoisha: string; stockValuePoisha: string }[] }>(response);
    expect(findCostFields(payload).length).toBeGreaterThan(0);
    // Integer poisha as a decimal string, never a JSON number (§23).
    expect(typeof payload.items[0]?.wacPoisha).toBe('string');
  }, 60_000);

  it('gives sales 403 on the valuation report, which is cost in its own right', async () => {
    expect((await sales.client.request('GET', '/v1/inventory/valuation')).statusCode).toBe(403);
    const allowed = await admin.client.request('GET', '/v1/inventory/valuation');
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(body<{ stockValuePoisha: string }>(allowed).stockValuePoisha).toMatch(/^\d+$/);
  }, 60_000);

  it('gives sales no way to change stock at all', async () => {
    const refused = await sales.client.request('POST', '/v1/inventory/adjustments', {
      body: {
        locationId: warehouseLocation,
        direction: 'gain',
        reason: 'found some',
        lines: [{ skuId: sku(0), qty: 1 }],
      },
    });
    expect(refused.statusCode).toBe(403);
    // And there is no endpoint that sets a level, for anybody (invariant 3).
    expect(
      (
        await admin.client.request('PUT', '/v1/inventory/stock', {
          body: { skuId: sku(0), locationId: warehouseLocation, onHand: 999 },
        })
      ).statusCode,
    ).toBe(404);
  }, 60_000);
});

// --- transfers and counts -----------------------------------------------------

describe('two-step transfers', () => {
  it('parks stock in transit, then lands it at the destination', async () => {
    const { skus: fresh } = await seedProductWithSkus(ORG_A, 'xfer', 1);
    const target = fresh[0]?.id ?? '';
    await receive(target, 12, 25_000);

    const dispatched = await warehouse.client.request('POST', '/v1/inventory/transfers', {
      body: {
        fromLocationId: warehouseLocation,
        toLocationId: showroomLocation,
        lines: [{ skuId: target, qty: 5 }],
      },
    });
    expect(dispatched.statusCode, dispatched.body).toBe(201);
    const transfer = body<{ id: string; status: string; transitLocationId: string }>(dispatched);
    expect(transfer.status).toBe('dispatched');

    // Off the source shelf and visible in transit — not nowhere.
    expect(await onHand(target, warehouseLocation)).toBe(7);
    expect(await onHand(target, transfer.transitLocationId)).toBe(5);
    expect(await onHand(target, showroomLocation)).toBe(0);

    const received = await warehouse.client.request(
      'POST',
      `/v1/inventory/transfers/${transfer.id}/receive`,
    );
    expect(received.statusCode, received.body).toBe(201);
    expect(await onHand(target, transfer.transitLocationId)).toBe(0);
    expect(await onHand(target, showroomLocation)).toBe(5);

    // Receiving twice is idempotent rather than a second set of movements.
    const again = await warehouse.client.request(
      'POST',
      `/v1/inventory/transfers/${transfer.id}/receive`,
    );
    expect(again.statusCode, again.body).toBe(201);
    expect(await onHand(target, showroomLocation)).toBe(5);

    // And the transfer changed no cost at all (§8).
    const wac = await withOrg({ orgId: ORG_A, userId: 'usr_inventory_e2e' }, async (tx) => {
      const rows = await tx.execute<{ wac_poisha: string; qty_basis: number }>(sql`
        select wac_poisha::text as wac_poisha, qty_basis from inventory.sku_costs
        where org_id = ${ORG_A} and sku_id = ${target}
      `);
      return rows[0];
    });
    expect(wac).toMatchObject({ wac_poisha: '25000', qty_basis: 12 });
  }, 180_000);
});

describe('count sessions', () => {
  it('freezes a snapshot, then turns the variance into two approvals', async () => {
    const { skus: fresh } = await seedProductWithSkus(ORG_A, 'count', 2);
    const short = fresh[0]?.id ?? '';
    const long = fresh[1]?.id ?? '';
    const location = await makeLocation(ORG_A, {
      code: 'COUNT-WH',
      name: 'Count warehouse',
      kind: 'warehouse',
    });
    await receive(short, 10, 30_000, location);
    await receive(long, 10, 30_000, location);

    const opened = await warehouse.client.request('POST', '/v1/inventory/counts', {
      body: { locationId: location, memo: 'December floor count' },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const session = body<{ id: string; lines: { skuId: string; snapshotQty: number }[] }>(opened);
    expect(session.lines).toHaveLength(2);
    expect(session.lines.every((line) => line.snapshotQty === 10)).toBe(true);

    // A sale during the count does not move the snapshot, which is the whole point.
    await receive(short, 4, 30_000, location);
    const reread = body<{ lines: { snapshotQty: number }[] }>(
      await warehouse.client.request('GET', `/v1/inventory/counts/${session.id}`),
    );
    expect(reread.lines.every((line) => line.snapshotQty === 10)).toBe(true);

    const counted = await warehouse.client.request(
      'PUT',
      `/v1/inventory/counts/${session.id}/lines`,
      {
        body: {
          lines: [
            { skuId: short, countedQty: 7 },
            { skuId: long, countedQty: 13 },
          ],
        },
      },
    );
    expect(counted.statusCode, counted.body).toBe(200);
    const variances = body<{ lines: { skuId: string; varianceQty: number | null }[] }>(counted);
    expect(variances.lines.find((line) => line.skuId === short)?.varianceQty).toBe(-3);
    expect(variances.lines.find((line) => line.skuId === long)?.varianceQty).toBe(3);

    // Closing before submitting is refused: the two are different decisions.
    expect(
      (await warehouse.client.request('POST', `/v1/inventory/counts/${session.id}/close`))
        .statusCode,
    ).toBe(409);

    expect(
      (await warehouse.client.request('POST', `/v1/inventory/counts/${session.id}/submit`))
        .statusCode,
    ).toBe(201);

    const closed = await warehouse.client.request(
      'POST',
      `/v1/inventory/counts/${session.id}/close`,
    );
    expect(closed.statusCode, closed.body).toBe(201);
    const result = body<{
      session: { status: string };
      adjustments: { direction: string; status: string; approvalId: string }[];
    }>(closed);
    expect(result.session.status).toBe('closed');
    // One write-off and one gain, never a net figure: §7 gives them different
    // accounts, and netting a floor full of miscounts to zero hides the problem.
    expect(result.adjustments.map((item) => item.direction).sort()).toEqual(['gain', 'loss']);
    expect(result.adjustments.every((item) => item.status === 'pending_approval')).toBe(true);

    // Nothing has moved yet.
    expect(await onHand(short, location)).toBe(14);
    expect(await onHand(long, location)).toBe(10);

    for (const item of result.adjustments) {
      const decided = await admin.client.request(
        'POST',
        `/v1/approvals/${item.approvalId}/decide`,
        {
          body: { decision: 'approved' },
        },
      );
      expect(decided.statusCode, decided.body).toBe(201);
    }

    expect(await onHand(short, location)).toBe(11);
    expect(await onHand(long, location)).toBe(13);

    // A closed session takes no more counts, and cannot be reopened.
    expect(
      (
        await warehouse.client.request('PUT', `/v1/inventory/counts/${session.id}/lines`, {
          body: { lines: [{ skuId: short, countedQty: 1 }] },
        })
      ).statusCode,
    ).toBe(409);
  }, 240_000);
});

// --- locations and reorder levels ---------------------------------------------

describe('locations and low stock', () => {
  it('lets an admin add a location and refuses a branch on a shared one', async () => {
    const created = await admin.client.request('POST', '/v1/inventory/locations', {
      body: { code: 'DMG-01', name: 'Damaged goods', kind: 'damaged' },
    });
    expect(created.statusCode, created.body).toBe(201);

    const refused = await admin.client.request('POST', '/v1/inventory/locations', {
      body: { code: 'DMG-02', name: 'Damaged goods', kind: 'damaged', branchId: hqBranch },
    });
    expect(refused.statusCode).toBe(400);

    const noBranch = await admin.client.request('POST', '/v1/inventory/locations', {
      body: { code: 'SHR-NOBRANCH', name: 'Floating showroom', kind: 'showroom' },
    });
    expect(noBranch.statusCode).toBe(400);

    // The warehouse role reads locations but does not invent them (§8, D-046).
    expect(
      (
        await warehouse.client.request('POST', '/v1/inventory/locations', {
          body: { code: 'WH-99', name: 'Secret warehouse', kind: 'warehouse' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await warehouse.client.request('GET', '/v1/inventory/locations')).statusCode).toBe(200);
  }, 60_000);

  it('emits stock.low when availability reaches the reorder level', async () => {
    const { skus: fresh } = await seedProductWithSkus(ORG_A, 'low', 1);
    const target = fresh[0]?.id ?? '';
    await receive(target, 10, 15_000);

    const set = await admin.client.request('PUT', '/v1/inventory/reorder-levels', {
      body: { skuId: target, locationId: warehouseLocation, reorderLevel: 6 },
    });
    expect(set.statusCode, set.body).toBe(200);

    const actor = { orgId: ORG_A, userId: 'usr_inventory_e2e' };
    await withOrg(actor, (tx) =>
      api.dispatch(tx, actor, {
        orderId: randomUUID(),
        locationId: warehouseLocation,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 5 }],
      }),
    );

    const emitted = await withOrg(actor, async (tx) => {
      const rows = await tx.execute<{ payload: { skuId: string; available: number } }>(sql`
        select payload from events.outbox
        where org_id = ${ORG_A} and name = 'stock.low'
        order by created_at desc limit 1
      `);
      return rows[0]?.payload;
    });
    expect(emitted).toMatchObject({ skuId: target, available: 5, reorderLevel: 6 });
    // Quantities only. A socket has no `serializeFor` in front of it, and this event
    // goes to `warehouse`, which holds no `read:cost`.
    expect(findCostFields(emitted)).toEqual([]);

    // And the low filter finds it.
    const low = body<{ items: { skuId: string }[] }>(
      await warehouse.client.request('GET', '/v1/inventory/stock?low=true'),
    );
    expect(low.items.map((item) => item.skuId)).toContain(target);
  }, 120_000);
});
