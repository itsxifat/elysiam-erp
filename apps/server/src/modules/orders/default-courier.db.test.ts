import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import { ORDERS_API, type OrdersApi } from './orders.api.js';
import { OrdersModule } from './orders.module.js';
import { OrdersService } from './orders.service.js';
import { applyOrderMigrations, ownRiderCourier, seedCustomer } from './orders.testing.js';

/**
 * The brand's default courier is §9's, its delivery zones' (D-913), against real Postgres.
 *
 * 1. **A delivery that names no courier** is posted against the order's zone's default courier,
 *    else the one courier the zones name, never against whichever party sorts first by code.
 *    Settings → Couriers makes a Carrybee party when Carrybee is added, and `carrybee` sorts
 *    before `own_rider`: the old fallback moved every such delivery's courier receivable onto
 *    Carrybee, for cash Carrybee never collected.
 * 2. **Two people making two couriers the default at once** are served one after the other.
 *    Without the zones locked first, the second update skipped the zones that already named its
 *    courier in its snapshot and left the zones split, with no default at all.
 */

const SYSTEM_USER = 'usr_default_courier_test';

let harness: HttpHarness;
let orders: OrdersService;
let ordersApi: OrdersApi;
let inventory: InventoryApi;

beforeAll(async () => {
  harness = await startHttpHarness('orders-default-courier', { extraModules: [OrdersModule] });
  await applyOrderMigrations();
  orders = harness.app.get(OrdersService);
  ordersApi = harness.app.get<OrdersApi>(ORDERS_API);
  inventory = harness.app.get<InventoryApi>(INVENTORY_API);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

function request(): AuditableRequest {
  const value = {} as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

function context(): ActiveContext {
  return {
    orgId: ORG_A,
    userId: SYSTEM_USER,
    isSuperAdmin: false,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: 'default-courier-test',
  };
}

async function party(code: string, name: string): Promise<string> {
  return withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
    const row = await ordersApi.ensureCourierParty(tx, ORG_A, { code, name });
    return row.id;
  });
}

async function setZones(byCode: Readonly<Record<string, string | null>>): Promise<void> {
  await withSystem(
    async (tx) => {
      for (const [code, courierId] of Object.entries(byCode)) {
        await tx.execute(sql`
          update sales.delivery_zones set default_courier_id = ${courierId}::uuid
          where org_id = ${ORG_A} and code = ${code}
        `);
      }
    },
    { orgId: ORG_A },
  );
}

async function zones(): Promise<Record<string, string | null>> {
  const rows = await withSystem(
    async (tx) => [
      ...(await tx.execute<{ code: string; default_courier_id: string | null }>(sql`
        select code, default_courier_id from sales.delivery_zones
        where org_id = ${ORG_A} order by code
      `)),
    ],
    { orgId: ORG_A },
  );
  return Object.fromEntries(rows.map((row) => [row.code, row.default_courier_id]));
}

/** A shipped order that names no courier, in this zone (or none): an older order, say. */
async function shippedWithNoCourier(zoneCode: string | null): Promise<string> {
  const location = await warehouseId(ORG_A);
  const { skus } = await seedProductWithSkus(ORG_A, `dflt${randomUUID().slice(0, 6)}`, 1);
  const skuId = skus[0]?.id ?? '';
  const actor = { orgId: ORG_A, userId: SYSTEM_USER };
  await withOrg(actor, (tx) =>
    inventory.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: location,
      branchId: null,
      occurredAt: new Date(),
      lines: [{ skuId, qty: 1, unitCostPoisha: poisha(40_000n) }],
    }),
  );
  const customerId = await seedCustomer(ORG_A, {
    phoneE164: '+8801712345601',
    name: 'Nusrat Jahan',
  });
  const created = await orders.create(context(), request(), {
    channel: 'phone',
    customerId,
    locationId: location,
    courierId: await ownRiderCourier(ORG_A),
    deliveryChargePoisha: '6000',
    lines: [{ skuId, qty: 1, unitPricePoisha: '150000' }],
  });
  await orders.confirm(context(), request(), created.id);
  await orders.transition(context(), request(), created.id, 'ship');
  await withSystem(
    (tx) =>
      tx.execute(sql`
        update sales.orders
        set courier_id = null,
            delivery_zone_id = (select id from sales.delivery_zones
                                where org_id = ${ORG_A} and code = ${zoneCode})
        where org_id = ${ORG_A} and id = ${created.id}
      `),
    { orgId: ORG_A },
  );
  return created.id;
}

