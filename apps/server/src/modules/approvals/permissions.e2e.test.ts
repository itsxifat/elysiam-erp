import { assertNoCostFields, MEMBERSHIP_ROLES, NEVER_AUTO_APPROVE_TYPES } from '@elysium/contracts';
import { withOrg, withSystem } from '@elysium/db';
import { asUser, grantMembership } from '@elysium/db/testing';
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
import type { ActiveContext } from '../../platform/http/context.js';
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

/**
 * The rows of a page of `GET /v1/approvals`.
 *
 * The endpoint returns `{ rows, nextCursor }` per §23 rather than a bare
 * array; this keeps the assertions about membership rather than about shape.
 */
function pageRows<T>(body: string): T[] {
  return (JSON.parse(body) as { rows: T[] }).rows;
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
      ['its decision note', () => sql`decision_note = 'rewritten'`],
      ['its reason', () => sql`reason = 'rewritten'`],
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
      ['its amount source', () => sql`amount_derived_by_server = true`],
      ['its reason', () => sql`reason = 'rewritten'`],
      ['its creation time', () => sql`created_at = now() - interval '1 day'`],
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
    const { client: maker } = await asRole('accounts');

    const below = await requestApproval(maker, 'wallet_adjustment', '499999');
    const belowEvents = (await outboxFor(below.id)).map((event) => [
      event.name,
      event.payload.status ?? event.payload.decision,
    ]);

    const at = await requestApproval(maker, 'wallet_adjustment', '500000');
    const atEvents = (await outboxFor(at.id)).map((event) => [
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
    const { client: maker } = await asRole('org_admin');
    const { client: checker } = await asRole('org_admin');

    const { id } = await requestApproval(maker, 'wallet_adjustment', '900000');
    await checker.request('POST', `/v1/approvals/${id}/decide`, { body: { decision: 'approved' } });

    const events = await outboxFor(id);
    // Both events, in order: the request that was held, then the decision.
    expect(events.map((event) => event.name)).toEqual(['approval.requested', 'approval.decided']);
    expect(events[1]?.payload).toMatchObject({ id, decision: 'approved' });
  });
});

describe('the branch-tier checker (§6 "branch items under threshold", M1, D-076)', () => {
  /**
   * A branch item the way the owning module will raise it: amount derived by
   * the system (M07's WAC valuation), through the service rather than the
   * generic route — which can only ever send a typed amount.
   */
  async function derivedBranchRequest(branchId: string | null, amount: string): Promise<string> {
    const { userId } = await asRole('org_admin');
    const context = (await asUser(userId, ORG_A)) as ActiveContext;
    const held = await harness.app.get(ApprovalsService).request(context, {
      type: 'stock_gain',
      amountPoisha: BigInt(amount),
      amountDerivedByServer: true,
      ...(branchId === null ? {} : { branchId }),
    });
    // Branch items are never auto-approved, even under the threshold.
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
    const id = await derivedBranchRequest(branchA, '5000');

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const decided = await decideAs(client, id);
    expect(decided.statusCode, decided.body).toBe(201);
  });

  it('refuses the same item when its amount was typed by a person (final pass W3)', async () => {
    await setThreshold('stock_gain', '10000000');
    const { client: maker } = await asRole('org_admin');
    const typed = await requestApproval(maker, 'stock_gain', '5000', { branchId: branchA });
    expect(typed.status).toBe('pending');

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, typed.id);
    expect(attempt.statusCode, attempt.body).toBe(403);
    expect(attempt.body).toMatch(/derived/);
  });

  it('refuses another branch’s item, as not found', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await derivedBranchRequest(branchB, '5000');

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(404);
  });

  it('judges the branch on the branch-tier role alone, not the union with hr (C2)', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await derivedBranchRequest(branchB, '5000');

    const { client } = await asRole(['hr', 'branch_manager'], ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(403);
    expect(attempt.body).toMatch(/own branches/);

    // The positive control: the same person may decide their own branch's.
    const own = await derivedBranchRequest(branchA, '5000');
    expect((await decideAs(client, own)).statusCode).toBe(201);
  });

  it('refuses an item at or above the threshold', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await derivedBranchRequest(branchA, '10000000');

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(403);
    expect(attempt.body).toMatch(/threshold/);
  });

  it('refuses when no threshold was configured when the request was raised', async () => {
    const id = await withNoThreshold('stock_gain', () => derivedBranchRequest(branchA, '1'));
    expect(await currentThreshold('stock_gain')).not.toBeNull();

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const attempt = await decideAs(client, id);
    expect(attempt.statusCode, attempt.body).toBe(403);
  });

  it('refuses an org-level item with no branch', async () => {
    await setThreshold('stock_gain', '10000000');
    const id = await derivedBranchRequest(null, '5');

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
    const ids = pageRows<{ id: string }>(response.body).map((row) => row.id);
    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
  });
});

