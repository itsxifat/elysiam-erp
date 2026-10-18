import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_QUEUES } from '../../job-queues.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  APP_DOMAIN,
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { silentWav } from './providers/envo-gateway.js';
import { TelephonyRecordingsService } from './recordings.service.js';
import { envoSignatureFor } from './signature.js';
import { TelephonySyncService } from './sync.service.js';
import { registerTelephonyJobs } from './telephony.worker.js';
import { TelephonyWebhookService } from './webhook.service.js';

/**
 * M47's acceptance checks on real Postgres, through the real routes and jobs, with the real Envo
 * adapter pointed at a stand-in for Envo on this machine (built from Envo's own `v1.ts` and
 * `webhooks.ts`):
 *
 * 1. A connection is saved with its key and secret sealed (never returned, only fingerprints);
 *    the Test reads its extensions and numbers; a wrong key is refused with Envo's reason.
 * 2. An extension is given to a person; their Call rings their extension, then the customer
 *    (Envo's `POST /api/v1/calls` from the extension to the national number), written and
 *    committed before Envo is asked; a person with no extension is told so; a colleague's order
 *    needs its owner acknowledged.
 * 3. A signed `call.started` and `call.ended` land on the click: the customer, the order and the
 *    person; an inbound call is linked by the caller's phone; a bad signature and an old
 *    timestamp are refused (and the connection says so); a repeated delivery is stored once.
 * 4. The recording is downloaded from the connection's own host into the files and plays for the
 *    person and a supervisor, not for another sales agent; a link to another host is never
 *    fetched. The outcome is M41's attempt, once. The sync fills a missed webhook.
 * 5. No key, secret or whole phone reaches the audit log; another brand sees none of it; the
 *    call record's origin cannot be rewritten.
 */

const KEY = 'envo_live_m47_test_key_0123456789abcdef';
const WRONG_KEY = 'envo_live_m47_wrong_key_000000000000';
const SECRET = 'whsec_m47_test_secret_0123456789';
const CUSTOMER_PHONE = '+8801812345678';
const INBOUND_PHONE = '+8801912345670';

interface EnvoRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
  /** Whether the click's row was already committed when Envo was asked (invariant 6). */
  readonly committedBefore?: boolean;
}

const envoRequests: EnvoRequest[] = [];
let history: { readonly startedAt: string }[] = [];
/** What the stand-in's `/api/v1/calls/live` answers, as Envo's `liveCalls` shapes it. */
let live: unknown[] = [];
let envo: Server;
let envoBase = '';
let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let salesA: RoleClient;
let salesB: RoleClient;
let manager: RoleClient;
let adminB: RoleClient;
let salesC: RoleClient;
let connectionId = '';
let customerId = '';
let orderA = { id: '', orderNo: '' };

function collect(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function committedClickExists(): Promise<boolean> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from telephony.calls
        where org_id = ${ORG_A} and first_seen = 'click' and status = 'requested'
      `);
      return (rows[0]?.n ?? 0) > 0;
    },
    { orgId: ORG_A },
  );
}

async function deliver(
  body: Record<string, unknown>,
  options: { secret?: string; timestamp?: number; org?: string; connection?: string } = {},
): Promise<InjectedResponse> {
  const raw = JSON.stringify(body);
  return harness.server.inject({
    method: 'POST',
    url: `/webhooks/envo/${options.org ?? ORG_A}/${options.connection ?? connectionId}`,
    headers: {
      host: APP_DOMAIN,
      'content-type': 'application/json',
      'x-forwarded-for': '10.9.9.8',
      'x-envo-event': String(body.event),
      'x-envo-delivery': '5f0b3c1e-1111-4a2b-9c3d-000000000001',
      'x-envo-signature': envoSignatureFor(raw, options.secret ?? SECRET, options.timestamp),
    },
    payload: raw,
  });
}

async function processed(): Promise<void> {
  await until(
    () =>
      withOrg({ orgId: ORG_A }, async (tx) => {
        const rows = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from telephony.webhook_events where processed_at is null`,
        );
        return rows[0]?.n === 0 ? true : undefined;
      }),
    'the webhook job',
  );
}

