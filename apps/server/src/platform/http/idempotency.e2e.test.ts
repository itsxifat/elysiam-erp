import { randomUUID } from 'node:crypto';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startHttpHarness,
  ORG_A,
  ORG_B,
  type Client,
  type HttpHarness,
} from '../../testing/http-harness.js';
import { IDEMPOTENCY_HEADER, IDEMPOTENCY_REPLAYED_HEADER } from './idempotency.js';

/**
 * `Idempotency-Key` end to end, against real Postgres (architecture §23).
 *
 * Driven through `POST /v1/demo/costed-items` because it does the one thing that
 * makes the test meaningful: it inserts a row and returns its id. So "the reply
 * was replayed" and "nothing happened twice" are both observable — the second
 * response must carry the *same* id, and the table must hold *one* row. A route
 * that only echoed its input could pass this suite while creating two records.
 *
 * Every assertion here is about a failure that happens on real hardware: the
 * order desk works over mobile data, a reply is lost, and the operator taps
 * again.
 */

const CREATE = '/v1/demo/costed-items';

/** An RFC 9457 body, typed enough to assert on. */
const problem = (body: string) =>
  JSON.parse(body) as { code?: string; instance?: string; status?: number };

let harness: HttpHarness;

beforeAll(async () => {
  harness = await startHttpHarness('idempotency');
}, 180_000);

afterAll(async () => {
  await harness.close();
});

/** Rows in `demo.costed_items` with this sku, read as the owner so RLS is not the question. */
async function rowCount(orgId: string, sku: string): Promise<number> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ count: string }>(sql`
        select count(*)::text as count from demo.costed_items
        where org_id = ${orgId}::uuid and sku = ${sku}
      `),
    { orgId },
  );
  return Number(rows[0]?.count ?? '0');
}

async function records(orgId: string): Promise<
  {
    route: string;
    idempotency_key: string;
    status_code: number | null;
    completed_at: Date | null;
  }[]
> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{
        route: string;
        idempotency_key: string;
        status_code: number | null;
        completed_at: Date | null;
      }>(sql`
        select route, idempotency_key, status_code, completed_at
        from http.idempotency_keys
        where org_id = ${orgId}::uuid
        order by created_at
      `),
    { orgId },
  );
  return [...rows];
}

const post = (client: Client, sku: string, key?: string) =>
  client.request('POST', CREATE, {
    body: { sku, name: 'Replay fixture' },
    ...(key === undefined ? {} : { headers: { [IDEMPOTENCY_HEADER]: key } }),
  });