describe('a type right and its branch scope come from the same role (C-1)', () => {
  async function raise(client: Client, branchId?: string) {
    return client.request('POST', '/v1/approvals', {
      body: {
        type: 'wallet_adjustment',
        amountPoisha: '499999',
        ...(branchId === undefined ? {} : { branchId }),
      },
    });
  }

  it('refuses branch_manager@A + warehouse raising a wallet adjustment for B, or for no branch', async () => {
    await setThreshold('wallet_adjustment', '500000');
    const { client, userId } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    // warehouse is org-wide for `request`, but may not raise a wallet adjustment.
    await grantMembership({ userId, orgId: ORG_A, role: 'warehouse' });

    expect((await raise(client, branchB)).statusCode).toBe(403);

    // No branch: branch_manager's only branch is inferred, so name none and
    // hold two roles — the inference comes from the wallet-capable role alone.
    const inferred = await raise(client);
    expect(inferred.statusCode, inferred.body).toBe(201);
    const { id } = parse<{ id: string }>(inferred.body);
    const [row] = await withSystem(
      async (tx) =>
        tx.execute<{ branch_id: string | null }>(
          sql`select branch_id from approvals.approval_requests where id = ${id}`,
        ),
      { orgId: ORG_A },
    );
    expect(row?.branch_id, 'never an org-level request').toBe(branchA);
  });

  it('refuses a branch manager with two branches naming none', async () => {
    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA, branchB] });
    const attempt = await raise(client);
    expect(attempt.statusCode, attempt.body).toBe(403);
  });

  it('refuses hr + branch_manager@A raising a wallet adjustment for B', async () => {
    const { client } = await asRole(['hr', 'branch_manager'], ORG_A, { branchIds: [branchA] });
    expect((await raise(client, branchB)).statusCode).toBe(403);
  });

  it('lets the same caller raise it for their own branch (the positive control)', async () => {
    const { client } = await asRole(['hr', 'branch_manager'], ORG_A, { branchIds: [branchA] });
    const own = await raise(client, branchA);
    expect(own.statusCode, own.body).toBe(201);
  });
});

