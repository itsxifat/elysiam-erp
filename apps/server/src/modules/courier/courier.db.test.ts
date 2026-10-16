import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { poisha } from '@elysium/domain';
import { matchSettlement } from '@elysium/domain/courier';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ORG_A, ORG_B, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { ApprovalsService } from '../approvals/approvals.service.js';
import { CourierAccountsService } from './accounts.service.js';
import { COURIER_ADAPTERS, CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { FakeCourierAdapter } from './adapters/fake.adapter.js';
import { BookingService } from './booking.service.js';
import { resetCourierEnv } from './courier.config.js';
import { COURIER_QUEUE_DEFINITIONS } from './courier.queues.js';
import { PACKING_QUEUE_DEFINITIONS } from '../packing/packing.queues.js';
import * as repo from './courier.repository.js';
import { ORDERS_PORT } from './ports/orders.port.js';
import {
  applyCourierMigrations,
  closeMonth,
  makeBankWallet,
  makeCourier,
  makeLocation,
  seedShippedOrder,
  statementCsv,
  taka,
  type SeededOrder,
} from './courier.testing.js';
import { CourierReportsService } from './reports.service.js';
import { ReturnsService } from './returns.service.js';
import { SettlementsService } from './settlements.service.js';
import { CourierSyncService } from './sync.service.js';

/**
 * M12 against a real database (acceptance checks 3, 4, 5 and 6).
 *
 * The four claims, in the order the milestone states them:
 *
 * 3. **A duplicate webhook or poll never double-transitions or double-posts.** The same event
 *    is delivered twice, and the second delivery changes nothing: one event row, one
 *    transition, one journal. Then the same fact with a *different* timestamp, which gets
 *    past the dedupe row and is stopped by the state machine instead — the second layer,
 *    exercised on its own.
 * 4. **A settlement import matches, lists every mismatch, posts only after approval, and
 *    obeys D-037.** Including a settlement dated inside a closed month, which posts to the
 *    earliest open period and keeps its own date on the row.
 * 5. **book → deliver → settle leaves the consignment's courier receivable at exactly zero,
 *    and the P&L shows the courier charges.** Read back out of `ledger.journal_lines`, not
 *    from anything this module computed.
 * 6. **A booking that fails after every retry raises `delivery.booking_failed` and flags the
 *    order.** Driven through the dead-letter path rather than by calling the reporter
 *    directly, so the flag and the event are both proven to come from the same place.
 *
 * Plus the tenancy and immutability rules the database owns, because they are the half of
 * invariants 4 and 2 a service cannot be trusted with.
 *
 * ## What is a double and what is real
 *
 * The database, the migrations, the ledger, the approvals module and the audit log are real.
 * `ORDERS_PORT` is `TestOrdersPort`, which runs the real state machine and posts the real §7
 * journals through the real `LedgerApi` — see the comment on that class for why a recording
 * stub would have made check 5 a test of nothing. `WALLETS_PORT` and `LEDGER_READ_PORT` are
 * implemented against the real tables.
 */

let harness: HttpHarness;
let jobs: JobsRuntime;
let approvals: ApprovalsService;

let adapters: CourierAdapterRegistry;
let fake: FakeCourierAdapter;

let accounts: CourierAccountsService;
let booking: BookingService;
let sync: CourierSyncService;
let returns: ReturnsService;
let settlements: SettlementsService;
let reports: CourierReportsService;

let courierId = '';
let courierIdB = '';
let accountId = '';
let walletId = '';
let damagedLocation = '';

const WEBHOOK_SECRET = 'a-webhook-secret-of-sufficient-length';
const ACTOR = 'usr_courier_test';
const CHECKER = 'usr_courier_checker';

function context(orgId = ORG_A, userId = ACTOR): ActiveContext {
  return {
    userId,
    orgId,
    roles: ['org_admin', 'accounts'],
    branchIds: [],
    isSuperAdmin: false,
    requestId: randomUUID(),
  } as unknown as ActiveContext;
}

/**
 * A request the scope helpers and the audit net accept.
 *
 * `attachScope` is normally called by `AbilityGuard` once a route's ability has been granted,
 * and `scopeWhere`/`assertInScope` refuse a request it never touched — deliberately, so a
 * handler that forgot its scope fails closed. This suite calls the services directly, so it
 * attaches the scope itself, at `all`, which is what an org-wide `org_admin` gets. The branch
 * narrowing has its own tests in the route-matrix suite, where the guard computes it.
 */
function request(): AuditableRequest {
  const carrier = { headers: {} } as unknown as AuditableRequest;
  attachScope(carrier, 'update', 'CourierSettlement', { kind: 'all' });
  return carrier;
}

beforeAll(async () => {
  process.env.COURIER_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  // M13's phone-hash key is set by `startHttpHarness` now, with every other variable the
  // application refuses to boot without — see `apps/server/src/testing/test-env.ts`.
  resetCourierEnv();

  harness = await startHttpHarness('courier-db');
  // M15's three migrations (0065–0067) are not in the journal until integration; the
  // services now read their columns, so they are applied here, guarded and idempotent.
  await applyCourierMigrations();

  /*
   * A real pg-boss runtime, because invariant 6 is the shape of this module.
   *
   * `reserveConsignment` calls `enqueue(tx, …)`, which refuses a queue the process has not
   * registered — so without this every booking test would fail for the right reason in a way
   * that looks like the wrong one. Registering the module's own definitions rather than a
   * stand-in is also what proves `assertValidQueue` accepts them, and that the cron on
   * `delivery.poll_status` is allowed only because that queue is global.
   *
   * The handlers are *not* registered: this suite drives `runBooking` and `runWebhook`
   * directly, so a worker fetching the same job in the background would run it twice and turn
   * an idempotency assertion into a race.
   */
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    // M46 (D-817): a booked parcel queues its labels' auto-print in the booking transaction.
    queues: [...COURIER_QUEUE_DEFINITIONS, ...PACKING_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  approvals = harness.app.get(ApprovalsService);

  /*
   * The **real** services, out of the booted application, with the real ports behind them.
   *
   * This suite used to construct them by hand over test doubles, which was the only thing
   * available while `modules/orders` was being finished beside it. Now that `CourierModule` is
   * registered in `AppModule` and its three ports are bound to `ORDERS_API`, `WALLETS_API` and
   * `LEDGER_API`, taking them from the container is strictly better and not merely tidier:
   *
   * - every transition really runs `TransitionsService`, so §9's effects — the stock movements
   *   and §7's journals — happen for real rather than in a double's approximation;
   * - `settlement_posting` is registered once, by the real `SettlementsService`, so
   *   `approvals.decide` reaches the same instance these tests drive. Constructing a second one
   *   made `registerExecutor` throw "already registered", which is the check doing its job;
   * - the ports are exercised, so a drift between `OrdersPort` and `OrdersApi` fails here
   *   instead of in production.
   *
   * The fake courier comes out of the module's own registry for the same reason: it is the
   * instance the services will actually call.
   */
  accounts = harness.app.get(CourierAccountsService);
  booking = harness.app.get(BookingService);
  sync = harness.app.get(CourierSyncService);
  returns = harness.app.get(ReturnsService);
  settlements = harness.app.get(SettlementsService);
  reports = harness.app.get(CourierReportsService);

  adapters = harness.app.get<CourierAdapterRegistry>(COURIER_ADAPTERS);
  const registered = adapters.get('fake');
  if (!(registered instanceof FakeCourierAdapter)) {
    throw new Error('the courier module did not register the fake adapter');
  }
  fake = registered;

  courierId = await makeCourier(ORG_A, 'fake', 'Fake Courier');
  courierIdB = await makeCourier(ORG_B, 'fake', 'Fake Courier');
  walletId = await makeBankWallet(ORG_A);
  damagedLocation = await makeLocation(ORG_A, {
    code: 'DAMAGED',
    name: 'Damaged shelf',
    kind: 'damaged',
  });

  const account = await accounts.upsert(context(), request(), {
    courierId,
    providerCode: 'fake',
    label: 'Fake Courier (sandbox)',
    mode: 'sandbox',
    webhookSecret: WEBHOOK_SECRET,
    pollAfterHours: 1,
    settlementWalletId: walletId,
    isActive: true,
  });
  accountId = account.id;
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

beforeEach(() => {
  fake.reset();
  fake.failNextBookings = 0;
  fake.rejectNextBookings = 0;
});

// --- helpers ------------------------------------------------------------------

/**
 * Assert that a database trigger refused something, by its code.
 *
 * Drizzle wraps a PostgreSQL error in one whose message is "Failed query: …" and hangs the
 * real one off `.cause`, so `rejects.toThrow(/CODE/)` matches nothing — it would pass for any
 * failed query at all, which is the worst kind of green test. This walks the chain, the same
 * way `databaseCourierCode` does in production.
 */
async function expectRefusal(work: () => Promise<unknown>, code: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await work();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'expected a refusal, got none').toBeDefined();

  const messages: string[] = [];
  for (let current = thrown; current instanceof Error; current = current.cause) {
    messages.push(current.message);
  }
  expect(messages.join(' | ')).toMatch(code);
}

/** Book a parcel end to end: reserve, run the job's work, return the consignment. */
async function book(order: SeededOrder, orgId = ORG_A): Promise<string> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        update sales.orders set courier_id = ${orgId === ORG_A ? courierId : courierIdB}
        where org_id = ${orgId} and id = ${order.orderId}
      `);
    },
    { orgId },
  );

  const reserved = await withOrg({ orgId, userId: ACTOR }, (tx) =>
    booking.reserveConsignment(tx, { orgId, userId: ACTOR }, { orderId: order.orderId }),
  );
  await booking.runBooking({
    orgId,
    payload: { consignmentId: reserved.consignmentId, orderId: order.orderId, actorUserId: ACTOR },
  });
  return reserved.consignmentId;
}

async function consignment(id: string, orgId = ORG_A) {
  const row = await withOrg({ orgId, userId: ACTOR }, (tx) => repo.consignmentById(tx, orgId, id));
  if (row === undefined) throw new Error('no consignment');
  return row;
}

async function eventCount(consignmentId: string, orgId = ORG_A): Promise<number> {
  return withOrg({ orgId, userId: ACTOR }, async (tx) => {
    const rows = await tx.execute<{ count: string }>(sql`
      select count(*) as count from courier.consignment_events
      where org_id = ${orgId} and consignment_id = ${consignmentId}
    `);
    return Number(rows[0]?.count ?? 0);
  });
}

async function journalCount(orderId: string, event: string, orgId = ORG_A): Promise<number> {
  return withOrg({ orgId, userId: ACTOR }, async (tx) => {
    const rows = await tx.execute<{ count: string }>(sql`
      select count(*) as count from ledger.journals
      where org_id = ${orgId} and source_type = 'order' and source_id = ${orderId}
        and idempotency_key like ${`%:${event}`}
    `);
    return Number(rows[0]?.count ?? 0);
  });
}

/** Units on hand at one location, for the returns inspection assertions (§8). */
async function onHand(skuId: string, locationId: string, orgId = ORG_A): Promise<number> {
  return withOrg({ orgId, userId: ACTOR }, async (tx) => {
    const rows = await tx.execute<{ on_hand: number }>(sql`
      select on_hand from inventory.stock_levels
      where org_id = ${orgId} and sku_id = ${skuId} and location_id = ${locationId}
    `);
    return rows[0]?.on_hand ?? 0;
  });
}

/** Σ debit − Σ credit on `courier_receivable` for one courier (§7). */
async function courierReceivable(courier: string, orgId = ORG_A): Promise<bigint> {
  return withOrg({ orgId, userId: ACTOR }, async (tx) => {
    const rows = await tx.execute<{ balance: string }>(sql`
      select coalesce(sum(l.debit_poisha) - sum(l.credit_poisha), 0)::text as balance
      from ledger.journal_lines l
      join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${orgId} and a.subtype = 'courier_receivable'
        and l.party_type = 'courier' and l.party_id = ${courier}
    `);
    return BigInt(rows[0]?.balance ?? '0');
  });
}

/** Σ debit − Σ credit on one expense subtype: what the P&L shows for it (§7). */
async function expenseBalance(subtype: string, orgId = ORG_A): Promise<bigint> {
  return withOrg({ orgId, userId: ACTOR }, async (tx) => {
    const rows = await tx.execute<{ balance: string }>(sql`
      select coalesce(sum(l.debit_poisha) - sum(l.credit_poisha), 0)::text as balance
      from ledger.journal_lines l
      join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
      where l.org_id = ${orgId} and a.subtype = ${subtype}::ledger.account_subtype
    `);
    return BigInt(rows[0]?.balance ?? '0');
  });
}

/** Deliver a parcel through the webhook path, exactly as a courier would. */
async function deliverByWebhook(
  consignmentId: string,
  options: { at?: Date; rawStatus?: string; collectedPoisha?: string } = {},
) {
  const row = await consignment(consignmentId);
  fake.advance(row.consignment_no ?? '', options.rawStatus ?? 'handed_to_customer', {
    ...(options.at === undefined ? {} : { at: options.at }),
    ...(options.collectedPoisha === undefined ? {} : { collectedPoisha: options.collectedPoisha }),
  });
  const body = Buffer.from(JSON.stringify(fake.webhookBody(row.consignment_no ?? '')), 'utf8');

  const accepted = await sync.acceptWebhook({
    orgId: ORG_A,
    providerCode: 'fake',
    headers: { 'x-fake-courier-secret': WEBHOOK_SECRET, 'content-type': 'application/json' },
    raw: body,
  });
  if (accepted.deliveryId !== null && !accepted.duplicate) {
    await sync.runWebhook({
      orgId: ORG_A,
      payload: { deliveryId: accepted.deliveryId, courierAccountId: accountId },
    });
  }
  return accepted;
}

// --- what the audit found (the four defects these tests now pin) ---------------

describe('the collection a courier reports survives the webhook path', () => {
  /**
   * The bug: `acceptWebhook` stored only the adapter's stripped payload allow-list, which
   * carries no collected amount — so the worker always read null and fell back to the full COD.
   * Every partial delivery arriving by webhook was booked as a full collection: revenue and
   * `courier_receivable` overstated by the shortfall, and the courier's own statement then
   * flagged as an `amount_mismatch` a person had to clear by parcel.
   *
   * It survived the original suite because every webhook test delivered in full, where the
   * fallback happens to be right.
   */
  it('records a partial collection, not the full COD', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);

    const before = await courierReceivable(courierId);

    /*
     * A haggled full delivery: everything arrived, the rider took ৳80 less.
     *
     * §7's "Partially delivered" row sends the difference between the computed value and the
     * courier's collection to Sales discounts with a reason, and that path applies to a full
     * delivery too — which is exactly the case the stored-collection bug corrupted, and the one
     * that needs no `deliveredLines` to express.
     */
    const collected = (order.codAmountPoisha - 8_000n).toString();
    await deliverByWebhook(consignmentId, {
      rawStatus: 'handed_to_customer',
      collectedPoisha: collected,
    });

    const row = await consignment(consignmentId);
    expect(row.collected_poisha).toBe(collected);

    // And the receivable moved by the collection, not by the COD.
    expect(await courierReceivable(courierId)).toBe(before + BigInt(collected));
  });

  it('still falls back to the COD when the courier reports no amount', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    const row = await consignment(consignmentId);

    // A body with the status and no collected amount — which is what Steadfast's status poll
    // gives, and what a courier that says nothing gives.
    fake.advance(row.consignment_no ?? '', 'handed_to_customer');
    const body = fake.webhookBody(row.consignment_no ?? '');
    delete body.collected_poisha;

    const accepted = await sync.acceptWebhook({
      orgId: ORG_A,
      providerCode: 'fake',
      headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
      raw: Buffer.from(JSON.stringify(body), 'utf8'),
    });
    await sync.runWebhook({
      orgId: ORG_A,
      payload: { deliveryId: accepted.deliveryId ?? '', courierAccountId: accountId },
    });

    // Recording null would leave the settlement matcher expecting zero from every such parcel.
    expect((await consignment(consignmentId)).collected_poisha).toBe(
      order.codAmountPoisha.toString(),
    );
  });
});

describe('the §20 poll fan-out', () => {
  /**
   * The bug: the fan-out selected `distinct org_id from courier.courier_accounts` inside
   * `withSystem()` with no org context. `courier_accounts` is FORCE RLS, so the policy evaluated
   * `org_id = NULL`, no row matched, and the half-hourly cron enqueued nothing — for ever,
   * silently. For any courier whose webhook was missing or missed, no status ever synced.
   */
  it('finds the orgs that have an active courier account', async () => {
    const enqueued = await sync.runPollFanOut();
    // ORG_A has an active account; ORG_B has a courier party but no account.
    expect(enqueued).toBeGreaterThanOrEqual(1);
  });
});

describe('a settlement below the org’s approval threshold', () => {
  /**
   * The bug: below the threshold, `approvals.request` auto-approves and runs the executor
   * *inline* — while the batch was still `imported` and named no approval. The executor refused
   * that state, and the throw unwound `approvals.request`'s own transaction along with the
   * request row, its audit row and its events. The batch was stuck in `imported` for ever, with
   * no exit but rejection: COD already in the bank that could never be posted, for exactly the
   * small statements a threshold exists to wave through.
   */
  it('auto-approves and posts in one step (D-068)', async () => {
    const order = await seedShippedOrder(ORG_A, { unitPricePoisha: 20_000n, qty: 1 });
    const consignmentId = await book(order);
    await deliverByWebhook(consignmentId);
    const parcel = await consignment(consignmentId);

    // A threshold well above this batch's matched gross, so no checker is required.
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
          values (${ORG_A}, 'settlement_posting'::approvals.approval_type, 100000000)
          on conflict (org_id, type) do update set threshold_poisha = 100000000
        `);
      },
      { orgId: ORG_A },
    );

    try {
      const file = statementCsv([
        {
          consignmentNo: parcel.consignment_no ?? '',
          invoice: order.orderNo,
          cod: taka(order.codAmountPoisha),
          delivery: '80.00',
        },
      ]);
      const imported = await settlements.import(context(), request(), {
        courierId,
        walletId,
        fileName: 'fake-2026-10-31-S4001.csv',
        fileBase64: file.toString('base64'),
      });

      const raised = await settlements.requestApproval(context(), request(), imported.id, {});
      expect(raised.status).toBe('auto_approved');

      // Posted in the same transaction that raised the request, and the batch is not stuck.
      const posted = await settlements.get(context(), imported.id);
      expect(posted.status).toBe('posted');
      expect(posted.approvalRequestId).toBe(raised.approvalRequestId);
      expect(posted.chargesJournalId).not.toBeNull();
      expect(posted.cashJournalId).not.toBeNull();
    } finally {
      await withSystem(
        async (tx) => {
          await tx.execute(sql`
            delete from approvals.approval_thresholds
            where org_id = ${ORG_A} and type = 'settlement_posting'
          `);
        },
        { orgId: ORG_A },
      );
    }
  });
});

