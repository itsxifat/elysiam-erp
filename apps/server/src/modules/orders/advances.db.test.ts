import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withOrg, withSystem } from '@elysium/db';
import { businessDate, poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { AdvancesService } from './advances.service.js';
import { OrdersModule } from './orders.module.js';
import { OrdersService } from './orders.service.js';
import {
  applyOrderMigrations,
  balancesBySubtype,
  ownRiderCourier,
  seedCustomer,
  stockAt,
  trialBalanceDifference,
  walletAccount,
} from './orders.testing.js';
import { ReturnReasonsService } from './returns.service.js';

/**
 * Advances and return reasons against a real database (M17 acceptance checks 1 to 3).
 *
 * 1. **Golden books.** An advance is applied on delivery, and on a cancel it is refunded or
 *    kept per the brand's policy. Every figure is read back from `ledger.journal_lines`, the
 *    trial balance is asserted at zero, and Customer advance is asserted against the rows.
 * 2. **An unverified advance never reaches the books.** A claim posts nothing and leaves the
 *    COD alone, through a delivery; a rejected claim never posts; the database refuses a
 *    verified row with no journal and a self-verification.
 * 3. **Return reasons on every return**, refused without one by the machine and by the
 *    database, and reported by reason.
 *
 * Each money scenario takes its own brand, because the balances are Σ over an org's journal
 * lines and two scenarios in one org would each be asserting the other's postings.
 */

const ORG_APPLY = SEED_ORG_IDS.orvo ?? '';
const ORG_REFUND = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const ORG_KEEP = SEED_ORG_IDS['wear-x-clothing'] ?? '';
const ORG_RETURN = SEED_ORG_IDS.beownz ?? '';
const ORG_PARTIAL = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

const AGENT = 'usr_m17_agent';
const ACCOUNTANT = 'usr_m17_accounts';

let harness: HttpHarness;
let orders: OrdersService;
let advances: AdvancesService;
let returns: ReturnReasonsService;
let inventory: InventoryApi;

beforeAll(async () => {
  harness = await startHttpHarness('advances-db', { extraModules: [OrdersModule] });
  await applyOrderMigrations();
  orders = harness.app.get(OrdersService);
  advances = harness.app.get(AdvancesService);
  returns = harness.app.get(ReturnReasonsService);
  inventory = harness.app.get<InventoryApi>(INVENTORY_API);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- calling the services without HTTP ---------------------------------------------

function request(): AuditableRequest {
  const value = {} as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

function context(orgId: string, userId: string): ActiveContext {
  return {
    orgId,
    userId,
    isSuperAdmin: false,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: 'advances-db-test',
  };
}

interface Scene {
  readonly orgId: string;
  readonly location: string;
  readonly customerId: string;
  readonly courierId: string;
  readonly wallet: string;
  readonly sku: SeededSku;
}

async function scene(orgId: string, slug: string): Promise<Scene> {
  const { skus } = await seedProductWithSkus(orgId, slug, 1);
  const sku = skus[0];
  if (sku === undefined) throw new Error('no SKU seeded');
  const place: Scene = {
    orgId,
    location: await warehouseId(orgId),
    customerId: await seedCustomer(orgId, { phoneE164: '+8801712345679', name: 'Nusrat Jahan' }),
    courierId: await ownRiderCourier(orgId),
    wallet: await walletAccount(orgId),
    sku,
  };
  const actor = { orgId, userId: ACCOUNTANT };
  await withOrg(actor, (tx) =>
    inventory.receiveSupply(tx, actor, {
      supplyId: randomUUID(),
      supplierId: randomUUID(),
      locationId: place.location,
      branchId: null,
      occurredAt: new Date(),
      lines: [{ skuId: sku.id, qty: 10, unitCostPoisha: poisha(40_000n) }],
    }),
  );
  return place;
}

async function takeOrder(place: Scene, qty = 1, unitPricePoisha = '150000'): Promise<string> {
  const created = await orders.create(context(place.orgId, AGENT), request(), {
    channel: 'phone',
    customerId: place.customerId,
    locationId: place.location,
    courierId: place.courierId,
    deliveryChargePoisha: '6000',
    lines: [{ skuId: place.sku.id, qty, unitPricePoisha }],
  });
  return created.id;
}

let refSequence = 0;
/** The agent records a claim; nothing posts. */
async function claim(place: Scene, orderId: string, amountPoisha: string): Promise<string> {
  refSequence += 1;
  const recorded = await advances.record(context(place.orgId, AGENT), request(), orderId, {
    method: 'bkash',
    transactionRef: `M17T${String(refSequence).padStart(6, '0')}`,
    amountPoisha,
  });
  return recorded.id;
}

/** Accounts verifies it into the brand's bKash wallet. */
async function verify(place: Scene, advanceId: string) {
  return advances.verify(context(place.orgId, ACCOUNTANT), request(), advanceId, place.wallet);
}

async function move(
  place: Scene,
  orderId: string,
  trigger: Parameters<OrdersService['transition']>[3],
  options: Parameters<OrdersService['transition']>[4] = {},
): Promise<void> {
  await orders.transition(context(place.orgId, AGENT), request(), orderId, trigger, options);
}

async function orderAmounts(orgId: string, orderId: string) {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ advance: string; cod: string; status: string }>(sql`
        select advance_paid_poisha::text as advance, cod_amount_poisha::text as cod,
               status::text as status
        from sales.orders where org_id = ${orgId} and id = ${orderId}
      `),
    { orgId },
  );
  return rows[0];
}

async function advanceRow(orgId: string, id: string) {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ status: string; applied: string; kept: string }>(sql`
        select status, applied_poisha::text as applied, kept_poisha::text as kept
        from sales.order_advances where org_id = ${orgId} and id = ${id}
      `),
    { orgId },
  );
  return rows[0];
}