describe('nobody approves for whoever granted them their role (final pass W4, D-077)', () => {
  async function grantedBy(userId: string, granter: string): Promise<void> {
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update iam.memberships set granted_by = ${granter}
          where user_id = ${userId} and org_id = ${ORG_A}
        `);
      },
      { orgId: ORG_A },
    );
  }

  it('refuses a checker granted by the requester, and one granted down that chain', async () => {
    const { client: x, userId: xId } = await asRole('org_admin');
    const { client: y, userId: yId } = await asRole('org_admin');
    const { client: z, userId: zId } = await asRole('org_admin');
    await grantedBy(yId, xId);
    await grantedBy(zId, yId);

    const { id } = await requestApproval(x, 'wallet_adjustment', '900000000');

    const byY = await y.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });
    expect(byY.statusCode, byY.body).toBe(403);
    expect(byY.body).toMatch(/granted you/);

    const byZ = await z.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });
    expect(byZ.statusCode, byZ.body).toBe(403);

    // The positive control: an admin outside that lineage may decide it.
    const { client: other } = await asRole('org_admin');
    const byOther = await other.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });
    expect(byOther.statusCode, byOther.body).toBe(201);
  });

  it('records who granted a membership created through the API', async () => {
    const { client, userId } = await asRole('org_admin');
    const email = `granted_${String(Date.now())}@example.invalid`;
    const created = await client.request('POST', '/v1/users', {
      body: { email, name: 'Granted', role: 'accounts', branchIds: [] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { userId: newUser } = parse<{ userId: string }>(created.body);

    const [row] = await withSystem(
      async (tx) =>
        tx.execute<{ granted_by: string | null }>(sql`
          select granted_by from iam.memberships where user_id = ${newUser} and org_id = ${ORG_A}
        `),
      { orgId: ORG_A },
    );
    expect(row?.granted_by).toBe(userId);
  });
});

describe('threshold changes, as a checker sees and decides them (final pass W1, W2)', () => {
  it('shows the terms of a threshold change in the list and the decide view', async () => {
    await setThreshold('supplier_payment', '1000');
    const { client: admin } = await asRole('org_admin');
    const proposed = await admin.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'supplier_payment', thresholdPoisha: '5000' },
    });
    const { approvalId } = parse<{ approvalId: string }>(proposed.body);

    const { client: checker } = await asRole('org_admin');
    const listed = pageRows<{ id: string; thresholdChange: unknown }>(
      (await checker.request('GET', '/v1/approvals')).body,
    ).find((row) => row.id === approvalId);
    const terms = { targetType: 'supplier_payment', fromPoisha: '1000', toPoisha: '5000' };
    expect(listed?.thresholdChange).toEqual(terms);

    const view = await checker.request('GET', `/v1/approvals/${approvalId}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(parse(view.body)).toMatchObject({ type: 'threshold_change', thresholdChange: terms });
  });

  it('refuses to apply a raise over a threshold that was lowered in the meantime', async () => {
    await setThreshold('supplier_payment', '1000');
    const { client: admin } = await asRole('org_admin');
    const proposed = await admin.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'supplier_payment', thresholdPoisha: '9000' },
    });
    const { approvalId } = parse<{ approvalId: string }>(proposed.body);

    const lowered = await admin.request('PUT', '/v1/approvals/thresholds', {
      body: { type: 'supplier_payment', thresholdPoisha: '500' },
    });
    expect(parse(lowered.body)).toMatchObject({ status: 'applied' });

    const { client: checker } = await asRole('org_admin');
    const approved = await checker.request('POST', `/v1/approvals/${approvalId}/decide`, {
      body: { decision: 'approved' },
    });
    expect(approved.statusCode, approved.body).toBe(409);
    expect(await currentThreshold('supplier_payment'), 'the lowering stands').toBe('500');
  });

  it('withholds a WAC-valued amount in the decide view too (D-074)', async () => {
    const { client: maker } = await asRole('warehouse');
    const { id } = await requestApproval(maker, 'stock_write_off', '4343', { branchId: branchA });

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const view = await client.request('GET', `/v1/approvals/${id}`);
    expect(view.statusCode, view.body).toBe(200);
    expect(parse(view.body)).toMatchObject({ amountPoisha: null, amountWithheld: true });
    expect(view.body).not.toContain('4343');
  });

  it('answers a request the caller may not see with 404', async () => {
    const { client: maker } = await asRole('accounts');
    const { id } = await requestApproval(maker, 'supplier_payment', '900000000');

    const { client } = await asRole('hr');
    expect((await client.request('GET', `/v1/approvals/${id}`)).statusCode).toBe(404);
  });
});

