import { randomUUID } from 'node:crypto';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OutboxDispatcher, type DeliveredEvent } from '../../platform/events/dispatcher.js';
import { createLogger } from '../../platform/logging/logger.js';
import {
  asRole,
  auditRowsFor,
  expectRefused,
  ORG_A,
  startHttpHarness,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { FraudModule } from './fraud.module.js';
import { FraudService } from './fraud.service.js';
import { applyFraudMigrations, TEST_HASH_KEY } from './fraud.testing.js';
import { outcomeForStatus, subscribeFraudToOrderEvents } from './fraud.subscriber.js';
import { PhoneHashService } from './phone-hash.js';
import { FakeFraudProvider } from './providers/fake.provider.js';
import { ProviderGateway } from './providers/provider-gateway.js';

/**
 * M13 end to end, against real PostgreSQL.
 *
 * Covers check 3 (the provider-unavailable fallback and the desk still working) and check 5
 * (an org_admin override recording its reason in the audit log), plus the maintenance path
 * the cross-org counters depend on and the immutability rules migration 0047 enforces.
 *
 * Check 1 is a pure-function table in `packages/domain/src/fraud/fraud.test.ts`, check 2 is
 * `fraud-isolation.e2e.test.ts`, and check 4 is `fraud-lookup.bench.mjs`.
 */

let harness: HttpHarness;

const BLOCKED_PHONE = '01911111111';
const CLEAN_PHONE = '01811111111';

beforeAll(async () => {
  process.env.FRAUD_PHONE_HASH_KEY = TEST_HASH_KEY;
  harness = await startHttpHarness('fraud-e2e', { extraModules: [FraudModule] });
  await applyFraudMigrations();
}, 180_000);

afterAll(async () => {
  await harness.close();
});

describe('the badge over HTTP', () => {
  it('scores a number nobody has seen at the allow floor, with a no-history reason', async () => {
    const sales = await asRole('sales', ORG_A);
    const response = await sales.client.request(
      'GET',
      `/v1/fraud/check?phone=${encodeURIComponent(CLEAN_PHONE)}`,
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      trustScore: number;
      decision: string;
      reasons: { code: string }[];
      signals: unknown;
      bands: { allowMin: number };
    };

    // Deliberately `allow`, at the floor. Most COD orders in Bangladesh are from a number
    // nobody has seen, and a badge that warns on all of them is one the desk learns to
    // click past.
    expect(body.decision).toBe('allow');
    expect(body.trustScore).toBe(body.bands.allowMin);
    expect(body.reasons.map((reason) => reason.code)).toContain('no_history');
    expect(body.signals).toBeNull();
  });

  it('refuses a number that is not a Bangladeshi mobile', async () => {
    const sales = await asRole('sales', ORG_A);
    // A landline. Valid, and useless for a COD order: no SMS and no courier will take it as
    // a contact, so it must not get a signals row to accumulate nothing in.
    const response = await sales.client.request('GET', '/v1/fraud/check?phone=029611000');
    expect(response.statusCode).toBe(400);
  });

  it('gives sales the badge and refuses them the override ability', async () => {
    // §6's two fraud rows: everyone who works the desk reads the badge, only org_admin makes
    // a standing decision about a buyer.
    const sales = await asRole('sales', ORG_A);

    const read = await sales.client.request('GET', `/v1/fraud/check?phone=${CLEAN_PHONE}`);
    expect(read.statusCode).toBe(200);

    const flag = await sales.client.request('POST', '/v1/fraud/flags', {
      body: { phone: CLEAN_PHONE, severity: 1, reason: 'sales should not be able to do this' },
    });
    expect(flag.statusCode).toBe(403);

    const rules = await sales.client.request('PUT', '/v1/fraud/rules', {
      body: { allowMin: 90, warnMin: 50, requireAdvanceMin: 25 },
    });
    expect(rules.statusCode).toBe(403);
  });

  it('lets an org be stricter than D-011 and applies it to the next badge', async () => {
    const admin = await asRole('org_admin', ORG_A);

    const saved = await admin.client.request('PUT', '/v1/fraud/rules', {
      body: {
        allowMin: 85,
        warnMin: 60,
        requireAdvanceMin: 35,
        providerEnabled: false,
        providerTtlMinutes: 4_320,
      },
    });
    expect(saved.statusCode).toBe(200);

    const badge = await admin.client.request('GET', `/v1/fraud/check?phone=${CLEAN_PHONE}`);
    const body = JSON.parse(badge.body) as { trustScore: number; decision: string };
    // The same 70 as before, now a `warn` — the bands moved, not the evidence.
    expect(body.trustScore).toBe(70);
    expect(body.decision).toBe('warn');

    // Put D-011's defaults back for the rest of the suite.
    await admin.client.request('PUT', '/v1/fraud/rules', {
      body: { allowMin: 70, warnMin: 40, requireAdvanceMin: 20 },
    });
  });

  it('refuses bands that delete a whole band', async () => {
    const admin = await asRole('org_admin', ORG_A);
    const response = await admin.client.request('PUT', '/v1/fraud/rules', {
      body: { allowMin: 70, warnMin: 70, requireAdvanceMin: 20 },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'FRAUD_RULES_INVALID' });
  });
});

describe('check 5: an override needs org_admin and records its reason in the audit log', () => {
  it('blocks a flagged buyer, refuses sales an override, and audits an admin one', async () => {
    const admin = await asRole('org_admin', ORG_A);
    const fraud = harness.app.get(FraudService);
    const hasher = harness.app.get(PhoneHashService);

    // A manual flag, which alone reaches `block` from a neutral start (see the score's
    // constants). Raised through the real route, so the permission is exercised too.
    const flagged = await admin.client.request('POST', '/v1/fraud/flags', {
      body: { phone: BLOCKED_PHONE, severity: 1, reason: 'Refused three parcels at the door' },
    });
    expect(flagged.statusCode).toBe(201);

    const badge = await admin.client.request('GET', `/v1/fraud/check?phone=${BLOCKED_PHONE}`);
    const badgeBody = JSON.parse(badge.body) as { decision: string; trustScore: number };
    expect(badgeBody.decision).toBe('block');

    const orderId = randomUUID();

    // --- no reason: refused --------------------------------------------------

    await expect(
      withOrg({ orgId: ORG_A }, async (tx) =>
        fraud.assertConfirmAllowed(tx, {
          orgId: ORG_A,
          orderId,
          phone: BLOCKED_PHONE,
          actor: {
            roles: ['org_admin'],
            isSuperAdmin: false,
            userId: admin.userId,
            branchIds: [],
            branchIdsByRole: { org_admin: [] },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'ORDER_FRAUD_BLOCKED' });

    // --- a reason from somebody who may not override: refused ----------------

    const agent = await asRole('sales', ORG_A);
    await expect(
      withOrg({ orgId: ORG_A }, async (tx) =>
        fraud.assertConfirmAllowed(tx, {
          orgId: ORG_A,
          orderId,
          phone: BLOCKED_PHONE,
          actor: {
            roles: ['sales'],
            isSuperAdmin: false,
            userId: agent.userId,
            branchIds: [],
            branchIdsByRole: { sales: [] },
          },
          overrideReason: 'the customer promised on the phone',
        }),
      ),
    ).rejects.toMatchObject({ code: 'FRAUD_OVERRIDE_UNAUTHORISED' });

    // No override row from either attempt: the transaction that would have written it threw.
    const none = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ count: string }>(
        sql`select count(*) as count from fraud.overrides where order_id = ${orderId}`,
      ),
    );
    expect(Number(none[0]?.count ?? -1)).toBe(0);

    // --- an org_admin with a reason: allowed, recorded, audited --------------

    const reason = 'Known customer, paid in advance by bKash; approved by the brand owner.';
    const decision = await withOrg({ orgId: ORG_A }, async (tx) =>
      fraud.assertConfirmAllowed(tx, {
        orgId: ORG_A,
        orderId,
        phone: BLOCKED_PHONE,
        actor: {
          roles: ['org_admin'],
          isSuperAdmin: false,
          userId: admin.userId,
          branchIds: [],
          branchIdsByRole: { org_admin: [] },
        },
        overrideReason: reason,
      }),
    );

    expect(decision.overridden).toBe(true);
    expect(decision.decision).toBe('block');
    expect(decision.overrideId).not.toBeNull();

    // The override row, with the score frozen as it stood.
    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ reason: string; decided_by: string; trust_score: number; phone_hash: string }>(
        sql`select reason, decided_by, trust_score, phone_hash from fraud.overrides where order_id = ${orderId}`,
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe(reason);
    expect(rows[0]?.decided_by).toBe(admin.userId);
    expect(Number(rows[0]?.trust_score)).toBe(badgeBody.trustScore);
    expect(rows[0]?.phone_hash).toBe(hasher.hash(BLOCKED_PHONE));

    // The audit entry, which is the half check 5 actually names.
    const audited = await auditRowsFor(ORG_A, decision.overrideId ?? '');
    const entry = audited.find((row) => row.action === 'fraud.override_granted');
    expect(entry, 'an override must leave an audit row').toBeDefined();
    expect(entry?.operation).toBe('approve');
    expect(JSON.stringify(entry?.after)).toContain(reason);

    /*
     * And the audit row carries no phone number and no hash. `AuditService.record` redacts
     * what it is handed, but the right amount of personal data in an append-only table that
     * anyone with `read AuditLog` can read is none — and a hash there would be a
     * cross-brand correlation key in the one table nobody can delete from.
     */
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain(hasher.hash(BLOCKED_PHONE));
    expect(serialised).not.toContain(BLOCKED_PHONE);
  }, 180_000);

  it('refuses to alter an override afterwards, even as the owner', async () => {
    // The grant is the control for the application role; this is the trigger in 0047, which
    // also binds `erp_owner` — the role a data-fix script runs as. "Who approved selling to
    // this blocked buyer" has to answer the same way in a year.
    await expectRefused(
      withSystem(
        async (tx) => tx.execute(sql`update fraud.overrides set reason = 'something else'`),
        // In the org's context: the table has FORCE RLS, so an uncontexted owner
        // transaction sees no rows and updates nothing — which would pass this test for
        // the wrong reason.
        { orgId: ORG_A },
      ),
      /FRAUD_OVERRIDE_IMMUTABLE/,
    );
    await expectRefused(
      withSystem(async (tx) => tx.execute(sql`delete from fraud.overrides`), { orgId: ORG_A }),
      /FRAUD_OVERRIDE_IMMUTABLE/,
    );
  });

  it('refuses to move a phone signal row onto another hash', async () => {
    // The one unrecoverable corruption in this schema: the cross-org counters have no
    // per-org copy to rebuild from, and the input cannot be recovered to tell which of two
    // plausible rows was right.
    await expectRefused(
      withSystem(async (tx) =>
        tx.execute(sql`update fraud.phone_signals set phone_hash = ${'f'.repeat(64)}`),
      ),
      /FRAUD_SIGNAL_KEY_IMMUTABLE/,
    );
  });

  it('lets a flag be cleared and nothing else', async () => {
    const admin = await asRole('org_admin', ORG_A);
    const raised = await admin.client.request('POST', '/v1/fraud/flags', {
      body: { phone: '01611111111', severity: 2, reason: 'to be cleared' },
    });
    const { id } = JSON.parse(raised.body) as { id: string };

    await expectRefused(
      withSystem(
        async (tx) =>
          tx.execute(sql`update fraud.phone_flags set reason = 'rewritten' where id = ${id}`),
        { orgId: ORG_A },
      ),
      /FRAUD_FLAG_IMMUTABLE/,
    );

    const cleared = await admin.client.request('POST', `/v1/fraud/flags/${id}/clear`, {
      body: { reason: 'Raised in error — wrong number typed' },
    });
    expect(cleared.statusCode).toBe(201);

    // Clearing removed the aggregate entry, so the cross-org count is back to nothing and the
    // buyer is no longer blocked in any brand.
    const badge = await admin.client.request('GET', '/v1/fraud/check?phone=01611111111');
    const body = JSON.parse(badge.body) as {
      decision: string;
      signals: { manualFlagCount: number } | null;
    };
    expect(body.signals?.manualFlagCount ?? 0).toBe(0);
    expect(body.decision).toBe('allow');

    // And it cannot be cleared twice: a second clear would overwrite who cleared it first.
    const again = await admin.client.request('POST', `/v1/fraud/flags/${id}/clear`, {
      body: { reason: 'trying again' },
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('check 3: the provider times out and the desk keeps working', () => {
  it('falls back to an internal-only score marked provider unavailable', async () => {
    const fraud = harness.app.get(FraudService);
    const hasher = harness.app.get(PhoneHashService);
    const gateway = harness.app.get(ProviderGateway);
    const admin = await asRole('org_admin', ORG_A);
    const phone = '01511111111';

    // Turn providers on for this org, which is what makes "did not answer" a fact worth
    // showing rather than a configuration the badge should be silent about.
    await admin.client.request('PUT', '/v1/fraud/rules', {
      body: { allowMin: 70, warnMin: 40, requireAdvanceMin: 20, providerEnabled: true },
    });

    // A real internal history, so the fallback has something to fall back *to*.
    await withOrg({ orgId: ORG_A }, async (tx) => {
      for (let i = 0; i < 6; i += 1) {
        const orderId = randomUUID();
        await fraud.assessForOrder(tx, { orgId: ORG_A, orderId, phone });
        await fraud.applyOutcome(tx, {
          orgId: ORG_A,
          orderId,
          outcome: 'confirmed',
          at: new Date(),
        });
        await fraud.applyOutcome(tx, {
          orgId: ORG_A,
          orderId,
          outcome: 'delivered',
          at: new Date(),
        });
      }
    });

    /*
     * The stalling provider is pushed into the live gateway rather than into a separate
     * instance, because check 3 is about the *desk*: the request has to go through the real
     * controller, the real service and the real gateway for "the order desk keeps working"
     * to mean anything.
     */
    const stalling = new FakeFraudProvider('steadfast').stall();
    const injected = gateway as unknown as { providers: readonly unknown[] };
    const original = injected.providers;
    Object.defineProperty(injected, 'providers', { value: [stalling], configurable: true });

    try {
      const started = Date.now();
      const response = await admin.client.request(
        'GET',
        `/v1/fraud/check?phone=${encodeURIComponent(phone)}`,
      );
      const elapsed = Date.now() - started;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        trustScore: number;
        decision: string;
        providerAvailable: boolean;
        providers: unknown[];
        reasons: { code: string }[];
      };

      // The desk kept working, and it did not wait for the provider at all: the refresh is a
      // background job (§10, invariant 6), so the request never touches the network.
      expect(elapsed).toBeLessThan(2_000);
      expect(body.providerAvailable).toBe(false);
      expect(body.reasons.map((reason) => reason.code)).toContain('provider_unavailable');
      expect(body.providers).toEqual([]);

      // And the score is the internal-only one, unpenalised. A provider being down is a fact
      // about us, not about the buyer — penalising it would turn a third party's slow
      // afternoon into every order in the country being refused.
      expect(body.trustScore).toBe(80);
      expect(body.decision).toBe('allow');

      /*
       * The refresh itself, run directly rather than through pg-boss: the queue's
       * registration in the worker is an integration step, and what check 3 is about is the
       * timeout. `refreshProviders` must come back reporting the timeout and must write
       * **nothing** — a stored zero row would read as a clean record for the whole TTL and
       * would suppress the next refresh, so one timeout would blind the check for three days.
       */
      const refreshed = await fraud.refreshProviders(ORG_A, {
        phone,
        providers: ['steadfast'],
      });
      expect(refreshed.fetched).toBe(0);
      expect(refreshed.unavailable).toEqual(['steadfast:timeout']);

      const stored = await withOrg({ orgId: ORG_A }, async (tx) =>
        tx.execute<{ count: string }>(
          sql`select count(*) as count from fraud.provider_checks where phone_hash = ${hasher.hash(phone)}`,
        ),
      );
      expect(Number(stored[0]?.count ?? -1)).toBe(0);

      // A provider that does answer fills the cache, and the badge stops saying unavailable.
      stalling.returns({
        total: 20,
        delivered: 4,
        returnedOrCancelled: 16,
        ratio: 0.2,
        raw: { total: 20, status: 'checked' },
      });
      const ok = await fraud.refreshProviders(ORG_A, { phone, providers: ['steadfast'] });
      expect(ok.fetched).toBe(1);

      const after = await admin.client.request('GET', `/v1/fraud/check?phone=${phone}`);
      const afterBody = JSON.parse(after.body) as {
        providerAvailable: boolean;
        trustScore: number;
        providers: { name: string; total: number; fetchedAt: string }[];
      };
      expect(afterBody.providerAvailable).toBe(true);
      expect(afterBody.providers).toHaveLength(1);
      expect(afterBody.providers[0]).toMatchObject({
        name: 'steadfast',
        total: 20,
        delivered: 4,
        returnedOrCancelled: 16,
      });
      expect(typeof afterBody.providers[0]?.fetchedAt).toBe('string');
      // Sixteen of twenty came back elsewhere, so a buyer who is perfect with us drops a long
      // way. That is the point of paying for a provider.
      expect(afterBody.trustScore).toBeLessThan(body.trustScore);
    } finally {
      Object.defineProperty(injected, 'providers', { value: original, configurable: true });
      await admin.client.request('PUT', '/v1/fraud/rules', {
        body: { allowMin: 70, warnMin: 40, requireAdvanceMin: 20, providerEnabled: false },
      });
    }
  }, 180_000);
});

describe('the cross-org counters are maintained from order events', () => {
  it('maps §9 statuses to outcomes, and ignores our own logistics', () => {
    expect(outcomeForStatus('confirmed')).toBe('confirmed');
    expect(outcomeForStatus('delivered')).toBe('delivered');
    // The buyer took the parcel and paid, which is the behaviour being measured.
    expect(outcomeForStatus('partially_delivered')).toBe('delivered');
    expect(outcomeForStatus('returned')).toBe('returned');
    expect(outcomeForStatus('cancelled')).toBe('cancelled');

    // `return_in_transit` must not count: every return passes through it *and* through
    // `returned`, so counting both would double every return in the system.
    expect(outcomeForStatus('return_in_transit')).toBeNull();
    // Pending is not a promise. Counting it would let anybody lower a stranger's score by
    // filling in a landing-page form ten times.
    expect(outcomeForStatus('pending')).toBeNull();
    for (const status of ['packed', 'shipped', 'on_hold', 'exchange']) {
      expect(outcomeForStatus(status)).toBeNull();
    }
  });

  it('moves a counter once per event, however many times the event is delivered', async () => {
    const fraud = harness.app.get(FraudService);
    const hasher = harness.app.get(PhoneHashService);
    const phone = '01411111111';
    const orderId = randomUUID();

    await withOrg({ orgId: ORG_A }, async (tx) => {
      await fraud.assessForOrder(tx, { orgId: ORG_A, orderId, phone });
    });

    const dispatcher = new OutboxDispatcher();
    subscribeFraudToOrderEvents(dispatcher, fraud, createLogger('fraud-test'));

    const event: DeliveredEvent = {
      id: randomUUID(),
      orgId: ORG_A,
      name: 'order.status_changed',
      payload: {
        id: orderId,
        orderNo: 'ELY-1',
        from: 'pending',
        to: 'returned',
        at: new Date().toISOString(),
      },
      rooms: [],
      attempts: 0,
      occurredAt: new Date(),
      actorUserId: null,
    };

    // Delivered three times, which the dispatcher is entitled to do — it marks a row after
    // its subscribers return, so a crash in between redelivers.
    const subscribers = dispatcher as unknown as {
      subscribers: Map<string, ((e: DeliveredEvent) => Promise<void>)[]>;
    };
    const handler = subscribers.subscribers.get('order.status_changed')?.[0];
    expect(handler).toBeDefined();
    await handler?.(event);
    await handler?.(event);
    await handler?.(event);

    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ returned: number }>(
        sql`select returned from fraud.phone_signals where phone_hash = ${hasher.hash(phone)}`,
      ),
    );
    expect(Number(rows[0]?.returned ?? -1)).toBe(1);
  });

  it('counts nothing for an order that never went through the guard', async () => {
    // A landing-page order cancelled before anyone looked at it. There is no mapping from it
    // to a number, and inventing one would mean guessing.
    const fraud = harness.app.get(FraudService);
    const counted = await withOrg({ orgId: ORG_A }, async (tx) =>
      fraud.applyOutcome(tx, {
        orgId: ORG_A,
        orderId: randomUUID(),
        outcome: 'returned',
        at: new Date(),
      }),
    );
    expect(counted).toBe(false);
  });

  it('keeps an old incident from looking recent after a backlog', async () => {
    // `last_incident_at` moves forwards only. A redelivered event from a fortnight ago must
    // not overwrite this morning's return with its own older timestamp — the recency penalty
    // describes when the parcel came back, not when the worker got round to it.
    const fraud = harness.app.get(FraudService);
    const hasher = harness.app.get(PhoneHashService);
    const phone = '01311111111';
    const orderId = randomUUID();
    const recent = new Date();
    const old = new Date(recent.getTime() - 30 * 86_400_000);

    await withOrg({ orgId: ORG_A }, async (tx) => {
      await fraud.assessForOrder(tx, { orgId: ORG_A, orderId, phone });
      await fraud.applyOutcome(tx, { orgId: ORG_A, orderId, outcome: 'returned', at: recent });
      await fraud.applyOutcome(tx, { orgId: ORG_A, orderId, outcome: 'returned', at: old });
    });

    const rows = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ last_incident_at: string }>(
        sql`select last_incident_at from fraud.phone_signals where phone_hash = ${hasher.hash(phone)}`,
      ),
    );
    expect(new Date(rows[0]?.last_incident_at ?? 0).getTime()).toBe(recent.getTime());
  });

  it('announces a flagged verdict and stays silent about an allow', async () => {
    const fraud = harness.app.get(FraudService);
    const orderId = randomUUID();

    const announced = await withOrg({ orgId: ORG_A }, async (tx) => {
      const badge = await fraud.assessForOrder(tx, { orgId: ORG_A, orderId, phone: BLOCKED_PHONE });
      return fraud.announce(tx, { orgId: ORG_A, orderId, orderNo: 'ELY-2603-0001', badge });
    });
    expect(announced).toBe(true);

    const outbox = await withOrg({ orgId: ORG_A }, async (tx) =>
      tx.execute<{ payload: Record<string, unknown> }>(
        sql`select payload from events.outbox where name = 'order.fraud_flagged' and org_id = ${ORG_A}`,
      ),
    );
    expect(outbox).toHaveLength(1);
    const payload = outbox[0]?.payload ?? {};
    expect(payload).toMatchObject({ id: orderId, orderNo: 'ELY-2603-0001', decision: 'block' });
    // §19: ids plus display fields every recipient may see. No phone, and no hash — a socket
    // has no `serializeFor` in front of it, so a hash on the wire would be a correlation key
    // sitting in five browsers' memory.
    expect(JSON.stringify(payload)).not.toContain(BLOCKED_PHONE);
    expect(Object.keys(payload).sort()).toEqual([
      'at',
      'decision',
      'id',
      'orderNo',
      'providerAvailable',
      'reasons',
      'trustScore',
    ]);

    const quiet = await withOrg({ orgId: ORG_A }, async (tx) => {
      const badge = await fraud.assessForOrder(tx, {
        orgId: ORG_A,
        orderId: randomUUID(),
        phone: CLEAN_PHONE,
      });
      return fraud.announce(tx, { orgId: ORG_A, orderId, orderNo: 'ELY-2603-0002', badge });
    });
    expect(quiet).toBe(false);
  });
});