/** The party the delivery's courier receivable was debited against. */
async function receivableParty(orderId: string): Promise<string | null | undefined> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ party_id: string | null }>(sql`
        select l.party_id from ledger.journal_lines l
        join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${ORG_A} and j.source_id = ${orderId}
          and a.subtype = 'courier_receivable' and l.debit_poisha > 0
      `),
    { orgId: ORG_A },
  );
  return rows[0]?.party_id;
}

describe('a delivery that names no courier', () => {
  it('is posted against §9’s default, not against Carrybee added beside it', async () => {
    const ownRider = await ownRiderCourier(ORG_A);
    // Added in Settings → Couriers without the default switch, only so it can be chosen.
    const carrybee = await party('carrybee', 'Carrybee');
    expect((await zones()).inside_dhaka).toBe(ownRider);

    // Its own zone names the own rider.
    const inZone = await shippedWithNoCourier('inside_dhaka');
    await orders.transition(context(), request(), inZone, 'deliver');
    expect(await receivableParty(inZone)).toBe(ownRider);

    // Its zone names none (saved without a default): the courier the other zones name.
    await setZones({ outside_dhaka: null });
    const zoneWithout = await shippedWithNoCourier('outside_dhaka');
    await orders.transition(context(), request(), zoneWithout, 'deliver');
    expect(await receivableParty(zoneWithout)).toBe(ownRider);
    expect(await receivableParty(zoneWithout)).not.toBe(carrybee);
    await setZones({ outside_dhaka: ownRider });
  });

  it('is refused, not guessed, when nothing names one courier', async () => {
    const ownRider = await ownRiderCourier(ORG_A);
    const orderId = await shippedWithNoCourier(null);
    await setZones({ inside_dhaka: null, dhaka_suburbs: null, outside_dhaka: null });
    try {
      await expect(orders.transition(context(), request(), orderId, 'deliver')).rejects.toThrow(
        /names no courier/,
      );
      expect(await receivableParty(orderId)).toBeUndefined();
    } finally {
      await setZones({ inside_dhaka: ownRider, dhaka_suburbs: ownRider, outside_dhaka: ownRider });
    }
  });
});

describe('making a courier the default', () => {
  it('serves two changes at once one after the other, so the zones are never left split', async () => {
    const pathao = await party('pathao', 'Pathao');
    const steadfast = await party('steadfast', 'Steadfast');
    const carrybee = await party('carrybee', 'Carrybee');
    await setZones({ inside_dhaka: pathao, dhaka_suburbs: steadfast, outside_dhaka: steadfast });

    // A makes Carrybee the default and holds its transaction open.
    let changed!: () => void;
    const aChanged = new Promise<void>((resolve) => (changed = resolve));
    let release!: () => void;
    const aMayCommit = new Promise<void>((resolve) => (release = resolve));
    const first = withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
      await ordersApi.setDefaultCourier(tx, ORG_A, carrybee);
      changed();
      await aMayCommit;
    });
    await aChanged;

    // B makes Pathao the default meanwhile: inside_dhaka already names Pathao in its snapshot.
    const second = withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, (tx) =>
      ordersApi.setDefaultCourier(tx, ORG_A, pathao),
    );
    // Until B is waiting on A's locks (or a few seconds, which would only weaken the test).
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const waiting = await withSystem(
        async (tx) =>
          (
            await tx.execute<{ waiting: number }>(sql`
              select count(*)::int as waiting from pg_locks l
              join pg_stat_activity s on s.pid = l.pid
              where not l.granted and s.datname = current_database()
            `)
          )[0]?.waiting ?? 0,
        { orgId: ORG_A },
      );
      if (waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    release();
    await first;
    const { before } = await second;

    // B came second and saw A's change: every zone is Pathao's, and Pathao is the default.
    expect(new Set(before.map((zone) => zone.courierId))).toEqual(new Set([carrybee]));
    expect(new Set(Object.values(await zones()))).toEqual(new Set([pathao]));
    const state = await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, (tx) =>
      ordersApi.defaultCourierState(tx, ORG_A),
    );
    expect(state).toMatchObject({ courierId: pathao, mixed: false });

    const ownRider = await ownRiderCourier(ORG_A);
    await setZones({ inside_dhaka: ownRider, dhaka_suburbs: ownRider, outside_dhaka: ownRider });
  });

  it('says when the active zones name different couriers', async () => {
    const ownRider = await ownRiderCourier(ORG_A);
    const pathao = await party('pathao', 'Pathao');
    await setZones({ inside_dhaka: pathao });
    const state = await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, (tx) =>
      ordersApi.defaultCourierState(tx, ORG_A),
    );
    expect(state).toEqual({ courierId: null, mixed: true, activeZones: 3 });
    await setZones({ inside_dhaka: ownRider });
  });
});