describe('the payload carries no second amount (D-078)', () => {
  it('refuses a payload that names an amount, at any depth', async () => {
    const { client } = await asRole('accounts');
    for (const payload of [{ amountPoisha: '1' }, { lines: [{ total_poisha: 5 }] }]) {
      const attempt = await client.request('POST', '/v1/approvals', {
        body: { type: 'supplier_payment', amountPoisha: '100', payload },
      });
      expect(attempt.statusCode, attempt.body).toBe(400);
    }
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

  it('refuses period_reopen here, with an amount or without', async () => {
    const { client } = await asRole('accounts');
    const withAmount = await client.request('POST', '/v1/approvals', {
      body: { type: 'period_reopen', amountPoisha: '0' },
    });
    expect(withAmount.statusCode, withAmount.body).toBe(400);

    // And without one it is still refused here: only the ledger raises it,
    // with a payload it wrote (M03, D-081). The ledger suite proves it is held.
    const generic = await client.request('POST', '/v1/approvals', {
      body: { type: 'period_reopen', amountPoisha: null },
    });
    expect(generic.statusCode, generic.body).toBe(400);
    expect(generic.body).toMatch(/raised through its own endpoint/);
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
    const seen = pageRows<{ id: string; amountPoisha: string | null; amountWithheld: boolean }>(
      (await manager.request('GET', '/v1/approvals')).body,
    ).find((row) => row.id === id);
    expect(seen).toMatchObject({ amountPoisha: null, amountWithheld: true });

    // The positive control: a cost reader sees it.
    const { client: admin } = await asRole('org_admin');
    const full = pageRows<{ id: string; amountPoisha: string | null }>(
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

describe('events go through the outbox, in the caller’s transaction (§19, check 1)', () => {
  /** Undelivered rows across the whole org, for a before/after comparison. */
  async function outboxCount(): Promise<number> {
    const rows = await withSystem(
      async (tx) => tx.execute<{ count: string }>(sql`select count(*) as count from events.outbox`),
      { orgId: ORG_A },
    );
    return Number(rows[0]?.count ?? 0);
  }

  it('announces nothing for a request whose transaction rolled back', async () => {
    /*
     * Check 1 of this milestone: a job enqueued inside a transaction that rolls
     * back never runs.
     *
     * This used to assert on an in-memory array, which made it a test about
     * whether a method had been called after commit. Now the event is a row
     * written *inside* the transaction, so the rollback story belongs to
     * PostgreSQL rather than to our ordering — which is the whole reason
     * invariant 6 asks for an outbox instead of a post-commit callback.
     */
    const before = await outboxCount();

    const { client } = await asRole('org_admin');
    // An unknown branch fails the composite FK after the insert was attempted,
    // so the row and its event are both already written when it fails.
    const attempt = await client.request('POST', '/v1/approvals', {
      body: { type: 'wallet_adjustment', amountPoisha: '1', branchId: crypto.randomUUID() },
    });

    expect(attempt.statusCode, attempt.body).toBe(400);
    expect(await outboxCount(), 'a rolled-back request left an event behind').toBe(before);
  });

  it('writes one for a request that commits', async () => {
    // The positive control. Without it the assertion above passes just as well
    // on a system that never writes events at all.
    const before = await outboxCount();
    const { client } = await asRole('accounts');
    await requestApproval(client, 'supplier_payment', '900000000');

    expect(await outboxCount()).toBeGreaterThan(before);
  });
});

/**
 * The outbox rows one approval produced, newest last.
 *
 * Reads `events.outbox` rather than a field on the service. The service used to
 * keep its events in an in-memory ring and these tests read that — which
 * asserted that a method had been called, not that anything had been recorded.
 * A replica would never have seen those events and a restart would have lost
 * them, and `.claude/rules` says events go only through the outbox.
 */
async function outboxFor(
  approvalId: string,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ name: string; payload: Record<string, unknown> }>(sql`
        select name, payload from events.outbox
        where payload->>'id' = ${approvalId}
        order by created_at
      `),
    { orgId: ORG_A },
  );
  return [...rows];
}

describe('GET /v1/approvals', () => {
  it('lists for an org-wide checker (it was a 500 for everyone)', async () => {
    const { client: maker } = await asRole('accounts');
    const { id } = await requestApproval(maker, 'supplier_payment', '900000000');

    const { client } = await asRole('accounts');
    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    expect(pageRows<{ id: string }>(response.body).map((row) => row.id)).toContain(id);
  });

  it('shows a branch manager their branch’s requests and not another’s', async () => {
    const { client: maker } = await asRole('org_admin');
    const inA = await requestApproval(maker, 'stock_write_off', '999999999', { branchId: branchA });
    const inB = await requestApproval(maker, 'stock_write_off', '999999999', { branchId: branchB });

    const { client } = await asRole('branch_manager', ORG_A, { branchIds: [branchA] });
    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    const ids = pageRows<{ id: string }>(response.body).map((row) => row.id);

    expect(ids).toContain(inA.id);
    expect(ids).not.toContain(inB.id);
  });

  it('does not show hr the supplier payments it cannot decide', async () => {
    const { client: maker } = await asRole('accounts');
    const { id } = await requestApproval(maker, 'supplier_payment', '900000000');

    const { client } = await asRole('hr');
    const response = await client.request('GET', '/v1/approvals');
    expect(response.statusCode, response.body).toBe(200);
    expect(pageRows<{ id: string }>(response.body).map((row) => row.id)).not.toContain(id);
  });
});

describe('GET /v1/approvals pages, filters and bounds (§23)', () => {
  /*
   * §23 asks for cursor pagination — `?cursor=&limit=50`, maximum 200 — and
   * Zod-validated filters on every list. This one had `limit 100` and nothing
   * else, which is a silent truncation: the hundred-and-first request pushed an
   * older *pending* supplier payment off the end of the only endpoint that
   * lists them, its id is discoverable nowhere else, and the list looked
   * perfectly healthy while the checker could not find what they were there to
   * decide.
   */
  it('pages with a cursor instead of stopping at a limit', async () => {
    const { client } = await asRole('accounts');
    for (let i = 0; i < 5; i += 1) {
      await requestApproval(client, 'supplier_payment', String(900000000 + i));
    }

    const firstResponse = await client.request('GET', '/v1/approvals?limit=2');
    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const first = parse<{ rows: { id: string }[]; nextCursor: string | null }>(firstResponse.body);

    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor, 'there are more rows, so there must be a cursor').not.toBeNull();

    const second = parse<{ rows: { id: string }[]; nextCursor: string | null }>(
      (
        await client.request(
          'GET',
          `/v1/approvals?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
        )
      ).body,
    );

    expect(second.rows).toHaveLength(2);
    // The pages must not overlap. A boundary inside a same-millisecond group is
    // exactly where an offset page repeats or drops a row, which is why the
    // cursor is the composite `created_at,id`.
    const firstIds = new Set(first.rows.map((row) => row.id));
    for (const row of second.rows) {
      expect(firstIds.has(row.id), `${row.id} appeared on both pages`).toBe(false);
    }
  });

  it('stops offering a cursor on the last page', async () => {
    const { client } = await asRole('accounts');
    const page = parse<{ nextCursor: string | null }>(
      (await client.request('GET', '/v1/approvals?limit=200')).body,
    );
    expect(page.nextCursor).toBeNull();
  });

  it('filters by status, so a checker can ask for what is still open', async () => {
    const { client: maker } = await asRole('accounts');
    const { id } = await requestApproval(maker, 'supplier_payment', '900000000');

    const { client: checker } = await asRole('accounts');
    const decided = await checker.request('POST', `/v1/approvals/${id}/decide`, {
      body: { decision: 'approved' },
    });
    expect(decided.statusCode, decided.body).toBeLessThan(400);

    const pending = pageRows<{ id: string }>(
      (await checker.request('GET', '/v1/approvals?status=pending')).body,
    ).map((row) => row.id);
    expect(pending).not.toContain(id);

    // The positive control: findable under the status it now has, so the
    // absence above is the filter rather than the row having vanished.
    const approved = pageRows<{ id: string }>(
      (await checker.request('GET', '/v1/approvals?status=approved')).body,
    ).map((row) => row.id);
    expect(approved).toContain(id);
  });

  it('filters by type', async () => {
    const { client } = await asRole('accounts');
    const { id } = await requestApproval(client, 'settlement_posting', '4200');

    const same = pageRows<{ id: string }>(
      (await client.request('GET', '/v1/approvals?type=settlement_posting')).body,
    ).map((row) => row.id);
    const other = pageRows<{ id: string }>(
      (await client.request('GET', '/v1/approvals?type=supplier_payment')).body,
    ).map((row) => row.id);

    expect(same).toContain(id);
    expect(other).not.toContain(id);
  });

  it('refuses a limit outside §23’s bounds and a cursor Postgres could not cast', async () => {
    const { client } = await asRole('accounts');

    for (const query of [
      '?limit=0',
      '?limit=201',
      '?limit=abc',
      '?cursor=nonsense',
      // Shape-valid and uncastable: the regex that only checked shape turned
      // this into a 500 rather than the 400 it existed to produce.
      '?cursor=9999-99-99T99:99:99Z,------------------------------------',
      '?status=not_a_status',
    ]) {
      const response = await client.request('GET', `/v1/approvals${query}`);
      expect(response.statusCode, `${query}: ${response.body}`).toBe(400);
    }
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
