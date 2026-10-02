import { randomUUID } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SEED_ORG_IDS, withOrg } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { foldMovements, levelKey, poisha, type MovementKind } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setServerTestEnvWithDatabase } from '../../testing/test-env.js';
import { INVENTORY_API, type InventoryApi } from './inventory.api.js';
import { databaseStockCode, StockError } from './inventory.errors.js';
import { InventoryModule } from './inventory.module.js';
import {
  applyInventoryMigrations,
  makeLocation,
  seedProductWithSkus,
  warehouseId,
} from './inventory.testing.js';
import { MovementsService } from './movements.service.js';

/**
 * M07 check 2, against the code that actually runs: "random sequences of movements never
 * leave `on_hand` negative, and levels always equal Σ movements."
 *
 * `packages/domain`'s property test makes the same claim about `applyMovement` and
 * `foldMovements`, and an audit found two reasons it could not carry the check:
 *
 * 1. **Production never calls `applyMovement`.** Stock moves through the SQL in
 *    `inventory.repository.ts` — an upsert for stock arriving, a plain UPDATE for stock
 *    leaving, §8's conditional UPDATE for a reservation, a combined UPDATE for a dispatch
 *    from reservation — and through the CHECKs and triggers of migrations 0031 and 0033.
 *    A domain property holds of a model of that SQL, and a mistake in the SQL is exactly
 *    the thing it cannot see.
 * 2. **Its generator never reserves.** `reserved` stayed 0 in every case, so half of
 *    invariant 3 — reserved stock cannot be shipped out from under an order, and a release
 *    or a dispatch cannot take `reserved` below zero or leave it above `on_hand` — was
 *    never exercised at all.
 *
 * So this drives the real `InventoryApi` and `MovementsService`, against real PostgreSQL,
 * with random interleavings of the six things that move stock: receive, reserve, release,
 * dispatch (from a reservation and from free stock), return (a customer's and to a
 * supplier) and adjust (write-off, gain, and a count correction either way). Each step is
 * its own transaction, as each is in production, so a refusal rolls back exactly one step.
 *
 * After **every** step, not just at the end, the database is read back and three things
 * are asserted for every level the run touched:
 *
 * * `on_hand` equals Σ `qty_delta` of the movements, folded by `foldMovements` over the
 *   rows `stock_movements` actually holds — the movement log is the truth and the level is
 *   a cache of it (§8);
 * * `reserved` equals Σ the active reservation rows, and `0 ≤ reserved ≤ on_hand`;
 * * both equal an independent model of what should have happened, which is what catches a
 *   step that was refused when it should have succeeded, or succeeded when it should have
 *   been refused. A test that only checked the fold would pass a system that refused
 *   everything.
 *
 * Checking after every step matters because a transient violation is still a violation:
 * a dispatch that briefly leaves `reserved > on_hand` has already let a second order
 * reserve stock that is in a courier's van, even if a later step happens to repair the
 * numbers.
 *
 * A few dozen runs, not fast-check's hundred: each step is a transaction and a read-back
 * against a real database, and this suite shares a machine with everything else in
 * `pnpm verify`. Every run starts on SKUs of its own, so shrinking replays a failure from
 * a clean state rather than from whatever the previous run left behind.
 *
 * The services come from `InventoryModule`'s own application context rather than from the
 * HTTP harness. Nothing here is about a request, and the module context is the same graph
 * the worker builds — so this suite answers for the stock path alone and does not stop
 * booting when an unrelated module's wiring is mid-change.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

let database: TestDatabase;
let context: INestApplicationContext;
let api: InventoryApi;
let movements: MovementsService;

let locations: readonly string[] = [];
const ACTOR = { orgId: ORG_A, userId: 'usr_inventory_property' };
const SUPPLIER = randomUUID();
let runSeq = 0;

/**
 * What the runs actually did, by operation and outcome.
 *
 * A property over random sequences is vacuous if the interesting branches never fire — the
 * domain test this replaces passed for months with `reserved` stuck at zero. So the suite
 * counts, and the last test fails if any path the header claims was never taken.
 */
const tally = new Map<string, number>();
function count(what: string): void {
  tally.set(what, (tally.get(what) ?? 0) + 1);
}