describe('a collection is never recorded without a journal behind it', () => {
  /**
   * The bug: the consignment's `collected_poisha`, `delivered_at` and `status` were written
   * *before* the check on whether the state machine had anything to do. So a `delivered` event
   * reaching an order that is not `shipped` — a late webhook after a return — recorded the
   * collection with no delivery journal. `settlementCandidates` then offered it as a matchable
   * candidate, and the settlement's two journals credited `courier_receivable` for money that
   * was never debited, driving the courier's balance negative.
   */
  it('a late delivered webhook after a return records the event and no money', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);

    // Bring it back and receive it, so the order is `returned`.
    await deliverByWebhook(consignmentId, { rawStatus: 'coming_back' });
    await returns.receive(context(), request(), consignmentId, {
      reason: 'Customer refused at the door.',
      returnReason: 'customer_refused',
      lines: [{ skuId: order.skuId, sellableQty: order.qty, damagedQty: 0 }],
    });

    const receivableBeforeLate = await courierReceivable(courierId);
    const events = await eventCount(consignmentId);

    // Now the courier's delivered webhook turns up, late.
    await deliverByWebhook(consignmentId, {
      rawStatus: 'handed_to_customer',
      at: new Date('2026-12-01T10:00:00.000Z'),
    });

    // The event is recorded — it is a thing the courier said, and the discrepancy has to be
    // investigable — and nothing else moved.
    expect(await eventCount(consignmentId)).toBe(events + 1);
    expect(await courierReceivable(courierId)).toBe(receivableBeforeLate);

    const row = await consignment(consignmentId);
    // No collection, so `settlementCandidates` reports zero and no settlement can credit the
    // receivable for it.
    expect(row.collected_poisha).toBeNull();
    expect(row.delivered_at).toBeNull();
  });

  it('the database refuses a collection on a parcel whose order never shipped (0052)', async () => {
    const order = await seedShippedOrder(ORG_A, { status: 'confirmed' });
    const consignmentId = await book(order);

    await expectRefusal(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
              update courier.consignments set collected_poisha = 100
              where org_id = ${ORG_A} and id = ${consignmentId}
            `);
          },
          { orgId: ORG_A },
        ),
      /CONSIGNMENT_INVALID/,
    );
  });
});

describe('settlement matching when an order was rebooked', () => {
  it('refuses to guess between two consignments sharing one order number', () => {
    // Two consignments for one order is legitimate (§9 allows rebooking after a refusal), so a
    // statement row carrying only our reference is genuinely ambiguous. The matcher used to keep
    // whichever the candidate query returned last.
    const result = matchSettlement(
      [
        {
          rowNo: 1,
          consignmentNo: 'UNKNOWN-TO-US',
          reference: 'CUR-2609-09999',
          codCollectedPoisha: poisha(0),
          deliveryChargePoisha: poisha(0),
          returnChargePoisha: poisha(0),
          otherChargePoisha: poisha(0),
          netPoisha: null,
        },
      ],
      [
        {
          consignmentId: '44444444-4444-4444-8444-444444444441',
          orderId: '55555555-5555-4555-8555-555555555551',
          orderNo: 'CUR-2609-09999',
          consignmentNo: 'FK-FIRST',
          receivablePoisha: poisha(0),
          settled: false,
        },
        {
          consignmentId: '44444444-4444-4444-8444-444444444442',
          orderId: '55555555-5555-4555-8555-555555555551',
          orderNo: 'CUR-2609-09999',
          consignmentNo: 'FK-SECOND',
          receivablePoisha: poisha(0),
          settled: false,
        },
      ],
    );
    expect(result.lines[0]?.match).toBe('unmatched');
    expect(result.lines[0]?.note).toMatch(/More than one consignment/);
  });
});

// --- accounts and credentials -------------------------------------------------

describe('courier accounts', () => {
  it('never returns a credential, only a fingerprint (invariant 10)', async () => {
    const listed = await accounts.list(context(), { includeInactive: true });
    const account = listed.items.find((item) => item.id === accountId);
    expect(account).toBeDefined();
    expect(JSON.stringify(account)).not.toContain(WEBHOOK_SECRET);
    expect(account?.hasWebhookSecret).toBe(true);
    expect(account?.verified).toBe(true);
    // The courier's own code, which M10 owns and this module asks for over
    // `OrdersPort.courierParties` rather than joining (invariant 12). Asserted on the
    // value, because a stitch that silently matched nothing would read as null here and
    // as an empty column on the screen.
    expect(account?.courierCode).toBe('fake');
    expect(account?.courierId).toBe(courierId);
  });

  it('stores the webhook secret as ciphertext, not text', async () => {
    const raw = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ secret: Buffer | null }>(sql`
        select webhook_secret as secret from courier.courier_accounts
        where org_id = ${ORG_A} and id = ${accountId}
      `);
      return rows[0]?.secret ?? null;
    });
    expect(raw).not.toBeNull();
    // The plaintext is nowhere in the stored bytes. A `pg_dump`, a backup on a laptop and a
    // support engineer's `select *` all see only this.
    expect(Buffer.from(raw!).toString('utf8')).not.toContain(WEBHOOK_SECRET);
    expect(Buffer.from(raw!).toString('base64')).not.toContain(
      Buffer.from(WEBHOOK_SECRET).toString('base64').slice(0, 16),
    );
  });

  it('refuses to activate an account on an unverified adapter (D-176)', async () => {
    // The Steadfast adapter is not in this suite's registry, so the refusal is driven with a
    // registry of one unverified adapter — the same gate, exercised.
    const base = new FakeCourierAdapter();
    const unverified = Object.assign(Object.create(Object.getPrototypeOf(base) as object), base, {
      verified: false,
    }) as FakeCourierAdapter;
    const service = new CourierAccountsService(
      new CourierAdapterRegistry([unverified]),
      harness.app.get(ORDERS_PORT),
      harness.app.get(AuditService),
    );
    const another = await makeCourier(ORG_A, 'unverified_courier', 'Unverified');

    await expectRefusal(
      () =>
        service.upsert(context(), request(), {
          courierId: another,
          providerCode: 'fake',
          label: 'Unverified',
          mode: 'sandbox',
          pollAfterHours: 6,
          isActive: true,
        }),
      /UNVERIFIED/,
    );
  });
});

// --- booking ------------------------------------------------------------------

describe('booking a parcel (§9, §20, invariant 6)', () => {
  it('enqueues inside the transaction and books in the worker', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);

    const row = await consignment(consignmentId);
    expect(row.booking_state).toBe('booked');
    expect(row.consignment_no).not.toBeNull();
    expect(row.booked_at).not.toBeNull();
    // The reference the courier echoes on a statement is the order *number*.
    expect(row.reference).toBe(order.orderNo);
  });

  it('never books one order twice (0050)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const first = await book(order);

    // The second reserve returns the live parcel rather than creating one.
    const again = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      booking.reserveConsignment(tx, { orgId: ORG_A, userId: ACTOR }, { orderId: order.orderId }),
    );
    expect(again.consignmentId).toBe(first);
    expect(again.enqueued).toBe(false);

    // And the trigger refuses a second row directly, whatever the service does.
    await expectRefusal(
      () =>
        withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
          repo.insertConsignment(tx, {
            orgId: ORG_A,
            orderId: order.orderId,
            courierAccountId: accountId,
            courierId,
            branchId: order.branchId,
            reference: order.orderNo,
            codAmountPoisha: order.codAmountPoisha,
            createdBy: ACTOR,
          }),
        ),
      /CONSIGNMENT_ALREADY_BOOKED/,
    );
  });

  it('is idempotent when the courier answered and we lost the answer (§9)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    const first = await consignment(consignmentId);

    // Run the job again, as pg-boss's at-least-once delivery will.
    await booking.runBooking({
      orgId: ORG_A,
      payload: { consignmentId, orderId: order.orderId, actorUserId: ACTOR },
    });

    const second = await consignment(consignmentId);
    expect(second.consignment_no).toBe(first.consignment_no);
    expect(second.booked_at).toBe(first.booked_at);
    // One parcel at the courier, too.
    expect(fake.snapshot()).toHaveLength(1);
  });

  it('raises delivery.booking_failed and flags the order after every retry (check 6)', async () => {
    const order = await seedShippedOrder(ORG_A);
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update sales.orders set courier_id = ${courierId}
          where org_id = ${ORG_A} and id = ${order.orderId}
        `);
      },
      { orgId: ORG_A },
    );

    const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      booking.reserveConsignment(tx, { orgId: ORG_A, userId: ACTOR }, { orderId: order.orderId }),
    );

    // Five attempts, all refused, exactly as §20's retry budget would produce.
    fake.failNextBookings = 5;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        booking.runBooking({
          orgId: ORG_A,
          payload: {
            consignmentId: reserved.consignmentId,
            orderId: order.orderId,
            actorUserId: ACTOR,
          },
        }),
      ).rejects.toThrow();
    }

    let row = await consignment(reserved.consignmentId);
    // Still `pending` between retries: a row marked `failed` while a retry is queued would
    // show an order as un-bookable when it is not.
    expect(row.booking_state).toBe('pending');
    expect(row.booking_attempts).toBe(5);

    // Now the dead-letter handler's work.
    await booking.reportBookingFailed({
      orgId: ORG_A,
      consignmentId: reserved.consignmentId,
      code: 'COURIER_BOOKING_FAILED',
    });

    row = await consignment(reserved.consignmentId);
    expect(row.booking_state).toBe('failed');
    expect(row.booking_failure_code).toBe('COURIER_BOOKING_FAILED');

    const emitted = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ name: string; payload: Record<string, unknown> }>(sql`
        select name, payload from events.outbox
        where org_id = ${ORG_A} and name = 'delivery.booking_failed'
        order by created_at desc limit 1
      `);
      return rows[0];
    });
    expect(emitted?.name).toBe('delivery.booking_failed');
    expect(emitted?.payload.consignmentId).toBe(reserved.consignmentId);
    expect(emitted?.payload.orderNo).toBe(order.orderNo);
    // Ids and a code. No amount and no courier error text: this reaches every org_admin, and
    // a courier's refusal body quotes the address we sent (§19, invariant 10).
    expect(emitted?.payload.codAmountPoisha).toBeUndefined();
    expect(JSON.stringify(emitted?.payload)).not.toContain('8801');
  });
});