describe('a repeated mutation (§23)', () => {
  it('runs once and replays the same answer', async () => {
    const { client } = await harness.asRole('org_admin');
    const key = randomUUID();
    const sku = `SKU-${key.slice(0, 8)}`;

    const first = await post(client, sku, key);
    const second = await post(client, sku, key);

    expect(first.statusCode).toBe(201);
    // The status is replayed too, not defaulted to 200: Nest applies a POST's
    // 201 only after every interceptor has returned, so the stored status has to
    // come from the route's declaration rather than from the reply.
    expect(second.statusCode).toBe(201);
    expect(second.body).toBe(first.body);
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    expect(first.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();

    // The whole point: one row, one id.
    expect(await rowCount(ORG_A, sku)).toBe(1);
  });

  it('is a fresh request when no key is sent, which is how the surface behaved before', async () => {
    const { client } = await harness.asRole('org_admin');
    const sku = `SKU-${randomUUID().slice(0, 8)}`;

    const first = await post(client, sku);
    // The same body again, with no key. `demo.costed_items` is unique on
    // (org_id, sku), so if this were being replayed it would answer 201 with the
    // first id; that it *fails* is the proof the insert really ran a second time.
    const second = await post(client, sku);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect(await rowCount(ORG_A, sku)).toBe(1);
  });

  it('refuses a key reused for a different body instead of replaying the old answer', async () => {
    // Replaying here would hand the operator a receipt for a different amount
    // than the one they just submitted — the worst available outcome.
    const { client } = await harness.asRole('org_admin');
    const key = randomUUID();

    const first = await post(client, `SKU-${key.slice(0, 8)}-a`, key);
    const clash = await post(client, `SKU-${key.slice(0, 8)}-b`, key);

    expect(first.statusCode).toBe(201);
    expect(clash.statusCode).toBe(409);
    expect(JSON.parse(clash.body)).toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
      type: '/problems/idempotency-conflict',
    });
    expect(await rowCount(ORG_A, `SKU-${key.slice(0, 8)}-b`)).toBe(0);
  });

  it('is blind to the order the client built its body in', async () => {
    const { client } = await harness.asRole('org_admin');
    const key = randomUUID();
    const sku = `SKU-${key.slice(0, 8)}`;

    const first = await client.request('POST', CREATE, {
      body: { sku, name: 'Replay fixture' },
      headers: { [IDEMPOTENCY_HEADER]: key },
    });
    // A manual retry rebuilds the body from state, in a different order.
    const retry = await client.request('POST', CREATE, {
      body: { name: 'Replay fixture', sku },
      headers: { [IDEMPOTENCY_HEADER]: key },
    });

    expect(retry.statusCode).toBe(201);
    expect(retry.body).toBe(first.body);
  });

  it("keeps one user out of another user's records", async () => {
    const a = await harness.asRole('org_admin');
    const b = await harness.asRole('org_admin');
    const key = randomUUID();

    const first = await post(a.client, `SKU-${key.slice(0, 8)}-a`, key);
    const other = await post(b.client, `SKU-${key.slice(0, 8)}-b`, key);

    // §23 scopes the record per user. Two operators legitimately send the same
    // client-generated key, and one must not receive the other's response.
    expect(first.statusCode).toBe(201);
    expect(other.statusCode).toBe(201);
    expect(other.body).not.toBe(first.body);
  });

  it("keeps one org out of another org's records", async () => {
    const key = randomUUID();
    const sku = `SKU-${key.slice(0, 8)}`;
    const a = await harness.asRole('org_admin', ORG_A);
    const b = await harness.asRole('org_admin', ORG_B);

    const inA = await post(a.client, sku, key);
    const inB = await post(b.client, sku, key);

    expect(inA.statusCode).toBe(201);
    expect(inB.statusCode).toBe(201);
    expect(inB.body).not.toBe(inA.body);
    expect(await rowCount(ORG_A, sku)).toBe(1);
    expect(await rowCount(ORG_B, sku)).toBe(1);
  });

  it('refuses a key too short or too strange to be a client-generated one', async () => {
    const { client } = await harness.asRole('org_admin');

    for (const key of ['1', 'has a space', 'line\nbreak']) {
      const refused = await post(client, 'SKU-bad', key);
      expect(refused.statusCode, key).toBe(400);
      expect(problem(refused.body).code, key).toBe('IDEMPOTENCY_KEY_INVALID');
    }
    // Refused before anything ran.
    expect(await rowCount(ORG_A, 'SKU-bad')).toBe(0);
  });

  it('ignores the header on a read, which has nothing to replay', async () => {
    const { client } = await harness.asRole('org_admin');
    const key = randomUUID();

    const first = await client.request('GET', CREATE, {
      headers: { [IDEMPOTENCY_HEADER]: key },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();
    expect(
      (await records(ORG_A)).some((record) => record.idempotency_key === key),
      'a GET must not be recorded',
    ).toBe(false);
  });

  it('stores the record against the route template and the completed status', async () => {
    const { client } = await harness.asRole('org_admin');
    const key = randomUUID();
    await post(client, `SKU-${key.slice(0, 8)}`, key);

    const record = (await records(ORG_A)).find((entry) => entry.idempotency_key === key);
    expect(record?.route).toBe('POST /v1/demo/costed-items');
    expect(record?.status_code).toBe(201);
    expect(record?.completed_at).not.toBeNull();
  });

  it('gives the key back when the attempt failed, so the retry is not locked out', async () => {
    const { client } = await harness.asRole('org_admin');
    const key = randomUUID();

    // A duplicate sku violates demo.costed_items' unique index, so the handler
    // throws — and holding the reservation would turn a momentary failure into a
    // 24-hour one for a client that is retrying with the same key, as it should.
    const sku = `SKU-${randomUUID().slice(0, 8)}`;
    await post(client, sku);
    const failed = await post(client, sku, key);
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);

    expect(
      (await records(ORG_A)).some((entry) => entry.idempotency_key === key),
      'a failed attempt must not leave a reservation behind',
    ).toBe(false);
  });

  it('answers a replay without writing a second audit row', async () => {
    // A replayed response mutated nothing. An audit row for it would show two
    // cash entries where one happened, which is the log's whole value gone.
    const { client } = await harness.asRole('org_admin');
    const key = randomUUID();
    const sku = `SKU-${key.slice(0, 8)}`;

    const first = await post(client, sku, key);
    const { id } = JSON.parse(first.body) as { id: string };
    await post(client, sku, key);

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ count: string }>(sql`
          select count(*)::text as count from audit.audit_log
          where org_id = ${ORG_A}::uuid and entity_id = ${id}
        `),
      { orgId: ORG_A },
    );
    expect(Number(rows[0]?.count ?? '0')).toBe(1);
  });
});

describe('problem+json (§23, RFC 9457)', () => {
  it('shapes an ability refusal as problem details with a stable code', async () => {
    const { client } = await harness.asRole('sales');
    const refused = await client.request('POST', CREATE, { body: { sku: 'SKU-x' } });

    expect(refused.statusCode).toBe(403);
    expect(refused.headers['content-type']).toContain('application/problem+json');
    expect(JSON.parse(refused.body)).toMatchObject({
      type: '/problems/forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'FORBIDDEN',
      instance: CREATE,
    });
  });

  it('turns an anonymous request away as problem details too', async () => {
    const client = harness.client();
    await client.request('GET', '/health/live');
    const refused = await client.request('GET', CREATE);

    expect(refused.statusCode).toBe(401);
    expect(problem(refused.body).code).toBe('UNAUTHENTICATED');
  });

  it('never puts a query string in `instance`', async () => {
    // A filter here carries a customer phone number, and an error body is the
    // thing most likely to be pasted into a bug report (invariant 10).
    const { client } = await harness.asRole('sales');
    const refused = await client.request('POST', `${CREATE}?phone=01712345678`, {
      body: { sku: 'SKU-x' },
    });
    expect(problem(refused.body).instance).toBe(CREATE);
  });
});