beforeAll(async () => {
  database = await startTestDatabase('inventory-property');
  setServerTestEnvWithDatabase(database.appUrl, 'https://erp.example.com', 'erp.example.com');
  await applyInventoryMigrations();
  context = await NestFactory.createApplicationContext(InventoryModule, { logger: false });
  api = context.get<InventoryApi>(INVENTORY_API);
  movements = context.get(MovementsService);

  const warehouse = await warehouseId(ORG_A);
  const second = await makeLocation(ORG_A, {
    code: 'PROP-02',
    name: 'Property test shelf',
    kind: 'warehouse',
  });
  locations = [warehouse, second];
}, 420_000);

afterAll(async () => {
  await context?.close();
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

// --- the operations -------------------------------------------------------------

/** Which SKU and location a step acts on, as indexes into this run's own fixtures. */
const place = { sku: fc.nat({ max: 1 }), loc: fc.nat({ max: 1 }) };
const qty = fc.integer({ min: 1, max: 12 });

/**
 * One step. `pick` chooses among whatever reservations or dispatches are open when the
 * step runs, so the generator does not need to know the state it is generating against.
 *
 * Weighted towards reservations and the steps that consume them, because those are the
 * paths the domain test never reached.
 */
const stepArbitrary = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('receive' as const),
      ...place,
      qty,
      cost: fc.integer({ min: 1, max: 90_000 }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('reserve' as const), ...place, qty }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('release' as const), pick: fc.nat() }) },
  {
    weight: 3,
    arbitrary: fc.record({ op: fc.constant('dispatchReserved' as const), pick: fc.nat() }),
  },
  { weight: 2, arbitrary: fc.record({ op: fc.constant('dispatchFree' as const), ...place, qty }) },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('customerReturn' as const),
      pick: fc.nat(),
      part: fc.integer({ min: 1, max: 12 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ op: fc.constant('supplierReturn' as const), ...place, qty }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('adjust' as const),
      ...place,
      kind: fc.constantFrom<MovementKind>('adjustment_gain', 'adjustment_loss'),
      qty,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('countCorrection' as const),
      ...place,
      delta: fc.integer({ min: -12, max: 12 }).filter((value) => value !== 0),
    }),
  },
);

type Step = typeof stepArbitrary extends fc.Arbitrary<infer T> ? T : never;

interface Level {
  onHand: number;
  reserved: number;
}

interface OpenReservation {
  readonly refId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly qty: number;
}

interface Returnable {
  readonly orderId: string;
  readonly skuId: string;
  readonly locationId: string;
  readonly qty: number;
}

/** What the run believes, kept independently of anything the database says. */
class Model {
  readonly levels = new Map<string, Level>();
  readonly reservations: OpenReservation[] = [];
  readonly returnable: Returnable[] = [];

  level(skuId: string, locationId: string): Level {
    const key = levelKey({ skuId, locationId });
    let found = this.levels.get(key);
    if (found === undefined) {
      found = { onHand: 0, reserved: 0 };
      this.levels.set(key, found);
    }
    return found;
  }
}

/**
 * The reason a step was refused, or null when the refusal was not a stock refusal.
 *
 * A refusal has to be *the right* refusal: an insufficient-stock answer from the service,
 * or one of the two CHECKs 0031 puts on `stock_levels`. Anything else — a ledger error, a
 * type error, a missing account — means the step failed for a reason the model does not
 * know about, and the property should say so rather than count it as a correct refusal.
 */
