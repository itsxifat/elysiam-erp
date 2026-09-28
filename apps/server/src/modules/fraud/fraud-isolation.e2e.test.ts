import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asRole,
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { FraudModule } from './fraud.module.js';
import { FraudService } from './fraud.service.js';
import { applyFraudMigrations, TEST_HASH_KEY } from './fraud.testing.js';
import { PhoneHashService } from './phone-hash.js';

/**
 * M13 check 2: "returns in org A lower the trust score in org B, and org B sees counts
 * only: no org A order data (API test)."
 *
 * Written adversarially rather than as a happy path, because the happy path is the easy
 * half. The interesting question is not "does org B see a lower score" — that is one
 * assertion — it is "can org B see *anything* of org A's". So this suite:
 *
 * 1. makes org A's returns real, through the module's own maintenance path;
 * 2. asserts org B's score drops and its counts match;
 * 3. then takes org B's entire response body, walks every string in it, and fails on any
 *    org A identifier at all — the org id, the order id, the customer name, the amount,
 *    the phone number and the phone *hash*.
 *
 * That last one is the point of the design. A comment saying "the response contains no
 * order data" is not a control; a test that searches the serialised body for every value
 * org A wrote is, and it keeps working when somebody later adds a field to the badge.
 */

let harness: HttpHarness;

/** Org A's private facts. None of these may appear in anything org B receives. */
const ORG_A_SECRETS = {
  orderId: randomUUID(),
  orderNo: 'ELY-2603-0417',
  customerName: 'Rehana Chowdhury',
  addressLine: 'House 41, Road 7, Dhanmondi',
  codAmountPoisha: '349900',
};

/**
 * The buyer both brands meet. A Grameenphone number, which `normalizeBdPhone` accepts.
 *
 * Fixed rather than random so a failure is reproducible, and it is not a real number:
 * `017` followed by a run of a single digit is not in any operator's issued block, and
 * invariant 10 forbids a real one in a fixture.
 */
const SHARED_PHONE = '01711111111';

beforeAll(async () => {
  // Before the harness builds the module graph: the config provider is a factory that
  // reads the environment at `app.init()`, which is what makes a missing key a boot
  // failure rather than a first-request one.
  process.env.FRAUD_PHONE_HASH_KEY = TEST_HASH_KEY;

  harness = await startHttpHarness('fraud-isolation', { extraModules: [FraudModule] });
  await applyFraudMigrations();
}, 180_000);

afterAll(async () => {
  await harness.close();
});

/** Every string anywhere inside a parsed JSON value, however deeply nested. */
function allStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (typeof value === 'number' || typeof value === 'boolean') into.push(String(value));
  else if (Array.isArray(value)) for (const entry of value) allStrings(entry, into);
  else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      allStrings(entry, into);
    }
  }
  return into;
}

