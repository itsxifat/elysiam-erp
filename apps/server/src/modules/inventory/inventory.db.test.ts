import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { MOVEMENT_KINDS, poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ORG_A, ORG_B, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from './inventory.api.js';
import { InventoryModule } from './inventory.module.js';
import { MovementsService } from './movements.service.js';
import { ReconcileService } from './reconcile.service.js';
import {
  applyInventoryMigrations,
  makeLocation,
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from './inventory.testing.js';

/**
 * Invariant 3, against a real database (M07 acceptance checks 1, 2, 3 and 5).
 *
 * The four things this suite exists to prove, in the order they matter:
 *
 * 1. **Check 1 — 50 parallel reservations for the last 10 units yield exactly 10
 *    successes.** Each attempt is its own transaction against the real pool, so the
 *    statements genuinely race. The read-then-write version of `reserve` passes every
 *    single-threaded test and fails this one; that asymmetry is the entire reason the
 *    check is written this way.
 * 2. **Check 2 — levels equal Σ movements.** The property test over random movement
 *    sequences lives in `packages/domain`, where it can run thousands of cases in
 *    milliseconds. Here the same claim is checked against the database after a real
 *    sequence, using the same `findLevelDrift` query the nightly job uses — and then
 *    the database's own refusals are checked, because the interesting half of
 *    invariant 3 is not that the code keeps them in step but that nothing *can* put
 *    them out of step.
 * 3. **Check 3 — §8's worked WAC example, to the poisha, including the purchase price
 *    variance on the supplier return.** End to end: real movements, real cost row,
 *    real journals read back out of `ledger.journal_lines`.
 * 4. **Check 5 — drift injected by the owner role is detected and alerted.** The
 *    injection runs as `erp_owner`, which is the only role that can get past the
 *    grants, and that is the point: the job has to find damage done by something
 *    other than the application.
 */

let harness: HttpHarness;
let api: InventoryApi;
let movements: MovementsService;
let reconcile: ReconcileService;

let warehouse = '';
let showroom = '';
let transit = '';
let skus: SeededSku[] = [];
const SUPPLIER = randomUUID();
const SYSTEM_USER = 'usr_inventory_test';

beforeAll(async () => {
  harness = await startHttpHarness('inventory-db', { extraModules: [InventoryModule] });
  await applyInventoryMigrations();

  api = harness.app.get<InventoryApi>(INVENTORY_API);
  movements = harness.app.get(MovementsService);
  reconcile = harness.app.get(ReconcileService);

  warehouse = await warehouseId(ORG_A);
  const branch = await hqBranch(ORG_A);
  showroom = await makeLocation(ORG_A, {
    code: 'SHR-01',
    name: 'Gulshan Showroom',
    kind: 'showroom',
    branchId: branch,
  });
  transit = await makeLocation(ORG_A, { code: 'TRANSIT', name: 'In transit', kind: 'in_transit' });

  ({ skus } = await seedProductWithSkus(ORG_A, 'stock', 4));
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ------------------------------------------------------------------

async function hqBranch(orgId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.branches where org_id = ${orgId} and code = 'HQ'
      `);
      return rows[0]?.id ?? '';
    },
    { orgId },
  );
}

function actor(orgId = ORG_A) {
  return { orgId, userId: SYSTEM_USER };
}

async function receive(
  skuId: string,
  qty: number,
  unitCost: number,
  locationId = warehouse,
): Promise<void> {
  await withOrg(actor(), (tx) =>
    api.receiveSupply(tx, actor(), {
      supplyId: randomUUID(),
      supplierId: SUPPLIER,
      locationId,
      branchId: null,
      occurredAt: new Date(),
      lines: [{ skuId, qty, unitCostPoisha: poisha(unitCost) }],
    }),
  );
}

async function level(skuId: string, locationId: string) {
  return withOrg(actor(), async (tx) => {
    const rows = await tx.execute<{ on_hand: number; reserved: number }>(sql`
      select on_hand, reserved from inventory.stock_levels
      where org_id = ${ORG_A} and sku_id = ${skuId} and location_id = ${locationId}
    `);
    return rows[0];
  });
}

async function cost(skuId: string) {
  return withOrg(actor(), async (tx) => {
    const rows = await tx.execute<{ wac_poisha: string; qty_basis: number }>(sql`
      select wac_poisha::text as wac_poisha, qty_basis from inventory.sku_costs
      where org_id = ${ORG_A} and sku_id = ${skuId}
    `);
    return rows[0];
  });
}

async function journalLines(journalId: string) {
  return withOrg(actor(), async (tx) => {
    const rows = await tx.execute<{
      code: string;
      subtype: string;
      debit_poisha: string;
      credit_poisha: string;
    }>(sql`
      select a.code, a.subtype::text as subtype,
             l.debit_poisha::text as debit_poisha, l.credit_poisha::text as credit_poisha
      from ledger.journal_lines l
      join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${ORG_A} and l.journal_id = ${journalId}
      order by l.line_no
    `);
    return [...rows];
  });
}

/**
 * The message of a database refusal, from anywhere in the cause chain.
 *
 * Drizzle wraps a `PostgresError` in its own `Failed query: …`, so asserting on the
 * outer message finds only the SQL. The codes these triggers raise are the contract
 * `databaseStockCode` reads (`.claude/rules/inventory.md`), so the assertion has to
 * look where they actually are.
 */
async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    const parts: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      parts.push(current.message);
      const constraint = (current as { constraint_name?: unknown }).constraint_name;
      if (typeof constraint === 'string') parts.push(constraint);
    }
    return parts.join(' | ');
  }
  throw new Error('that statement was expected to be refused, and was not');
}

function sku(index: number): string {
  const found = skus[index];
  if (found === undefined) throw new Error('the fixture seeded fewer SKUs than this test expects');
  return found.id;
}

// --- check 1: concurrency -----------------------------------------------------

describe('check 1: reserving the last units under concurrency', () => {
  it('lets exactly 10 of 50 parallel reservations succeed', async () => {
    const target = sku(0);
    await receive(target, 10, 50_000);

    /*
     * Fifty independent transactions, each reserving one unit of a SKU with ten on
     * hand. Each carries its own reference, because the partial unique index makes a
     * hold idempotent per reference and fifty attempts on one reference would be
     * answering a different question.
     *
     * They are started together and awaited together: `withOrg` takes a connection
     * from the real pool, so up to ten run at any instant and the rest queue behind
     * them. That is enough for the race — ten simultaneous copies of the conditional
     * UPDATE contending for one row is exactly the situation the statement exists
     * for, and the queued ones then find the stock gone.
     */
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () =>
        withOrg(actor(), (tx) =>
          api.reserve(tx, actor(), {
            refType: 'order',
            refId: randomUUID(),
            lines: [{ skuId: target, locationId: warehouse, qty: 1 }],
          }),
        ).then(
          () => 'reserved' as const,
          () => 'refused' as const,
        ),
      ),
    );

    expect(outcomes.filter((outcome) => outcome === 'reserved')).toHaveLength(10);
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(40);

    // And the level says the same thing, which is the part a "10 successes" count
    // alone would not catch: a lost update would report ten successes and hold five.
    expect(await level(target, warehouse)).toMatchObject({ on_hand: 10, reserved: 10 });

    const rows = await withOrg(actor(), async (tx) => {
      const result = await tx.execute<{ total: string }>(sql`
        select count(*)::text as total from inventory.reservations
        where org_id = ${ORG_A} and sku_id = ${target} and status = 'active'
      `);
      return Number(result[0]?.total ?? '0');
    });
    expect(rows).toBe(10);
  }, 120_000);

  it('refuses to dispatch reserved stock from under an order, and releases cleanly', async () => {
    const target = sku(1);
    await receive(target, 5, 40_000);

    const orderId = randomUUID();
    await withOrg(actor(), (tx) =>
      api.reserve(tx, actor(), {
        refType: 'order',
        refId: orderId,
        lines: [{ skuId: target, locationId: warehouse, qty: 5 }],
      }),
    );

    // All five units are promised, so a write-off of one has nothing to take: the
    // `reserved <= on_hand` CHECK is what refuses it, not an availability read.
    await expect(
      withOrg(actor(), (tx) =>
        movements.apply(tx, actor(), {
          skuId: target,
          locationId: warehouse,
          kind: 'adjustment_loss',
          qty: 1,
          refType: 'adjustment',
          refId: randomUUID(),
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toThrow();

    const released = await withOrg(actor(), (tx) =>
      api.release(tx, actor(), { refType: 'order', refId: orderId }),
    );
    expect(released).toBe(1);
    expect(await level(target, warehouse)).toMatchObject({ on_hand: 5, reserved: 0 });

    // Releasing twice is a no-op rather than a negative reservation.
    expect(
      await withOrg(actor(), (tx) =>
        api.release(tx, actor(), { refType: 'order', refId: orderId }),
      ),
    ).toBe(0);
  }, 120_000);
});

// --- check 2: levels equal Σ movements, and cannot be made not to --------------

describe('check 2: levels always equal Σ movements', () => {
  it('agrees after a real sequence of receipts, dispatches and transfers', async () => {
    const target = sku(2);
    await receive(target, 20, 30_000);
    await receive(target, 5, 35_000);

    const orderId = randomUUID();
    await withOrg(actor(), async (tx) => {
      await api.reserve(tx, actor(), {
        refType: 'order',
        refId: orderId,
        lines: [{ skuId: target, locationId: warehouse, qty: 3 }],
      });
      await api.dispatch(tx, actor(), {
        orderId,
        locationId: warehouse,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 3 }],
        fromReservation: true,
      });
    });

    await withOrg(actor(), async (tx) => {
      await movements.apply(tx, actor(), {
        skuId: target,
        locationId: warehouse,
        kind: 'transfer_out',
        qty: 4,
        refType: 'transfer',
        refId: randomUUID(),
        occurredAt: new Date(),
      });
      await movements.apply(tx, actor(), {
        skuId: target,
        locationId: showroom,
        kind: 'transfer_in',
        qty: 4,
        refType: 'transfer',
        refId: randomUUID(),
        occurredAt: new Date(),
      });
    });

    expect(await level(target, warehouse)).toMatchObject({ on_hand: 18, reserved: 0 });
    expect(await level(target, showroom)).toMatchObject({ on_hand: 4, reserved: 0 });

    // The same query the nightly job runs, over every level in the org.
    const drift = await reconcile.reconcileOrg(ORG_A, SYSTEM_USER);
    expect(drift.driftCount).toBe(0);
    expect(drift.costDriftCount).toBe(0);
  }, 120_000);

  it('refuses a level change with no movement behind it (invariant 3)', async () => {
    const target = sku(2);
    /*
     * As `erp_owner`, which owns every table. The application role holds no path to
     * this at all, so if the trigger were absent the only thing standing between a
     * repair script and silently created stock would be someone's memory.
     */
    expect(
      await refusal(() =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
              update inventory.stock_levels set on_hand = on_hand + 99
              where org_id = ${ORG_A} and sku_id = ${target} and location_id = ${warehouse}
            `);
          },
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/STOCK_MOVEMENT_REQUIRED/);
  }, 60_000);

  it('refuses to edit or delete a movement (append-only)', async () => {
    expect(
      await refusal(() =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
              update inventory.stock_movements set qty_delta = qty_delta + 1
              where org_id = ${ORG_A}
            `);
          },
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/STOCK_MOVEMENT_IMMUTABLE/);

    expect(
      await refusal(() =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`delete from inventory.stock_movements where org_id = ${ORG_A}`);
          },
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/STOCK_MOVEMENT_IMMUTABLE/);
  }, 60_000);

  it('refuses a movement whose sign contradicts its kind, in the database', async () => {
    expect(
      await refusal(() =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
              insert into inventory.stock_movements
                (org_id, sku_id, location_id, kind, qty_delta, ref_type, business_date,
                 created_by, created_txid)
              values (${ORG_A}, ${sku(2)}, ${warehouse}, 'dispatch', 5, 'test', current_date,
                      'test', pg_current_xact_id())
            `);
          },
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/stock_movements_sign_matches_kind/);
  }, 60_000);

  it('keeps one org out of another org’s stock', async () => {
    const visible = await withOrg({ orgId: ORG_B, userId: SYSTEM_USER }, async (tx) => {
      const rows = await tx.execute<{ total: string }>(sql`
        select count(*)::text as total from inventory.stock_levels
      `);
      return Number(rows[0]?.total ?? '0');
    });
    // ORG_B has no stock of its own, and every row written above belongs to ORG_A.
    expect(visible).toBe(0);
  }, 60_000);
});