function refusalCode(error: unknown): string | null {
  if (error instanceof StockError) return error.code;
  const mapped = databaseStockCode(error);
  if (mapped !== null) return mapped.code;
  for (
    let current: unknown = error, depth = 0;
    current !== null && current !== undefined && depth < 8;
    depth += 1
  ) {
    const constraint = (current as { constraint_name?: unknown }).constraint_name;
    if (
      (current as { code?: unknown }).code === '23514' &&
      (constraint === 'stock_levels_on_hand_not_negative' ||
        constraint === 'stock_levels_reserved_within_on_hand')
    ) {
      return 'STOCK_INSUFFICIENT';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function describeError(error: unknown): string {
  const parts: string[] = [];
  for (
    let current: unknown = error, depth = 0;
    current !== null && current !== undefined && depth < 8;
    depth += 1
  ) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** Run one step in its own transaction. True when it committed, false when refused. */
async function attempt(work: () => Promise<unknown>, label: string): Promise<boolean> {
  try {
    await work();
    count(`${label}: committed`);
    return true;
  } catch (error) {
    const code = refusalCode(error);
    if (code !== 'STOCK_INSUFFICIENT') {
      throw new Error(
        `${label} failed for a reason that is not a stock refusal: ${describeError(error)}`,
        { cause: error },
      );
    }
    count(`${label}: refused`);
    return false;
  }
}

/**
 * Apply one step to the database and to the model, and check they agreed on whether it
 * was allowed.
 */
async function applyStep(step: Step, model: Model, skus: readonly string[]): Promise<void> {
  const at = new Date();
  const sku = (index: number): string => skus[index] ?? '';
  const loc = (index: number): string => locations[index] ?? '';

  switch (step.op) {
    case 'receive': {
      const skuId = sku(step.sku);
      const locationId = loc(step.loc);
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            api.receiveSupply(tx, ACTOR, {
              supplyId: randomUUID(),
              supplierId: SUPPLIER,
              locationId,
              branchId: null,
              occurredAt: at,
              lines: [{ skuId, qty: step.qty, unitCostPoisha: poisha(step.cost) }],
            }),
          ),
        'receive',
      );
      expect(ok, 'a receipt is never refused for stock').toBe(true);
      model.level(skuId, locationId).onHand += step.qty;
      return;
    }

    case 'reserve': {
      const skuId = sku(step.sku);
      const locationId = loc(step.loc);
      const level = model.level(skuId, locationId);
      const refId = randomUUID();
      const expected = level.onHand - level.reserved >= step.qty;
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            api.reserve(tx, ACTOR, {
              refType: 'order',
              refId,
              lines: [{ skuId, locationId, qty: step.qty }],
            }),
          ),
        'reserve',
      );
      expect(ok, `reserve ${String(step.qty)} with ${JSON.stringify(level)}`).toBe(expected);
      if (ok) {
        level.reserved += step.qty;
        model.reservations.push({ refId, skuId, locationId, qty: step.qty });
      }
      return;
    }

    case 'release': {
      if (model.reservations.length === 0) {
        // Nothing held: releasing a reference that holds nothing is a no-op, not an error.
        const released = await withOrg(ACTOR, (tx) =>
          api.release(tx, ACTOR, { refType: 'order', refId: randomUUID() }),
        );
        expect(released).toBe(0);
        return;
      }
      const [held] = model.reservations.splice(step.pick % model.reservations.length, 1);
      if (held === undefined) return;
      const released = await withOrg(ACTOR, (tx) =>
        api.release(tx, ACTOR, { refType: 'order', refId: held.refId }),
      );
      expect(released, 'a held reservation releases').toBe(1);
      count('release: committed');
      model.level(held.skuId, held.locationId).reserved -= held.qty;
      return;
    }

    case 'dispatchReserved': {
      if (model.reservations.length === 0) return;
      const [held] = model.reservations.splice(step.pick % model.reservations.length, 1);
      if (held === undefined) return;
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            api.dispatch(tx, ACTOR, {
              orderId: held.refId,
              locationId: held.locationId,
              branchId: null,
              occurredAt: at,
              lines: [{ skuId: held.skuId, qty: held.qty }],
              fromReservation: true,
            }),
          ),
        'dispatch from reservation',
      );
      // Reserved units are on the shelf by construction: nothing may take them away.
      expect(ok, 'shipping what was reserved is never refused').toBe(true);
      const level = model.level(held.skuId, held.locationId);
      level.onHand -= held.qty;
      level.reserved -= held.qty;
      model.returnable.push({ ...held, orderId: held.refId });
      return;
    }

    case 'dispatchFree': {
      const skuId = sku(step.sku);
      const locationId = loc(step.loc);
      const level = model.level(skuId, locationId);
      const orderId = randomUUID();
      // Only unreserved stock may leave without a reservation of its own.
      const expected = level.onHand - level.reserved >= step.qty;
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            api.dispatch(tx, ACTOR, {
              orderId,
              locationId,
              branchId: null,
              occurredAt: at,
              lines: [{ skuId, qty: step.qty }],
            }),
          ),
        'dispatch of free stock',
      );
      expect(ok, `dispatch ${String(step.qty)} with ${JSON.stringify(level)}`).toBe(expected);
      if (ok) {
        level.onHand -= step.qty;
        model.returnable.push({ orderId, skuId, locationId, qty: step.qty });
      }
      return;
    }

    case 'customerReturn': {
      if (model.returnable.length === 0) return;
      // One return per dispatched line: the dedupe key is per order, SKU and location, so
      // a second return of the same line is a replay and moves nothing.
      const [shipped] = model.returnable.splice(step.pick % model.returnable.length, 1);
      if (shipped === undefined) return;
      const back = Math.min(step.part, shipped.qty);
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            api.receiveCustomerReturn(tx, ACTOR, {
              orderId: shipped.orderId,
              locationId: shipped.locationId,
              occurredAt: at,
              lines: [{ skuId: shipped.skuId, qty: back, dispatchUnitCostPoisha: poisha(20_000) }],
            }),
          ),
        'customer return',
      );
      expect(ok, 'a customer return is never refused for stock').toBe(true);
      model.level(shipped.skuId, shipped.locationId).onHand += back;
      return;
    }

    case 'supplierReturn': {
      const skuId = sku(step.sku);
      const locationId = loc(step.loc);
      const level = model.level(skuId, locationId);
      const expected = level.onHand - level.reserved >= step.qty;
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            api.returnToSupplier(tx, ACTOR, {
              returnId: randomUUID(),
              supplierId: SUPPLIER,
              locationId,
              branchId: null,
              occurredAt: at,
              lines: [{ skuId, qty: step.qty, originalUnitCostPoisha: poisha(30_000) }],
            }),
          ),
        'supplier return',
      );
      expect(ok, `supplier return ${String(step.qty)} with ${JSON.stringify(level)}`).toBe(
        expected,
      );
      if (ok) level.onHand -= step.qty;
      return;
    }

    case 'adjust': {
      const skuId = sku(step.sku);
      const locationId = loc(step.loc);
      const level = model.level(skuId, locationId);
      const delta = step.kind === 'adjustment_gain' ? step.qty : -step.qty;
      const expected = delta > 0 || level.onHand + delta >= level.reserved;
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            movements.apply(tx, ACTOR, {
              skuId,
              locationId,
              kind: step.kind,
              qty: step.qty,
              refType: 'adjustment',
              refId: randomUUID(),
              occurredAt: at,
            }),
          ),
        step.kind,
      );
      expect(ok, `${step.kind} ${String(step.qty)} with ${JSON.stringify(level)}`).toBe(expected);
      if (ok) level.onHand += delta;
      return;
    }

    case 'countCorrection': {
      const skuId = sku(step.sku);
      const locationId = loc(step.loc);
      const level = model.level(skuId, locationId);
      const expected = step.delta > 0 || level.onHand + step.delta >= level.reserved;
      const ok = await attempt(
        () =>
          withOrg(ACTOR, (tx) =>
            movements.applyCorrection(tx, ACTOR, {
              skuId,
              locationId,
              qtyDelta: step.delta,
              refType: 'count',
              refId: randomUUID(),
              occurredAt: at,
            }),
          ),
        'count correction',
      );
      expect(ok, `count correction ${String(step.delta)} with ${JSON.stringify(level)}`).toBe(
        expected,
      );
      if (ok) level.onHand += step.delta;
      return;
    }
  }
}