async function callRow(id: string) {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{
          id: string;
          envo_call_id: string | null;
          status: string;
          answered: boolean;
          user_id: string | null;
          customer_id: string | null;
          order_id: string | null;
          talk_seconds: number | null;
          recording_status: string;
          recording_error: string | null;
          direction: string;
          outcome: string | null;
        }>(sql`
          select id, envo_call_id, status, answered, user_id, customer_id, order_id, talk_seconds,
                 recording_status, recording_error, direction, outcome
          from telephony.calls where org_id = ${ORG_A} and id = ${id}
        `)
      )[0],
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  envo = createServer((request, response) => {
    void collect(request).then(async (body) => {
      const url = request.url ?? '';
      const authorization = request.headers.authorization;
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      const committedBefore =
        request.method === 'POST' && url === '/api/v1/calls'
          ? await committedClickExists()
          : undefined;
      envoRequests.push({
        method: request.method ?? '',
        url,
        authorization,
        body,
        ...(committedBefore === undefined ? {} : { committedBefore }),
      });
      if (authorization !== `Bearer ${KEY}`) {
        send(401, { error: 'Missing or invalid API key' });
        return;
      }
      if (url === '/api/v1/ping') {
        send(200, {
          ok: true,
          sipServer: { id: 7, name: 'Brand', slug: 'brand' },
          scopes: ['read', 'calls', 'webphone'],
          key: 'erp',
        });
      } else if (url === '/api/v1/extensions') {
        send(200, [
          {
            extension: '101',
            name: 'Desk 1',
            enabled: true,
            dnd: false,
            webPhone: true,
            online: true,
            status: 'idle',
          },
          {
            extension: '102',
            name: 'Desk 2',
            enabled: true,
            dnd: false,
            webPhone: true,
            online: false,
            status: 'unavailable',
          },
        ]);
      } else if (url === '/api/v1/numbers') {
        send(200, [
          {
            number: '09644342036',
            label: 'Hotline',
            channels: 4,
            destination_type: 'ring_group',
            destination: '600',
            enabled: true,
            trunk: 'BTCL',
          },
        ]);
      } else if (request.method === 'POST' && url === '/api/v1/calls') {
        const input = JSON.parse(body) as { from: string; to: string };
        send(202, {
          ok: true,
          extension: input.from,
          to: input.to,
          startedAt: new Date().toISOString(),
        });
      } else if (url === '/api/v1/webphone/token') {
        send(200, {
          token: 'jwt-for-the-web-phone-0123456789',
          extension: '101',
          expiresIn: 120,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          sipDomain: 'envo.example.test',
        });
      } else if (url.startsWith('/api/v1/calls?')) {
        // As Envo's `GET /calls`: `calldate >= from` and `< to`, newest first, paged.
        const query = new URL(url, 'http://envo.test').searchParams;
        const from = Date.parse(query.get('from') ?? '1970-01-01T00:00:00Z');
        const to = query.has('to') ? Date.parse(query.get('to') ?? '') : Infinity;
        const limit = Number(query.get('limit') ?? 50);
        const page = Number(query.get('page') ?? 1);
        const listed = history
          .filter((call) => Date.parse(call.startedAt) >= from && Date.parse(call.startedAt) < to)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        send(200, {
          calls: listed.slice((page - 1) * limit, page * limit),
          total: listed.length,
          page,
          limit,
        });
      } else if (url === '/api/v1/recordings/42?download=1') {
        const wav = silentWav(2);
        response.writeHead(200, {
          'content-type': 'audio/wav',
          'content-length': String(wav.byteLength),
        });
        response.end(Buffer.from(wav));
      } else if (url === '/api/v1/calls/live') {
        send(200, { calls: live });
      } else {
        send(404, { error: 'Not found' });
      }
    });
  });
  await new Promise<void>((resolve) => envo.listen(0, '127.0.0.1', resolve));
  envoBase = `http://127.0.0.1:${String((envo.address() as AddressInfo).port)}`;
  process.env.TELEPHONY_ENVO_PROVIDER = 'http';
  process.env.TELEPHONY_ALLOW_PLAIN_HTTP = 'true';

  harness = await startHttpHarness('m47-telephony');
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: ALL_QUEUES,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  await registerTelephonyJobs({
    jobs,
    webhooks: harness.app.get(TelephonyWebhookService),
    sync: harness.app.get(TelephonySyncService),
    recordings: harness.app.get(TelephonyRecordingsService),
    report: () => Promise.resolve(),
  });

  admin = await harness.asRole('org_admin', ORG_A);
  salesA = await harness.asRole('sales', ORG_A);
  salesB = await harness.asRole('sales', ORG_A);
  manager = await harness.asRole('branch_manager', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);
  salesC = await harness.asRole('sales', ORG_A);

  customerId = await seedCustomer(ORG_A, { phoneE164: CUSTOMER_PHONE, name: 'Rumana Akter' });
  orderA = await seedOrder(ORG_A, {
    status: 'pending',
    customerId,
    lines: [],
    assignedTo: salesA.userId,
    createdBy: salesA.userId,
  });
}, 300_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
  await new Promise<void>((resolve) => envo.close(() => resolve()));
  delete process.env.TELEPHONY_ENVO_PROVIDER;
  delete process.env.TELEPHONY_ALLOW_PLAIN_HTTP;
}, 60_000);