// --- check 3: §8's worked WAC example -----------------------------------------

describe('check 3: the §8 worked example, to the poisha', () => {
  it('receives 10 @ ৳500 then 30 @ ৳540, dispatches 5, and returns 3 at a 3,000 variance', async () => {
    const { skus: fresh } = await seedProductWithSkus(ORG_A, 'wac', 1);
    const target = fresh[0]?.id ?? '';
    const location = await makeLocation(ORG_A, {
      code: 'WAC-WH',
      name: 'WAC warehouse',
      kind: 'warehouse',
    });

    // Starting position: on-hand 10 @ ৳500.00.
    await receive(target, 10, 50_000, location);
    expect(await cost(target)).toMatchObject({ wac_poisha: '50000', qty_basis: 10 });

    // Receive 30 @ ৳540.00 → (10×50,000 + 30×54,000) / 40 = 53,000 poisha.
    const receipt = await withOrg(actor(), (tx) =>
      api.receiveSupply(tx, actor(), {
        supplyId: randomUUID(),
        supplierId: SUPPLIER,
        locationId: location,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 30, unitCostPoisha: poisha(54_000) }],
      }),
    );
    expect(await cost(target)).toMatchObject({ wac_poisha: '53000', qty_basis: 40 });

    // Dr Inventory 1,620,000 / Cr Supplier payable 1,620,000.
    expect(await journalLines(receipt.journalId ?? '')).toEqual([
      expect.objectContaining({ subtype: 'inventory', debit_poisha: '1620000' }),
      expect.objectContaining({ subtype: 'supplier_payable', credit_poisha: '1620000' }),
    ]);

    // Dispatch 5 at 53,000: the average holds, the basis falls, and the handover
    // journal moves 265,000 into goods in transit.
    const orderId = randomUUID();
    const dispatched = await withOrg(actor(), (tx) =>
      api.dispatch(tx, actor(), {
        orderId,
        locationId: location,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 5 }],
      }),
    );
    expect(await cost(target)).toMatchObject({ wac_poisha: '53000', qty_basis: 35 });
    expect(dispatched.valuePoisha).toBe('265000');
    expect(await journalLines(dispatched.journalId ?? '')).toEqual([
      expect.objectContaining({ subtype: 'goods_in_transit', debit_poisha: '265000' }),
      expect.objectContaining({ subtype: 'inventory', credit_poisha: '265000' }),
    ]);

    // A supplier return of 3 from the second lot: credit 3 × 54,000 = 162,000,
    // relieve inventory at 3 × 53,000 = 159,000, and the 3,000 difference is a
    // credit to purchase price variance.
    const returned = await withOrg(actor(), (tx) =>
      api.returnToSupplier(tx, actor(), {
        returnId: randomUUID(),
        supplierId: SUPPLIER,
        locationId: location,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 3, originalUnitCostPoisha: poisha(54_000) }],
      }),
    );
    expect(returned.valuePoisha).toBe('162000');
    expect(await journalLines(returned.journalId ?? '')).toEqual([
      expect.objectContaining({ subtype: 'supplier_payable', debit_poisha: '162000' }),
      expect.objectContaining({ subtype: 'inventory', credit_poisha: '159000' }),
      expect.objectContaining({ subtype: 'purchase_price_variance', credit_poisha: '3000' }),
    ]);

    // The return left the average alone and took the basis to 32.
    expect(await cost(target)).toMatchObject({ wac_poisha: '53000', qty_basis: 32 });
    expect(await level(target, location)).toMatchObject({ on_hand: 32 });

    // And the movement recorded the value the units left at, which is what M12's
    // delivery journal has to credit goods in transit with.
    const dispatchMovement = await withOrg(actor(), async (tx) => {
      const rows = await tx.execute<{ unit_cost_poisha: string; qty_delta: number }>(sql`
        select unit_cost_poisha::text as unit_cost_poisha, qty_delta
        from inventory.stock_movements
        where org_id = ${ORG_A} and ref_id = ${orderId} and kind = 'dispatch'
      `);
      return rows[0];
    });
    expect(dispatchMovement).toMatchObject({ unit_cost_poisha: '53000', qty_delta: -5 });
  }, 180_000);

  it('replays a dispatch idempotently, reporting the value it first recorded', async () => {
    const { skus: fresh } = await seedProductWithSkus(ORG_A, 'replay', 1);
    const target = fresh[0]?.id ?? '';
    await receive(target, 6, 45_000);

    const orderId = randomUUID();
    const first = await withOrg(actor(), (tx) =>
      api.dispatch(tx, actor(), {
        orderId,
        locationId: warehouse,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 2 }],
      }),
    );
    expect(first.valuePoisha).toBe('90000');

    // The same call again: §20's queues are at-least-once, so this is the ordinary
    // case rather than the exotic one. The dedupe key stops the second movement, the
    // stock does not move twice, and the journal is the same one.
    const second = await withOrg(actor(), (tx) =>
      api.dispatch(tx, actor(), {
        orderId,
        locationId: warehouse,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 2 }],
      }),
    );
    expect(second.movementIds).toHaveLength(0);
    expect(await level(target, warehouse)).toMatchObject({ on_hand: 4 });

    const journals = await withOrg(actor(), async (tx) => {
      const rows = await tx.execute<{ total: string }>(sql`
        select count(*)::text as total from ledger.journals
        where org_id = ${ORG_A} and source_id = ${orderId}
      `);
      return Number(rows[0]?.total ?? '0');
    });
    expect(journals).toBe(1);
  }, 120_000);

  it('brings a customer return back at the cost it was dispatched at', async () => {
    const { skus: fresh } = await seedProductWithSkus(ORG_A, 'creturn', 1);
    const target = fresh[0]?.id ?? '';

    await receive(target, 10, 20_000);
    const orderId = randomUUID();
    await withOrg(actor(), (tx) =>
      api.dispatch(tx, actor(), {
        orderId,
        locationId: warehouse,
        branchId: null,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 2 }],
      }),
    );
    // A later purchase moves the average to something else entirely.
    await receive(target, 8, 60_000);
    const beforeReturn = await cost(target);

    await withOrg(actor(), (tx) =>
      api.receiveCustomerReturn(tx, actor(), {
        orderId,
        locationId: warehouse,
        occurredAt: new Date(),
        lines: [{ skuId: target, qty: 2, dispatchUnitCostPoisha: poisha(20_000) }],
      }),
    );

    // Blended at 20,000 — the dispatch cost — not at the current average, so the
    // refund cannot create inventory value out of a price rise.
    const basis = BigInt(beforeReturn?.qty_basis ?? 0);
    const wacBefore = BigInt(beforeReturn?.wac_poisha ?? '0');
    // Rounded half away from zero, like `divideRounded` — bigint `/` truncates, and
    // the difference between the two is one poisha, which is exactly the size of
    // error this check exists to notice.
    const numerator = wacBefore * basis + 20_000n * 2n;
    const denominator = basis + 2n;
    const expected = (2n * numerator + denominator) / (2n * denominator);
    const after = await cost(target);
    expect(BigInt(after?.wac_poisha ?? '0')).toBe(expected);
  }, 120_000);
});

