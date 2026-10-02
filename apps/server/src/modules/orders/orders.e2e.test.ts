import { findCostFields } from '@elysium/contracts';
import { withSystem } from '@elysium/db';
import { poisha } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  auditRowsFor,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { describeRoutes } from '../../platform/auth/route-map.js';
import { routeKey } from '../../platform/auth/route-matrix.manifest.js';
import { loadFonts } from '../files/pdf/fonts.js';
import { GotenbergClient } from '../files/pdf/gotenberg.client.js';
import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { renderOrderInvoiceHtml, renderPackingSlipHtml } from './documents.service.js';
import { OrdersModule } from './orders.module.js';
import { ORDERS_ROUTE_KEYS } from './orders.route-fixtures.js';
import {
  applyOrderMigrations,
  ownRiderCourier,
  seedCustomer,
  seedStockLevel,
  walletAccount,
} from './orders.testing.js';

/**
 * Orders over HTTP (M10 acceptance checks 1, 3, 5, 6 and §6's Orders row).
 *
 * Everything here goes through the real pipeline — the ability guard, the scope
 * interceptor, the serializer and the audit net, in the order `main.api.ts` mounts them —
 * against real PostgreSQL. The money and the stock are proved in `orders.db.test.ts`; what
 * this suite is for is the three things only the pipeline can answer:
 *
 * 1. **Who may see which order.** §6's sales cell is "own orders **plus** the unassigned
 *    queue", and the interesting assertion is the pair: a second agent can see an
 *    unassigned order and cannot see the same order once it is assigned. A suite that only
 *    checked the second half would pass against a scope that hid the queue, which is the
 *    version that makes the order desk useless.
 * 2. **That no cost field ever leaves.** `findCostFields` over every order response.
 *    `dispatch_unit_cost_poisha` is on the row from the moment the parcel ships, so this is
 *    not a hypothetical (invariant 5).
 * 3. **That the state machine's refusals arrive as refusals**, with the code §23 names
 *    rather than a 500 — including the transitions §9's table forbids (check 1's HTTP half;
 *    the exhaustive pair-by-pair assertion is `packages/domain/src/orders/orders.test.ts`,
 *    where all 121 pairs run in milliseconds).
 */

let harness: HttpHarness;

let admin: RoleClient;
let sales: RoleClient;
let otherSales: RoleClient;
let warehouse: RoleClient;
let accounts: RoleClient;
let reseller: RoleClient;
let otherOrgAdmin: RoleClient;

let location = '';
let customerId = '';
let courierId = '';
let wallet = '';
let skus: SeededSku[] = [];