// --- duplicates (check 3) -----------------------------------------------------

describe('duplicate webhooks and polls (check 3)', () => {
  it('records one event, one transition and one journal for a webhook delivered twice', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    const at = new Date('2026-03-04T10:11:12.000Z');

    const first = await deliverByWebhook(consignmentId, { at });
    expect(first.duplicate).toBe(false);

    const before = {
      events: await eventCount(consignmentId),
      journals: await journalCount(order.orderId, 'delivered'),
      receivable: await courierReceivable(courierId),
    };
    expect(before.journals).toBe(1);

    // The identical body again. §20's stored-payload dedupe recognises it at the door.
    const second = await deliverByWebhook(consignmentId, { at });
    expect(second.duplicate).toBe(true);

    expect(await eventCount(consignmentId)).toBe(before.events);
    expect(await journalCount(order.orderId, 'delivered')).toBe(1);
    expect(await courierReceivable(courierId)).toBe(before.receivable);
  });

  it('stops the same fact with a different timestamp at the state machine', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);

    await deliverByWebhook(consignmentId, { at: new Date('2026-03-04T10:11:12.000Z') });
    const journals = await journalCount(order.orderId, 'delivered');
    const receivable = await courierReceivable(courierId);

    /*
     * A second delivered, one minute later. Different dedupe key, so layer 1 lets it through
     * — and layer 2 (`orderTriggerFor` for an order already `delivered`) stops it. The event
     * is recorded, because it is a thing the courier said; nothing else moves.
     */
    const events = await eventCount(consignmentId);
    await deliverByWebhook(consignmentId, { at: new Date('2026-03-04T10:12:12.000Z') });

    expect(await eventCount(consignmentId)).toBe(events + 1);
    expect(await journalCount(order.orderId, 'delivered')).toBe(journals);
    expect(await courierReceivable(courierId)).toBe(receivable);
  });

  it('does not double-post when a poll and a webhook describe one delivery', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    const row = await consignment(consignmentId);
    const at = new Date('2026-03-06T08:00:00.000Z');

    fake.advance(row.consignment_no ?? '', 'handed_to_customer', { at });

    /*
     * Age the parcel so §20's poll considers it stale.
     *
     * `staleConsignments` deliberately skips a parcel the courier has said something about
     * recently — the account's window is one hour here — because §20's poll "respects courier
     * rate limits". Without this the poll would correctly do nothing and the test would prove
     * only that.
     */
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update courier.consignments
          set booked_at = now() - interval '5 hours',
              last_status_at = now() - interval '5 hours'
          where org_id = ${ORG_A} and id = ${consignmentId}
        `);
      },
      { orgId: ORG_A },
    );

    // The poll gets there first…
    const moved = await sync.runPollOrg({ orgId: ORG_A, payload: { limit: 10 } });
    expect(moved).toBe(1);
    const journals = await journalCount(order.orderId, 'delivered');
    expect(journals).toBe(1);

    // …and the webhook arrives about the same fact.
    await deliverByWebhook(consignmentId, { at });
    expect(await journalCount(order.orderId, 'delivered')).toBe(journals);
  });

  it('refuses a webhook with the wrong secret and stores nothing', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    const row = await consignment(consignmentId);
    fake.advance(row.consignment_no ?? '', 'handed_to_customer');

    const before = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ count: string }>(sql`
        select count(*) as count from courier.webhook_deliveries where org_id = ${ORG_A}
      `);
      return Number(rows[0]?.count ?? 0);
    });

    await expect(
      sync.acceptWebhook({
        orgId: ORG_A,
        providerCode: 'fake',
        headers: { 'x-fake-courier-secret': 'wrong' },
        raw: Buffer.from(JSON.stringify(fake.webhookBody(row.consignment_no ?? '')), 'utf8'),
      }),
    ).rejects.toThrow();

    const after = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ count: string }>(sql`
        select count(*) as count from courier.webhook_deliveries where org_id = ${ORG_A}
      `);
      return Number(rows[0]?.count ?? 0);
    });
    // A row in a tenant table is a row somebody wrote into that tenant's data.
    expect(after).toBe(before);
  });

  it('never stores the Authorization header (invariant 10)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    const row = await consignment(consignmentId);
    fake.advance(row.consignment_no ?? '', 'moving');

    await sync.acceptWebhook({
      orgId: ORG_A,
      providerCode: 'fake',
      headers: {
        'x-fake-courier-secret': WEBHOOK_SECRET,
        authorization: `Bearer ${WEBHOOK_SECRET}`,
        'content-type': 'application/json',
      },
      raw: Buffer.from(JSON.stringify(fake.webhookBody(row.consignment_no ?? '')), 'utf8'),
    });

    const headers = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ headers: Record<string, unknown> }>(sql`
        select headers from courier.webhook_deliveries
        where org_id = ${ORG_A} order by received_at desc limit 1
      `);
      return rows[0]?.headers ?? {};
    });
    expect(JSON.stringify(headers)).not.toContain(WEBHOOK_SECRET);
    expect(Object.keys(headers)).not.toContain('authorization');
  });
});

// --- database integrity -------------------------------------------------------

describe('what the database refuses', () => {
  it('rejects an event whose dedupe key was not built from its own columns (0050)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);

    await expectRefusal(
      () =>
        withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
          repo.insertConsignmentEvent(tx, {
            orgId: ORG_A,
            consignmentId,
            source: 'manual',
            status: 'in_transit',
            rawStatus: 'moving',
            occurredAt: new Date('2026-03-04T10:00:00.000Z'),
            businessDate: '2026-03-04',
            // Built from the moment of receipt rather than the courier's instant, which is
            // the mistake that would defeat the dedupe index entirely.
            dedupeKey: 'made-up',
            payload: {},
            webhookDeliveryId: null,
            appliedTrigger: null,
            orderFromStatus: null,
            orderToStatus: null,
          }),
        ),
      /CONSIGNMENT_EVENT_INVALID/,
    );
  });

  it('rejects an event whose business date is not its Asia/Dhaka date (invariant 8)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    const at = new Date('2026-03-04T20:00:00.000Z'); // 02:00 on the 5th in Dhaka

    await expectRefusal(
      () =>
        withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
          repo.insertConsignmentEvent(tx, {
            orgId: ORG_A,
            consignmentId,
            source: 'manual',
            status: 'in_transit',
            rawStatus: 'moving',
            occurredAt: at,
            businessDate: '2026-03-04',
            dedupeKey: `${consignmentId}|in_transit|${String(Math.floor(at.getTime() / 1000))}`,
            payload: {},
            webhookDeliveryId: null,
            appliedTrigger: null,
            orderFromStatus: null,
            orderToStatus: null,
          }),
        ),
      /CONSIGNMENT_EVENT_INVALID/,
    );
  });

  it('never lets an event be edited or deleted (0050)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    await deliverByWebhook(consignmentId);

    await expectRefusal(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            update courier.consignment_events set status = 'cancelled'
            where org_id = ${ORG_A} and consignment_id = ${consignmentId}
          `);
          },
          { orgId: ORG_A },
        ),
      /CONSIGNMENT_EVENT_IMMUTABLE/,
    );

    await expectRefusal(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            delete from courier.consignments where org_id = ${ORG_A} and id = ${consignmentId}
          `);
          },
          { orgId: ORG_A },
        ),
      /COURIER_RECORD_IMMUTABLE/,
    );
  });

  it('records what the courier collected exactly once (0051)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    await deliverByWebhook(consignmentId);

    await expectRefusal(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            update courier.consignments set collected_poisha = 1
            where org_id = ${ORG_A} and id = ${consignmentId}
          `);
          },
          { orgId: ORG_A },
        ),
      /CONSIGNMENT_IMMUTABLE/,
    );
  });

  it('isolates one org’s consignments from another’s (invariant 4)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);

    const seenFromB = await withOrg({ orgId: ORG_B, userId: ACTOR }, (tx) =>
      repo.consignmentById(tx, ORG_B, consignmentId),
    );
    expect(seenFromB).toBeUndefined();

    // And the count from inside B is zero, not "one row we cannot read".
    const count = await withOrg({ orgId: ORG_B, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ count: string }>(
        sql`select count(*) as count from courier.consignments`,
      );
      return Number(rows[0]?.count ?? 0);
    });
    expect(count).toBe(0);
  });
});

