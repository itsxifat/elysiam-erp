import { assertNoCostFields, MEMBERSHIP_ROLES, NEVER_AUTO_APPROVE_TYPES } from '@elysium/contracts';
import { withOrg, withSystem } from '@elysium/db';
import { grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asRole,
  auditRowsFor,
  createBranch,
  expectRefused,
  ORG_A,
  ORG_B,
  startHttpHarness,
  type Client,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { ApprovalsService } from './approvals.service.js';

/**
 * Permissions, audit and approvals over the real HTTP surface (M02b).
 *
 * The matrix has unit tests in `packages/contracts`; those prove the matrix is
 * self-consistent. These prove the *system* honours it — that the guard is
 * actually mounted, that `serializeFor` actually runs on the way out, that the
 * audit row is actually written, and that the database actually refuses a
 * self-approval. Every one of those is a thing that can be true in a unit test
 * and false in the running application.
 *
 * The harness mounts production's own pipeline (`applyGlobalPipeline`), and
 * `asRole(role, org)` signs a new user in through the real flow.
 */

let harness: HttpHarness;
let branchA: string;
let branchB: string;

beforeAll(async () => {
  harness = await startHttpHarness('permissions');

  branchA = await createBranch(ORG_A, 'BR-A');
  branchB = await createBranch(ORG_A, 'BR-B');

  // One item per branch plus an org-level one in A, and one in B, so a
  // cross-org read and a cross-branch read both have something to fail to find.
  await seedItem(ORG_A, 'SKU-A-BRANCH-A', branchA);
  await seedItem(ORG_A, 'SKU-A-BRANCH-B', branchB);
  await seedItem(ORG_A, 'SKU-A-ORG', null);
  await seedItem(ORG_B, 'SKU-B-ORG', null);
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

async function seedItem(orgId: string, sku: string, branchId: string | null): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into demo.costed_items (org_id, sku, name, unit_cost_poisha, sell_price_poisha, available_qty, branch_id)
        values (${orgId}, ${sku}, 'Kurti', 120000, 250000, 7, ${branchId}::uuid)
      `);
    },
    { orgId },
  );
}

function parse<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function skusSeenBy(client: Client): Promise<string[]> {
  const response = await client.request('GET', '/v1/demo/costed-items');
  expect(response.statusCode, response.body).toBe(200);
  return parse<{ items: { sku: string }[] }>(response.body)
    .items.map((item) => item.sku)
    .sort();
}

/** The interceptor writes after the response; give it a moment, then look. */
async function eventually<T>(read: () => Promise<T[]>, minimum = 1): Promise<T[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await read();
    if (rows.length >= minimum) return rows;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return read();
}

describe('check 1: the guard honours the matrix over HTTP', () => {
  it.each(['org_admin', 'accounts', 'sales', 'marketing', 'warehouse', 'branch_manager'] as const)(
    'lets %s read the costed items the matrix says they may',
    async (role) => {
      const { client } = await asRole(role);
      const response = await client.request('GET', '/v1/demo/costed-items');
      expect(response.statusCode, response.body).toBe(200);
    },
  );

  it.each(['hr', 'investor'] as const)('refuses %s, who has no rule for it', async (role) => {
    const { client } = await asRole(role);
    const response = await client.request('GET', '/v1/demo/costed-items');
    expect(response.statusCode, response.body).toBe(403);
  });

  it('refuses a role that may read but not create', async () => {
    const { client } = await asRole('sales');
    const response = await client.request('POST', '/v1/demo/costed-items', {
      body: { sku: 'NOPE', name: 'Nope' },
    });
    expect(response.statusCode, response.body).toBe(403);
  });

  it('allows the role that may create', async () => {
    // The positive control: the 403s above would also appear if the route were
    // simply broken.
    const { client } = await asRole('org_admin');
    const response = await client.request('POST', '/v1/demo/costed-items', {
      body: { sku: `MADE-${String(Date.now())}`, name: 'Made' },
    });
    expect(response.statusCode, response.body).toBe(201);
  });

  // The undeclared-route and contradictory-declaration refusals are tested
  // against deliberately broken controllers in platform/auth/guard.test.ts;
  // this application has no undeclared route to call, by construction.
});

describe('check 1: branch scope is enforced on rows, not only on routes (M2)', () => {
  it('shows a branch manager their branch and nothing else', async () => {
    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const skus = await skusSeenBy(client);

    expect(skus).toContain('SKU-A-BRANCH-A');
    expect(skus).not.toContain('SKU-A-BRANCH-B');
    expect(skus, 'an org-level row is in nobody’s branch').not.toContain('SKU-A-ORG');
  });

  it('shows an org-wide role every branch (the positive control)', async () => {
    const { client } = await asRole('org_admin');
    const skus = await skusSeenBy(client);

    expect(skus).toEqual(expect.arrayContaining(['SKU-A-BRANCH-A', 'SKU-A-BRANCH-B', 'SKU-A-ORG']));
    expect(skus, 'and never another org').not.toContain('SKU-B-ORG');
  });

  it('treats a branch manager with no branches as org-wide (§6)', async () => {
    const { client } = await asRole('branch_manager');
    const skus = await skusSeenBy(client);
    expect(skus).toEqual(expect.arrayContaining(['SKU-A-BRANCH-A', 'SKU-A-BRANCH-B']));
  });
});

describe('check 2: cost reaches accounts and nobody else, through the API', () => {
  it('gives accounts the cost', async () => {
    const { client } = await asRole('accounts');
    const response = await client.request('GET', '/v1/demo/costed-items');
    const body = parse<{ items: { unitCostPoisha?: string }[] }>(response.body);

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]?.unitCostPoisha, 'accounts must see cost').toBeDefined();
  });

  it.each(['sales', 'marketing', 'warehouse'] as const)('hides it from %s', async (role) => {
    const { client } = await asRole(role);
    const response = await client.request('GET', '/v1/demo/costed-items');
    const body = parse<{ items: Record<string, unknown>[] }>(response.body);

    // The positive control first: a payload with no items would pass
    // assertNoCostFields for the wrong reason.
    expect(body.items.length, 'nothing to check means nothing was proved').toBeGreaterThan(0);
    expect(body.items[0]).toHaveProperty('sellPricePoisha');

    expect(() => {
      assertNoCostFields(body);
    }).not.toThrow();
  });

  it('gives a reseller only the allow-listed fields', async () => {
    const { client } = await asRole('reseller');
    const response = await client.request('GET', '/v1/demo/costed-items');
    const body = parse<{ items: Record<string, unknown>[] }>(response.body);

    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0]).not.toHaveProperty('sellPricePoisha');
    expect(body.items[0]).not.toHaveProperty('unitCostPoisha');
    expect(body.items[0]).not.toHaveProperty('branchId');
    expect(body.items[0]).toHaveProperty('sku');
  });

  it('still isolates orgs, cost or no cost', async () => {
    // Permissions sit on top of tenancy; they do not replace it.
    const { client } = await asRole('accounts', ORG_B);
    expect(await skusSeenBy(client)).toEqual(['SKU-B-ORG']);
  });
});

describe('check 3: every mutation writes a redacted audit row', () => {
  it('records the approval request that caused it, with what was asked', async () => {
    const { client, userId } = await asRole('accounts');

    const created = await client.request('POST', '/v1/approvals', {
      body: { type: 'wallet_adjustment', amountPoisha: '750000', reason: 'till short' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = parse<{ id: string }>(created.body);

    const rows = await auditRowsFor(ORG_A, id);
    expect(rows.length, 'no audit row was written').toBe(1);
    expect(rows[0]).toMatchObject({
      action: 'approval.requested:wallet_adjustment',
      operation: 'create',
      actor_user_id: userId,
      entity_type: 'ApprovalRequest',
      before: null,
      after: { type: 'wallet_adjustment', amountPoisha: '750000', reason: 'till short' },
    });
  });

  it('redacts a secret and masks a phone, and keeps everything else', async () => {
    const { client } = await asRole('accounts');

    const created = await client.request('POST', '/v1/approvals', {
      body: {
        type: 'supplier_payment',
        amountPoisha: '100',
        reason: 'supplier 01812345677 called',
        payload: { note: 'ok', apiKey: 'sk_live_must_not_appear', phone: '01712345689' },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = parse<{ id: string }>(created.body);

    const rows = await auditRowsFor(ORG_A, id);
    // The positive control: a row exists and carries the payload. "The secret
    // is not in the log" also passes when there is no log.
    expect(rows).toHaveLength(1);
    const after = rows[0]?.after as {
      reason: string;
      payload: { note: string; apiKey: string; phone: string };
    };

    expect(after.payload.note).toBe('ok');
    expect(after.payload.apiKey).toBe('[redacted]');
    expect(after.payload.phone).toBe('017******89');
    expect(after.reason, 'a phone in free text is masked too (L1)').toBe(
      'supplier 018******77 called',
    );
    expect(JSON.stringify(rows)).not.toContain('sk_live_must_not_appear');
    expect(JSON.stringify(rows)).not.toContain('12345689');
  });

  it('records a decision with its before and after', async () => {
    const { client: maker } = await asRole('org_admin');
    const { client: checker, userId: checkerId } = await asRole('org_admin');

    const created = await maker.request('POST', '/v1/approvals', {
      body: { type: 'back_dated_entry', amountPoisha: '900000' },
    });
    const { id } = parse<{ id: string }>(created.body);

    const decided = await checker.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'rejected', note: 'wrong period' },
    });
    expect(decided.statusCode, decided.body).toBe(201);

    const rows = await auditRowsFor(ORG_A, id);
    const decision = rows.find((row) => row.action === 'approval.decided:back_dated_entry');
    expect(decision, 'no decision row').toBeDefined();
    expect(decision).toMatchObject({
      operation: 'reject',
      actor_user_id: checkerId,
      before: { status: 'pending', decidedBy: null },
      after: { status: 'rejected', decidedBy: checkerId, note: 'wrong period' },
    });
  });

  it('catches a mutation on a route that instruments nothing itself', async () => {
    // The net. `POST /v1/demo/costed-items` writes no audit entry of its own —
    // it is the kind of route that ships instrumented-later — and the
    // interceptor is what stops that being an unrecorded change.
    const { client } = await asRole('org_admin');
    const sku = `AUDITED-${String(Date.now())}`;

    const created = await client.request('POST', '/v1/demo/costed-items', {
      body: { sku, name: 'Audited' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = parse<{ id: string }>(created.body);

    const rows = await eventually(() => auditRowsFor(ORG_A, id));
    expect(rows.length, 'the interceptor recorded nothing').toBeGreaterThan(0);
    expect(rows[0]?.entity_type).toBe('CostedItem');
    expect(rows[0]?.action).toContain('POST');
    expect(rows[0]?.after).toMatchObject({ request: { sku } });
  });

  it('does not write the entry twice when a service already did', async () => {
    const { client } = await asRole('warehouse');

    const created = await client.request('POST', '/v1/approvals', {
      body: { type: 'stock_write_off', amountPoisha: '100' },
    });
    const { id } = parse<{ id: string }>(created.body);

    await new Promise((resolve) => setTimeout(resolve, 300));

    const rows = await auditRowsFor(ORG_A, id);
    expect(rows.length, 'the mutation was audited twice').toBe(1);
    expect(rows[0]?.action).toContain('approval.requested');
  });

  it('audits the first org switch, into the org being entered', async () => {
    // asRole's switch is the first one this session makes: there was no
    // request context yet, and the interceptor used to return early on that.
    const { userId } = await asRole('sales');

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ action: string; before: unknown; after: unknown }>(sql`
          select action, before, after from audit.audit_log
          where actor_user_id = ${userId} and action = 'iam.active_org_switched'
        `),
      { orgId: ORG_A },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ before: { activeOrg: 'none' }, after: { activeOrgId: ORG_A } });
  });

  it('audits a later switch into the target org, not the one being left', async () => {
    const { client, userId } = await asRole('sales', ORG_A);
    await grantMembership({ userId, orgId: ORG_B, role: 'sales' });

    const switched = await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_B } });
    expect(switched.statusCode, switched.body).toBe(201);

    const count = async (orgId: string) => [
      ...(await withSystem(
        async (tx) =>
          tx.execute<{ before: unknown }>(sql`
              select before from audit.audit_log
              where actor_user_id = ${userId} and action = 'iam.active_org_switched'
            `),
        { orgId },
      )),
    ];

    const inB = await count(ORG_B);
    expect(inB, 'the switch into B belongs in B’s log').toHaveLength(1);
    // B's admin learns the user came from "another" org, not which one.
    expect(inB[0]?.before).toEqual({ activeOrg: 'another' });
    expect(await count(ORG_A), 'A has only the first switch').toHaveLength(1);
  });

  it('audits the credential events Better Auth owns (D-066)', async () => {
    // An accounts user goes through all four on the way in: redeem the
    // invite, sign in, enrol TOTP, verify it.
    const { userId } = await asRole('accounts');

    const actions = (
      await withSystem(
        async (tx) =>
          tx.execute<{ action: string; after: unknown }>(sql`
            select action, after from audit.audit_log
            where actor_user_id = ${userId} and entity_type = 'User'
            order by created_at
          `),
        { orgId: ORG_A },
      )
    ).map((row) => row.action);

    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.password_set',
        'auth.signed_in',
        'auth.two_factor_enabled',
        'auth.second_factor_verified',
      ]),
    );
  });

  it('never writes an auth request body into the log', async () => {
    const { userId } = await asRole('accounts');
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ after: unknown }>(sql`
          select after from audit.audit_log where actor_user_id = ${userId}
        `),
      { orgId: ORG_A },
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('correct-horse-battery');
  });

  it('keeps the raw session token out of auth responses (M02a follow-up)', async () => {
    const { client } = await asRole('sales');
    const session = await client.request('GET', '/api/auth/get-session');
    expect(session.statusCode).toBe(200);

    const body = parse<{ session?: Record<string, unknown>; user?: unknown }>(session.body);
    expect(body.user, 'the positive control: it is a real session').toBeDefined();
    expect(body.session).toBeDefined();
    expect(body.session).not.toHaveProperty('token');
  });

  it('cannot be updated or deleted, because the log is append-only', async () => {
    // The grant is the control. A log whose rows can be edited is not evidence.
    await expectRefused(
      withSystem(
        async (tx) => {
          await tx.execute(sql`set role erp_app`);
          await tx.execute(sql`update audit.audit_log set action = 'tampered'`);
        },
        { orgId: ORG_A },
      ),
      /permission denied/i,
    );
  });
});

async function requestApproval(
  client: Client,
  type: string,
  amountPoisha: string | null,
  extra: Record<string, unknown> = {},
) {
  const response = await client.request('POST', '/v1/approvals', {
    body: { type, amountPoisha, ...extra },
  });
  expect(response.statusCode, response.body).toBe(201);
  return parse<{ id: string; required: boolean; status: string }>(response.body);
}

/**
 * Set a threshold the way an org does it: one org admin proposes, and if that
 * relaxes it, a second org admin approves the change (D-073).
 */
async function setThreshold(type: string, thresholdPoisha: string): Promise<void> {
  const { client } = await asRole('org_admin');
  const response = await client.request('PUT', '/v1/approvals/thresholds', {
    body: { type, thresholdPoisha },
  });
  expect(response.statusCode, response.body).toBe(200);

  const body = parse<{ status: string; approvalId?: string }>(response.body);
  if (body.status === 'pending_approval') {
    const { client: second } = await asRole('org_admin');
    const decided = await second.request(
      'POST',
      `/v1/approvals/${String(body.approvalId)}/decide`,
      {
        body: { decision: 'approved' },
      },
    );
    expect(decided.statusCode, decided.body).toBe(201);
  }
}

async function currentThreshold(type: string): Promise<string | null> {
  const [row] = await withSystem(
    async (tx) =>
      tx.execute<{ threshold_poisha: string }>(sql`
        select threshold_poisha::text as threshold_poisha from approvals.approval_thresholds
        where org_id = ${ORG_A} and type = ${type}::approvals.approval_type
      `),
    { orgId: ORG_A },
  );
  return row?.threshold_poisha ?? null;
}

describe('check 4: maker-checker', () => {
  it('refuses a requester approving their own request', async () => {
    const { client } = await asRole('org_admin');
    const { id } = await requestApproval(client, 'wallet_adjustment', '900000');

    const decided = await client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(decided.statusCode, decided.body).toBe(403);
  });

  it('and the database refuses it too, not only the service', async () => {
    // The service check is a courtesy. This is the control: it bypasses the
    // service entirely and writes the row the way a job or a repair script
    // would — as the application role, through RLS.
    const { client, userId } = await asRole('org_admin');
    const { id } = await requestApproval(client, 'wallet_adjustment', '900000');

    await expectRefused(
      withOrg({ orgId: ORG_A, userId }, async (tx) => {
        await tx.execute(sql`
          update approvals.approval_requests
          set status = 'approved', decided_by = ${userId}, decided_at = now()
          where id = ${id}
        `);
      }),
      /approval_requests_maker_is_not_checker/,
      '23514',
    );
  });

  it('lets a different person decide', async () => {
    const { client: maker } = await asRole('org_admin');
    const { client: checker } = await asRole('org_admin');

    const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');
    const decided = await checker.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved', note: 'checked' },
    });

    expect(decided.statusCode, decided.body).toBe(201);
    expect(parse(decided.body)).toMatchObject({ status: 'approved' });
  });

  it('refuses a second decision on a decided request', async () => {
    const { client: maker } = await asRole('org_admin');
    const { client: checker } = await asRole('org_admin');
    const { client: other } = await asRole('org_admin');

    const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');
    await checker.request('POST', `/v1/approvals/${id}/decide`, { body: { decision: 'approved' } });

    const again = await other.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'rejected' },
    });

    expect(again.statusCode, again.body).toBe(409);
  });

  describe('a decided request is frozen by the database (migration 0009, 0010)', () => {
    async function decidedRequest(): Promise<{ id: string; checkerId: string }> {
      const { client: maker } = await asRole('org_admin');
      const { client: checker, userId: checkerId } = await asRole('org_admin');
      const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');
      const decided = await checker.request('POST', `/v1/approvals/${id}/decide`, {
        body: { decision: 'approved' },
      });
      expect(decided.statusCode, decided.body).toBe(201);
      return { id, checkerId };
    }

    // Functions, because `branchA` does not exist until beforeAll has run.
    it.each([
      ['its amount', () => sql`amount_poisha = 500000000`],
      ['its payload', () => sql`payload = '{"to":"someone else"}'::jsonb`],
      ['its branch', () => sql`branch_id = ${branchA}::uuid`],
      [
        'its status, back to pending',
        () => sql`status = 'pending', decided_by = null, decided_at = null`,
      ],
      ['its decider', () => sql`decided_by = 'someone-else'`],
    ])('refuses changing %s with integrity_constraint_violation', async (_what, assignment) => {
      const { id, checkerId } = await decidedRequest();

      // As the application role, through RLS: the path a buggy module or a
      // compromised handler would take.
      await expectRefused(
        withOrg({ orgId: ORG_A, userId: checkerId }, async (tx) => {
          await tx.execute(
            sql`update approvals.approval_requests set ${assignment()} where id = ${id}`,
          );
        }),
        /cannot change|already/,
        '23000',
      );
    });

    // W3: a *pending* row was editable, which undid maker-checker from the
    // other end — skip the checker, or re-attribute the request so its real
    // maker could approve it, or change the terms after a checker looked.
    it.each([
      ['its status to auto_approved', () => sql`status = 'auto_approved', decided_at = now()`],
      ['who requested it', () => sql`requested_by = 'someone-else'`],
      ['its amount', () => sql`amount_poisha = 1`],
      ['its type', () => sql`type = 'stock_gain'`],
      ['its payload', () => sql`payload = '{"to":"someone else"}'::jsonb`],
      ['its branch', () => sql`branch_id = ${branchA}::uuid`],
      ['its captured threshold', () => sql`threshold_poisha = 999999999999`],
    ])('refuses changing a pending request’s %s (migration 0011)', async (_what, assignment) => {
      const { client: maker, userId } = await asRole('org_admin');
      const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');

      await expectRefused(
        withOrg({ orgId: ORG_A, userId }, async (tx) => {
          await tx.execute(
            sql`update approvals.approval_requests set ${assignment()} where id = ${id}`,
          );
        }),
        /cannot change|cannot become auto_approved/,
        '23000',
      );
    });

    it('refuses writing an auto-approved control type even by INSERT (D-071)', async () => {
      const { userId } = await asRole('org_admin');
      await expectRefused(
        withOrg({ orgId: ORG_A, userId }, async (tx) => {
          await tx.execute(sql`
            insert into approvals.approval_requests (org_id, type, status, requested_by, decided_at)
            values (${ORG_A}, 'period_reopen', 'auto_approved', ${userId}, now())
          `);
        }),
        /approval_requests_never_auto_approved/,
        '23514',
      );
    });

    it('still lets a pending request be decided (the positive control)', async () => {
      const { client: maker } = await asRole('org_admin');
      const { userId: checkerId } = await asRole('org_admin');
      const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');

      await withOrg({ orgId: ORG_A, userId: checkerId }, async (tx) => {
        await tx.execute(sql`
          update approvals.approval_requests
          set status = 'approved', decided_by = ${checkerId}, decided_at = now()
          where id = ${id}
        `);
      });
    });
  });

  it('refuses a role that may not approve at all', async () => {
    const { client: maker } = await asRole('accounts');
    const { client: warehouse } = await asRole('warehouse');

    const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');
    const attempt = await warehouse.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    expect(attempt.statusCode, attempt.body).toBe(403);
  });

  it("does not let one org decide another org's request", async () => {
    const { client: maker } = await asRole('org_admin', ORG_A);
    const { client: outsider } = await asRole('org_admin', ORG_B);

    const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');
    const attempt = await outsider.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });

    // RLS scoped it away, so it is genuinely not found rather than forbidden —
    // which is also the answer that reveals least.
    expect(attempt.statusCode, attempt.body).toBe(404);
  });

  it('answers a malformed id with 400, not 500', async () => {
    const { client } = await asRole('org_admin');
    const attempt = await client.request('POST', '/v1/approvals/not-a-uuid/decide', {
      body: { decision: 'approved' },
    });
    expect(attempt.statusCode, attempt.body).toBe(400);
  });

  it('answers an amount outside bigint with 400, not 500', async () => {
    const { client } = await asRole('accounts');
    const attempt = await client.request('POST', '/v1/approvals', {
      body: { type: 'wallet_adjustment', amountPoisha: '99999999999999999999' },
    });
    expect(attempt.statusCode, attempt.body).toBe(400);
  });
});

describe('check 5: below and above the threshold behave differently', () => {
  it('only lets org_admin set a threshold', async () => {
    for (const role of ['accounts', 'branch_manager', 'sales'] as const) {
      const { client } = await asRole(role);
      const attempt = await client.request('PUT', '/v1/approvals/thresholds', {
        body: { type: 'wallet_adjustment', thresholdPoisha: '1' },
      });
      expect(attempt.statusCode, `${role}: ${attempt.body}`).toBe(403);
    }
  });

  it('records the threshold change in the audit log, old value beside new', async () => {
    await setThreshold('settlement_posting', '200');
    const { client } = await asRole('org_admin');
    // Lowering only asks for more checking, so it applies at once (D-073).
    const changed = await client.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'settlement_posting', thresholdPoisha: '100' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(parse(changed.body)).toMatchObject({ status: 'applied' });

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ before: unknown; after: unknown }>(sql`
          select before, after from audit.audit_log
          where action = 'approval.threshold_set:settlement_posting'
          order by created_at desc limit 1
        `),
      { orgId: ORG_A },
    );
    expect(rows[0]).toMatchObject({
      before: { thresholdPoisha: '200' },
      after: { thresholdPoisha: '100' },
    });
  });

  it('auto-approves below the threshold and holds at it, each emitting its events', async () => {
    await setThreshold('wallet_adjustment', '500000');
    const approvals = harness.app.get(ApprovalsService);

    const { client: maker } = await asRole('accounts');

    approvals.emitted.length = 0;
    const below = await requestApproval(maker, 'wallet_adjustment', '499999');
    const belowEvents = approvals.emitted.map((event) => [
      event.name,
      event.payload.status ?? event.payload.decision,
    ]);

    approvals.emitted.length = 0;
    const at = await requestApproval(maker, 'wallet_adjustment', '500000');
    const atEvents = approvals.emitted.map((event) => [
      event.name,
      event.payload.status ?? event.payload.decision,
    ]);

    expect(below).toMatchObject({ required: false, status: 'auto_approved' });
    expect(at).toMatchObject({ required: true, status: 'pending' });

    // Below: requested, and decided at once — the requester hears the same
    // event a checker's decision would send.
    expect(belowEvents).toEqual([
      ['approval.requested', 'auto_approved'],
      ['approval.decided', 'auto_approved'],
    ]);
    // At the threshold: requested only, until a checker acts.
    expect(atEvents).toEqual([['approval.requested', 'pending']]);
  });

  it('treats a negative amount by its magnitude', async () => {
    await setThreshold('wallet_adjustment', '500000');
    const { client } = await asRole('accounts');
    expect(await requestApproval(client, 'wallet_adjustment', '-500000')).toMatchObject({
      status: 'pending',
    });
  });

  it('fails closed when no threshold is configured', async () => {
    const { client } = await asRole('accounts');
    // `supplier_payment` is never given a threshold in this file.
    expect(await requestApproval(client, 'supplier_payment', '1')).toMatchObject({
      required: true,
      status: 'pending',
    });
  });

  it('keeps an auto-approved request out of every checker queue, and final', async () => {
    await setThreshold('wallet_adjustment', '500000');
    const { client: maker } = await asRole('accounts');
    const { client: checker } = await asRole('org_admin');

    const { id } = await requestApproval(maker, 'wallet_adjustment', '1');
    const attempt = await checker.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'rejected' },
    });
    expect(attempt.statusCode, attempt.body).toBe(409);
  });

  it('emits approval.decided when a checker decides a held request', async () => {
    const approvals = harness.app.get(ApprovalsService);
    const { client: maker } = await asRole('org_admin');
    const { client: checker } = await asRole('org_admin');

    const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');
    approvals.emitted.length = 0;
    await checker.request('POST', `/v1/approvals/${id}/decide`, { body: { decision: 'approved' } });

    expect(approvals.emitted).toHaveLength(1);
    expect(approvals.emitted[0]).toMatchObject({
      name: 'approval.decided',
      payload: { id, decision: 'approved' },
    });
  });
});

describe('the branch-tier checker (§6 "branch items under threshold", M1)', () => {
  // `stock_gain` is branch-checkable and server-derived, so through the
  // generic route it is always held (D-072) — which is exactly what makes the
  // branch-tier checker reachable: a held branch item under the threshold.
  async function heldBranchRequest(branchId: string | null, amount: string): Promise<string> {
    const { client: maker } = await asRole('org_admin');
    const held = await requestApproval(
      maker,
      'stock_gain',
      amount,
      branchId === null ? {} : { branchId },
    );
    expect(held.status).toBe('pending');
    return held.id;
  }

  async function decideAs(client: Client, id: string) {
    return client.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });
  }

  it('lets a branch manager decide their own branch’s item under the threshold', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await heldBranchRequest(branchA, '5000');

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const decided = await decideAs(client, id);
    expect(decided.statusCode, decided.body).toBe(201);
  });

  it('refuses another branch’s item, as not found', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await heldBranchRequest(branchB, '5000');

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(404);
  });

  it('judges the branch on the branch-tier role alone, not the union with hr (C2)', async () => {
    // hr's org-wide `approve` made the unioned scope `all`, and the branch
    // check then passed for branch B — which hr may not check at all and the
    // branch manager may not check outside A.
    await setThreshold('stock_gain', '10000000');
    const id = await heldBranchRequest(branchB, '5000');

    const { client } = await asRole(['hr', 'branch_manager'], ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(403);
    expect(attempt.body).toMatch(/own branches/);

    // The positive control: the same person may decide their own branch's.
    const own = await heldBranchRequest(branchA, '5000');
    expect((await decideAs(client, own)).statusCode).toBe(201);
  });

  it('refuses an item at or above the threshold', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await heldBranchRequest(branchA, '10000000');

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(403);
    expect(attempt.body).toMatch(/threshold/);
  });

  it('refuses when no threshold was configured when the request was raised', async () => {
    const id = await withNoThreshold('stock_gain', () => heldBranchRequest(branchA, '1'));
    // A threshold exists again now; the one captured at request time did not.
    expect(await currentThreshold('stock_gain')).not.toBeNull();

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(403);
  });

  it('refuses an org-level item with no branch', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await heldBranchRequest(null, '5');

    const { client } = await asRole('branch_manager');
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(403);
  });

  it('lets a branch manager raise requests only for their own branches', async () => {
    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });

    const own = await client.request('POST', '/v1/approvals', {
      body: { type: 'closing_variance', amountPoisha: '10' },
    });
    expect(own.statusCode, own.body).toBe(201);

    const other = await client.request('POST', '/v1/approvals', {
      body: { type: 'closing_variance', amountPoisha: '10', branchId: branchB },
    });
    expect(other.statusCode, other.body).toBe(403);
  });

  it('answers an unknown branch with 400, whoever owns it', async () => {
    const { client } = await asRole('org_admin');
    const attempt = await client.request('POST', '/v1/approvals', {
      body: { type: 'closing_variance', amountPoisha: '10', branchId: crypto.randomUUID() },
    });
    expect(attempt.statusCode, attempt.body).toBe(400);
  });

  it('keeps branch scope per membership: warehouse@B does not widen branch_manager@A (W7)', async () => {
    const { client: maker } = await asRole('org_admin');
    const inA = await requestApproval(maker, 'stock_write_off', '777', { branchId: branchA });
    const inB = await requestApproval(maker, 'stock_write_off', '777', { branchId: branchB });

    const { client, userId } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    await grantMembership({ userId, orgId: ORG_A, role: 'warehouse', branchIds: [branchB] });

    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    const ids = parse<{ id: string }[]>(response.body).map((row) => row.id);
    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
  });
});

/** Run `work` with `type`'s threshold removed, then put the previous one back. */
async function withNoThreshold<T>(type: string, work: () => Promise<T>): Promise<T> {
  const [previous] = await withSystem(
    async (tx) =>
      tx.execute<{ threshold_poisha: string }>(sql`
        delete from approvals.approval_thresholds
        where org_id = ${ORG_A} and type = ${type}::approvals.approval_type
        returning threshold_poisha::text as threshold_poisha
      `),
    { orgId: ORG_A },
  );
  try {
    return await work();
  } finally {
    if (previous !== undefined) await setThreshold(type, previous.threshold_poisha);
  }
}

describe('control types are never auto-approved (C1, D-071)', () => {
  it('refuses a threshold on period_reopen, and the database refuses it too', async () => {
    const { client, userId } = await asRole('org_admin');
    const attempt = await client.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'period_reopen', thresholdPoisha: '1' },
    });
    expect(attempt.statusCode, attempt.body).toBe(400);

    for (const type of NEVER_AUTO_APPROVE_TYPES) {
      await expectRefused(
        withOrg({ orgId: ORG_A, userId }, async (tx) => {
          await tx.execute(sql`
            insert into approvals.approval_thresholds (org_id, type, threshold_poisha)
            values (${ORG_A}, ${type}::approvals.approval_type, 1)
          `);
        }),
        /approval_thresholds_never_for_controls/,
        '23514',
      );
    }
  });

  it('refuses an amount on period_reopen, and holds it with none', async () => {
    const { client } = await asRole('accounts');
    const withAmount = await client.request('POST', '/v1/approvals', {
      body: { type: 'period_reopen', amountPoisha: '0' },
    });
    expect(withAmount.statusCode, withAmount.body).toBe(400);

    expect(await requestApproval(client, 'period_reopen', null)).toMatchObject({
      required: true,
      status: 'pending',
    });
  });

  it('holds a back-dated entry however small', async () => {
    const { client } = await asRole('accounts');
    expect(await requestApproval(client, 'back_dated_entry', '1')).toMatchObject({
      status: 'pending',
    });
  });
});

describe('the maker side has per-type authority (W5, D-072)', () => {
  it('refuses sales raising anything, and warehouse raising a payment', async () => {
    const { client: sales } = await asRole('sales');
    const bySales = await sales.request('POST', '/v1/approvals', {
      body: { type: 'wallet_adjustment', amountPoisha: '1' },
    });
    expect(bySales.statusCode, bySales.body).toBe(403);

    const { client: warehouse } = await asRole('warehouse');
    const payment = await warehouse.request('POST', '/v1/approvals', {
      body: { type: 'supplier_payment', amountPoisha: '1' },
    });
    expect(payment.statusCode, payment.body).toBe(403);
  });

  it('never auto-approves an amount the owning module should have derived', async () => {
    // A write-off is valued at WAC by M07. Typed by the requester, it cannot
    // decide whether a second person looks, however far under the threshold.
    await setThreshold('stock_write_off', '1000000000');
    const { client } = await asRole('warehouse');
    expect(await requestApproval(client, 'stock_write_off', '1')).toMatchObject({
      required: true,
      status: 'pending',
    });
  });

  it('withholds a WAC-valued amount from a role without read:cost (D-074)', async () => {
    const { client: maker } = await asRole('warehouse');
    const { id } = await requestApproval(maker, 'stock_write_off', '4242', { branchId: branchA });

    const { client: manager } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const seen = parse<{ id: string; amountPoisha: string | null; amountWithheld: boolean }[]>(
      (await manager.request('GET', '/v1/approvals')).body,
    ).find((row) => row.id === id);
    expect(seen).toMatchObject({ amountPoisha: null, amountWithheld: true });

    // The positive control: a cost reader sees it.
    const { client: admin } = await asRole('org_admin');
    const full = parse<{ id: string; amountPoisha: string | null }[]>(
      (await admin.request('GET', '/v1/approvals')).body,
    ).find((row) => row.id === id);
    expect(full?.amountPoisha).toBe('4242');
  });
});

describe('relaxing a threshold needs a second org admin (W4, D-073)', () => {
  it('holds a raise until another org admin approves it', async () => {
    await setThreshold('wallet_adjustment', '500000');
    const { client: admin } = await asRole('org_admin');

    const raise = await admin.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'wallet_adjustment', thresholdPoisha: '900000000' },
    });
    expect(raise.statusCode, raise.body).toBe(200);
    const { status, approvalId } = parse<{ status: string; approvalId: string }>(raise.body);
    expect(status).toBe('pending_approval');
    expect(await currentThreshold('wallet_adjustment'), 'not applied yet').toBe('500000');

    // The attack: raise, then auto-approve one's own big request. Still held.
    const own = await requestApproval(admin, 'wallet_adjustment', '800000000');
    expect(own.status).toBe('pending');

    // The proposer cannot approve their own change.
    const self = await admin.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(self.statusCode, self.body).toBe(403);

    const { client: second } = await asRole('org_admin');
    const approved = await second.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(201);
    expect(await currentThreshold('wallet_adjustment')).toBe('900000000');

    // And a lowering applies straight away.
    const lower = await admin.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'wallet_adjustment', thresholdPoisha: '500000' },
    });
    expect(parse(lower.body)).toMatchObject({ status: 'applied' });
    expect(await currentThreshold('wallet_adjustment')).toBe('500000');
  });

  it('treats a first threshold as a relaxation too', async () => {
    const { client: admin } = await asRole('org_admin');
    const first = await admin.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'reseller_payout_batch', thresholdPoisha: '1' },
    });
    expect(parse(first.body)).toMatchObject({ status: 'pending_approval' });
    expect(await currentThreshold('reseller_payout_batch')).toBeNull();
  });

  it('records the threshold in force on each request', async () => {
    await setThreshold('wallet_adjustment', '500000');
    const { client } = await asRole('accounts');
    const { id } = await requestApproval(client, 'wallet_adjustment', '7');
    const rows = await auditRowsFor(ORG_A, id);
    expect(rows[0]?.after).toMatchObject({ thresholdPoisha: '500000' });
  });
});

describe('events', () => {
  it('announces nothing for a request whose transaction rolled back', async () => {
    const approvals = harness.app.get(ApprovalsService);
    approvals.emitted.length = 0;

    const { client } = await asRole('org_admin');
    // An unknown branch fails the composite FK after the insert was attempted.
    const attempt = await client.request('POST', '/v1/approvals', {
      body: { type: 'wallet_adjustment', amountPoisha: '1', branchId: crypto.randomUUID() },
    });
    expect(attempt.statusCode, attempt.body).toBe(400);
    expect(approvals.emitted).toEqual([]);
  });
});

describe('GET /v1/approvals', () => {
  it('lists for an org-wide checker (it was a 500 for everyone)', async () => {
    const { client: maker } = await asRole('accounts');
    const { id } = await requestApproval(maker, 'supplier_payment', '900000000');

    const { client } = await asRole('accounts');
    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    expect(parse<{ id: string }[]>(response.body).map((row) => row.id)).toContain(id);
  });

  it('shows a branch manager their branch’s requests and not another’s', async () => {
    const { client: maker } = await asRole('org_admin');
    const inA = await requestApproval(maker, 'stock_write_off', '999999999', { branchId: branchA });
    const inB = await requestApproval(maker, 'stock_write_off', '999999999', { branchId: branchB });

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    const ids = parse<{ id: string }[]>(response.body).map((row) => row.id);

    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
  });

  it('does not show hr the supplier payments it cannot decide', async () => {
    const { client: maker } = await asRole('accounts');
    const { id } = await requestApproval(maker, 'supplier_payment', '900000000');

    const { client } = await asRole('hr');
    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    expect(parse<{ id: string }[]>(response.body).map((row) => row.id)).not.toContain(id);
  });
});

describe('asRole covers every role, so none is untested by accident', () => {
  it.each(MEMBERSHIP_ROLES)('can sign in and act as %s', async (role) => {
    const { client } = await asRole(role);
    const me = await client.request('GET', '/v1/me');

    expect(me.statusCode, me.body).toBe(200);
    expect(parse(me.body)).toMatchObject({ roles: [role] });
  });
});