beforeAll(async () => {
  harness = await startHttpHarness('orders-e2e', { extraModules: [OrdersModule] });
  await applyOrderMigrations();

  location = await warehouseId(ORG_A);
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711223344', name: 'Shamima Akter' });
  courierId = await ownRiderCourier(ORG_A);
  wallet = await walletAccount(ORG_A);
  ({ skus } = await seedProductWithSkus(ORG_A, 'orderse2e', 3));
  for (const sku of skus) {
    await seedStockLevel(ORG_A, {
      skuId: sku.id,
      locationId: location,
      qty: 200,
      unitCostPoisha: 40_000n,
    });
  }

  admin = await harness.asRole('org_admin', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  otherSales = await harness.asRole('sales', ORG_A);
  warehouse = await harness.asRole('warehouse', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  reseller = await harness.asRole('reseller', ORG_A);
  otherOrgAdmin = await harness.asRole('org_admin', ORG_B);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

// --- helpers ------------------------------------------------------------------

function body<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

function sku(index: number): string {
  const found = skus[index];
  if (found === undefined) throw new Error(`no fixture SKU ${String(index)}`);
  return found.id;
}

interface CreatedOrderBody {
  readonly id: string;
  readonly orderNo: string;
  readonly codAmountPoisha: string;
}

async function takeOrder(
  actor: RoleClient,
  overrides: Record<string, unknown> = {},
): Promise<CreatedOrderBody> {
  const response = await actor.client.request('POST', '/v1/orders', {
    body: {
      channel: 'phone',
      customerId,
      locationId: location,
      courierId,
      deliveryChargePoisha: '6000',
      lines: [{ skuId: sku(0), qty: 1, unitPricePoisha: '150000' }],
      ...overrides,
    },
  });
  if (response.statusCode !== 201) {
    throw new Error(`could not take an order: ${String(response.statusCode)} ${response.body}`);
  }
  return body<CreatedOrderBody>(response);
}

/** Journals posted for one advance (M17): received, refunded or forfeited. */
async function journalsFor(advanceId: string): Promise<number> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from ledger.journals
        where org_id = ${ORG_A} and source_type = 'customer_advance' and source_id = ${advanceId}
      `),
    { orgId: ORG_A },
  );
  return rows[0]?.n ?? -1;
}

function errorCode(response: InjectedResponse): string {
  const payload = body<{ code?: string; message?: string }>(response);
  return payload.code ?? '';
}

// --- §6: who may see which order ----------------------------------------------

describe('§6’s Orders row, through the guard and the scope interceptor', () => {
  it('shows an unassigned order to any agent and hides it once it is assigned', async () => {
    const order = await takeOrder(sales);

    /*
     * The queue first, because this is the half that a narrower scope would break
     * silently: §6 gives sales "own + unassigned queue", and an order nobody has claimed is
     * the whole point of a queue.
     */
    const beforeAssignment = await otherSales.client.request('GET', `/v1/orders/${order.id}`);
    expect(beforeAssignment.statusCode).toBe(200);

    const assigned = await sales.client.request('POST', `/v1/orders/${order.id}/assign`, {
      body: { assignedTo: sales.userId },
    });
    expect(assigned.statusCode).toBe(201);

    // Now it belongs to somebody, and the other agent is out of scope. 404, not 403: a row
    // you may not see must be indistinguishable from one that does not exist.
    const afterAssignment = await otherSales.client.request('GET', `/v1/orders/${order.id}`);
    expect(afterAssignment.statusCode).toBe(404);

    // The list obeys the same rule, which is a separate query and therefore a separate bug.
    const theirs = body<{ items: { id: string }[] }>(
      await otherSales.client.request('GET', '/v1/orders'),
    );
    expect(theirs.items.some((item) => item.id === order.id)).toBe(false);

    const mine = body<{ items: { id: string }[] }>(
      await sales.client.request('GET', '/v1/orders?queue=mine'),
    );
    expect(mine.items.some((item) => item.id === order.id)).toBe(true);
  }, 120_000);

  it('does not hand the unassigned queue to a reseller holding the same own-scoped grant', async () => {
    const order = await takeOrder(sales);

    /*
     * `reseller` and `sales` both hold `read Order|own`, and only one of them has the queue.
     * Widening the scope for everyone with `own` would have looked like a tidy
     * simplification and handed a reseller every staff order nobody had claimed yet.
     */
    const seen = await reseller.client.request('GET', `/v1/orders/${order.id}`);
    expect(seen.statusCode).toBe(404);
  }, 120_000);

  it('keeps another brand’s admin out entirely (invariant 4)', async () => {
    const order = await takeOrder(sales);
    const seen = await otherOrgAdmin.client.request('GET', `/v1/orders/${order.id}`);
    expect(seen.statusCode).toBe(404);
  }, 120_000);

  it('lets exactly one of two agents claim the same order', async () => {
    const order = await takeOrder(admin);

    const [first, second] = await Promise.all([
      sales.client.request('POST', `/v1/orders/${order.id}/claim`),
      otherSales.client.request('POST', `/v1/orders/${order.id}/claim`),
    ]);

    /*
     * One winner, and the loser is refused — with either code.
     *
     * `assigned_to is null` is part of the *scope* for a sales agent as well as part of the
     * claim's WHERE, so once the winner commits the loser's row is out of their reach and
     * PostgreSQL's EvalPlanQual re-check drops it: the honest answer is then 404 rather than
     * 409. Both are a refusal and neither is a second claim, which is the property that
     * matters. The 409 path is asserted on its own below, where the caller can still see the
     * order.
     */
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes[0]).toBe(201);
    expect([404, 409]).toContain(codes[1]);

    const detail = body<{ assignedTo: string | null }>(
      await admin.client.request('GET', `/v1/orders/${order.id}`),
    );
    expect([sales.userId, otherSales.userId]).toContain(detail.assignedTo);
  }, 120_000);

  it('reports ORDER_ALREADY_CLAIMED to a caller who can see the order (§6, §23)', async () => {
    const order = await takeOrder(admin);
    const claimed = await sales.client.request('POST', `/v1/orders/${order.id}/claim`);
    expect(claimed.statusCode).toBe(201);

    // org_admin reaches the whole org, so the row is in scope and the refusal is about the
    // claim rather than about visibility.
    const again = await admin.client.request('POST', `/v1/orders/${order.id}/claim`);
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('ORDER_ALREADY_CLAIMED');
  }, 120_000);
});

// --- invariant 5: no cost leaves ----------------------------------------------

describe('invariant 5, on every order response', () => {
  it('never returns a cost field, not even after the dispatch cost is written', async () => {
    const order = await takeOrder(admin);
    await admin.client.request('POST', `/v1/orders/${order.id}/confirm`);
    await admin.client.request('POST', `/v1/orders/${order.id}/ship`, { body: { courierId } });

    // The line now carries `dispatch_unit_cost_poisha`, which is what the handover journal
    // posted. It is not in the view and `serializeFor` would strip it if it were.
    const detail = await admin.client.request('GET', `/v1/orders/${order.id}`);
    expect(detail.statusCode).toBe(200);
    expect(findCostFields(body<unknown>(detail))).toEqual([]);
    expect(detail.body).not.toContain('dispatchUnitCost');
    expect(detail.body).not.toContain('dispatch_unit_cost');

    const list = await admin.client.request('GET', '/v1/orders');
    expect(findCostFields(body<unknown>(list))).toEqual([]);

    // And the availability read, which an order desk calls on every keystroke: selling
    // price, yes; weighted average, never.
    const available = await sales.client.request(
      'GET',
      `/v1/orders/availability?skuIds=${sku(0)}&locationId=${location}`,
    );
    expect(available.statusCode).toBe(200);
    expect(findCostFields(body<unknown>(available))).toEqual([]);
  }, 180_000);
});

// --- invariant 7: the machine, over HTTP --------------------------------------

describe('invariant 7, over HTTP', () => {
  it('walks pending → confirmed → packed → shipped → delivered, auditing each step', async () => {
    const order = await takeOrder(admin);
    expect(order.codAmountPoisha).toBe('156000');

    for (const step of ['confirm', 'pack']) {
      const response = await admin.client.request('POST', `/v1/orders/${order.id}/${step}`);
      expect(response.statusCode, `${step}: ${response.body}`).toBe(201);
    }
    // The warehouse hands the parcel over: §6's "pack, ship, returns" cell, at org scope.
    const shipped = await warehouse.client.request('POST', `/v1/orders/${order.id}/ship`, {
      body: { courierId, consignmentNo: 'SF-778811' },
    });
    expect(shipped.statusCode, shipped.body).toBe(201);
    const delivered = await warehouse.client.request('POST', `/v1/orders/${order.id}/deliver`);
    expect(delivered.statusCode, delivered.body).toBe(201);
    expect(body<{ status: string }>(delivered).status).toBe('delivered');

    const rows = await auditRowsFor(ORG_A, order.id);
    const actions = rows.map((row) => row.action);
    expect(actions).toContain('order.created');
    expect(actions).toContain('order.confirm');
    expect(actions).toContain('order.ship');
    expect(actions).toContain('order.deliver');

    // §9's history, which is append-only and is the order's own record of itself.
    const detail = body<{ history: { trigger: string; to: string }[] }>(
      await admin.client.request('GET', `/v1/orders/${order.id}`),
    );
    expect(detail.history.map((entry) => entry.trigger)).toEqual([
      'create',
      'confirm',
      'pack',
      'ship',
      'deliver',
    ]);
    // The consignment number the desk typed, kept on the order's history until M12 gives it
    // a column of its own.
    expect(detail.history.some((entry) => entry.to === 'shipped')).toBe(true);
  }, 180_000);

  it('refuses a transition §9’s table does not list, with the code §23 names', async () => {
    const order = await takeOrder(admin);

    // `pending → delivered` is not in the table. 409 and `ORDER_TRANSITION_INVALID`, because
    // the request was well formed and the order was in the wrong state — a 400 would tell a
    // client to change the body instead of reloading.
    const refused = await admin.client.request('POST', `/v1/orders/${order.id}/deliver`);
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('ORDER_TRANSITION_INVALID');

    // And a reason where §9 requires one.
    const noReason = await admin.client.request('POST', `/v1/orders/${order.id}/cancel`, {
      body: {},
    });
    expect(noReason.statusCode).toBe(400);
  }, 120_000);

  it('refuses a confirm it cannot reserve, and leaves the order pending', async () => {
    const scarce = sku(2);
    // Two units on the shelf beyond whatever else this suite has reserved; the order asks
    // for far more than the 200 seeded, so the refusal is certain rather than incidental.
    const order = await takeOrder(admin, {
      lines: [{ skuId: scarce, qty: 100_000, unitPricePoisha: '100' }],
    });
    const refused = await admin.client.request('POST', `/v1/orders/${order.id}/confirm`);
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused)).toBe('STOCK_INSUFFICIENT');

    const detail = body<{ status: string }>(
      await admin.client.request('GET', `/v1/orders/${order.id}`),
    );
    expect(detail.status).toBe('pending');
  }, 120_000);

  it('edits a pending order’s lines and reprices it in the domain', async () => {
    const order = await takeOrder(admin);
    const edited = await admin.client.request('PATCH', `/v1/orders/${order.id}`, {
      body: {
        lines: [
          { skuId: sku(0), qty: 2, unitPricePoisha: '150000' },
          { skuId: sku(1), qty: 1, unitPricePoisha: '90000', discountPoisha: '9000' },
        ],
        discountPoisha: '10000',
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);

    /*
     * 2 × 150,000 + 1 × 90,000 = 390,000 items; 9,000 on the line plus 10,000 on the order
     * = 19,000 discount; delivery 6,000 → COD 377,000. The arithmetic is
     * `computeOrderTotals`; the point of asserting it here is that the *edit* goes through
     * the same function as the create, not through SQL that adds up columns.
     */
    const amounts = body<{ amounts: Record<string, string> }>(edited).amounts;
    expect(amounts).toMatchObject({
      itemsPoisha: '390000',
      discountPoisha: '19000',
      deliveryChargePoisha: '6000',
      codAmountPoisha: '377000',
    });
  }, 120_000);
});

// --- §6: the abilities that are not `update Order` ----------------------------

describe('the grants that are deliberately not an order grant', () => {
  /*
   * M17 check 2 over HTTP: an unverified advance never reaches the books (D-230, D-235).
   *
   * The agent records the claim under `update Order`, which posts nothing and leaves the COD
   * alone. Only `create Wallet` (accounts) verifies it, and never the person who recorded
   * it. The two old ways money reached the COD on one person's word are gone: the
   * `POST /v1/orders/:id/advance` route, and an amount on the create body.
   */
  it('lets an agent claim an advance, and only accounts verify it (M17 check 2)', async () => {
    const order = await takeOrder(sales);

    // The old route is gone, and so is an advance typed on the create body.
    const oldRoute = await accounts.client.request('POST', `/v1/orders/${order.id}/advance`, {
      body: { walletAccountId: wallet, amountPoisha: '5000' },
    });
    expect(oldRoute.statusCode).toBe(404);
    const typedOnCreate = await sales.client.request('POST', '/v1/orders', {
      body: {
        channel: 'phone',
        customerId,
        locationId: location,
        lines: [{ skuId: sku(0), qty: 1, unitPricePoisha: '150000' }],
        advancePaidPoisha: '5000',
      },
    });
    expect(typedOnCreate.statusCode).toBe(400);

    // Accounts holds `read Order`, not `update Order`: it verifies, it does not claim.
    const byAccounts = await accounts.client.request('POST', `/v1/orders/${order.id}/advances`, {
      body: { method: 'bkash', transactionRef: 'E2E8N7A6B5C', amountPoisha: '5000' },
    });
    expect(byAccounts.statusCode).toBe(403);

    const claimed = await sales.client.request('POST', `/v1/orders/${order.id}/advances`, {
      body: { method: 'bkash', transactionRef: ' e2e 8n7a-6b5c ', amountPoisha: '5000' },
    });
    expect(claimed.statusCode, claimed.body).toBe(201);
    const claim = body<{ id: string; status: string; transactionRef: string }>(claimed);
    expect(claim).toMatchObject({ status: 'pending', transactionRef: 'E2E8N7A6B5C' });

    // The same payment cannot back a second claim.
    const again = await sales.client.request('POST', `/v1/orders/${order.id}/advances`, {
      body: { method: 'bkash', transactionRef: 'E2E8N7A6B5C', amountPoisha: '5000' },
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('ADVANCE_DUPLICATE');

    // Claimed but not verified: the COD is untouched and nothing is in the books.
    const pending = body<{ amounts: Record<string, string> }>(
      await admin.client.request('GET', `/v1/orders/${order.id}`),
    );
    expect(pending.amounts).toMatchObject({ advancePaidPoisha: '0', codAmountPoisha: '156000' });
    expect(await journalsFor(claim.id)).toBe(0);

    // The agent cannot verify, by grant; accounts sees it in the queue and verifies it.
    const bySalesVerify = await sales.client.request(
      'POST',
      `/v1/order-advances/${claim.id}/verify`,
      { body: { walletAccountId: wallet } },
    );
    expect(bySalesVerify.statusCode).toBe(403);
    const queue = body<{ items: { id: string; orderNo: string }[] }>(
      await accounts.client.request('GET', '/v1/order-advances'),
    );
    expect(queue.items.find((item) => item.id === claim.id)?.orderNo).toBe(order.orderNo);

    const verified = await accounts.client.request(
      'POST',
      `/v1/order-advances/${claim.id}/verify`,
      { body: { walletAccountId: wallet } },
    );
    expect(verified.statusCode, verified.body).toBe(201);
    expect(body<{ status: string }>(verified).status).toBe('verified');
    expect(await journalsFor(claim.id)).toBe(1);

    // Verified money lowers what the rider collects: 156,000 − 5,000.
    const detail = body<{ amounts: Record<string, string> }>(
      await admin.client.request('GET', `/v1/orders/${order.id}`),
    );
    expect(detail.amounts).toMatchObject({ advancePaidPoisha: '5000', codAmountPoisha: '151000' });

    // Deciding twice is refused, and the order's own list shows the claim to the agent.
    const twice = await accounts.client.request('POST', `/v1/order-advances/${claim.id}/verify`, {
      body: { walletAccountId: wallet },
    });
    expect(twice.statusCode).toBe(400);
    expect(errorCode(twice)).toBe('ADVANCE_INVALID');
    const listed = body<{ items: { id: string; status: string }[] }>(
      await sales.client.request('GET', `/v1/orders/${order.id}/advances`),
    );
    expect(listed.items).toEqual([expect.objectContaining({ id: claim.id, status: 'verified' })]);
  }, 120_000);

  it('rejects a claim with no journal, and frees its reference', async () => {
    const order = await takeOrder(sales);
    const claimed = await sales.client.request('POST', `/v1/orders/${order.id}/advances`, {
      body: { method: 'bkash', transactionRef: 'E2EREJ12345', amountPoisha: '6000' },
    });
    const claim = body<{ id: string }>(claimed);

    const rejected = await accounts.client.request(
      'POST',
      `/v1/order-advances/${claim.id}/reject`,
      { body: { reason: 'Not in the bKash statement' } },
    );
    expect(rejected.statusCode, rejected.body).toBe(201);
    expect(body<{ status: string }>(rejected).status).toBe('rejected');
    expect(await journalsFor(claim.id)).toBe(0);

    // A rejected claim frees the reference: the agent can record it again, correctly.
    const retyped = await sales.client.request('POST', `/v1/orders/${order.id}/advances`, {
      body: { method: 'bkash', transactionRef: 'E2EREJ12345', amountPoisha: '5000' },
    });
    expect(retyped.statusCode, retyped.body).toBe(201);
  }, 120_000);

  it('opens delivery zones to the desk and keeps editing them with org_admin (D-009)', async () => {
    const listed = await sales.client.request('GET', '/v1/delivery-zones');
    expect(listed.statusCode).toBe(200);
    const zones = body<{ zones: { code: string; chargePoisha: string }[] }>(listed).zones;
    // D-009's assumed placeholders, seeded per org and editable.
    expect(zones.find((zone) => zone.code === 'inside_dhaka')?.chargePoisha).toBe('6000');

    const forArea = await sales.client.request('GET', '/v1/delivery-zones/for-area?districtId=47');
    expect(forArea.statusCode).toBe(200);
    expect(body<{ code: string }>(forArea).code).toBe('inside_dhaka');

    const bySales = await sales.client.request('PUT', '/v1/delivery-zones', {
      body: {
        code: 'inside_dhaka',
        nameEn: 'Inside Dhaka',
        nameBn: 'ঢাকার ভিতরে',
        chargePoisha: '1',
      },
    });
    expect(bySales.statusCode).toBe(403);

    const byAdmin = await admin.client.request('PUT', '/v1/delivery-zones', {
      body: {
        code: 'inside_dhaka',
        nameEn: 'Inside Dhaka',
        nameBn: 'ঢাকার ভিতরে',
        chargePoisha: '7000',
        position: 1,
      },
    });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
  }, 120_000);
});

// --- check 6: phone normalisation at the edge ---------------------------------

describe('check 6, through the customers endpoint', () => {
  it('normalises every shape a buyer sends and refuses what a courier cannot deliver to', async () => {
    const shapes = ['01812345678', '+88 01812-345678', '০১৮১২৩৪৫৬৭৮', '8801812345678'];
    const created: string[] = [];
    for (const phone of shapes) {
      const response = await sales.client.request('POST', '/v1/customers', {
        body: { phone, name: 'Tanjina Islam' },
      });
      expect(response.statusCode, `${phone}: ${response.body}`).toBe(201);
      const payload = body<{ id: string; phone: string; created: boolean }>(response);
      expect(payload.phone).toBe('+8801812345678');
      created.push(payload.id);
    }
    // One buyer, four spellings. A second row here is a buyer whose order history and §10
    // trust score are split in half.
    expect(new Set(created).size).toBe(1);

    // A landline is a valid Bangladeshi number and a useless one for a COD parcel: no SMS,
    // and no courier will accept it as a contact (see `normalizeBdPhone`).
    const landline = await sales.client.request('POST', '/v1/customers', {
      body: { phone: '02-9611000', name: 'Some Office' },
    });
    expect(landline.statusCode).toBe(400);
    // The refusal never echoes the number it refused (invariant 10).
    expect(landline.body).not.toContain('9611000');
  }, 120_000);
});

// --- §22: the documents -------------------------------------------------------

describe('§22’s invoice and packing slip', () => {
  /*
   * The page contents are asserted without Gotenberg, because that is the part this module
   * owns; the bytes are Chromium's business and are asserted separately when it is up.
   */
  const brand = {
    displayName: 'Elysium Lifestyle BD',
    legalName: 'Elysium Lifestyle BD Limited',
    address: 'বাড়ি ১২, সড়ক ৫, ধানমন্ডি, ঢাকা ১২০৫',
    vatNo: '004512345678',
    invoiceFooter: 'পণ্য বদলাতে চাইলে ডেলিভারির ৭ দিনের মধ্যে যোগাযোগ করুন।',
    accentHue: 268,
  };

  const data = {
    orderNo: 'ELY-2609-00042',
    issuedOn: '2026-09-25',
    customerName: 'রহিমা খাতুন',
    customerPhone: '01712-345678',
    addressLine: 'ফ্ল্যাট ৪বি, বাড়ি ২৩, সড়ক ১১, বনানী',
    areaBn: 'গুলশান, ঢাকা',
    areaEn: 'Gulshan, Dhaka',
    lines: [
      {
        name: 'ক্ষুদ্র নকশার ওড়না',
        sku: 'ELY-ODN-PRT-1',
        qty: 3,
        unitPricePoisha: poisha(68_500n),
        lineDiscountPoisha: poisha(0n),
      },
    ],
    itemsPoisha: poisha(205_500n),
    discountPoisha: poisha(5_500n),
    deliveryChargePoisha: poisha(6_000n),
    advancePaidPoisha: poisha(6_000n),
    codAmountPoisha: poisha(200_000n),
    notes: 'ফোন করে তারপর ডেলিভারি দিন',
  };

  it('writes the invoice in Bangla, with the money the customer will be asked for', () => {
    const html = renderOrderInvoiceHtml({ brand, data, fonts: [] });
    expect(html).toContain('lang="bn"');
    expect(html).toContain('বিক্রয় চালান');
    // The conjuncts §22's font requirement exists for: a renderer without the right GSUB
    // table draws these as separate letters, which still looks like text.
    expect(html).toContain('ক্ষুদ্র');
    expect(html).toContain('ELY-2609-00042');
    expect(html).toContain('৳2,055.00');
    expect(html).toContain('৳2,000.00');
    expect(html).toContain('01712-345678');
    expect(html).toContain(brand.invoiceFooter);
  });

  it('keeps line prices off the packing slip and the collectable amount on it', () => {
    const html = renderPackingSlipHtml({ brand, data, fonts: [] });
    expect(html).toContain('প্যাকিং স্লিপ');
    expect(html).toContain('৳2,000.00');
    // A priced slip taped to a box is an argument at the door about a discount the buyer
    // did not expect, and the picker has no use for the number.
    expect(html).not.toContain('৳685.00');
    expect(html).not.toContain('৳2,055.00');
  });

  it('escapes a buyer’s name rather than letting it become markup', () => {
    const html = renderOrderInvoiceHtml({
      brand,
      data: { ...data, customerName: '<script>alert(1)</script>' },
      fonts: [],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders a real order to PDF through Gotenberg', async () => {
    const client = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
    if (!(await client.isReady())) {
      // Skipped rather than failed: Gotenberg is a container from the dev compose file, and
      // a machine without it should not fail a suite about orders. The render functions
      // above are asserted unconditionally, and the fonts are loaded here either way.
      expect((await loadFonts()).length).toBeGreaterThan(0);
      return;
    }

    const order = await takeOrder(admin);
    for (const kind of ['invoice', 'packing_slip']) {
      const response = await admin.client.request(
        'GET',
        `/v1/orders/${order.id}/document?kind=${kind}`,
      );
      expect(response.statusCode, `${kind}: ${response.body.slice(0, 200)}`).toBe(200);
      expect(response.headers['content-type']).toBe('application/pdf');
      expect(response.body.slice(0, 5)).toBe('%PDF-');
    }
  }, 180_000);
});

// --- D-070: the gate's three sets, for this module ----------------------------

describe('the route gate (D-070), scoped to this module', () => {
  /*
   * The manifest and the shared route-matrix suite are one file each, edited by every
   * milestone building in parallel, so M10 hands its entries to the integrator instead of
   * writing them itself — and until they land, nothing checks that the list is right.
   *
   * This is that check, brought forward: the routes `OrdersModule` actually registers, the
   * keys `ORDERS_ROUTE_KEYS` claims, and the requirement that every one of them declares an
   * ability. An entry the integrator pastes in for a route that does not exist fails
   * `check:routes` with a message about a stale manifest; catching it here makes that a
   * problem of this milestone rather than of the merge.
   */
  it('registers exactly the routes the fixtures claim, each with a declared ability', () => {
    const mine = describeRoutes(harness.app).filter((route) =>
      [
        'OrdersController',
        'CustomersController',
        'DeliveryZonesController',
        // M11's buyer list lives in this module too.
        'BuyersController',
        // M16's re-engagement list, beside it.
        'ReengagementController',
        // M17's advances and returns by reason.
        'AdvancesController',
      ].includes(route.controller),
    );

    expect(mine.length).toBeGreaterThan(20);
    expect([...mine.map(routeKey)].sort()).toEqual([...ORDERS_ROUTE_KEYS].sort());

    // Undeclared means denied at the guard, and `check:routes` fails the build for it. A
    // route with no ability is not a route with a default — it is one nobody can call.
    const undeclared = mine.filter((route) => route.declared === null);
    expect(undeclared.map(routeKey)).toEqual([]);
    // Nothing here is public: an order is somebody's money and somebody's address.
    expect(mine.filter((route) => route.declared?.startsWith('public') === true)).toEqual([]);
  });
});

// --- confirm, with the fraud check removed (D-291) ------------------------------

describe('confirm without a fraud check', () => {
  it('confirms on the machine alone, and the order carries no fraud verdict', async () => {
    const order = await takeOrder(admin);
    const confirmed = await admin.client.request('POST', `/v1/orders/${order.id}/confirm`);
    expect(confirmed.statusCode, confirmed.body).toBe(201);

    const detail = body<Record<string, unknown>>(
      await admin.client.request('GET', `/v1/orders/${order.id}`),
    );
    expect(detail.status).toBe('confirmed');
    expect(detail).not.toHaveProperty('trustScore');
    expect(detail).not.toHaveProperty('fraudDecision');
  }, 120_000);
});

// --- §6's customers cell, on the order path -----------------------------------

describe('§6’s "customers of own orders", on both paths', () => {
  it('lets the agent who entered a buyer order for them, and refuses another agent', async () => {
    const phone = `+88016${String(Math.floor(Math.random() * 90_000_000) + 10_000_000)}`;
    const created = await sales.client.request('POST', '/v1/customers', {
      body: { phone, name: 'Sumaiya Akter', address: await someAddress() },
    });
    expect(created.statusCode, created.body).toBe(201);
    const buyer = body<{ id: string }>(created).id;

    /*
     * The agent's own first order for that buyer must work.
     *
     * A literal reading of "customers of own orders" hides a buyer with no orders from
     * everybody, which breaks this step and reads as the create endpoint having failed. A
     * buyer nobody has ordered for is nobody's, so admitting them takes nothing from anyone.
     */
    const mine = await sales.client.request('POST', '/v1/orders', {
      body: {
        channel: 'phone',
        customerId: buyer,
        locationId: location,
        courierId,
        deliveryChargePoisha: '6000',
        lines: [{ skuId: sku(0), qty: 1, unitPricePoisha: '150000' }],
      },
    });
    expect(mine.statusCode, mine.body).toBe(201);

    // Now the buyer is somebody's. A second agent guessing the uuid gets nothing — an order
    // returns the buyer's name and phone, so an unchecked id was a way to read them.
    const theirs = await otherSales.client.request('POST', '/v1/orders', {
      body: {
        channel: 'phone',
        customerId: buyer,
        locationId: location,
        courierId,
        deliveryChargePoisha: '6000',
        lines: [{ skuId: sku(0), qty: 1, unitPricePoisha: '150000' }],
      },
    });
    expect(theirs.statusCode).toBe(404);
    expect(await otherSales.client.request('GET', `/v1/customers/${buyer}`)).toMatchObject({
      statusCode: 404,
    });
    // And the org-wide roles still see them.
    expect(await admin.client.request('GET', `/v1/customers/${buyer}`)).toMatchObject({
      statusCode: 200,
    });
  }, 180_000);
});

/** A district and thana from the reference data, so an address needs no hard-coded ids. */
async function someAddress(): Promise<{
  districtId: number;
  thanaId: number;
  addressLine: string;
}> {
  const zones = await admin.client.request('GET', '/v1/delivery-zones/for-area?districtId=47');
  expect(zones.statusCode).toBe(200);
  const thanas = await withSystem(
    async (tx) =>
      tx.execute<{ id: number }>(sql`
        select id from ref.thanas where district_id = 47 order by id limit 1
      `),
    { orgId: ORG_A },
  );
  return {
    districtId: 47,
    thanaId: thanas[0]?.id ?? 1,
    addressLine: 'House 7, Road 2, Dhanmondi, Dhaka',
  };
}