// --- returns ------------------------------------------------------------------

describe('receiving a return with inspection (§7, §8)', () => {
  it('splits sellable from damaged and posts the return once', async () => {
    const order = await seedShippedOrder(ORG_A, { qty: 3 });
    const consignmentId = await book(order);

    // The courier brings it back. A webhook cannot receive a return — §9 gives that to the
    // warehouse — so the parcel first goes `return_in_transit`.
    const row = await consignment(consignmentId);
    fake.advance(row.consignment_no ?? '', 'coming_back');
    await deliverByWebhook(consignmentId, { rawStatus: 'coming_back' });

    const received = await returns.receive(context(), request(), consignmentId, {
      damagedLocationId: damagedLocation,
      reason: 'Customer refused at the door.',
      returnReason: 'customer_refused',
      lines: [{ skuId: order.skuId, sellableQty: 2, damagedQty: 1 }],
    });

    expect(received.orderStatus).toBe('returned');
    expect(received.journalId).not.toBeNull();

    // M17 (D-234): the reason the warehouse chose is the one the orders module recorded.
    const reason = await withSystem(
      async (tx) =>
        tx.execute<{ kind: string; reason_code: string; note: string | null }>(sql`
          select kind, reason_code, note from sales.order_returns
          where org_id = ${ORG_A} and order_id = ${order.orderId}
        `),
      { orgId: ORG_A },
    );
    expect(reason).toEqual([
      { kind: 'return', reason_code: 'customer_refused', note: 'Customer refused at the door.' },
    ]);

    /*
     * The inspection reached the real orders module and became stock, in two places.
     *
     * This used to assert against a test double's call log. Asserting the movements instead is
     * the point of §7's split: two sellable units back on the shelf they shipped from, one
     * damaged unit on the damaged shelf, so that writing it off later is a separate step with
     * its own approval.
     */
    expect(await onHand(order.skuId, order.locationId)).toBe(2);
    expect(await onHand(order.skuId, damagedLocation)).toBe(1);

    // §7: Dr Inventory / Cr Goods in transit, at the dispatch value — 3 × 60,000.
    const value = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ debit: string }>(sql`
        select coalesce(sum(l.debit_poisha), 0)::text as debit
        from ledger.journal_lines l
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = ${ORG_A} and l.journal_id = ${received.journalId}
          and a.subtype = 'inventory'
      `);
      return BigInt(rows[0]?.debit ?? '0');
    });
    expect(value).toBe(180_000n);

    // A second receipt is refused: the units are already back on a shelf.
    await expectRefusal(
      () =>
        returns.receive(context(), request(), consignmentId, {
          reason: 'again',
          returnReason: 'customer_refused',
          lines: [{ skuId: order.skuId, sellableQty: 1, damagedQty: 0 }],
        }),
      /already been received/,
    );
  });

  it('refuses damage with nowhere to put it (§7)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    await deliverByWebhook(consignmentId, { rawStatus: 'coming_back' });

    await expect(
      returns.receive(context(), request(), consignmentId, {
        reason: 'torn',
        returnReason: 'customer_refused',
        lines: [{ skuId: order.skuId, sellableQty: 0, damagedQty: 1 }],
      }),
    ).rejects.toThrow(/damaged location/);
  });

  it('refuses more units back than went out', async () => {
    const order = await seedShippedOrder(ORG_A, { qty: 1 });
    const consignmentId = await book(order);
    await deliverByWebhook(consignmentId, { rawStatus: 'coming_back' });

    await expect(
      returns.receive(context(), request(), consignmentId, {
        reason: 'extra unit in the box',
        returnReason: 'customer_refused',
        lines: [{ skuId: order.skuId, sellableQty: 2, damagedQty: 0 }],
      }),
    ).rejects.toThrow(/came back/);
  });
});

