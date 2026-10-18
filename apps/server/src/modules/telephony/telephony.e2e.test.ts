import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_QUEUES } from '../../job-queues.js';
import { attachScope } from '../../platform/auth/scope.js';
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
import { TelephonyCallsService } from './calls.service.js';
import { TELEPHONY_SYSTEM_USER } from './ingest.service.js';
import { rangeOf, silentWav } from './providers/envo-gateway.js';
import { envoSignatureFor } from './signature.js';
import { TelephonySyncService } from './sync.service.js';
import * as repo from './telephony.repository.js';
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
 * 4. The recording stays with Envo and is streamed from the connection's own host for the person
 *    and a supervisor, not for another sales agent (D-858); a link to another host is never
 *    kept. The outcome is M41's attempt, once. The sync fills a missed webhook.
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
let history: (Readonly<Record<string, unknown>> & { readonly startedAt: string })[] = [];
/** What the stand-in's `/api/v1/calls/live` answers, as Envo's `liveCalls` shapes it. */
let live: unknown[] = [];
/** The history page the stand-in refuses once with Envo's 429, then serves again. */
let historyRefusesPage: number | null = null;
/** Envo's extensions, as `/api/v1/extensions` lists them. */
const envoExtensions: Record<string, unknown>[] = [
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
];
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
          recording_url: string | null;
          direction: string;
          outcome: string | null;
        }>(sql`
          select id, envo_call_id, status, answered, user_id, customer_id, order_id, talk_seconds,
                 recording_url, direction, outcome
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
        send(200, envoExtensions);
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
        if (historyRefusesPage === page) {
          historyRefusesPage = null;
          send(429, { error: 'Too many requests' });
          return;
        }
        const listed = history
          .filter((call) => Date.parse(call.startedAt) >= from && Date.parse(call.startedAt) < to)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        send(200, {
          calls: listed.slice((page - 1) * limit, page * limit),
          total: listed.length,
          page,
          limit,
        });
      } else if (url === '/api/v1/recordings/42') {
        // As Envo's `res.sendFile`: one range gets 206, one past the end 416, none the whole file.
        const range = request.headers.range;
        const part = rangeOf(silentWav(2), typeof range === 'string' ? range : null);
        response.writeHead(part.status, {
          'accept-ranges': 'bytes',
          ...(part.contentRange === null ? {} : { 'content-range': part.contentRange }),
          ...(part.status === 416
            ? {}
            : { 'content-type': 'audio/wav', 'content-length': String(part.body.byteLength) }),
        });
        response.end(Buffer.from(part.body));
      } else if (url === '/api/v1/recordings/43') {
        // Envo's retention blanked it, or the .wav is still being written.
        send(404, { error: 'Recording file not found' });
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
  // The five-minute sweep is left out here: the sync cases drive `syncConnection` themselves,
  // and a sweep landing mid-case would read the stand-in's pages first.
  const sync = harness.app.get(TelephonySyncService);
  await registerTelephonyJobs({
    jobs,
    webhooks: harness.app.get(TelephonyWebhookService),
    sync: Object.assign(Object.create(sync) as TelephonySyncService, {
      sweep: () => Promise.resolve({ queued: 0 }),
    }),
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
            recording_url: string | null;
          }>(sql`
            select customer_id, order_id, recording_url
            from telephony.calls where envo_call_id = '1789455900.3'
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(row).toMatchObject({
      customer_id: inboundCustomer,
      order_id: open.id,
      recording_url: null,
    });
    expect(envoRequests.some((call) => call.url.includes('elsewhere'))).toBe(false);
  });
});