async function advanceJournals(orgId: string, orderId: string): Promise<number> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from ledger.journals j
        where j.org_id = ${orgId} and j.source_type = 'customer_advance'
          and j.source_id in (select id from sales.order_advances where order_id = ${orderId})
      `),
    { orgId },
  );
  return rows[0]?.n ?? -1;
}

/** Customer advance owed, by the rows: verified or owed back, less what was applied. */
async function owedByRows(orgId: string): Promise<bigint> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ owed: string }>(sql`
        select coalesce(sum(amount_poisha - applied_poisha - kept_poisha), 0)::text as owed
        from sales.order_advances
        where org_id = ${orgId} and status in ('verified', 'refund_due')
      `),
    { orgId },
  );
  return BigInt(rows[0]?.owed ?? '0');
}

const balance = (balances: Map<string, bigint>, subtype: string): bigint =>
  balances.get(subtype) ?? 0n;

async function setPolicy(orgId: string, key: string, value: string): Promise<void> {
  await withSystem(
    async (tx) =>
      tx.execute(sql`
        insert into org.settings (org_id, key, value)
        values (${orgId}, ${key}, ${JSON.stringify(value)}::jsonb)
        on conflict (org_id, key) do update set value = excluded.value
      `),
    { orgId },
  );
}

// --- check 1: golden books -------------------------------------------------------------

describe('check 1: the advance is applied on delivery', () => {
  /*
   * Hand-computed, in poisha:
   *
   *   supply        10 @ 40,000                 Dr Inventory 400,000 / Cr Payable 400,000
   *   order         1 @ 150,000, delivery 6,000 → COD 156,000
   *   claim         6,000                       (nothing)
   *   verify        Dr bKash 6,000 / Cr Customer advance 6,000        → COD 150,000
   *   ship          Dr Goods in transit 40,000 / Cr Inventory 40,000
   *   deliver       Dr Courier receivable 150,000 + Dr Customer advance 6,000
   *                   Cr Sales revenue 150,000 + Cr Delivery income 6,000
   *                 Dr COGS 40,000 / Cr Goods in transit 40,000
   *
   * Customer advance ends at zero, and the advance row says `applied` for all 6,000.
   */
  it('posts on verification, lowers the COD, and the delivery relieves it to zero', async () => {
    const place = await scene(ORG_APPLY, 'm17apply');
    const orderId = await takeOrder(place);

    const advanceId = await claim(place, orderId, '6000');
    const verified = await verify(place, advanceId);
    expect(verified.status).toBe('verified');
    expect(await orderAmounts(place.orgId, orderId)).toMatchObject({
      advance: '6000',
      cod: '150000',
    });
    const afterVerify = await balancesBySubtype(place.orgId);
    expect(balance(afterVerify, 'wallet_bkash')).toBe(6_000n);
    expect(balance(afterVerify, 'customer_advance')).toBe(-6_000n);
    expect(await owedByRows(place.orgId)).toBe(6_000n);

    await move(place, orderId, 'confirm');
    await move(place, orderId, 'ship', { courierId: place.courierId });
    await move(place, orderId, 'deliver');

    const closing = await balancesBySubtype(place.orgId);
    expect(balance(closing, 'wallet_bkash')).toBe(6_000n);
    expect(balance(closing, 'customer_advance')).toBe(0n);
    expect(balance(closing, 'courier_receivable')).toBe(150_000n);
    expect(balance(closing, 'sales_revenue')).toBe(-150_000n);
    expect(balance(closing, 'delivery_charge_income')).toBe(-6_000n);
    expect(balance(closing, 'cogs')).toBe(40_000n);
    expect(balance(closing, 'goods_in_transit')).toBe(0n);
    expect(balance(closing, 'inventory')).toBe(360_000n);
    expect(balance(closing, 'other_income')).toBe(0n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);

    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({
      status: 'applied',
      applied: '6000',
    });
    // The rows and the books agree: nothing is owed on either.
    expect(await owedByRows(place.orgId)).toBe(0n);
    expect(await stockAt(place.orgId, place.sku.id, place.location)).toEqual({
      onHand: 9,
      reserved: 0,
    });
  }, 240_000);
});

describe('check 1: refunded on cancel, per policy', () => {
  /*
   * The default policy (refund), with two payments on one order (D-101 closed):
   *
   *   verify × 2    Dr bKash 3,000 / Cr Customer advance 3,000, twice   → COD 150,000
   *   cancel        (nothing posted: owed back, still a liability)
   *   refund × 2    Dr Customer advance 3,000 / Cr bKash 3,000, twice
   *
   * Everything back where it started: wallet 0, Customer advance 0, no income.
   */
  it('owes the buyer at the cancel, and posts the refund when it is paid', async () => {
    const place = await scene(ORG_REFUND, 'm17refund');
    const orderId = await takeOrder(place);

    const first = await claim(place, orderId, '3000');
    const second = await claim(place, orderId, '3000');
    await verify(place, first);
    await verify(place, second);
    expect(await orderAmounts(place.orgId, orderId)).toMatchObject({
      advance: '6000',
      cod: '150000',
    });

    await move(place, orderId, 'confirm');
    await move(place, orderId, 'cancel', { reason: 'Buyer ordered twice' });

    // Owed, not paid: the liability is still on the books and nothing new posted.
    const owed = await balancesBySubtype(place.orgId);
    expect(balance(owed, 'customer_advance')).toBe(-6_000n);
    expect(balance(owed, 'wallet_bkash')).toBe(6_000n);
    expect(await advanceJournals(place.orgId, orderId)).toBe(2);
    expect(await advanceRow(place.orgId, first)).toMatchObject({ status: 'refund_due' });
    expect(await owedByRows(place.orgId)).toBe(6_000n);

    const accounts = context(place.orgId, ACCOUNTANT);
    const refunded = await advances.refund(accounts, request(), first, {
      refundRef: 'RF 1A2B3C4D',
    });
    expect(refunded).toMatchObject({ status: 'refunded', refundRef: 'RF1A2B3C4D' });
    await advances.refund(accounts, request(), second, {});
    // A refund is paid once.
    await expect(advances.refund(accounts, request(), second, {})).rejects.toThrow();

    const closing = await balancesBySubtype(place.orgId);
    expect(balance(closing, 'customer_advance')).toBe(0n);
    expect(balance(closing, 'wallet_bkash')).toBe(0n);
    expect(balance(closing, 'other_income')).toBe(0n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
    expect(await owedByRows(place.orgId)).toBe(0n);
    expect(await advanceJournals(place.orgId, orderId)).toBe(4);
  }, 240_000);

  /*
   * A brand whose policy is to keep it (`orders.advance_on_cancel = forfeit`) keeps at most
   * the delivery charge, and the rest still goes back:
   *
   *   verify        Dr bKash 20,000 / Cr Customer advance 20,000
   *   cancel        Dr Customer advance 6,000 / Cr Other income 6,000   (kept)
   *   refund        Dr Customer advance 14,000 / Cr bKash 14,000
   */
  it('keeps at most the delivery charge when the brand keeps it, and refunds the rest', async () => {
    const place = await scene(ORG_KEEP, 'm17keep');
    await setPolicy(place.orgId, 'orders.advance_on_cancel', 'forfeit');
    const orderId = await takeOrder(place);

    const advanceId = await claim(place, orderId, '20000');
    await verify(place, advanceId);
    await move(place, orderId, 'cancel', { reason: 'Buyer stopped answering' });

    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({
      status: 'refund_due',
      kept: '6000',
    });
    const kept = await balancesBySubtype(place.orgId);
    expect(balance(kept, 'other_income')).toBe(-6_000n);
    expect(balance(kept, 'customer_advance')).toBe(-14_000n);
    expect(await owedByRows(place.orgId)).toBe(14_000n);

    await advances.refund(context(place.orgId, ACCOUNTANT), request(), advanceId, {});
    const closing = await balancesBySubtype(place.orgId);
    expect(balance(closing, 'customer_advance')).toBe(0n);
    expect(balance(closing, 'wallet_bkash')).toBe(6_000n);
    expect(balance(closing, 'other_income')).toBe(-6_000n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
  }, 240_000);
});

describe('the other endings: a refused parcel, and the rest of a partial delivery', () => {
  /*
   * The default return policy keeps the delivery charge the brand paid a courier to carry:
   *
   *   verify        Dr bKash 6,000 / Cr Customer advance 6,000
   *   ship          Dr Goods in transit 40,000 / Cr Inventory 40,000
   *   return        Dr Inventory 40,000 / Cr Goods in transit 40,000
   *                 Dr Customer advance 6,000 / Cr Other income 6,000   (kept)
   */
  it('keeps the advance on a refused parcel, up to the delivery charge', async () => {
    const place = await scene(ORG_RETURN, 'm17return');
    const orderId = await takeOrder(place);
    const advanceId = await claim(place, orderId, '6000');
    await verify(place, advanceId);

    await move(place, orderId, 'confirm');
    await move(place, orderId, 'ship', { courierId: place.courierId });
    await move(place, orderId, 'start_return', { reason: 'Refused at the door' });
    await move(place, orderId, 'receive_return', {
      reason: 'Came back sealed',
      returnReason: 'customer_refused',
      ret: { reason: 'Came back sealed', locationId: place.location },
    });

    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({
      status: 'forfeited',
      kept: '6000',
    });
    const closing = await balancesBySubtype(place.orgId);
    expect(balance(closing, 'customer_advance')).toBe(0n);
    expect(balance(closing, 'other_income')).toBe(-6_000n);
    expect(balance(closing, 'wallet_bkash')).toBe(6_000n);
    expect(balance(closing, 'goods_in_transit')).toBe(0n);
    expect(balance(closing, 'inventory')).toBe(400_000n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
  }, 240_000);

  /*
   * Two units at 50,000 and a 6,000 charge, all paid ahead (106,000). One unit arrives:
   * the delivery applies 56,000 (the unit and the charge), and when the other comes back
   * the 50,000 left is the buyer's, so it is owed back whatever the return policy says.
   */
  it('applies only what was delivered, and owes the rest back at the return', async () => {
    const place = await scene(ORG_PARTIAL, 'm17partial');
    const orderId = await takeOrder(place, 2, '50000');
    const advanceId = await claim(place, orderId, '106000');
    await verify(place, advanceId);
    expect(await orderAmounts(place.orgId, orderId)).toMatchObject({ cod: '0' });

    await move(place, orderId, 'confirm');
    await move(place, orderId, 'ship', { courierId: place.courierId });
    await move(place, orderId, 'deliver_partially', {
      deliver: { lines: [{ skuId: place.sku.id, deliveredQty: 1 }], collectedPoisha: '0' },
    });
    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({
      status: 'verified',
      applied: '56000',
    });

    await move(place, orderId, 'receive_return', {
      reason: 'The second piece came back',
      returnReason: 'size_issue',
      ret: { reason: 'The second piece came back', locationId: place.location },
    });
    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({
      status: 'refund_due',
      applied: '56000',
      kept: '0',
    });
    await advances.refund(context(place.orgId, ACCOUNTANT), request(), advanceId, {});

    const closing = await balancesBySubtype(place.orgId);
    expect(balance(closing, 'customer_advance')).toBe(0n);
    expect(balance(closing, 'other_income')).toBe(0n);
    expect(balance(closing, 'sales_revenue')).toBe(-50_000n);
    expect(balance(closing, 'delivery_charge_income')).toBe(-6_000n);
    expect(balance(closing, 'wallet_bkash')).toBe(56_000n);
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);
  }, 240_000);
});

// --- check 2: an unverified advance never reaches the books -----------------------------

describe('check 2: an unverified advance never reaches the books', () => {
  it('a claim posts nothing and moves no COD, through a whole delivery', async () => {
    const place = await scene(ORG_APPLY, 'm17unverified');
    const orderId = await takeOrder(place);
    const before = await balancesBySubtype(place.orgId);

    const advanceId = await claim(place, orderId, '6000');
    expect(await advanceJournals(place.orgId, orderId)).toBe(0);
    expect(await orderAmounts(place.orgId, orderId)).toMatchObject({
      advance: '0',
      cod: '156000',
    });

    // The recorder cannot verify their own claim, and neither can the database be told to.
    await expect(
      advances.verify(context(place.orgId, AGENT), request(), advanceId, place.wallet),
    ).rejects.toMatchObject({ response: { code: 'ADVANCE_SELF_VERIFY' } });
    await expect(
      withSystem(
        async (tx) =>
          tx.execute(sql`
            update sales.order_advances
            set status = 'verified', decided_by = recorded_by, decided_at = now()
            where org_id = ${place.orgId} and id = ${advanceId}
          `),
        { orgId: place.orgId },
      ),
    ).rejects.toThrow();
    // Nor can a row say "verified" with no journal behind it.
    await expect(
      withSystem(
        async (tx) =>
          tx.execute(sql`
            update sales.order_advances
            set status = 'verified', decided_by = 'usr_somebody_else', decided_at = now()
            where org_id = ${place.orgId} and id = ${advanceId}
          `),
        { orgId: place.orgId },
      ),
    ).rejects.toThrow();

    // Shipped with the claim still pending: the COD the courier holds is the full one, so
    // verification has to wait for the order to end.
    await move(place, orderId, 'confirm');
    await move(place, orderId, 'ship', { courierId: place.courierId });
    await expect(verify(place, advanceId)).rejects.toMatchObject({
      response: { code: 'ADVANCE_PARCEL_IN_FLIGHT' },
    });
    await move(place, orderId, 'deliver');

    // The delivery relieved no Customer advance: the claim never reached the books.
    const delivered = await balancesBySubtype(place.orgId);
    expect(balance(delivered, 'customer_advance')).toBe(balance(before, 'customer_advance'));
    expect(balance(delivered, 'wallet_bkash')).toBe(balance(before, 'wallet_bkash'));
    expect(await advanceJournals(place.orgId, orderId)).toBe(0);
    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({ status: 'pending' });
    expect(await trialBalanceDifference(place.orgId)).toBe(0n);

    // Verified after the rider collected the full COD: the buyer paid twice, so it is owed.
    await verify(place, advanceId);
    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({ status: 'refund_due' });
  }, 240_000);

  it('a rejected claim never posts, and the reference is free again', async () => {
    const place = await scene(ORG_REFUND, 'm17rejected');
    const orderId = await takeOrder(place);
    const advanceId = await claim(place, orderId, '6000');

    await advances.reject(
      context(place.orgId, ACCOUNTANT),
      request(),
      advanceId,
      'Not in the statement',
    );
    expect(await advanceRow(place.orgId, advanceId)).toMatchObject({ status: 'rejected' });
    await expect(verify(place, advanceId)).rejects.toThrow();
    await move(place, orderId, 'cancel', { reason: 'No payment came' });
    expect(await advanceJournals(place.orgId, orderId)).toBe(0);
    // The trigger keeps a decided claim decided.
    await expect(
      withSystem(
        async (tx) =>
          tx.execute(sql`
            update sales.order_advances set status = 'pending', decided_by = null,
              decided_at = null, reject_reason = null
            where org_id = ${place.orgId} and id = ${advanceId}
          `),
        { orgId: place.orgId },
      ),
    ).rejects.toSatisfy((error: unknown) =>
      String((error as { cause?: { message?: unknown } }).cause?.message).startsWith(
        'ADVANCE_IMMUTABLE',
      ),
    );
  }, 240_000);
});

// --- check 3: return reasons ------------------------------------------------------------

describe('check 3: return reasons on every return, reported by reason', () => {
  it('refuses a return without a reason, records one with it, and reports by reason', async () => {
    const place = await scene(ORG_RETURN, 'm17reasons');
    const today = businessDate(new Date());
    const before = await returns.report(context(place.orgId, AGENT), request(), today, today);

    const shipBack = async (): Promise<string> => {
      const orderId = await takeOrder(place);
      await move(place, orderId, 'confirm');
      await move(place, orderId, 'ship', { courierId: place.courierId });
      await move(place, orderId, 'start_return', { reason: 'Coming back' });
      return orderId;
    };

    // The machine refuses a return with no reason, and the order stays where it was.
    const refused = await shipBack();
    await expect(
      move(place, refused, 'receive_return', {
        reason: 'Came back',
        ret: { reason: 'Came back', locationId: place.location },
      }),
    ).rejects.toMatchObject({ response: { code: 'ORDER_RETURN_REASON_REQUIRED' } });
    expect(await orderAmounts(place.orgId, refused)).toMatchObject({
      status: 'return_in_transit',
    });

    // The database refuses it too, at commit, for anything that bypasses the machine.
    await expect(
      withSystem(
        async (tx) =>
          tx.execute(sql`
            update sales.orders set status = 'returned'
            where org_id = ${place.orgId} and id = ${refused}
          `),
        { orgId: place.orgId },
      ),
    ).rejects.toThrow(/ORDER_RETURN_REASON_REQUIRED/);

    for (const [orderId, code] of [
      [refused, 'customer_refused'],
      [await shipBack(), 'customer_refused'],
      [await shipBack(), 'wrong_address'],
    ] as const) {
      await move(place, orderId, 'receive_return', {
        reason: 'Came back',
        returnReason: code,
        ret: { reason: 'Came back', locationId: place.location },
      });
    }

    // An exchange is a return too, and says why.
    const delivered = await takeOrder(place);
    await move(place, delivered, 'confirm');
    await move(place, delivered, 'ship', { courierId: place.courierId });
    await move(place, delivered, 'deliver');
    await orders.exchange(context(place.orgId, AGENT), request(), delivered, {
      reason: 'Needs the next size',
      returnReason: 'size_issue',
      returnLines: [{ skuId: place.sku.id, qty: 1 }],
      lines: [{ skuId: place.sku.id, qty: 1, unitPricePoisha: '150000' }],
      locationId: place.location,
    });

    const recorded = await withSystem(
      async (tx) =>
        tx.execute<{ kind: string; reason_code: string; note: string | null }>(sql`
          select kind, reason_code, note from sales.order_returns
          where org_id = ${place.orgId} and order_id = ${delivered}
        `),
      { orgId: place.orgId },
    );
    expect(recorded).toEqual([
      { kind: 'exchange', reason_code: 'size_issue', note: 'Needs the next size' },
    ]);
    // A recorded reason is permanent.
    await expect(
      withSystem(
        async (tx) =>
          tx.execute(sql`
            update sales.order_returns set reason_code = 'other'
            where org_id = ${place.orgId} and order_id = ${delivered}
          `),
        { orgId: place.orgId },
      ),
    ).rejects.toThrow();

    // Every returned or exchanged order in this brand has its reason.
    const missing = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from sales.orders o
          where o.org_id = ${place.orgId} and o.status in ('returned', 'exchange')
            and not exists (select 1 from sales.order_returns r
                            where r.org_id = o.org_id and r.order_id = o.id)
        `),
      { orgId: place.orgId },
    );
    expect(missing[0]?.n).toBe(0);

    const report = await returns.report(context(place.orgId, AGENT), request(), today, today);
    const countOf = (r: typeof report, reason: string) =>
      r.reasons.find((line) => line.reason === reason);
    expect(report.total - before.total).toBe(4);
    expect(report.exchanges - before.exchanges).toBe(1);
    expect(
      (countOf(report, 'customer_refused')?.returns ?? 0) -
        (countOf(before, 'customer_refused')?.returns ?? 0),
    ).toBe(2);
    expect(
      (countOf(report, 'wrong_address')?.returns ?? 0) -
        (countOf(before, 'wrong_address')?.returns ?? 0),
    ).toBe(1);
    expect(
      (countOf(report, 'size_issue')?.exchanges ?? 0) -
        (countOf(before, 'size_issue')?.exchanges ?? 0),
    ).toBe(1);
    expect(report.reasons.reduce((total, line) => total + line.shareBps, 0)).toBe(10_000);
  }, 300_000);
});