/** Everything the database holds for this run's SKUs, read in one transaction. */
async function readBack(skus: readonly string[]) {
  return withOrg(ACTOR, async (tx) => {
    const ids = sql.join(
      skus.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const [levels, moved, held] = await Promise.all([
      tx.execute<{ sku_id: string; location_id: string; on_hand: number; reserved: number }>(sql`
        select sku_id, location_id, on_hand, reserved from inventory.stock_levels
        where org_id = ${ORG_A} and sku_id in (${ids})
      `),
      tx.execute<{ sku_id: string; location_id: string; kind: MovementKind; qty_delta: number }>(
        sql`
          select sku_id, location_id, kind::text as kind, qty_delta from inventory.stock_movements
          where org_id = ${ORG_A} and sku_id in (${ids})
        `,
      ),
      tx.execute<{ sku_id: string; location_id: string; total: string }>(sql`
        select sku_id, location_id, sum(qty)::text as total from inventory.reservations
        where org_id = ${ORG_A} and sku_id in (${ids}) and status = 'active'
        group by sku_id, location_id
      `),
    ]);
    return { levels: [...levels], moved: [...moved], held: [...held] };
  });
}

/** The three assertions the header promises, for every level this run has touched. */
async function assertConsistent(
  model: Model,
  skus: readonly string[],
  after: string,
): Promise<void> {
  const { levels, moved, held } = await readBack(skus);

  // Σ movements, rebuilt from the log by the domain's fold — and the fold itself refuses a
  // movement whose sign contradicts its kind, so a wrongly signed row fails here too.
  const sums = foldMovements(
    moved.map((row) => ({
      skuId: row.sku_id,
      locationId: row.location_id,
      kind: row.kind,
      qtyDelta: row.qty_delta,
    })),
  );
  const reservedByKey = new Map(
    held.map((row) => [
      levelKey({ skuId: row.sku_id, locationId: row.location_id }),
      Number(row.total),
    ]),
  );
  const levelByKey = new Map(
    levels.map((row) => [levelKey({ skuId: row.sku_id, locationId: row.location_id }), row]),
  );

  const keys = new Set([...sums.keys(), ...levelByKey.keys(), ...model.levels.keys()]);
  for (const key of keys) {
    const row = levelByKey.get(key);
    const onHand = row?.on_hand ?? 0;
    const reserved = row?.reserved ?? 0;
    const where = `${key} after ${after}`;

    expect(onHand, `on_hand = Σ movements at ${where}`).toBe(sums.get(key) ?? 0);
    expect(onHand, `on_hand never negative at ${where}`).toBeGreaterThanOrEqual(0);
    expect(reserved, `reserved never negative at ${where}`).toBeGreaterThanOrEqual(0);
    expect(reserved, `reserved within on_hand at ${where}`).toBeLessThanOrEqual(onHand);
    expect(reserved, `reserved = Σ active reservations at ${where}`).toBe(
      reservedByKey.get(key) ?? 0,
    );

    const expected = model.levels.get(key) ?? { onHand: 0, reserved: 0 };
    expect({ onHand, reserved }, `the model at ${where}`).toEqual(expected);
  }
}

describe('check 2: random sequences through the real stock path', () => {
  it('keep every level equal to Σ movements, and on_hand and reserved never negative', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArbitrary, { minLength: 6, maxLength: 24 }), async (steps) => {
        runSeq += 1;
        const { skus } = await seedProductWithSkus(
          ORG_A,
          `prop${String(runSeq)}${randomUUID().slice(0, 4)}`,
          2,
        );
        const skuIds = skus.map((row) => row.id);
        const model = new Model();

        for (const [index, step] of steps.entries()) {
          await applyStep(step, model, skuIds);
          await assertConsistent(model, skuIds, `step ${String(index)} (${step.op})`);
        }
      }),
      // A shrunk counterexample would cost dozens more database runs; the first failing
      // sequence, with its seed, is enough to reproduce one.
      //
      // The seed is fixed because the vacuity check below needs every path taken, and 30
      // random runs occasionally never reached a committed release (4 committed reserves
      // in one run of `pnpm verify`). A fixed seed makes that coverage a fact rather than
      // a likelihood; widen the exploration by changing the seed, not by removing it.
      { numRuns: 30, endOnFailure: true, seed: 20261002 },
    );
  }, 600_000);
});

describe('the property was not vacuous', () => {
  it('took every path it claims to, including refusals caused by reserved stock', () => {
    const seen = Object.fromEntries(tally);
    // Each of these is a branch the domain test never reached, or one whose absence would
    // let the property pass a system that refuses everything.
    for (const path of [
      'receive: committed',
      'reserve: committed',
      'reserve: refused',
      'release: committed',
      'dispatch from reservation: committed',
      'dispatch of free stock: committed',
      'dispatch of free stock: refused',
      'customer return: committed',
      'supplier return: committed',
      'adjustment_loss: committed',
      'adjustment_loss: refused',
      'count correction: committed',
      'count correction: refused',
    ]) {
      expect(seen[path] ?? 0, `${path} never happened: ${JSON.stringify(seen)}`).toBeGreaterThan(0);
    }
  });
});