describe('check 4: the recording, the outcome and the sync', () => {
  it('streams the recording from Envo for its person and a supervisor, not another agent', async () => {
    const click = await until(
      () =>
        withSystem(
          async (tx) =>
            (
              await tx.execute<{ id: string }>(sql`
                select id from telephony.calls
                where envo_call_id = '1789455634.59' and recording_url is not null
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
    expect(own.headers['cache-control']).toBe('no-store');
    // A seek: the browser's Range goes through to Envo, and Envo's 206 comes back.
    const boss = await manager.client.request('GET', `/v1/telephony/calls/${click}/recording`, {
      headers: { range: 'bytes=0-3' },
    });
    expect(boss.statusCode, boss.body).toBe(206);
    expect(boss.headers['content-range']).toMatch(/^bytes 0-3\/\d+$/);
    expect(boss.body).toBe('RIFF');
    const other = await salesB.client.request('GET', `/v1/telephony/calls/${click}/recording`);
    expect(other.statusCode).toBe(404);
    const download = envoRequests.find((call) => call.url === '/api/v1/recordings/42');
    expect(download?.authorization).toBe(`Bearer ${KEY}`);
    // Nothing is kept in the ERP's storage (D-858).
    const stored = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(
          sql`select count(*)::int as n from files.objects where org_id = ${ORG_A}`,
        ),
      { orgId: ORG_A },
    );
    expect(stored[0]?.n).toBe(0);
  });

  it('says so when Envo no longer has the recording', async () => {
    const ended = await deliver({
      event: 'call.ended',
      id: '1789455950.4',
      sipServer: { id: 7 },
      direction: 'inbound',
      from: '8801555123456',
      to: '09644342036',
      answered: true,
      disposition: 'answered',
      talkSec: 12,
      durationSec: 15,
      recordingUrl: `${envoBase}/api/v1/recordings/43`,
    });
    expect(ended.statusCode, ended.body).toBe(200);
    await processed();
    const call = await until(
      () =>
        withSystem(
          async (tx) =>
            (
              await tx.execute<{ id: string }>(sql`
                select id from telephony.calls
                where envo_call_id = '1789455950.4' and recording_url is not null
              `)
            )[0]?.id,
          { orgId: ORG_A },
        ),
      'the call with a recording link',
    );
    const gone = await manager.client.request('GET', `/v1/telephony/calls/${call}/recording`);
    expect(gone.statusCode, gone.body).toBe(404);
    expect(json<{ code: string }>(gone).code).toBe('TELEPHONY_RECORDING_UNAVAILABLE');
  });

  it('wraps up a call about an order once, writing M41’s attempt, by its own person only', async () => {
    const click = (
      await withSystem(
        async (tx) =>
          tx.execute<{ id: string }>(
            sql`select id from telephony.calls where envo_call_id = '1789455634.59'`,
          ),
        { orgId: ORG_A },
      )
    )[0]?.id;
    const listed = await salesA.client.request('GET', '/v1/telephony/calls/wrap-ups');
    expect(listed.statusCode, listed.body).toBe(200);
    const waiting = json<{ items: { id: string; suggestedResult: string | null }[] }>(listed);
    expect(waiting.items.map((row) => row.id)).toContain(click);
    const listedForB = json<{ items: { id: string }[] }>(
      await salesB.client.request('GET', '/v1/telephony/calls/wrap-ups'),
    );
    expect(listedForB.items.map((row) => row.id)).not.toContain(click);

    const wrapUp = (viewer: RoleClient, id: string | undefined, body: Record<string, unknown>) =>
      viewer.client.request('POST', `/v1/telephony/calls/${id ?? ''}/wrap-up`, { body });
    // Reached needs what was said (the shared schema refuses it at the edge).
    const bare = await wrapUp(salesA, click, { result: 'reached' });
    expect(bare.statusCode, bare.body).toBe(400);
    // Another agent: not their call.
    const colleague = await wrapUp(salesB, click, { result: 'reached', note: 'Spoke to her' });
    expect(colleague.statusCode).toBe(404);
    // Sales B's own click from check 2 never connected: nothing to wrap up yet.
    const ringing = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ id: string }>(sql`
            select id from telephony.calls
            where org_id = ${ORG_A} and user_id = ${salesB.userId} and status <> 'ended'
            order by occurred_at limit 1
          `)
        )[0]?.id,
      { orgId: ORG_A },
    );
    const early = await wrapUp(salesB, ringing, { result: 'no_answer' });
    expect(early.statusCode, early.body).toBe(409);
    expect(json<{ code: string }>(early).code).toBe('TELEPHONY_WRAP_UP_INVALID');

    const saved = await wrapUp(salesA, click, {
      result: 'reached',
      note: 'Confirmed the address; wants it on Friday',
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(
      json<{
        orderAttempt: boolean;
        call: { wrapUp: { result: string; note: string; byUserId: string } | null };
      }>(saved),
    ).toMatchObject({
      orderAttempt: true,
      call: {
        wrapUp: {
          result: 'reached',
          note: 'Confirmed the address; wants it on Friday',
          byUserId: salesA.userId,
        },
      },
    });
    const again = await wrapUp(salesA, click, { result: 'no_answer' });
    expect(json<{ code: string }>(again).code).toBe('TELEPHONY_WRAP_UP_INVALID');
    const attempts = json<{ items: { outcome: string }[] }>(
      await salesA.client.request('GET', `/v1/orders/${orderA.id}/calls`),
    );
    expect(attempts.items.filter((row) => row.outcome === 'reached')).toHaveLength(1);
    expect(await callRow(click ?? '')).toMatchObject({ outcome: 'reached' });
    // Once set, the wrap-up never changes, even for its own person.
    await expect(
      withOrg({ orgId: ORG_A, userId: salesA.userId }, (tx) =>
        tx.execute(sql`update telephony.calls set wrap_up_note = 'rewritten' where id = ${click}`),
      ),
    ).rejects.toThrow();
    const after = json<{ items: { id: string }[] }>(
      await salesA.client.request('GET', '/v1/telephony/calls/wrap-ups'),
    );
    expect(after.items.map((row) => row.id)).not.toContain(click);
    // The audit row keeps the note's length, never its words.
    const audited = await withSystem(
      async (tx) =>
        tx.execute<{ after: Record<string, unknown> }>(sql`
          select after from audit.audit_log
          where org_id = ${ORG_A} and action = 'phone_call.wrapped_up' and entity_id = ${click}
        `),
      { orgId: ORG_A },
    );
    expect(audited).toHaveLength(1);
    expect(JSON.stringify(audited[0]?.after)).not.toContain('Friday');
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
    // A phone in a query string would reach the proxies' access logs: the GET refuses it.
    const byPhone = await manager.client.request('GET', '/v1/telephony/calls?phone=01812345678');
    expect(byPhone.statusCode, byPhone.body).toBe(400);
    expect(json<{ code: string }>(byPhone).code).toBe('TELEPHONY_INVALID');
    expect(byPhone.body).toContain('calls/search');
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
    const click = json<{ call: { id: string; customer: unknown } }>(placed).call;
    expect(click.customer).toBeNull();
    // Nor once Envo's webhook lands on the click: the buyer, their open order and its owner stay
    // off the caller's own call, and the ring-back's screen pop stays nobody's.
    const started = await deliver({
      event: 'call.started',
      id: '1789457900.1',
      sipServer: { id: 7 },
      direction: null,
      from: '103',
      to: '01912345670',
      startedAt: new Date().toISOString(),
      durationSec: 0,
      talkSec: 0,
    });
    expect(started.statusCode, started.body).toBe(200);
    await processed();
    expect(await callRow(click.id)).toMatchObject({
      envo_call_id: '1789457900.1',
      user_id: salesC.userId,
      customer_id: null,
      order_id: null,
    });
    const seen = json<{ customer: unknown; order: unknown; orderOwner: unknown }>(
      await salesC.client.request('GET', `/v1/telephony/calls/${click.id}`),
    );
    expect(seen).toMatchObject({ customer: null, order: null, orderOwner: null });
    const ringBack = json<{ customer: unknown; ringBack: { callId: string } | null }>(
      await lookup(salesC, '01912345670'),
    );
    expect(ringBack).toMatchObject({ customer: null, ringBack: { callId: click.id } });
  });

  it('names the caller Envo shows on the agent’s own phone before call.started is applied', async () => {
    const lookup = (viewer: RoleClient) =>
      viewer.client
        .request('POST', '/v1/telephony/lookup', { body: { phone: '01912345670' } })
        .then((response) =>
          json<{ customer: { name: string; reachable: boolean } | null }>(response),
        );
    // The phone rings first; Envo's webhook comes a second or more later and is applied by a
    // job. Until then, Envo's live calls say the number is ringing on sales C's phone (103).
    live = [
      {
        id: '1789457950.1',
        from: '8801912345670',
        to: '09644342036',
        state: 'ringing',
        channels: [{ endpoint: 'btcl_trunk' }, { endpoint: '103_brand_web' }],
      },
    ];
    try {
      // Asked again as the console's phone does (Envo's live calls are cached five seconds).
      const named = await until(async () => {
        const answer = await lookup(salesC);
        return answer.customer === null ? undefined : answer;
      }, 'the live call in the screen pop');
      expect(named.customer).toMatchObject({ name: 'Caller', reachable: false });
      // Not on sales A's phone (101): nobody.
      expect((await lookup(salesA)).customer).toBeNull();
    } finally {
      live = [];
    }
    await until(
      async () => ((await lookup(salesC)).customer === null ? true : undefined),
      'the call off the live calls',
    );
  }, 30_000);

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

  it('writes no audit row for the screen pop or the call log’s search: both are reads', async () => {
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n from audit.audit_log
          where org_id = ${ORG_A}
            and (action like 'http:POST /v1/telephony/lookup%'
                 or action like 'http:POST /v1/telephony/calls/search%')
        `),
      { orgId: ORG_A },
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('lets only the agent whose phone took a call claim it, once', async () => {
    const answered = (viewer: RoleClient) =>
      viewer.client.request('POST', '/v1/telephony/calls/answered', {
        body: { from: '01912345670' },
      });
    // Not yet talking in Envo: nobody's yet.
    live = [{ id: '1789458000.1', state: 'ringing', channels: [{ endpoint: 'btcl_trunk' }] }];
    expect((await answered(salesB)).statusCode).toBe(404);
    // Answered into an IVR or a queue: `up`, with only the trunk's channel. Nobody's.
    live = [{ id: '1789458000.1', state: 'up', channels: [{ endpoint: 'btcl_trunk' }] }];
    const queued = await answered(salesC);
    expect(queued.statusCode, queued.body).toBe(404);
    expect(queued.body).toContain('does not show your phone');
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
      connections: { id: string; name: string }[];
    }>(await admin.client.request('GET', '/v1/telephony/connections'));
    const wrong = view.connections.find((row) => row.name === 'Wrong');
    expect(wrong).toBeDefined();
    const moved = await admin.client.request('PUT', `/v1/telephony/connections/${wrong?.id}`, {
      body: {
        name: 'Wrong',
        baseUrl: 'http://127.0.0.1:9',
        enabled: true,
      },
    });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(json<{ code: string }>(moved).code).toBe('TELEPHONY_INVALID');
  });

  it('deletes processed webhook bodies at 30 days', async () => {
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
      .get(TelephonyWebhookService)
      .prune(new Date(Date.now() + 400 * 86_400_000));
    expect(swept.pruned).toBe(1);
    const after = await counted();
    expect(after).toEqual({ old: 0, kept: before?.kept });
  });
});

/**
 * The sync's windows and cursor, its stale clicks and a key that no longer opens (D-839), each
 * on a connection of its own to the stand-in, with a small request and page budget.
 */
describe('the review: the sync', () => {
  const LIMITS = { maxRequests: 3, pageSize: 5 };
  const connection = async (name: string) => {
    const created = await admin.client.request('POST', '/v1/telephony/connections', {
      body: { name, baseUrl: envoBase, apiKey: KEY, webhookSecret: SECRET },
    });
    expect(created.statusCode, created.body).toBe(201);
    return json<{ id: string }>(created).id;
  };
  const state = async (id: string) =>
    withSystem(
      async (tx) =>
        (
          await tx.execute<{ sync_cursor: Date | string | null; last_sync_error: string | null }>(
            sql`select sync_cursor, last_sync_error from telephony.connections where id = ${id}`,
          )
        )[0],
      { orgId: ORG_A },
    );
  const stored = async (id: string, prefix: string) =>
    withSystem(
      async (tx) =>
        (
          await tx.execute<{ n: number }>(sql`
            select count(*)::int as n from telephony.calls
            where connection_id = ${id} and envo_call_id like ${`${prefix}.%`}
          `)
        )[0]?.n ?? 0,
      { orgId: ORG_A },
    );
  /** Finished inbound calls from strangers, started `hoursAgo` before `now`. */
  const finished = (prefix: string, now: Date, hoursAgo: readonly number[]) =>
    hoursAgo.map((hours, index) => ({
      id: `${prefix}.${String(index + 1)}`,
      startedAt: new Date(now.getTime() - hours * 3600_000).toISOString(),
      direction: 'inbound',
      from: `0177${String(1_000_000 + index).slice(-7)}`,
      to: '09644342036',
      answered: false,
      disposition: 'no answer',
      durationSec: 20,
      talkSec: 0,
      recordingUrl: null,
      legs: 1,
    }));
  const syncOnce = (id: string, now: Date) =>
    harness.app.get(TelephonySyncService).syncConnection(ORG_A, id, now, LIMITS);

  it('keeps the cursor before a window Envo refused part of, and reads it all the next time', async () => {
    const id = await connection('Sync 429');
    const now = new Date();
    history = finished('1789470001', now, [20, 18, 16, 14, 12, 10, 8, 6]);
    historyRefusesPage = 2;
    try {
      const first = await syncOnce(id, now);
      expect(first.listed).toBe(LIMITS.pageSize);
      const after = await state(id);
      expect(after?.sync_cursor).toBeNull();
      expect(after?.last_sync_error).toContain('120 requests a minute');
      const second = await syncOnce(id, now);
      expect(second.listed).toBe(8);
      expect(await stored(id, '1789470001')).toBe(8);
      const read = await state(id);
      expect(read?.last_sync_error).toBeNull();
      // Never closer to now than the longest call.
      expect(new Date(read?.sync_cursor ?? 0).getTime()).toBe(now.getTime() - 2 * 3600_000);
    } finally {
      historyRefusesPage = null;
      history = [];
    }
  });

  it('reads a backlog bigger than one sync’s budget over two, the cursor only past what it read', async () => {
    const id = await connection('Sync backlog');
    const now = new Date();
    // Sixteen calls from 23 hours ago to 1 hour ago: four pages of five, a budget of three.
    history = finished(
      '1789470002',
      now,
      Array.from({ length: 16 }, (_, index) => 23 - (index * 22) / 15),
    );
    try {
      const first = await syncOnce(id, now);
      expect(first.listed).toBeGreaterThan(0);
      expect(first.listed).toBeLessThan(16);
      const halfway = new Date((await state(id))?.sync_cursor ?? 0).getTime();
      expect(halfway).toBeGreaterThan(now.getTime() - 24 * 3600_000);
      expect(halfway).toBeLessThan(now.getTime() - 2 * 3600_000);
      expect(await stored(id, '1789470002')).toBe(first.listed);
      await syncOnce(id, now);
      expect(await stored(id, '1789470002')).toBe(16);
      expect(new Date((await state(id))?.sync_cursor ?? 0).getTime()).toBe(
        now.getTime() - 2 * 3600_000,
      );
    } finally {
      history = [];
    }
  });

  /** A click Envo took and never described, `minutesAgo` old, on extension `extension`. */
  const click = async (id: string, extension: string, minutesAgo: number) =>
    withOrg({ orgId: ORG_A, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
      const at = new Date(Date.now() - minutesAgo * 60_000);
      const row = await repo.insertCall(tx, {
        orgId: ORG_A,
        connectionId: id,
        envoCallId: null,
        firstSeen: 'click',
        direction: 'outbound',
        status: 'dialing',
        fromNumber: extension,
        toNumber: '+8801766666666',
        customerPhoneE164: '+8801766666666',
        extension,
        userId: null,
        customerId: null,
        customerName: null,
        orderId: null,
        orderNo: null,
        orderOwnerUserId: null,
        occurredAt: at,
        requestedAt: at,
      });
      return row.id;
    });
  const clickState = async (id: string) =>
    withSystem(
      async (tx) =>
        (
          await tx.execute<{ status: string; error_code: string | null }>(
            sql`select status, error_code from telephony.calls where id = ${id}`,
          )
        )[0],
      { orgId: ORG_A },
    );

  it('keeps a stale click open while Envo shows its extension on a call, and closes it after', async () => {
    const id = await connection('Sync stale');
    const busy = await click(id, '105', 20);
    live = [{ id: '1789471000.1', state: 'talking', channels: [{ endpoint: '105_brand' }] }];
    try {
      expect((await syncOnce(id, new Date())).closed).toBe(0);
      expect(await clickState(busy)).toMatchObject({ status: 'dialing', error_code: null });
    } finally {
      live = [];
    }
    expect((await syncOnce(id, new Date())).closed).toBe(1);
    expect(await clickState(busy)).toMatchObject({ status: 'ended', error_code: 'not_connected' });
  });

  it('says so when the key no longer opens, and closes only clicks older than the longest call', async () => {
    const id = await connection('Sync sealed');
    const young = await click(id, '106', 20);
    const old = await click(id, '107', 3 * 60);
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          update telephony.connections set api_key_sealed = ${Buffer.from('not a sealed key')}
          where id = ${id}
        `),
      { orgId: ORG_A },
    );
    const before = envoRequests.length;
    const result = await syncOnce(id, new Date());
    expect(result).toEqual({ listed: 0, closed: 1 });
    expect(envoRequests.length).toBe(before);
    expect((await state(id))?.last_sync_error).toContain('no API key that opens');
    expect(await clickState(young)).toMatchObject({ status: 'dialing' });
    expect(await clickState(old)).toMatchObject({ status: 'ended', error_code: 'not_connected' });
  });
});

/**
 * Who a call names (D-846) and whether the console's phone can start (D-843): a holder who no
 * longer places calls, a call that began before the extension was given, and Envo's own word on
 * the extension.
 */
describe('the review: attribution and the phone’s readiness', () => {
  const context = (userId: string) => ({
    orgId: ORG_A,
    userId,
    isSuperAdmin: false,
    roles: ['sales' as const],
    branchIds: [],
    branchIdsByRole: {},
    requestId: 'm47-attribution',
  });
  /** A request the route guard has scoped, as the controller's would be. */
  const scoped = (action: 'read' | 'create') => {
    const request = {};
    attachScope(request, action, 'PhoneCall', { kind: 'all' });
    return request;
  };
  const give = async (extension: string, userId: string) => {
    const given = await manager.client.request(
      'PUT',
      `/v1/telephony/connections/${connectionId}/extensions/${extension}`,
      { body: { userId } },
    );
    expect(given.statusCode, given.body).toBe(200);
  };
  const byEnvoId = async (envoCallId: string) =>
    withSystem(
      async (tx) =>
        (
          await tx.execute<{ user_id: string | null; extension: string | null }>(sql`
            select user_id, extension from telephony.calls
            where connection_id = ${connectionId} and envo_call_id = ${envoCallId}
          `)
        )[0],
      { orgId: ORG_A },
    );
  const outbound = (id: string, from: string, startedAt: Date) =>
    deliver({
      event: 'call.started',
      id,
      sipServer: { id: 7 },
      direction: 'outbound',
      from,
      to: '01799999999',
      startedAt: startedAt.toISOString(),
      durationSec: 0,
      talkSec: 0,
    });

  it('names nobody for a holder whose calling role was taken away', async () => {
    const left = await harness.asRole('sales', ORG_A);
    await give('104', left.userId);
    const calls = harness.app.get(TelephonyCallsService);
    expect((await calls.me(context(left.userId), scoped('read'))).phone).toMatchObject({
      extension: '104',
    });
    await withSystem(
      async (tx) =>
        tx.execute(sql`
          update iam.memberships set is_active = false
          where org_id = ${ORG_A} and user_id = ${left.userId}
        `),
      { orgId: ORG_A },
    );
    // A session still carrying the role: the extension is no longer theirs to use.
    expect(await calls.me(context(left.userId), scoped('read'))).toEqual({ phone: null });
    await expect(calls.phoneToken(context(left.userId), scoped('create'))).rejects.toThrow(
      'You have no extension yet',
    );
    const started = await outbound('1789472000.1', '104', new Date());
    expect(started.statusCode, started.body).toBe(200);
    await processed();
    expect(await byEnvoId('1789472000.1')).toMatchObject({ extension: '104', user_id: null });
    const listed = json<{
      extensions: { extension: string; assignee: { id: string; current: boolean } | null }[];
    }>(await manager.client.request('GET', `/v1/telephony/connections/${connectionId}/extensions`));
    expect(listed.extensions.find((row) => row.extension === '104')?.assignee).toMatchObject({
      id: left.userId,
      current: false,
    });
  });

  it('names nobody for a call that began before the extension was given', async () => {
    const holder = await harness.asRole('sales', ORG_A);
    await give('105', holder.userId);
    const before = await outbound('1789472100.1', '105', new Date(Date.now() - 3600_000));
    expect(before.statusCode, before.body).toBe(200);
    const after = await outbound('1789472100.2', '105', new Date(Date.now() + 1_000));
    expect(after.statusCode, after.body).toBe(200);
    await processed();
    expect(await byEnvoId('1789472100.1')).toMatchObject({ extension: '105', user_id: null });
    expect(await byEnvoId('1789472100.2')).toMatchObject({
      extension: '105',
      user_id: holder.userId,
    });
  });

  it('says why the phone cannot start: no web phone, or the extension off in Envo', async () => {
    envoExtensions.push(
      {
        extension: '106',
        name: 'Desk phone',
        enabled: true,
        dnd: false,
        webPhone: false,
        online: true,
        status: 'idle',
      },
      {
        extension: '107',
        name: 'Off',
        enabled: false,
        dnd: false,
        webPhone: true,
        online: false,
        status: 'unavailable',
      },
    );
    const deskPhone = await harness.asRole('sales', ORG_A);
    const switchedOff = await harness.asRole('sales', ORG_A);
    await give('106', deskPhone.userId);
    await give('107', switchedOff.userId);
    // Envo's extension list is cached ten seconds: asked until it is read afresh.
    const readiness = (viewer: RoleClient, reason: string) =>
      until(async () => {
        const mine = json<{ phone: { ready: boolean; notReady: string | null } | null }>(
          await viewer.client.request('GET', '/v1/telephony/me'),
        );
        return mine.phone?.notReady === reason ? mine.phone : undefined;
      }, `the phone: ${reason}`);
    expect(await readiness(deskPhone, 'no_web_phone')).toMatchObject({ ready: false });
    expect(await readiness(switchedOff, 'extension_off')).toMatchObject({ ready: false });
  }, 30_000);
});

describe('the owner’s answers: wrap-up, the caller panel and the inbox’s go-ahead', () => {
  let conversationId = '';
  let contactId = '';

  it('wraps up a call with no order: the result and the note, no attempt', async () => {
    const click = (
      await withSystem(
        async (tx) =>
          tx.execute<{ id: string }>(
            sql`select id from telephony.calls where envo_call_id = '1789457900.1'`,
          ),
        { orgId: ORG_A },
      )
    )[0]?.id;
    const ended = await deliver({
      event: 'call.ended',
      id: '1789457900.1',
      sipServer: { id: 7 },
      direction: 'outbound',
      from: '103',
      to: '01912345670',
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      answeredAt: new Date(Date.now() - 25_000).toISOString(),
      endedAt: new Date().toISOString(),
      answered: true,
      disposition: 'answered',
      durationSec: 30,
      talkSec: 25,
    });
    expect(ended.statusCode, ended.body).toBe(200);
    await processed();
    const waiting = json<{ items: { id: string }[] }>(
      await salesC.client.request('GET', '/v1/telephony/calls/wrap-ups'),
    );
    expect(waiting.items.map((row) => row.id)).toContain(click);
    const notA = json<{ items: { id: string }[] }>(
      await salesA.client.request('GET', '/v1/telephony/calls/wrap-ups'),
    );
    expect(notA.items.map((row) => row.id)).not.toContain(click);
    const saved = await salesC.client.request(
      'POST',
      `/v1/telephony/calls/${click ?? ''}/wrap-up`,
      {
        body: { result: 'no_answer', note: 'Rang out twice' },
      },
    );
    expect(saved.statusCode, saved.body).toBe(201);
    expect(
      json<{ orderAttempt: boolean; call: { wrapUp: { result: string; note: string } } }>(saved),
    ).toMatchObject({
      orderAttempt: false,
      call: { wrapUp: { result: 'no_answer', note: 'Rang out twice' } },
    });
  });

  it('asks the conversation’s owner’s go-ahead before an inbox Call, and tells the owner', async () => {
    ({ conversationId, contactId } = await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into inbox.channels (org_id, kind, external_id, enabled, updated_by)
          values (${ORG_A}, 'messenger', '900000000000047', true, 'usr_m47_fixture')
          on conflict (org_id, kind) do nothing
        `);
        const channel = (
          await tx.execute<{ id: string }>(sql`
            select id from inbox.channels where org_id = ${ORG_A} and kind = 'messenger'
          `)
        )[0]?.id;
        const contact = (
          await tx.execute<{ id: string }>(sql`
            insert into inbox.contacts (org_id, display_name, phone_e164, customer_id)
            values (${ORG_A}, 'Rumana on Messenger', '+8801612345678', ${customerId})
            returning id
          `)
        )[0]?.id;
        const identity = (
          await tx.execute<{ id: string }>(sql`
            insert into inbox.identities (org_id, contact_id, channel_id, external_user_id)
            values (${ORG_A}, ${contact}, ${channel}, 'psid-m47-telephony')
            returning id
          `)
        )[0]?.id;
        const conversation = (
          await tx.execute<{ id: string }>(sql`
            insert into inbox.conversations
              (org_id, channel_id, contact_id, identity_id, last_inbound_at, last_message_at,
               last_preview, last_direction, unread_count, assigned_to, assigned_at)
            values (${ORG_A}, ${channel}, ${contact}, ${identity}, now(), now(), 'hello',
                    'inbound', 1, ${salesA.userId}, now())
            returning id
          `)
        )[0]?.id;
        return { conversationId: conversation ?? '', contactId: contact ?? '' };
      },
      { orgId: ORG_A },
    ));
    const refused = await salesB.client.request('POST', '/v1/telephony/calls', {
      body: { conversationId },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(json<{ code: string }>(refused).code).toBe('INBOX_OWNER_ACK_REQUIRED');
    const before = envoRequests.length;
    const placed = await salesB.client.request('POST', '/v1/telephony/calls', {
      body: { conversationId },
      headers: { 'x-acknowledge-owner': '1' },
    });
    expect(placed.statusCode, placed.body).toBe(201);
    const originate = envoRequests.slice(before).find((row) => row.url === '/api/v1/calls');
    expect(JSON.parse(originate?.body ?? '{}')).toEqual({ from: '102', to: '01612345678' });
    const audited = await withSystem(
      async (tx) =>
        tx.execute<{ actor_user_id: string }>(sql`
          select actor_user_id from audit.audit_log
          where org_id = ${ORG_A} and action = 'inbox.call' and entity_id = ${contactId}
        `),
      { orgId: ORG_A },
    );
    expect(audited.map((row) => row.actor_user_id)).toEqual([salesB.userId]);
    const told = await withSystem(
      async (tx) =>
        tx.execute<{ payload: Record<string, unknown> }>(sql`
          select payload from events.outbox where name = 'inbox.owner_overridden'
        `),
      { orgId: ORG_A },
    );
    expect(told.map((row) => row.payload)).toContainEqual(
      expect.objectContaining({
        conversationId,
        ownerUserId: salesA.userId,
        actorUserId: salesB.userId,
        action: 'call',
      }),
    );
  });

  it('pins a note on the buyer, with its author, for whoever may see their panel', async () => {
    const pinned = await salesA.client.request('PUT', `/v1/customers/${customerId}/pinned-note`, {
      body: { body: 'Sales A handles her; she wants Friday deliveries' },
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(json<{ pinnedNote: { body: string; byUserId: string } | null }>(pinned)).toMatchObject({
      pinnedNote: {
        body: 'Sales A handles her; she wants Friday deliveries',
        byUserId: salesA.userId,
      },
    });
    const stranger = await salesC.client.request('PUT', `/v1/customers/${customerId}/pinned-note`, {
      body: { body: 'Not mine to write' },
    });
    expect(stranger.statusCode, stranger.body).toBe(404);
  });

  it('gives a supervisor the whole panel: every order newest first, contacts, every call', async () => {
    const newer = await seedOrder(ORG_A, {
      status: 'delivered',
      customerId,
      lines: [],
      assignedTo: salesA.userId,
    });
    const newest = await seedOrder(ORG_A, {
      status: 'confirmed',
      customerId,
      lines: [],
      assignedTo: salesA.userId,
    });
    const panel = await manager.client.request('POST', '/v1/telephony/caller-panel', {
      body: { customerId },
    });
    expect(panel.statusCode, panel.body).toBe(200);
    expect(panel.headers['cache-control']).toBe('no-store');
    const full = json<{
      full: boolean;
      customer: {
        id: string;
        pinnedNote: { body: string; byUserId: string; byName: string | null } | null;
      } | null;
      orders: { items: { id: string }[] };
      addresses: unknown[];
      otherPhones: { phone: string; source: string }[];
      socials: { channel: string }[];
      calls: {
        person: { id: string } | null;
        wrapUp: { note: string | null } | null;
        canPlay: boolean;
      }[];
    }>(panel);
    expect(full.full).toBe(true);
    expect(full.customer).toMatchObject({
      id: customerId,
      pinnedNote: { byUserId: salesA.userId },
    });
    expect(full.customer?.pinnedNote?.byName).not.toBeNull();
    expect(full.orders.items.slice(0, 3).map((row) => row.id)).toEqual([
      newest.id,
      newer.id,
      orderA.id,
    ]);
    expect(full.addresses.length).toBeGreaterThan(0);
    expect(full.otherPhones).toContainEqual({ phone: '+8801612345678', source: 'inbox' });
    expect(full.socials.map((row) => row.channel)).toContain('messenger');
    // A colleague's call is in the history with what they wrote after it.
    const colleagues = full.calls.find((row) => row.person?.id === salesA.userId && row.wrapUp);
    expect(colleagues).toMatchObject({
      wrapUp: { note: 'Confirmed the address; wants it on Friday' },
      canPlay: true,
    });
    // Sales A reaches her through her order: the whole panel, sales B's calls with her too.
    const own = json<{ full: boolean; calls: { person: { id: string } | null }[] }>(
      await salesA.client.request('POST', '/v1/telephony/caller-panel', { body: { customerId } }),
    );
    expect(own.full).toBe(true);
    expect(own.calls.map((row) => row.person?.id)).toContain(salesB.userId);
    // Whoever sees the whole panel may write its note: the branch manager too (D-863).
    const managers = await manager.client.request(
      'PUT',
      `/v1/customers/${customerId}/pinned-note`,
      {
        body: { body: 'Call her after six' },
      },
    );
    expect(managers.statusCode, managers.body).toBe(200);
    expect(json<{ pinnedNote: { byUserId: string } | null }>(managers).pinnedNote?.byUserId).toBe(
      manager.userId,
    );
  });

  it('gives an agent who cannot reach the buyer and is on no call with them the minimal answer', async () => {
    // A Call whose ring-back they never picked up rang nobody: it opens nothing (D-860).
    await withOrg({ orgId: ORG_A, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
      const at = new Date();
      await repo.insertCall(tx, {
        orgId: ORG_A,
        connectionId,
        envoCallId: null,
        firstSeen: 'click',
        direction: 'outbound',
        status: 'dialing',
        fromNumber: '103',
        toNumber: CUSTOMER_PHONE,
        customerPhoneE164: CUSTOMER_PHONE,
        extension: '103',
        userId: salesC.userId,
        customerId,
        customerName: null,
        orderId: null,
        orderNo: null,
        orderOwnerUserId: null,
        occurredAt: at,
        requestedAt: at,
      });
    });
    const minimal = json<{ full: boolean; phone: string | null; customer: unknown }>(
      await salesC.client.request('POST', '/v1/telephony/caller-panel', { body: { customerId } }),
    );
    // Asked by the buyer's id, the number is not given back: the route is no phone lookup.
    expect(minimal).toMatchObject({ full: false, phone: null, customer: null });
    const pin = await salesC.client.request('PUT', `/v1/customers/${customerId}/pinned-note`, {
      body: { body: 'Not mine to write' },
    });
    expect(pin.statusCode, pin.body).toBe(404);
    const byPhone = json<{ full: boolean; customer: unknown }>(
      await salesC.client.request('POST', '/v1/telephony/caller-panel', {
        body: { phone: '01812345678' },
      }),
    );
    expect(byPhone).toMatchObject({ full: false, customer: null });
  });
});