describe('check 1: a connection, sealed, tested', () => {
  it('saves the key and secret sealed, shows only fingerprints, and refuses a bad base URL', async () => {
    const refused = await admin.client.request('POST', '/v1/telephony/connections', {
      body: { name: 'Bad', baseUrl: `${envoBase}/api`, apiKey: KEY },
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(json<{ code: string }>(refused).code).toBe('TELEPHONY_INVALID');

    const created = await admin.client.request('POST', '/v1/telephony/connections', {
      body: { name: 'Envo', baseUrl: envoBase, apiKey: KEY, webhookSecret: SECRET },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.body).not.toContain(KEY);
    expect(created.body).not.toContain(SECRET);
    const view = json<{
      id: string;
      apiKeySet: boolean;
      apiKeyFingerprint: string;
      webhookSecretSet: boolean;
      webhookPath: string;
    }>(created);
    connectionId = view.id;
    expect(view).toMatchObject({ apiKeySet: true, webhookSecretSet: true });
    expect(view.webhookPath).toBe(`/webhooks/envo/${ORG_A}/${view.id}`);

    const stored = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ key: Buffer; secret: Buffer }>(sql`
            select api_key_sealed as key, webhook_secret_sealed as secret
            from telephony.connections where id = ${view.id}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(Buffer.from(stored?.key ?? []).toString('latin1')).not.toContain(KEY);
    expect(Buffer.from(stored?.secret ?? []).toString('latin1')).not.toContain(SECRET);

    const listed = await manager.client.request('GET', '/v1/telephony/connections');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain(KEY);
    const salesSees = await salesA.client.request('GET', '/v1/telephony/connections');
    expect(salesSees.statusCode).toBe(403);
  });

  it('tests: Envo’s extensions and numbers, with the key as a bearer token', async () => {
    const test = await admin.client.request(
      'POST',
      `/v1/telephony/connections/${connectionId}/test`,
    );
    expect(test.statusCode, test.body).toBe(200);
    const answer = json<{
      sipServer: { id: number };
      extensions: { extension: string }[];
      numbers: { number: string }[];
      missingScopes: string[];
    }>(test);
    expect(answer.sipServer.id).toBe(7);
    expect(answer.extensions.map((row) => row.extension)).toEqual(['101', '102']);
    expect(answer.numbers.map((row) => row.number)).toEqual(['09644342036']);
    expect(answer.missingScopes).toEqual([]);
    expect(
      envoRequests.some(
        (call) => call.url === '/api/v1/ping' && call.authorization === `Bearer ${KEY}`,
      ),
    ).toBe(true);
  });

  it('refuses a wrong key with a clear reason, and keeps the reason on the connection', async () => {
    const other = await admin.client.request('POST', '/v1/telephony/connections', {
      body: { name: 'Wrong', baseUrl: envoBase, apiKey: WRONG_KEY },
    });
    const id = json<{ id: string }>(other).id;
    const test = await admin.client.request('POST', `/v1/telephony/connections/${id}/test`);
    expect(test.statusCode, test.body).toBe(424);
    const problem = json<{ code: string; detail?: string; message?: string }>(test);
    expect(problem.code).toBe('TELEPHONY_ENVO_REFUSED');
    expect(test.body).toContain('Envo refused the API key');
    expect(test.body).not.toContain(WRONG_KEY);
    const listed = json<{
      connections: { id: string; lastTest: { ok: boolean; error: string } | null }[];
    }>(await admin.client.request('GET', '/v1/telephony/connections'));
    expect(listed.connections.find((row) => row.id === id)?.lastTest).toMatchObject({ ok: false });
  });
});

describe('check 2: an extension, and Call', () => {
  it('gives extension 101 to sales A: one person per extension, one extension per person', async () => {
    const given = await manager.client.request(
      'PUT',
      `/v1/telephony/connections/${connectionId}/extensions/101`,
      { body: { userId: salesA.userId } },
    );
    expect(given.statusCode, given.body).toBe(200);
    const twice = await admin.client.request(
      'PUT',
      `/v1/telephony/connections/${connectionId}/extensions/101`,
      { body: { userId: salesB.userId } },
    );
    expect(json<{ code: string }>(twice).code).toBe('TELEPHONY_EXTENSION_TAKEN');
    const second = await admin.client.request(
      'PUT',
      `/v1/telephony/connections/${connectionId}/extensions/102`,
      { body: { userId: salesA.userId } },
    );
    expect(json<{ code: string }>(second).code).toBe('TELEPHONY_EXTENSION_TAKEN');
    const extensions = json<{
      extensions: { extension: string; online: boolean; assignee: { id: string } | null }[];
    }>(await admin.client.request('GET', `/v1/telephony/connections/${connectionId}/extensions`));
    expect(extensions.extensions.find((row) => row.extension === '101')).toMatchObject({
      online: true,
      assignee: { id: salesA.userId },
    });
  });

  it('tells a person with no extension so', async () => {
    const refused = await salesB.client.request('POST', '/v1/telephony/calls', {
      body: { orderId: orderA.id },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(json<{ code: string }>(refused).code).toBe('TELEPHONY_NO_EXTENSION');
  });

  it('rings sales A’s extension, then the customer, after the click is committed', async () => {
    const before = envoRequests.length;
    const placed = await salesA.client.request('POST', '/v1/telephony/calls', {
      body: { orderId: orderA.id },
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const call = json<{ call: { id: string; status: string; order: { id: string } } }>(placed).call;
    expect(call.status).toBe('dialing');
    expect(call.order.id).toBe(orderA.id);
    const originate = envoRequests.slice(before).find((row) => row.url === '/api/v1/calls');
    expect(JSON.parse(originate?.body ?? '{}')).toEqual({ from: '101', to: '01812345678' });
    expect(originate?.committedBefore).toBe(true);

    // A second press is the same call.
    const again = await salesA.client.request('POST', '/v1/telephony/calls', {
      body: { orderId: orderA.id },
    });
    expect(json<{ repeated: boolean; call: { id: string } }>(again)).toMatchObject({
      repeated: true,
      call: { id: call.id },
    });
  });

  it('asks a colleague to acknowledge the order’s owner first', async () => {
    await admin.client.request('PUT', `/v1/telephony/connections/${connectionId}/extensions/102`, {
      body: { userId: salesB.userId },
    });
    const refused = await salesB.client.request('POST', '/v1/telephony/calls', {
      body: { orderId: orderA.id },
    });
    expect(json<{ code: string }>(refused).code).toBe('ORDER_HANDLED_BY_OTHER');
    const acked = await salesB.client.request('POST', '/v1/telephony/calls', {
      body: { orderId: orderA.id },
      headers: { 'x-acknowledge-owner': '1' },
    });
    expect(acked.statusCode, acked.body).toBe(201);
    const told = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from audit.audit_log
          where org_id = ${ORG_A} and action = 'order.acted_over_owner' and entity_id = ${orderA.id}
        `),
      { orgId: ORG_A },
    );
    expect(told[0]?.n).toBeGreaterThan(0);
  });
});

describe('check 3: Envo’s signed webhooks', () => {
  let clickId = '';

  it('lands call.started and call.ended on the click: customer, order and person', async () => {
    const list = json<{
      items: { id: string; user: unknown; person: { id: string } | null; status: string }[];
    }>(await salesA.client.request('GET', `/v1/telephony/calls?orderId=${orderA.id}`));
    clickId = list.items.find((row) => row.person?.id === salesA.userId)?.id ?? '';
    expect(clickId).not.toBe('');

    const started = await deliver({
      event: 'call.started',
      id: '1789455634.59',
      sipServer: { id: 7, name: 'Brand', slug: 'brand' },
      direction: null,
      from: '101',
      fromName: 'Desk 1',
      to: '01812345678',
      startedAt: new Date().toISOString(),
      answeredAt: null,
      durationSec: 0,
      talkSec: 0,
    });
    expect(started.statusCode, started.body).toBe(200);
    await processed();
    const ended = await deliver({
      event: 'call.ended',
      id: '1789455634.59',
      sipServer: { id: 7, name: 'Brand', slug: 'brand' },
      direction: 'outbound',
      from: '101',
      to: '01812345678',
      startedAt: new Date(Date.now() - 42_000).toISOString(),
      answeredAt: new Date(Date.now() - 38_000).toISOString(),
      endedAt: new Date().toISOString(),
      answered: true,
      disposition: 'answered',
      durationSec: 42,
      talkSec: 38,
      recordingUrl: `${envoBase}/api/v1/recordings/42`,
    });
    expect(ended.statusCode, ended.body).toBe(200);
    await processed();
    const row = await callRow(clickId);
    expect(row).toMatchObject({
      envo_call_id: '1789455634.59',
      status: 'ended',
      answered: true,
      talk_seconds: 38,
      user_id: salesA.userId,
      customer_id: customerId,
      order_id: orderA.id,
      direction: 'outbound',
    });
  });

  it('stores a repeated delivery once', async () => {
    const again = await deliver({
      event: 'call.ended',
      id: '1789455634.59',
      sipServer: { id: 7 },
      direction: 'outbound',
      from: '101',
      to: '01812345678',
      answered: true,
      talkSec: 38,
    });
    expect(json<{ duplicate: boolean }>(again).duplicate).toBe(true);
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from telephony.webhook_events
          where org_id = ${ORG_A} and envo_call_id = '1789455634.59' and event = 'call.ended'
        `),
      { orgId: ORG_A },
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('refuses a bad signature and an old timestamp, and the connection says so', async () => {
    const body = { event: 'call.ended', id: '1789455700.1', from: '01712345678', to: '096' };
    const bad = await deliver(body, { secret: 'whsec_not_the_secret_000' });
    expect(bad.statusCode).toBe(401);
    const old = await deliver(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(old.statusCode).toBe(401);
    expect(old.body).not.toContain('stale');
    const view = json<{
      connections: { id: string; lastSignatureFailure: { reason: string } | null }[];
    }>(await admin.client.request('GET', '/v1/telephony/connections'));
    expect(
      view.connections.find((row) => row.id === connectionId)?.lastSignatureFailure,
    ).not.toBeNull();
    const stored = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from telephony.webhook_events where envo_call_id = '1789455700.1'`,
        ),
      { orgId: ORG_A },
    );
    expect(stored[0]?.n).toBe(0);
  });

  it('acknowledges Envo’s test delivery without making a call', async () => {
    const test = await deliver({
      event: 'call.ended',
      id: '1789455800.1',
      test: true,
      from: '01712345678',
    });
    expect(json<{ ignored: string }>(test).ignored).toBe('test');
  });

  it('links an inbound call to the buyer by the caller’s phone, and to their open order', async () => {
    const inboundCustomer = await seedCustomer(ORG_A, { phoneE164: INBOUND_PHONE, name: 'Caller' });
    const open = await seedOrder(ORG_A, {
      status: 'confirmed',
      customerId: inboundCustomer,
      lines: [],
      assignedTo: salesB.userId,
    });
    const delivered = await deliver({
      event: 'call.ended',
      id: '1789455900.3',
      sipServer: { id: 7 },
      direction: 'inbound',
      from: '8801912345670',
      to: '09644342036',
      answered: false,
      disposition: 'no answer',
      talkSec: 0,
      durationSec: 20,
      recordingUrl: 'https://elsewhere.example/api/v1/recordings/42',
    });
    expect(delivered.statusCode).toBe(200);
    await processed();
    const row = await withSystem(
      async (tx) =>
        (
          await tx.execute<{
            customer_id: string;
            order_id: string;
            recording_status: string;
            recording_error: string;
          }>(sql`
            select customer_id, order_id, recording_status, recording_error
            from telephony.calls where envo_call_id = '1789455900.3'
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(row).toMatchObject({
      customer_id: inboundCustomer,
      order_id: open.id,
      recording_status: 'failed',
      recording_error: 'not_connection_host',
    });
    expect(envoRequests.some((call) => call.url.includes('elsewhere'))).toBe(false);
  });
});

describe('check 4: the recording, the outcome and the sync', () => {
  it('keeps the recording and plays it for its person and a supervisor, not another agent', async () => {
    const click = await until(
      () =>
        withSystem(
          async (tx) =>
            (
              await tx.execute<{ id: string }>(sql`
                select id from telephony.calls
                where envo_call_id = '1789455634.59' and recording_status = 'stored'
              `)
            )[0]?.id,
          { orgId: ORG_A },
        ),
      'the recording',
    );
    const own = await salesA.client.request('GET', `/v1/telephony/calls/${click}/recording`);
    expect(own.statusCode).toBe(200);
    expect(own.headers['content-type']).toBe('audio/wav');
    expect(own.body.slice(0, 4)).toBe('RIFF');
    const boss = await manager.client.request('GET', `/v1/telephony/calls/${click}/recording`);
    expect(boss.statusCode).toBe(200);
    const other = await salesB.client.request('GET', `/v1/telephony/calls/${click}/recording`);
    expect(other.statusCode).toBe(404);
    const download = envoRequests.find((call) => call.url === '/api/v1/recordings/42?download=1');
    expect(download?.authorization).toBe(`Bearer ${KEY}`);
  });

  it('records the verification outcome on the order once, as M41’s attempt', async () => {
    const click = (
      await withSystem(
        async (tx) =>
          tx.execute<{ id: string }>(
            sql`select id from telephony.calls where envo_call_id = '1789455634.59'`,
          ),
        { orgId: ORG_A },
      )
    )[0]?.id;
    const recorded = await salesA.client.request('POST', `/v1/telephony/calls/${click}/outcome`, {
      body: { outcome: 'reached' },
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const again = await salesA.client.request('POST', `/v1/telephony/calls/${click}/outcome`, {
      body: { outcome: 'reached' },
    });
    expect(json<{ code: string }>(again).code).toBe('TELEPHONY_OUTCOME_INVALID');
    const attempts = json<{ items: { outcome: string }[] }>(
      await salesA.client.request('GET', `/v1/orders/${orderA.id}/calls`),
    );
    expect(attempts.items.map((row) => row.outcome)).toContain('reached');
  });

  it('fills a missed webhook from Envo’s call history', async () => {
    history = [
      {
        id: '1789456000.7',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        direction: 'inbound',
        from: '01812345678',
        to: '09644342036',
        answered: true,
        disposition: 'answered',
        durationSec: 30,
        talkSec: 25,
        recordingUrl: null,
        legs: 2,
      },
    ];
    const synced = await harness.app.get(TelephonySyncService).syncConnection(ORG_A, connectionId);
    expect(synced.listed).toBe(1);
    const row = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ status: string; customer_id: string; first_seen: string }>(sql`
            select status, customer_id, first_seen from telephony.calls where envo_call_id = '1789456000.7'
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(row).toMatchObject({ status: 'ended', customer_id: customerId, first_seen: 'sync' });
  });

  it('mints a web phone token for the person’s own extension only', async () => {
    const token = await salesA.client.request('GET', '/v1/telephony/phone/token');
    expect(token.statusCode, token.body).toBe(200);
    expect(json<{ token: string; extension: string }>(token)).toMatchObject({ extension: '101' });
    const minted = envoRequests.filter((call) => call.url === '/api/v1/webphone/token').at(-1);
    expect(JSON.parse(minted?.body ?? '{}')).toEqual({ extension: '101', ttlSeconds: 120 });
  });
});

describe('check 5: secrets, phones, brands and the record', () => {
  it('writes no key, secret or whole phone into the audit log', async () => {
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ body: string }>(sql`
          select coalesce(before::text, '') || coalesce(after::text, '') as body
          from audit.audit_log where org_id = ${ORG_A}
            and (action like 'telephony.%' or action like 'phone_call.%')
        `),
      { orgId: ORG_A },
    );
    expect(rows.length).toBeGreaterThan(3);
    for (const row of rows) {
      expect(row.body).not.toContain(KEY);
      expect(row.body).not.toContain(SECRET);
      expect(row.body).not.toContain('01812345678');
      expect(row.body).not.toContain('8801812345678');
    }
  });

  it('shows another brand nothing, and refuses its path for this connection', async () => {
    const theirs = json<{ connections: unknown[] }>(
      await adminB.client.request('GET', '/v1/telephony/connections'),
    );
    expect(theirs.connections).toEqual([]);
    const calls = json<{ items: unknown[] }>(
      await adminB.client.request('GET', '/v1/telephony/calls'),
    );
    expect(calls.items).toEqual([]);
    const crossed = await deliver(
      { event: 'call.ended', id: '1789457000.1', from: '01712345678' },
      { org: ORG_B },
    );
    expect(crossed.statusCode).toBe(401);
    const visible = await withOrg({ orgId: ORG_B }, async (tx) =>
      tx.execute<{ n: number }>(sql`
        select (select count(*) from telephony.calls)::int
             + (select count(*) from telephony.connections)::int
             + (select count(*) from telephony.webhook_events)::int
             + (select count(*) from telephony.extension_assignments)::int as n
      `),
    );
    expect(visible[0]?.n).toBe(0);
  });

  it('keeps a call’s origin fixed and its status moving forward only', async () => {
    const click = (
      await withSystem(
        async (tx) =>
          tx.execute<{ id: string }>(
            sql`select id from telephony.calls where envo_call_id = '1789455634.59'`,
          ),
        { orgId: ORG_A },
      )
    )[0]?.id;
    const refusal = async (statement: ReturnType<typeof sql>): Promise<string> => {
      try {
        await withOrg({ orgId: ORG_A, userId: admin.userId }, (tx) => tx.execute(statement));
        return 'accepted';
      } catch (error) {
        const cause = (error as { cause?: { message?: string } }).cause;
        return `${(error as Error).message} ${cause?.message ?? ''}`;
      }
    };
    expect(
      await refusal(sql`update telephony.calls set status = 'ringing' where id = ${click}`),
    ).toMatch(/this call is over/);
    expect(
      await refusal(
        sql`update telephony.calls set occurred_at = now() - interval '1 day' where id = ${click}`,
      ),
    ).toMatch(/origin is fixed/);
    expect(await refusal(sql`delete from telephony.calls where id = ${click}`)).toMatch(
      /permission denied/,
    );
  });
});