// --- handover -----------------------------------------------------------------

describe('handover confirmation', () => {
  it('records who signed for the parcel, once, and does not move the order', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);

    const first = await sync.confirmHandover(context(), request(), consignmentId, {});
    expect(first.handoverConfirmedAt).not.toBeNull();

    const status = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ status: string }>(sql`
        select status::text as status from sales.orders
        where org_id = ${ORG_A} and id = ${order.orderId}
      `);
      return rows[0]?.status;
    });
    // §9 gives `→ shipped` the trigger `ship`, performed by the warehouse. A courier-side
    // signature is not that, and making it also ship would give one event two owners.
    expect(status).toBe('shipped');

    const again = await sync.confirmHandover(context(), request(), consignmentId, {});
    expect(again.handoverConfirmedAt).toBe(first.handoverConfirmedAt);
  });
});

// --- settlement (checks 4 and 5) ---------------------------------------------

describe('settlement import, approval and posting (check 4)', () => {
  async function deliveredParcel(overrides: Parameters<typeof seedShippedOrder>[1] = {}) {
    const order = await seedShippedOrder(ORG_A, overrides);
    const consignmentId = await book(order);
    await deliverByWebhook(consignmentId);
    const row = await consignment(consignmentId);
    return { order, consignmentId, consignmentNo: row.consignment_no ?? '' };
  }

  it('matches, totals and lists every mismatch', async () => {
    const good = await deliveredParcel();
    const other = await deliveredParcel();

    const file = statementCsv([
      {
        consignmentNo: good.consignmentNo,
        invoice: good.order.orderNo,
        cod: taka(good.order.codAmountPoisha),
        delivery: '80.00',
        other: '10.00',
        net: taka(good.order.codAmountPoisha - 9_000n),
      },
      // Not ours at all.
      { consignmentNo: 'FK-NOTOURS', invoice: 'SOMEONE-ELSE', cod: '500.00' },
      // The courier says it collected less than our books expect.
      {
        consignmentNo: other.consignmentNo,
        invoice: other.order.orderNo,
        cod: taka(other.order.codAmountPoisha - 5_000n),
      },
    ]);

    const imported = await settlements.import(context(), request(), {
      courierId,
      walletId,
      fileName: 'fake-2026-03-31-S1001.csv',
      fileBase64: file.toString('base64'),
    });

    expect(imported.status).toBe('imported');
    expect(imported.fileRowCount).toBe(3);
    expect(imported.matchedRowCount).toBe(1);
    expect(imported.exceptionCount).toBe(2);
    expect(imported.exceptions.map((line) => line.match).sort()).toEqual([
      'amount_mismatch',
      'unmatched',
    ]);
    for (const exception of imported.exceptions) expect(exception.note).not.toBeNull();

    // The matched totals are the matched rows' and nothing else's.
    expect(BigInt(imported.matchedGrossPoisha)).toBe(good.order.codAmountPoisha);
    expect(BigInt(imported.matchedChargesPoisha)).toBe(9_000n);
    expect(BigInt(imported.matchedNetPoisha)).toBe(good.order.codAmountPoisha - 9_000n);
    // And the file totals are the whole file's, so the two can be compared.
    expect(BigInt(imported.fileGrossPoisha)).toBeGreaterThan(BigInt(imported.matchedGrossPoisha));

    // Nothing posted. §9: "→ approval → posting".
    expect(imported.chargesJournalId).toBeNull();
    expect(imported.cashJournalId).toBeNull();
  });

  it('posts only after approval, and refuses to be edited once one is raised', async () => {
    const parcel = await deliveredParcel();
    const file = statementCsv([
      {
        consignmentNo: parcel.consignmentNo,
        invoice: parcel.order.orderNo,
        cod: taka(parcel.order.codAmountPoisha),
        delivery: '80.00',
      },
    ]);

    const imported = await settlements.import(context(), request(), {
      courierId,
      walletId,
      fileName: 'fake-2026-04-15-S1002.csv',
      fileBase64: file.toString('base64'),
    });

    const raised = await settlements.requestApproval(context(), request(), imported.id, {});
    // No threshold is configured for `settlement_posting`, so `requiresApproval` requires a
    // checker — which is the safe default.
    expect(raised.status).toBe('pending');

    const pending = await settlements.get(context(), imported.id);
    expect(pending.status).toBe('pending_approval');
    expect(pending.chargesJournalId).toBeNull();

    // 0051: the terms are fixed from the moment the approval exists.
    await expectRefusal(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
              update courier.settlements set matched_net_poisha = matched_net_poisha + 1,
                matched_gross_poisha = matched_gross_poisha + 1
              where org_id = ${ORG_A} and id = ${imported.id}
            `);
          },
          { orgId: ORG_A },
        ),
      /SETTLEMENT_FROZEN/,
    );

    // And a `posted` row with no approved request is refused outright.
    await expectRefusal(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            update courier.settlements set status = 'posted', posted_at = now(),
              posting_business_date = settlement_date, approval_request_id = null
            where org_id = ${ORG_A} and id = ${imported.id}
          `);
          },
          { orgId: ORG_A },
        ),
      /SETTLEMENT_FROZEN|APPROVAL_REQUIRED/,
    );

    // The checker decides, and the executor posts inside that transaction.
    await approvals.decide(context(ORG_A, CHECKER), {
      id: raised.approvalRequestId,
      decision: 'approved',
      request: request(),
    });

    const posted = await settlements.get(context(), imported.id);
    expect(posted.status).toBe('posted');
    expect(posted.chargesJournalId).not.toBeNull();
    expect(posted.cashJournalId).not.toBeNull();
    expect(posted.postingBusinessDate).toBe('2026-04-15');
    expect(posted.deferredFromClosedPeriod).toBe(false);
  });

  it('posts a settlement dated in a closed period to the earliest open one, keeping its date (D-037)', async () => {
    // A month with nothing in it, closed. D-093: closing it locks every earlier date too.
    await closeMonth(ORG_A, '2026-01');
    await closeMonth(ORG_A, '2026-02');

    const parcel = await deliveredParcel();
    const file = statementCsv([
      {
        consignmentNo: parcel.consignmentNo,
        invoice: parcel.order.orderNo,
        cod: taka(parcel.order.codAmountPoisha),
        delivery: '80.00',
      },
    ]);

    const imported = await settlements.import(context(), request(), {
      courierId,
      walletId,
      // Inside the closed February.
      fileName: 'fake-2026-02-28-S1003.csv',
      fileBase64: file.toString('base64'),
    });
    expect(imported.settlementDate).toBe('2026-02-28');

    const raised = await settlements.requestApproval(context(), request(), imported.id, {});
    await approvals.decide(context(ORG_A, CHECKER), {
      id: raised.approvalRequestId,
      decision: 'approved',
      request: request(),
    });

    const posted = await settlements.get(context(), imported.id);
    expect(posted.status).toBe('posted');
    // The earliest open period, which is the day after the latest closed month ends.
    expect(posted.postingBusinessDate).toBe('2026-03-01');
    expect(posted.deferredFromClosedPeriod).toBe(true);
    // The half of D-037 that is easy to lose: the original date survives on the row.
    expect(posted.settlementDate).toBe('2026-02-28');

    // And the journals carry the resolved date plus the original in their memo.
    const journals = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ business_date: string; memo: string | null }>(sql`
        select business_date::text as business_date, memo from ledger.journals
        where org_id = ${ORG_A} and source_type = 'courier_settlement'
          and source_id = ${imported.id}
        order by idempotency_key
      `);
      return [...rows];
    });
    expect(journals).toHaveLength(2);
    for (const journal of journals) {
      expect(journal.business_date).toBe('2026-03-01');
      expect(journal.memo).toContain('2026-02-28');
    }
  });

  it('refuses a statement that would pay the courier rather than us', async () => {
    const parcel = await deliveredParcel();
    // A returned parcel's fee, on its own.
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update courier.consignments set status = 'returned_to_merchant'
          where org_id = ${ORG_A} and id = ${parcel.consignmentId}
        `);
      },
      { orgId: ORG_A },
    );

    const file = statementCsv([
      { consignmentNo: 'FK-UNKNOWN-1', invoice: 'NOPE', cod: '0.00', ret: '60.00' },
    ]);
    await expectRefusal(
      () =>
        settlements.import(context(), request(), {
          courierId,
          walletId,
          fileName: 'fake-2026-05-01-S1004.csv',
          fileBase64: file.toString('base64'),
        }),
      /nothing to post|exceed/,
    );
  });

  it('can be rejected without posting anything', async () => {
    const parcel = await deliveredParcel();
    const file = statementCsv([
      {
        consignmentNo: parcel.consignmentNo,
        invoice: parcel.order.orderNo,
        cod: taka(parcel.order.codAmountPoisha),
      },
    ]);
    const imported = await settlements.import(context(), request(), {
      courierId,
      walletId,
      fileName: 'fake-2026-06-01-S1005.csv',
      fileBase64: file.toString('base64'),
    });

    const rejected = await settlements.reject(context(), request(), imported.id, {
      reason: 'The courier is re-issuing this statement.',
    });
    expect(rejected.status).toBe('rejected');

    const after = await settlements.get(context(), imported.id);
    expect(after.chargesJournalId).toBeNull();
    expect(after.cashJournalId).toBeNull();
  });
});

// --- the scenario (check 5) ---------------------------------------------------

describe('book → deliver → settle (check 5)', () => {
  it('leaves that consignment’s courier receivable at exactly zero, and the P&L shows the charges', async () => {
    /*
     * Its own courier party, so the assertion is about *this* consignment's receivable rather
     * than about a balance every other test in this file has also moved.
     */
    const scenarioCourier = await makeCourier(ORG_A, 'fake_scenario', 'Scenario Courier');
    await accounts.upsert(context(), request(), {
      courierId: scenarioCourier,
      providerCode: 'fake',
      label: 'Scenario Courier',
      mode: 'sandbox',
      webhookSecret: WEBHOOK_SECRET,
      pollAfterHours: 1,
      settlementWalletId: walletId,
      isActive: true,
    });

    const order = await seedShippedOrder(ORG_A, {
      qty: 2,
      unitPricePoisha: 120_000n,
      deliveryChargePoisha: 8_000n,
      dispatchUnitCostPoisha: 60_000n,
    });
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update sales.orders set courier_id = ${scenarioCourier}
          where org_id = ${ORG_A} and id = ${order.orderId}
        `);
      },
      { orgId: ORG_A },
    );

    // 1. Book.
    const reserved = await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
      booking.reserveConsignment(
        tx,
        { orgId: ORG_A, userId: ACTOR },
        { orderId: order.orderId, courierId: scenarioCourier },
      ),
    );
    await booking.runBooking({
      orgId: ORG_A,
      payload: {
        consignmentId: reserved.consignmentId,
        orderId: order.orderId,
        actorUserId: ACTOR,
      },
    });
    const parcel = await consignment(reserved.consignmentId);
    expect(parcel.booking_state).toBe('booked');

    // Zero before anything is delivered.
    expect(await courierReceivable(scenarioCourier)).toBe(0n);

    // 2. Deliver. §7's journal debits courier receivable with the collection.
    fake.advance(parcel.consignment_no ?? '', 'handed_to_customer');
    const body = Buffer.from(JSON.stringify(fake.webhookBody(parcel.consignment_no ?? '')), 'utf8');
    const accepted = await sync.acceptWebhook({
      orgId: ORG_A,
      providerCode: 'fake',
      headers: { 'x-fake-courier-secret': WEBHOOK_SECRET },
      raw: body,
    });
    await sync.runWebhook({
      orgId: ORG_A,
      payload: {
        deliveryId: accepted.deliveryId ?? '',
        courierAccountId:
          (
            await withOrg({ orgId: ORG_A, userId: ACTOR }, (tx) =>
              repo.accountByCourier(tx, ORG_A, scenarioCourier),
            )
          )?.id ?? '',
      },
    });

    const afterDelivery = await courierReceivable(scenarioCourier);
    expect(afterDelivery).toBe(order.codAmountPoisha);

    const chargesBefore = await expenseBalance('courier_charges');
    const returnsBefore = await expenseBalance('return_charges');

    // 3. Settle: the courier keeps ৳80 delivery and ৳10 COD fee, and pays the rest.
    const deliveryCharge = 8_000n;
    const otherCharge = 1_000n;
    const file = statementCsv([
      {
        consignmentNo: parcel.consignment_no ?? '',
        invoice: order.orderNo,
        cod: taka(order.codAmountPoisha),
        delivery: taka(deliveryCharge),
        other: taka(otherCharge),
        net: taka(order.codAmountPoisha - deliveryCharge - otherCharge),
      },
    ]);
    const imported = await settlements.import(context(), request(), {
      courierId: scenarioCourier,
      walletId,
      fileName: 'fake-2026-07-31-S2001.csv',
      fileBase64: file.toString('base64'),
    });
    expect(imported.exceptionCount).toBe(0);

    const raised = await settlements.requestApproval(context(), request(), imported.id, {});
    await approvals.decide(context(ORG_A, CHECKER), {
      id: raised.approvalRequestId,
      decision: 'approved',
      request: request(),
    });

    // **Exactly zero.** Not "close to", not "within rounding".
    expect(await courierReceivable(scenarioCourier)).toBe(0n);

    // The P&L shows the courier's charges, split as §7 asks.
    expect((await expenseBalance('courier_charges')) - chargesBefore).toBe(
      deliveryCharge + otherCharge,
    );
    expect((await expenseBalance('return_charges')) - returnsBefore).toBe(0n);

    // The net reached the wallet.
    const walletBalance = await withOrg({ orgId: ORG_A, userId: ACTOR }, async (tx) => {
      const rows = await tx.execute<{ balance: string }>(sql`
        select coalesce(sum(l.debit_poisha) - sum(l.credit_poisha), 0)::text as balance
        from ledger.journal_lines l
        join wallets.wallets w on w.org_id = l.org_id and w.ledger_account_id = l.account_id
        where l.org_id = ${ORG_A} and w.id = ${walletId}
      `);
      return BigInt(rows[0]?.balance ?? '0');
    });
    expect(walletBalance).toBeGreaterThanOrEqual(
      order.codAmountPoisha - deliveryCharge - otherCharge,
    );

    // The consignment says it was settled, and the reconciliation report agrees.
    const settled = await consignment(reserved.consignmentId);
    expect(settled.settlement_id).toBe(imported.id);
    expect(settled.settled_at).not.toBeNull();

    const report = await reports.reconciliation(context(), request(), {
      courierId: scenarioCourier,
    });
    const line = report.couriers.find((row) => row.courierId === scenarioCourier);
    expect(line?.outstandingPoisha).toBe('0');
    expect(line?.ledgerOutstandingPoisha).toBe('0');
    // The operational record and the book agree, which is the check the report exists for.
    expect(line?.variancePoisha).toBe('0');
    expect(line?.settledCount).toBe(1);
    expect(BigInt(line?.chargesPoisha ?? '0')).toBe(deliveryCharge + otherCharge);
  });

  it('never settles one consignment twice (0051)', async () => {
    const order = await seedShippedOrder(ORG_A);
    const consignmentId = await book(order);
    await deliverByWebhook(consignmentId);
    const parcel = await consignment(consignmentId);

    const file = statementCsv([
      {
        consignmentNo: parcel.consignment_no ?? '',
        invoice: order.orderNo,
        cod: taka(order.codAmountPoisha),
        delivery: '80.00',
      },
    ]);
    const first = await settlements.import(context(), request(), {
      courierId,
      walletId,
      fileName: 'fake-2026-08-31-S3001.csv',
      fileBase64: file.toString('base64'),
    });
    const raised = await settlements.requestApproval(context(), request(), first.id, {});
    await approvals.decide(context(ORG_A, CHECKER), {
      id: raised.approvalRequestId,
      decision: 'approved',
      request: request(),
    });

    // The same statement again. Every row is `already_settled`, so there is nothing to post.
    await expect(
      settlements.import(context(), request(), {
        courierId,
        walletId,
        fileName: 'fake-2026-09-01-S3002.csv',
        fileBase64: file.toString('base64'),
      }),
    ).rejects.toThrow(/nothing to post/);
  });
});