describe('check 2: a return in org A lowers the score in org B, and shows nothing else', () => {
  it('shares the counts and shares nothing that identifies the other brand', async () => {
    const hasher = harness.app.get(PhoneHashService);
    const fraud = harness.app.get(FraudService);
    const phoneHash = hasher.hash(SHARED_PHONE);

    /*
     * Org A's side, built the way production builds it: the confirm guard records which
     * hash the order was assessed against, and then the outcomes move the cross-org
     * counters. Seeding `phone_signals` directly would prove the score arithmetic and
     * nothing about the path, and the path is what check 2 is about.
     */
    await withOrg({ orgId: ORG_A }, async (tx) => {
      await fraud.assessForOrder(tx, {
        orgId: ORG_A,
        orderId: ORG_A_SECRETS.orderId,
        phone: SHARED_PHONE,
      });
      await fraud.applyOutcome(tx, {
        orgId: ORG_A,
        orderId: ORG_A_SECRETS.orderId,
        outcome: 'confirmed',
        at: new Date(),
      });
      await fraud.applyOutcome(tx, {
        orgId: ORG_A,
        orderId: ORG_A_SECRETS.orderId,
        outcome: 'returned',
        at: new Date(),
      });
    });

    // Four more returns, so the ratio has enough volume to bite. Same order id is not
    // possible — one row per order — so these are separate orders of org A's.
    for (let i = 0; i < 4; i += 1) {
      const orderId = randomUUID();
      await withOrg({ orgId: ORG_A }, async (tx) => {
        await fraud.assessForOrder(tx, { orgId: ORG_A, orderId, phone: SHARED_PHONE });
        await fraud.applyOutcome(tx, {
          orgId: ORG_A,
          orderId,
          outcome: 'confirmed',
          at: new Date(),
        });
        await fraud.applyOutcome(tx, {
          orgId: ORG_A,
          orderId,
          outcome: 'returned',
          at: new Date(),
        });
      });
    }

    /*
     * Org A also writes a manual flag with a reason nobody else may read, and rows in its
     * own tenant tables. These exist so the assertions below have something to *find* if
     * the isolation is broken: a test that only checks the cross-org table would pass
     * against a response that leaked the tenant one.
     */
    const adminA = await asRole('org_admin', ORG_A);
    const flagged = await adminA.client.request('POST', '/v1/fraud/flags', {
      body: {
        phone: SHARED_PHONE,
        severity: 1,
        reason: `Refused delivery for ${ORG_A_SECRETS.customerName} at ${ORG_A_SECRETS.addressLine}`,
      },
    });
    expect(flagged.statusCode).toBe(201);

    // Now org B, which has never sold to this number.
    const salesB = await asRole('sales', ORG_B);
    const response = await salesB.client.request(
      'GET',
      `/v1/fraud/check?phone=${encodeURIComponent(SHARED_PHONE)}`,
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;

    // --- the score did travel -------------------------------------------------

    // Five confirmed, five returned, and a flag. Org B sees a buyer it should refuse
    // although it has never sold to them — which is the whole reason this table is shared.
    expect(body.signals).toMatchObject({
      ordersTotal: 5,
      delivered: 0,
      returned: 5,
      cancelled: 0,
      manualFlagCount: 1,
    });
    expect(body.trustScore).toBeLessThan(20);
    expect(body.decision).toBe('block');

    // --- and nothing else did -------------------------------------------------

    // Org B's own flag list is empty: the *fact* of a flag crosses orgs through the
    // aggregate count above, the reason and the author do not.
    expect(body.flags).toEqual([]);

    const serialised = response.body;
    const strings = allStrings(body);

    for (const [label, secret] of Object.entries(ORG_A_SECRETS)) {
      expect(serialised, `org B's response must not contain org A's ${label}`).not.toContain(
        secret,
      );
    }
    expect(serialised, "org B must not learn org A's org id").not.toContain(ORG_A);
    expect(serialised, 'the reason text org A wrote must not cross orgs').not.toContain(
      ORG_A_SECRETS.addressLine,
    );

    /*
     * The phone number and its hash, both excluded.
     *
     * The number is personal data org B did type, so its absence here is about the
     * *response* not echoing it — but the hash is the one that matters: it is a stable
     * identifier for this person across all five brands, so a response carrying it would
     * hand every client a ready-made correlation key and undo the reason for hashing.
     */
    expect(serialised).not.toContain(phoneHash);
    expect(serialised).not.toContain(SHARED_PHONE);
    expect(serialised).not.toContain('+8801711111111');

    // A uuid anywhere in the body would be an id of something, and none of the things a
    // badge is about have ids org B may see. `flags[].id` is org B's own and the list is
    // empty here, which the assertion above already established.
    const uuidLike = strings.filter((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    );
    expect(uuidLike, 'a badge names no rows').toEqual([]);

    // No 64-character hex string of any kind: a stricter version of the hash assertion
    // that also catches a hash the test did not compute, e.g. a provider's own key.
    const hashLike = strings.filter((value) => /^[0-9a-f]{64}$/i.test(value));
    expect(hashLike, 'a badge carries no phone hash').toEqual([]);
  }, 180_000);

  it("keeps org A's flag rows unreadable from org B, in the database as well as the API", async () => {
    // The API assertion above is about what we choose to serialise. This one is about
    // whether the choice is the only thing standing in the way: `fraud.phone_flags` is a
    // tenant table with FORCE RLS, so an org B transaction must see zero of org A's rows
    // even asking for them directly.
    const rows = await withOrg({ orgId: ORG_B }, async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from fraud.phone_flags`),
    );
    expect(Number(rows[0]?.count ?? -1)).toBe(0);

    const asA = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ count: string }>(sql`select count(*) as count from fraud.phone_flags`),
    );
    expect(Number(asA[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('shares the cross-org counters with every org, by design', async () => {
    // The mirror image of the test above, and the reason this schema exists. If this ever
    // fails, the exception has been closed and the milestone's goal has gone with it —
    // which is worth a test of its own rather than being implied by the API one.
    const counts = await Promise.all(
      [ORG_A, ORG_B].map(async (orgId) =>
        withOrg({ orgId }, async (tx) =>
          tx.execute<{ returned: number }>(
            sql`select returned from fraud.phone_signals order by phone_hash limit 1`,
          ),
        ),
      ),
    );

    expect(Number(counts[0]?.[0]?.returned ?? -1)).toBe(5);
    expect(Number(counts[1]?.[0]?.returned ?? -2)).toBe(5);
  });

  it('has no org_id column to filter on, which is what makes the exception narrow', async () => {
    // §5 exception 1 is safe because of the column list, not because of a policy. This is
    // that claim as a test: the two cross-org tables must have no column that names a
    // brand, a buyer, an order or an amount, so there is nowhere for one to be stored
    // even by a future migration that forgets why.
    const columns = await withSystem(async (tx) =>
      tx.execute<{ table_name: string; column_name: string }>(sql`
        select table_name, column_name
        from information_schema.columns
        where table_schema = 'fraud'
          and table_name in ('phone_signals', 'provider_checks')
        order by table_name, ordinal_position
      `),
    );

    const names = [...columns].map((row) => `${row.table_name}.${row.column_name}`);

    expect(names).toEqual([
      'phone_signals.phone_hash',
      'phone_signals.orders_total',
      'phone_signals.delivered',
      'phone_signals.returned',
      'phone_signals.cancelled',
      'phone_signals.last_incident_at',
      'phone_signals.manual_flags',
      'phone_signals.updated_at',
      'provider_checks.phone_hash',
      'provider_checks.provider',
      'provider_checks.total',
      'provider_checks.delivered',
      'provider_checks.returned_or_cancelled',
      'provider_checks.ratio',
      'provider_checks.fetched_at',
      'provider_checks.raw',
    ]);

    for (const name of names) {
      expect(name).not.toMatch(/org_id|order_id|customer|name|address|poisha|user_id|branch/);
    }
  });
});