/**
 * The review's permission and correctness paths (M47's ledger, tenancy and correctness audits):
 * who sees which call, the screen pop's reach, the answered claim, a late event, a base URL
 * changed without its key, and the nightly retention.
 */
describe('the review: scope, reach, claims and retention', () => {
  const clickOfA = async () =>
    (
      await withSystem(
        async (tx) =>
          tx.execute<{ id: string }>(
            sql`select id from telephony.calls where envo_call_id = '1789455634.59'`,
          ),
        { orgId: ORG_A },
      )
    )[0]?.id ?? '';
  const inboundOfB = async () =>
    (
      await withSystem(
        async (tx) =>
          tx.execute<{ id: string }>(
            sql`select id from telephony.calls where envo_call_id = '1789455900.3'`,
          ),
        { orgId: ORG_A },
      )
    )[0]?.id ?? '';

  it('gives sales C extension 103', async () => {
    const given = await manager.client.request(
      'PUT',
      `/v1/telephony/connections/${connectionId}/extensions/103`,
      { body: { userId: salesC.userId } },
    );
    expect(given.statusCode, given.body).toBe(200);
  });

  it('shows another agent none of agent A’s calls, in the list, the search or by id', async () => {
    const click = await clickOfA();
    for (const viewer of [salesB, salesC]) {
      const listed = json<{ items: { id: string }[] }>(
        await viewer.client.request('GET', '/v1/telephony/calls'),
      );
      expect(listed.items.map((row) => row.id)).not.toContain(click);
      const searched = json<{ items: { id: string }[] }>(
        await viewer.client.request('POST', '/v1/telephony/calls/search', { body: { limit: 50 } }),
      );
      expect(searched.items.map((row) => row.id)).not.toContain(click);
      const one = await viewer.client.request('GET', `/v1/telephony/calls/${click}`);
      expect(one.statusCode).toBe(404);
    }
    const own = await salesA.client.request('GET', `/v1/telephony/calls/${click}`);
    expect(own.statusCode).toBe(200);
  });

  it('lets the owner of the linked order see an inbound call, and no other agent', async () => {
    const call = await inboundOfB();
    const owner = await salesB.client.request('GET', `/v1/telephony/calls/${call}`);
    expect(owner.statusCode, owner.body).toBe(200);
    for (const other of [salesA, salesC]) {
      const refused = await other.client.request('GET', `/v1/telephony/calls/${call}`);
      expect(refused.statusCode).toBe(404);
    }
    const boss = await manager.client.request('GET', `/v1/telephony/calls/${call}`);
    expect(boss.statusCode).toBe(200);
  });

  it('names a buyer in the screen pop only to someone who may open them', async () => {
    const lookup = (viewer: RoleClient, phone: string) =>
      viewer.client.request('POST', '/v1/telephony/lookup', { body: { phone } });
    // Sales C may not open the caller (their only order is sales B's): nothing, no orders.
    const stranger = json<{ customer: unknown; openOrders: unknown[] }>(
      await lookup(salesC, '01912345670'),
    );
    expect(stranger).toMatchObject({ customer: null, openOrders: [] });
    const owner = json<{ customer: { name: string; reachable: boolean } | null }>(
      await lookup(salesB, '01912345670'),
    );
    expect(owner.customer).toMatchObject({ name: 'Caller', reachable: true });
    // A Call to the bare number does not name the buyer on the call either.
    const placed = await salesC.client.request('POST', '/v1/telephony/calls', {
      body: { phone: '01912345670' },
    });
    expect(placed.statusCode, placed.body).toBe(201);
    expect(json<{ call: { customer: unknown } }>(placed).call.customer).toBeNull();
  });

  it('names the caller of a call ringing on the agent’s connection, then not once it ends', async () => {
    const started = await deliver({
      event: 'call.started',
      id: '1789458000.1',
      sipServer: { id: 7 },
      direction: null,
      from: '01912345670',
      to: '09644342036',
      startedAt: new Date().toISOString(),
      durationSec: 0,
      talkSec: 0,
    });
    expect(started.statusCode, started.body).toBe(200);
    await processed();
    const ringing = json<{ customer: { name: string; reachable: boolean } | null }>(
      await salesC.client.request('POST', '/v1/telephony/lookup', {
        body: { phone: '01912345670' },
      }),
    );
    expect(ringing.customer).toMatchObject({ name: 'Caller', reachable: false });
  });

  it('lets only the agent whose phone took a call claim it, once', async () => {
    const answered = (viewer: RoleClient) =>
      viewer.client.request('POST', '/v1/telephony/calls/answered', {
        body: { from: '01912345670' },
      });
    // Not yet talking in Envo: nobody's yet.
    live = [{ id: '1789458000.1', state: 'ringing', channels: [{ endpoint: 'btcl_trunk' }] }];
    expect((await answered(salesB)).statusCode).toBe(404);
    // Talking on 102's phone (sales B): sales C (103) cannot take it, sales B can, once.
    live = [
      {
        id: '1789458000.1',
        state: 'talking',
        channels: [{ endpoint: 'btcl_trunk' }, { endpoint: '102_brand_web' }],
      },
    ];
    const other = await answered(salesC);
    expect(other.statusCode, other.body).toBe(404);
    const mine = await answered(salesB);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(json<{ person: { id: string } }>(mine).person.id).toBe(salesB.userId);
    expect((await answered(salesC)).statusCode).toBe(404);
    live = [];
    const ended = await deliver({
      event: 'call.ended',
      id: '1789458000.1',
      sipServer: { id: 7 },
      direction: 'inbound',
      from: '01912345670',
      to: '09644342036',
      answered: true,
      disposition: 'answered',
      talkSec: 12,
      durationSec: 15,
    });
    expect(ended.statusCode).toBe(200);
    await processed();
    const after = json<{ customer: unknown }>(
      await salesC.client.request('POST', '/v1/telephony/lookup', {
        body: { phone: '01912345670' },
      }),
    );
    expect(after.customer).toBeNull();
  });

  it('never lets an ended call be claimed by the person answering the next one', async () => {
    const ended = await deliver({
      event: 'call.ended',
      id: '1789458100.1',
      sipServer: { id: 7 },
      direction: 'inbound',
      from: '01733333333',
      to: '09644342036',
      answered: false,
      disposition: 'no answer',
      talkSec: 0,
      durationSec: 20,
    });
    expect(ended.statusCode).toBe(200);
    await processed();
    live = [{ id: '1789458100.1', state: 'talking', channels: [{ endpoint: '101_brand_web' }] }];
    const claimed = await salesA.client.request('POST', '/v1/telephony/calls/answered', {
      body: { from: '01733333333' },
    });
    expect(claimed.statusCode).toBe(404);
    live = [];
  });

  it('keeps a finished call’s talk time when a late call.started arrives after call.ended', async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    await deliver({
      event: 'call.ended',
      id: '1789458200.1',
      sipServer: { id: 7 },
      direction: 'inbound',
      from: '01744444444',
      to: '09644342036',
      startedAt: at,
      answered: true,
      disposition: 'answered',
      talkSec: 30,
      durationSec: 40,
    });
    await processed();
    await deliver({
      event: 'call.started',
      id: '1789458200.1',
      sipServer: { id: 7 },
      direction: null,
      from: '01744444444',
      to: '09644342036',
      startedAt: at,
      talkSec: 0,
      durationSec: 1,
    });
    await processed();
    const row = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ talk_seconds: number; duration_seconds: number; status: string }>(sql`
            select talk_seconds, duration_seconds, status from telephony.calls
            where envo_call_id = '1789458200.1'
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(row).toMatchObject({ talk_seconds: 30, duration_seconds: 40, status: 'ended' });
  });

  it('refuses a new base URL without its API key, so the key never leaves for another host', async () => {
    const view = json<{
      connections: { id: string; name: string; recordingRetentionDays: number }[];
    }>(await admin.client.request('GET', '/v1/telephony/connections'));
    const wrong = view.connections.find((row) => row.name === 'Wrong');
    expect(wrong).toBeDefined();
    const moved = await admin.client.request('PUT', `/v1/telephony/connections/${wrong?.id}`, {
      body: {
        name: 'Wrong',
        baseUrl: 'http://127.0.0.1:9',
        enabled: true,
        recordingRetentionDays: 365,
      },
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(json<{ code: string }>(moved).code).toBe('TELEPHONY_INVALID');
  });

  it('expires recordings past their retention and deletes processed webhook bodies at 30 days', async () => {
    const click = await clickOfA();
    const old = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            insert into telephony.webhook_events
              (org_id, connection_id, event, envo_call_id, body, processed_at, outcome)
            values (${ORG_A}, ${connectionId}, 'call.ended', '1789400000.1', '{}'::jsonb,
                    now() - interval '40 days', 'updated')
            returning id
          `)
        )[0]?.id,
      { orgId: ORG_A },
    );
    const counted = async () =>
      withSystem(
        async (tx) =>
          (
            await tx.execute<{ old: number; kept: number }>(sql`
              select count(*) filter (where id = ${old ?? ''})::int as old,
                     count(*) filter (where id <> ${old ?? ''})::int as kept
              from telephony.webhook_events where org_id = ${ORG_A}
            `)
          )[0],
        { orgId: ORG_A },
      );
    const before = await counted();
    expect(before?.old).toBe(1);
    const swept = await harness.app
      .get(TelephonyRecordingsService)
      .retention(new Date(Date.now() + 400 * 86_400_000));
    expect(swept.expired).toBeGreaterThan(0);
    expect(swept.pruned).toBe(1);
    const after = await counted();
    expect(after).toEqual({ old: 0, kept: before?.kept });
    const row = await callRow(click);
    expect(row?.recording_status).toBe('expired');
    const gone = await salesA.client.request('GET', `/v1/telephony/calls/${click}/recording`);
    expect(json<{ code: string }>(gone).code).toBe('TELEPHONY_RECORDING_UNAVAILABLE');
  });
});