// --- check 5: drift detection -------------------------------------------------

describe('check 5: the nightly reconciliation finds drift the owner injected', () => {
  it('detects a level that no longer matches its movements, and alerts', async () => {
    const { skus: fresh } = await seedProductWithSkus(ORG_A, 'drift', 1);
    const target = fresh[0]?.id ?? '';
    await receive(target, 7, 10_000);

    const clean = await reconcile.reconcileOrg(ORG_A, SYSTEM_USER);
    expect(clean.driftCount).toBe(0);

    /*
     * Injected as `erp_owner`, and with the trigger disabled for the statement.
     *
     * That combination is the honest simulation. Migration 0033 stops the
     * application and any ordinary repair script, so the damage this job is meant to
     * find has to come from something that got past it — a restore from an
     * inconsistent backup, a trigger disabled during a maintenance window, a bug in
     * a future migration. Disabling the trigger here reproduces that state rather
     * than pretending the job protects against something already impossible.
     */
    await withSystem(
      async (tx) => {
        await tx.execute(sql`alter table inventory.stock_levels disable trigger user`);
        await tx.execute(sql`
          update inventory.stock_levels set on_hand = on_hand + 3
          where org_id = ${ORG_A} and sku_id = ${target} and location_id = ${warehouse}
        `);
        await tx.execute(sql`alter table inventory.stock_levels enable trigger user`);
      },
      { orgId: ORG_A },
    );

    const found = await reconcile.reconcileOrg(ORG_A, SYSTEM_USER);
    expect(found.driftCount).toBeGreaterThanOrEqual(1);
    expect(found.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'level',
          skuId: target,
          locationId: warehouse,
          expected: 7,
          found: 10,
        }),
      ]),
    );
    // The cost basis drifted with it, which is the failure that compounds: the next
    // receipt would blend against a denominator three units too large.
    expect(found.costDriftCount).toBeGreaterThanOrEqual(1);

    // The alert is an outbox row, so it fires only because the reconciliation
    // committed — and `stock.drift_detected` is the event §26's stock-drift alert
    // rule listens for.
    const alerted = await withOrg(actor(), async (tx) => {
      const rows = await tx.execute<{ payload: { reconciliationId: string } }>(sql`
        select payload from events.outbox
        where org_id = ${ORG_A} and name = 'stock.drift_detected'
        order by created_at desc limit 1
      `);
      return rows[0]?.payload.reconciliationId;
    });
    expect(alerted).toBe(found.reconciliationId);

    // A clean run still writes a row: "no drift" and "the job stopped running" must
    // not be the same silence.
    const history = await withOrg(actor(), async (tx) => {
      const rows = await tx.execute<{ total: string }>(sql`
        select count(*)::text as total from inventory.reconciliations where org_id = ${ORG_A}
      `);
      return Number(rows[0]?.total ?? '0');
    });
    expect(history).toBeGreaterThanOrEqual(2);
  }, 180_000);
});

// --- the enum, held in step ---------------------------------------------------

describe('the movement enum', () => {
  it('matches the domain’s list exactly', async () => {
    const values = await withSystem(async (tx) => {
      const rows = await tx.execute<{ label: string }>(sql`
        select e.enumlabel as label
        from pg_enum e
        join pg_type t on t.oid = e.enumtypid
        join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'inventory' and t.typname = 'movement_kind'
        order by e.enumsortorder
      `);
      return rows.map((row) => row.label);
    });
    // `packages/db` cannot import the domain, so the closed set is written twice.
    // This is what keeps the two copies honest (`.claude/rules/inventory.md`).
    expect(values).toEqual([...MOVEMENT_KINDS]);
  }, 60_000);

  it('has an in-transit location for transfers to pass through', () => {
    expect(transit).not.toBe('');
  });
});
