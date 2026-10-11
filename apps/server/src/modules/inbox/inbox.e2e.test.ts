import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { findCostFields } from '@elysium/contracts';
import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_QUEUES } from '../../job-queues.js';
import type { DeliveredEvent, OutboxDispatcher } from '../../platform/events/dispatcher.js';
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
import { seedProductWithSkus, warehouseId } from '../inventory/inventory.testing.js';
import {
  applyOrderMigrations,
  seedCustomer,
  seedOrder,
  seedStockLevel,
} from '../orders/orders.testing.js';
import { registerInboxJobs } from './inbox.worker.js';
import {
  instagramText,
  messengerDelivery,
  messengerRead,
  messengerText,
  whatsAppStatus,
  whatsAppText,
} from './meta-fixtures.js';
import { InboxOrderListener } from './order-listener.service.js';
import { InboxSendService } from './send.service.js';
import { metaSignatureFor } from './signature.js';
import { InboxWebhookService } from './webhook.service.js';

/**
 * M42's acceptance checks on real Postgres, through the real routes, with pg-boss running the
 * inbox's jobs and the real Graph adapter pointed at a stand-in for Meta on this machine:
 *
 * 1. A signed webhook per channel opens or threads a conversation; a bad signature is refused
 *    and stores nothing; a repeated delivery is ignored.
 * 2. A reply is sent by the job after the commit (to the stand-in, as the Send API and the Cloud
 *    API document); free text outside the 24-hour window is refused with the reason, at the route
 *    and again in the job.
 * 3. A phone in a message matches an existing customer and shows their orders; the contact
 *    becomes Customer when an order is placed from the chat.
 * 4. Notes and product interests are saved and shown with live catalog data, and no cost.
 * 5. Tenancy and permissions: another brand sees none of it; a write on someone else's
 *    conversation needs the acknowledgement, is audited and tells the owner.
 */

const APP_SECRET = 'm42-test-app-secret-0123456789abcdef';
const VERIFY_TOKEN = 'm42-verify-token-for-the-suite';
const PAGE = '104512345678901';
const IG = '17841400000000001';
const PHONE_ID = '106540352242922';

interface MetaCall {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

const metaCalls: MetaCall[] = [];
let metaServer: Server;
let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let salesA: RoleClient;
let salesB: RoleClient;
let adminB: RoleClient;
let skuId = '';
let skuCode = '';
let productId = '';

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    request.on('end', () => resolve(text));
  });
}

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Post a body to the brand's webhook, signed as Meta signs it unless told otherwise. */
async function deliver(
  body: unknown,
  options: { readonly orgId?: string; readonly secret?: string; readonly signature?: string } = {},
): Promise<InjectedResponse> {
  const raw = JSON.stringify(body);
  return harness.server.inject({
    method: 'POST',
    url: `/webhooks/meta/${options.orgId ?? ORG_A}`,
    headers: {
      host: APP_DOMAIN,
      'content-type': 'application/json',
      'x-forwarded-for': '10.9.9.9',
      'x-hub-signature-256':
        options.signature ?? metaSignatureFor(raw, options.secret ?? APP_SECRET),
    },
    payload: raw,
  });
}

async function webhookRows(orgId: string): Promise<number> {
  return withOrg({ orgId }, async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from inbox.webhook_events`,
    );
    return rows[0]?.n ?? 0;
  });
}

async function processed(orgId: string): Promise<boolean> {
  return withOrg({ orgId }, async (tx) => {
    const rows = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from inbox.webhook_events where processed_at is null`,
    );
    return (rows[0]?.n ?? 1) === 0;
  });
}

/** Deliver, then wait until the job threaded it. */
async function deliverAndThread(body: unknown): Promise<void> {
  const response = await deliver(body);
  expect(response.statusCode, response.body).toBe(200);
  await until(async () => ((await processed(ORG_A)) ? true : undefined), 'the webhook job');
}

async function conversationFor(externalUserId: string): Promise<string> {
  return until(
    () =>
      withOrg({ orgId: ORG_A }, async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          select v.id from inbox.conversations v
          join inbox.identities i on i.org_id = v.org_id and i.id = v.identity_id
          where i.external_user_id = ${externalUserId}
        `);
        return rows[0]?.id;
      }),
    `a conversation for ${externalUserId}`,
  );
}

async function messageStatus(
  messageId: string,
): Promise<{ status: string; provider: string | null; error: string | null }> {
  return withOrg({ orgId: ORG_A }, async (tx) => {
    const rows = await tx.execute<{
      status: string;
      provider_message_id: string | null;
      error_code: string | null;
    }>(sql`
      select status, provider_message_id, error_code from inbox.messages where id = ${messageId}
    `);
    const row = rows[0];
    if (row === undefined) throw new Error('no such message');
    return { status: row.status, provider: row.provider_message_id, error: row.error_code };
  });
}

async function outboxRows(
  name: string,
): Promise<{ payload: Record<string, unknown>; rooms: string[] }[]> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ payload: Record<string, unknown>; rooms: string[] }>(sql`
      select payload, rooms from events.outbox where name = ${name} order by created_at
    `);
      return [...rows];
    },
    { orgId: ORG_A },
  );
}

let metaAnswer: (call: MetaCall) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { message_id: `m_${randomUUID()}` },
});

beforeAll(async () => {
  metaServer = createServer((request, response) => {
    void readBody(request).then((text) => {
      const call: MetaCall = {
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      };
      metaCalls.push(call);
      const answer = metaAnswer(call);
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => metaServer.listen(0, '127.0.0.1', resolve));
  // The real Graph adapter, pointed at the stand-in: the whole send path runs as it would.
  process.env.INBOX_META_PROVIDER = 'graph';
  process.env.INBOX_META_ENABLED = 'true';
  process.env.INBOX_META_BASE_URL = `http://127.0.0.1:${String((metaServer.address() as AddressInfo).port)}`;

  harness = await startHttpHarness('m42-inbox');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: ALL_QUEUES,
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  await registerInboxJobs({
    jobs,
    dispatcher: { on: () => undefined } as unknown as OutboxDispatcher,
    webhooks: harness.app.get(InboxWebhookService),
    sender: harness.app.get(InboxSendService),
    orders: harness.app.get(InboxOrderListener),
    report: () => Promise.resolve(),
  });

  admin = await harness.asRole('org_admin', ORG_A);
  salesA = await harness.asRole('sales', ORG_A);
  salesB = await harness.asRole('sales', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);

  const seeded = await seedProductWithSkus(ORG_A, 'm42inbox', 2);
  productId = seeded.productId;
  skuId = seeded.skus[0]?.id ?? '';
  skuCode = seeded.skus[0]?.code ?? '';
  await seedStockLevel(ORG_A, {
    skuId,
    locationId: await warehouseId(ORG_A),
    qty: 7,
    unitCostPoisha: 55_500n,
  });

  // Settings → Inbox, as the brand's admin would fill it.
  const app = await admin.client.request('PUT', '/v1/inbox/meta-app', {
    body: { appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
  });
  expect(app.statusCode, app.body).toBe(200);
  for (const [kind, externalId, token] of [
    ['messenger', PAGE, 'EAAB-messenger-page-token-000000'],
    ['instagram', IG, undefined],
    ['whatsapp', PHONE_ID, 'EAAG-whatsapp-cloud-token-000000'],
  ] as const) {
    const saved = await admin.client.request('PUT', `/v1/inbox/channels/${kind}`, {
      body: { externalId, enabled: true, ...(token === undefined ? {} : { accessToken: token }) },
    });
    expect(saved.statusCode, saved.body).toBe(200);
  }
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
  await new Promise<void>((resolve) => metaServer.close(() => resolve()));
  delete process.env.INBOX_META_PROVIDER;
  delete process.env.INBOX_META_ENABLED;
  delete process.env.INBOX_META_BASE_URL;
}, 60_000);

describe('Settings → Inbox (D-733)', () => {
  it('keeps the secrets sealed and shows only that they are set, to org_admin alone', async () => {
    const response = await admin.client.request('GET', '/v1/inbox/channels');
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(APP_SECRET);
    expect(response.body).not.toContain(VERIFY_TOKEN);
    expect(response.body).not.toContain('EAAB-messenger-page-token');
    const view = json<{
      webhookPath: string;
      app: { appSecretSet: boolean; appSecretFingerprint: string };
      channels: { kind: string; tokenSet: boolean; tokenFingerprint: string | null }[];
    }>(response);
    expect(view.webhookPath).toBe(`/webhooks/meta/${ORG_A}`);
    expect(view.app.appSecretSet).toBe(true);
    expect(view.app.appSecretFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(view.channels.find((c) => c.kind === 'messenger')?.tokenSet).toBe(true);
    expect(view.channels.find((c) => c.kind === 'instagram')?.tokenSet).toBe(false);

    const stored = await withOrg({ orgId: ORG_A }, async (tx) => {
      const rows = await tx.execute<{ sealed: Buffer }>(
        sql`select app_secret_sealed as sealed from inbox.settings`,
      );
      return Buffer.from(rows[0]?.sealed ?? Buffer.alloc(0)).toString('latin1');
    });
    expect(stored).not.toContain(APP_SECRET);

    const sales = await salesA.client.request('GET', '/v1/inbox/channels');
    expect(sales.statusCode).toBe(403);
  });

  it('answers Meta’s subscription check only with the right verify token', async () => {
    const url = (token: string) =>
      `/webhooks/meta/${ORG_A}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`;
    const ok = await harness.server.inject({
      method: 'GET',
      url: url(VERIFY_TOKEN),
      headers: { host: APP_DOMAIN },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('1158201444');
    expect(ok.headers['content-type']).toContain('text/plain');
    const wrong = await harness.server.inject({
      method: 'GET',
      url: url('not-the-token-at-all'),
      headers: { host: APP_DOMAIN },
    });
    expect(wrong.statusCode).toBe(403);
    const otherBrand = await harness.server.inject({
      method: 'GET',
      url: url(VERIFY_TOKEN).replace(ORG_A, ORG_B),
      headers: { host: APP_DOMAIN },
    });
    expect(otherBrand.statusCode).toBe(403);
  });
});

describe('check 1: signed webhooks open and thread conversations', () => {
  it('Messenger: a text opens a conversation, the next threads into it', async () => {
    const psid = '6578123456789012';
    await deliverAndThread(
      messengerText({
        pageId: PAGE,
        psid,
        mid: `m_${randomUUID()}`,
        text: 'Is the black one available?',
      }),
    );
    const id = await conversationFor(psid);
    await deliverAndThread(
      messengerText({ pageId: PAGE, psid, mid: `m_${randomUUID()}`, text: 'Size M please' }),
    );
    expect(await conversationFor(psid)).toBe(id);

    const thread = await salesA.client.request('GET', `/v1/inbox/conversations/${id}`);
    expect(thread.statusCode, thread.body).toBe(200);
    const view = json<{
      conversation: { channel: string; unreadCount: number; window: { open: boolean } };
      messages: { text: string; direction: string }[];
    }>(thread);
    expect(view.conversation.channel).toBe('messenger');
    expect(view.conversation.unreadCount).toBe(2);
    expect(view.conversation.window.open).toBe(true);
    expect(view.messages.map((m) => m.text)).toEqual([
      'Is the black one available?',
      'Size M please',
    ]);

    // New messages reach the list's rooms and, once it is someone's, the assignee's room.
    const received = await outboxRows('inbox.message_received');
    const forThis = received.filter((row) => row.payload.conversationId === id);
    expect(forThis).toHaveLength(2);
    expect(forThis[0]?.rooms).toEqual(
      expect.arrayContaining([`org:${ORG_A}:role:sales`, `org:${ORG_A}:role:org_admin`]),
    );
    expect(JSON.stringify(forThis)).not.toContain('black one');
  });

  it('Instagram and WhatsApp: each opens its own conversation on its channel', async () => {
    await deliverAndThread(
      instagramText({
        igAccountId: IG,
        igsid: '5432109876543210',
        mid: `aWdf_${randomUUID()}`,
        text: 'price?',
      }),
    );
    await deliverAndThread(
      whatsAppText({
        phoneNumberId: PHONE_ID,
        waId: '16505551234',
        name: 'Sheena Nelson',
        wamid: `wamid.${randomUUID()}`,
        text: 'Does it come in another color?',
      }),
    );
    const list = await salesA.client.request('GET', '/v1/inbox/conversations?view=unassigned');
    const items = json<{ items: { channel: string; contact: { name: string | null } }[] }>(
      list,
    ).items;
    expect(items.map((item) => item.channel)).toEqual(
      expect.arrayContaining(['instagram', 'whatsapp', 'messenger']),
    );
    expect(items.find((item) => item.channel === 'whatsapp')?.contact.name).toBe('Sheena Nelson');
    const whatsapp = await salesA.client.request('GET', '/v1/inbox/conversations?channel=whatsapp');
    expect(
      json<{ items: { channel: string }[] }>(whatsapp).items.every(
        (item) => item.channel === 'whatsapp',
      ),
    ).toBe(true);
  });

  it('refuses a bad signature and stores nothing', async () => {
    const before = await webhookRows(ORG_A);
    const body = messengerText({
      pageId: PAGE,
      psid: '6578000000000001',
      mid: `m_${randomUUID()}`,
      text: 'forged',
    });
    const wrongSecret = await deliver(body, { secret: 'not-the-brands-secret-0000000000' });
    expect(wrongSecret.statusCode).toBe(401);
    expect(json<{ code: string }>(wrongSecret).code).toBe('WEBHOOK_SIGNATURE_INVALID');
    const noSignature = await deliver(body, { signature: '' });
    expect(noSignature.statusCode).toBe(401);
    // Another brand's address with this brand's signature: that brand has no such secret.
    const elsewhere = await deliver(body, { orgId: ORG_B });
    expect(elsewhere.statusCode).toBe(401);
    expect(await webhookRows(ORG_A)).toBe(before);
    expect(await webhookRows(ORG_B)).toBe(0);
  });

  it('ignores a repeated delivery: the same body, and the same message id in a new body', async () => {
    const psid = '6578123456780000';
    const mid = `m_${randomUUID()}`;
    const body = messengerText({
      pageId: PAGE,
      psid,
      mid,
      text: 'only once',
      timestamp: Date.now(),
    });
    await deliverAndThread(body);
    const again = await deliver(body);
    expect(again.statusCode).toBe(200);
    expect(json<{ duplicate: boolean }>(again).duplicate).toBe(true);
    // Meta's retry as a fresh batch: a different body carrying the same message.
    await deliverAndThread({ ...body, entry: [{ ...body.entry[0], time: 1 }] });
    const id = await conversationFor(psid);
    const thread = json<{ messages: unknown[] }>(
      await salesA.client.request('GET', `/v1/inbox/conversations/${id}`),
    );
    expect(thread.messages).toHaveLength(1);
  });
});

describe('check 2: replies go out by a job, inside the 24-hour window only', () => {
  it('sends a Messenger reply to Meta after the commit and records its id, then its receipts', async () => {
    const psid = '6578123456789099';
    await deliverAndThread(
      messengerText({ pageId: PAGE, psid, mid: `m_${randomUUID()}`, text: 'hello?' }),
    );
    const id = await conversationFor(psid);
    metaCalls.length = 0;
    const messageId = randomUUID();
    const reply = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/messages`, {
      body: { id: messageId, text: 'Ji, available in M.' },
    });
    expect(reply.statusCode, reply.body).toBe(201);
    expect(json<{ status: string }>(reply).status).toBe('queued');

    const sent = await until(async () => {
      const status = await messageStatus(messageId);
      return status.status === 'sent' ? status : undefined;
    }, 'the send job');
    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0]?.url).toMatch(new RegExp(`^/v25\\.0/${PAGE}/messages\\?access_token=`));
    expect(metaCalls[0]?.body).toEqual({
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: { text: 'Ji, available in M.' },
    });
    expect(sent.provider).toMatch(/^m_/);

    // Replying in a conversation nobody had took it.
    const after = json<{ conversation: { assignedTo: { userId: string } | null } }>(
      await salesA.client.request('GET', `/v1/inbox/conversations/${id}`),
    );
    expect(after.conversation.assignedTo?.userId).toBe(salesA.userId);

    // The same reply retried is one message and one send.
    const retried = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/messages`, {
      body: { id: messageId, text: 'Ji, available in M.' },
    });
    expect(json<{ replayed: boolean }>(retried).replayed).toBe(true);
    expect(metaCalls).toHaveLength(1);

    await deliverAndThread(
      messengerDelivery({ pageId: PAGE, psid, mids: [sent.provider ?? ''], watermark: Date.now() }),
    );
    expect((await messageStatus(messageId)).status).toBe('delivered');
    await deliverAndThread(messengerRead({ pageId: PAGE, psid, watermark: Date.now() + 1000 }));
    expect((await messageStatus(messageId)).status).toBe('read');
  });

  it('sends WhatsApp with the Cloud API body and follows its statuses', async () => {
    const waId = '8801712000001';
    await deliverAndThread(
      whatsAppText({
        phoneNumberId: PHONE_ID,
        waId,
        name: 'Rumana',
        wamid: `wamid.${randomUUID()}`,
        text: 'hi',
      }),
    );
    const id = await conversationFor(waId);
    metaCalls.length = 0;
    const wamid = `wamid.SENT.${randomUUID()}`;
    metaAnswer = () => ({
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: waId, wa_id: waId }],
        messages: [{ id: wamid }],
      },
    });
    const messageId = randomUUID();
    const reply = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/messages`, {
      body: { id: messageId, text: 'Assalamu alaikum' },
    });
    expect(reply.statusCode, reply.body).toBe(201);
    await until(
      async () => ((await messageStatus(messageId)).status === 'sent' ? true : undefined),
      'the WhatsApp send',
    );
    expect(metaCalls[0]?.url).toBe(`/v25.0/${PHONE_ID}/messages`);
    expect(metaCalls[0]?.authorization).toBe('Bearer EAAG-whatsapp-cloud-token-000000');
    expect(metaCalls[0]?.body).toMatchObject({
      messaging_product: 'whatsapp',
      to: waId,
      type: 'text',
      text: { body: 'Assalamu alaikum' },
    });
    metaAnswer = () => ({ status: 200, body: { message_id: `m_${randomUUID()}` } });

    await deliverAndThread(
      whatsAppStatus({ phoneNumberId: PHONE_ID, waId, wamid, status: 'read' }),
    );
    expect((await messageStatus(messageId)).status).toBe('read');
    // A late `delivered` does not move it back.
    await deliverAndThread(
      whatsAppStatus({ phoneNumberId: PHONE_ID, waId, wamid, status: 'delivered', timestamp: '1' }),
    );
    expect((await messageStatus(messageId)).status).toBe('read');
  });

  it('refuses free text outside the window, with the reason', async () => {
    const psid = '6578123456700001';
    const yesterday = Date.now() - 25 * 60 * 60 * 1000;
    await deliverAndThread(
      messengerText({
        pageId: PAGE,
        psid,
        mid: `m_${randomUUID()}`,
        text: 'old question',
        timestamp: yesterday,
      }),
    );
    const id = await conversationFor(psid);
    metaCalls.length = 0;
    const refused = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/messages`, {
      body: { id: randomUUID(), text: 'Sorry for the delay' },
    });
    expect(refused.statusCode).toBe(409);
    const problem = json<{ code: string; reason: string; detail: string }>(refused);
    expect(problem.code).toBe('INBOX_WINDOW_CLOSED');
    expect(problem.reason).toBe('window_expired');
    expect(problem.detail).toContain('24-hour');
    const view = json<{ conversation: { window: { open: boolean; reason: string } } }>(
      await salesA.client.request('GET', `/v1/inbox/conversations/${id}`),
    );
    expect(view.conversation.window).toMatchObject({ open: false, reason: 'expired' });
    expect(metaCalls).toHaveLength(0);
  });

  it('the job checks the window again and never sends a reply that waited past it', async () => {
    const psid = '6578123456700002';
    await deliverAndThread(
      messengerText({
        pageId: PAGE,
        psid,
        mid: `m_${randomUUID()}`,
        text: 'q',
        timestamp: Date.now() - 23 * 60 * 60 * 1000,
      }),
    );
    const id = await conversationFor(psid);
    const messageId = randomUUID();
    // Queued by hand, so no job is in flight, then the job runs "two hours later".
    await withOrg({ orgId: ORG_A }, (tx) =>
      tx.execute(sql`
        insert into inbox.messages (id, org_id, conversation_id, direction, body, status, sent_by, occurred_at)
        values (${messageId}, ${ORG_A}, ${id}, 'outbound', 'late reply', 'queued', ${salesA.userId}, now())
      `),
    );
    metaCalls.length = 0;
    const sender = harness.app.get(InboxSendService);
    const outcome = await sender.send(
      ORG_A,
      messageId,
      () => new Date(Date.now() + 2 * 60 * 60 * 1000),
    );
    expect(outcome).toBe('failed');
    expect(await messageStatus(messageId)).toMatchObject({
      status: 'failed',
      error: 'window_closed',
    });
    expect(metaCalls).toHaveLength(0);
  });

  it('a permanent refusal from Meta marks the reply failed with Meta’s code', async () => {
    const psid = '6578123456700003';
    await deliverAndThread(
      messengerText({ pageId: PAGE, psid, mid: `m_${randomUUID()}`, text: 'hey' }),
    );
    const id = await conversationFor(psid);
    metaAnswer = () => ({
      status: 400,
      body: { error: { message: 'Invalid OAuth access token.', code: 190 } },
    });
    const messageId = randomUUID();
    const reply = await salesB.client.request('POST', `/v1/inbox/conversations/${id}/messages`, {
      body: { id: messageId, text: 'Hi' },
    });
    expect(reply.statusCode, reply.body).toBe(201);
    const failed = await until(async () => {
      const status = await messageStatus(messageId);
      return status.status === 'failed' ? status : undefined;
    }, 'the refused send');
    expect(failed.error).toBe('meta:190');
    metaAnswer = () => ({ status: 200, body: { message_id: `m_${randomUUID()}` } });
  });
});

describe('ownership (D-737): take, hand over, and acknowledging the owner', () => {
  it('two people taking at once: exactly one gets it, the other is told who has it', async () => {
    const psid = '6578123456711111';
    await deliverAndThread(
      messengerText({ pageId: PAGE, psid, mid: `m_${randomUUID()}`, text: 'race' }),
    );
    const id = await conversationFor(psid);
    const [first, second] = await Promise.all([
      salesA.client.request('POST', `/v1/inbox/conversations/${id}/take`),
      salesB.client.request('POST', `/v1/inbox/conversations/${id}/take`),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(json<{ code: string; reason: string }>(loser)).toMatchObject({
      code: 'INBOX_OWNER_ACK_REQUIRED',
      reason: 'owned_by_other',
    });
  });

  it('a non-owner’s write is refused without the acknowledgement; with it, audited and the owner told', async () => {
    const psid = '6578123456722222';
    await deliverAndThread(
      messengerText({ pageId: PAGE, psid, mid: `m_${randomUUID()}`, text: 'mine?' }),
    );
    const id = await conversationFor(psid);
    expect(
      (await salesA.client.request('POST', `/v1/inbox/conversations/${id}/take`)).statusCode,
    ).toBe(200);

    const blocked = await salesB.client.request('POST', `/v1/inbox/conversations/${id}/notes`, {
      body: { body: 'Covering while Rahim is out' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(json<{ code: string }>(blocked).code).toBe('INBOX_OWNER_ACK_REQUIRED');

    const acknowledged = await salesB.client.request(
      'POST',
      `/v1/inbox/conversations/${id}/notes`,
      {
        body: { body: 'Covering while Rahim is out' },
        headers: { 'x-acknowledge-owner': '1' },
      },
    );
    expect(acknowledged.statusCode, acknowledged.body).toBe(201);
    const noteId = json<{ id: string }>(acknowledged).id;
    const audit = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{
          action: string;
          actor_user_id: string;
          after: Record<string, unknown>;
        }>(sql`
        select action, actor_user_id, after from audit.audit_log where entity_id = ${noteId}
      `);
        return [...rows];
      },
      { orgId: ORG_A },
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'inbox.note', actor_user_id: salesB.userId });
    expect(audit[0]?.after).toMatchObject({ acknowledgedOwner: salesA.userId, conversation: id });
    const told = (await outboxRows('inbox.owner_overridden')).filter(
      (row) => row.payload.conversationId === id,
    );
    expect(told).toEqual([
      {
        payload: {
          conversationId: id,
          ownerUserId: salesA.userId,
          actorUserId: salesB.userId,
          action: 'note',
        },
        rooms: [`user:${salesA.userId}`],
      },
    ]);

    // Handing someone else's conversation over is a supervisor's; org_admin may, acknowledging.
    const handOverBySales = await salesB.client.request(
      'POST',
      `/v1/inbox/conversations/${id}/hand-over`,
      {
        body: { userId: salesB.userId },
        headers: { 'x-acknowledge-owner': '1' },
      },
    );
    expect(handOverBySales.statusCode).toBe(403);
    expect(json<{ code: string }>(handOverBySales).code).toBe('INBOX_HANDOVER_NOT_ALLOWED');
    const withoutAck = await admin.client.request(
      'POST',
      `/v1/inbox/conversations/${id}/hand-over`,
      {
        body: { userId: salesB.userId },
      },
    );
    expect(withoutAck.statusCode).toBe(409);
    const handed = await admin.client.request('POST', `/v1/inbox/conversations/${id}/hand-over`, {
      body: { userId: salesB.userId },
      headers: { 'x-acknowledge-owner': '1' },
    });
    expect(handed.statusCode, handed.body).toBe(200);
    const changed = (await outboxRows('inbox.conversation_changed')).filter(
      (row) => row.payload.conversationId === id,
    );
    expect(changed.at(-1)?.rooms).toEqual(
      expect.arrayContaining([`user:${salesB.userId}`, `user:${salesA.userId}`]),
    );
    // The new owner releases it.
    expect(
      (await salesB.client.request('POST', `/v1/inbox/conversations/${id}/release`)).statusCode,
    ).toBe(200);
    const mine = json<{ items: { id: string }[] }>(
      await salesB.client.request('GET', '/v1/inbox/conversations?view=mine'),
    );
    expect(mine.items.some((item) => item.id === id)).toBe(false);
  });
});

describe('check 3: phones in the chat, the matched customer, and Customer on an order', () => {
  it('finds a number in a message, matches the brand’s buyer and shows their orders', async () => {
    const customerId = await seedCustomer(ORG_A, {
      phoneE164: '+8801712345678',
      name: 'Farhana Akter',
    });
    await seedOrder(ORG_A, {
      status: 'delivered',
      customerId,
      lines: [{ skuId, skuCode, productName: 'Kurti', qty: 1, unitPricePoisha: 150_000n }],
    });
    // The buyer's counters, as the delivery would have moved them.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update sales.customers set orders_total = 1, delivered_count = 1, ltv_poisha = 150000
          where id = ${customerId}
        `),
      { orgId: ORG_A },
    );
    const waId = '8801999000111';
    await deliverAndThread(
      whatsAppText({
        phoneNumberId: PHONE_ID,
        waId,
        name: 'Farhana',
        wamid: `wamid.${randomUUID()}`,
        text: 'amar number ০১৭১২-৩৪৫৬৭৮, order korte chai',
      }),
    );
    const id = await conversationFor(waId);

    const panel = json<{
      phonesFound: { phone: string; matchesCustomer: boolean; saved: boolean }[];
      customer: unknown;
    }>(await salesA.client.request('GET', `/v1/inbox/conversations/${id}/panel`));
    expect(panel.phonesFound).toEqual(
      expect.arrayContaining([{ phone: '+8801712345678', matchesCustomer: true, saved: false }]),
    );
    expect(panel.customer).toBeNull();

    const saved = await salesA.client.request(
      'PUT',
      `/v1/inbox/conversations/${id}/contact/phone`,
      {
        body: { phone: '+8801712345678' },
      },
    );
    expect(saved.statusCode, saved.body).toBe(200);
    const after = json<{
      contact: { phone: string; stage: string };
      customer: {
        name: string;
        orders: number;
        delivered: number;
        spentPoisha: string;
        recentOrders: { orderNo: string; status: string }[];
      };
    }>(await salesA.client.request('GET', `/v1/inbox/conversations/${id}/panel`));
    expect(after.contact.phone).toBe('+8801712345678');
    expect(after.customer).toMatchObject({
      name: 'Farhana Akter',
      orders: 1,
      delivered: 1,
      spentPoisha: '150000',
    });
    expect(after.customer.recentOrders).toEqual([expect.objectContaining({ status: 'delivered' })]);
    expect(after.contact.stage).toBe('customer');
  });

  it('a contact becomes Customer when an order is placed from the chat; Fraud stays and warns the desk', async () => {
    const waId = '8801888000222';
    await deliverAndThread(
      whatsAppText({
        phoneNumberId: PHONE_ID,
        waId,
        name: 'Nadia',
        wamid: `wamid.${randomUUID()}`,
        text: 'I want the black kurti',
      }),
    );
    const id = await conversationFor(waId);
    const lead = await salesA.client.request('PUT', `/v1/inbox/conversations/${id}/contact/stage`, {
      body: { stage: 'lead' },
    });
    expect(lead.statusCode, lead.body).toBe(200);
    await salesA.client.request('PUT', `/v1/inbox/conversations/${id}/contact/phone`, {
      body: { phone: '01888000222' },
    });

    const area = await withSystem(async (tx) => {
      const rows = await tx.execute<{ district_id: number; thana_id: number }>(
        sql`select district_id, id as thana_id from ref.thanas order by id limit 1`,
      );
      return rows[0];
    });
    const draft = json<{ channel: string; phone: string; conversationId: string }>(
      await salesA.client.request('GET', `/v1/inbox/conversations/${id}/order-draft`),
    );
    expect(draft).toMatchObject({
      channel: 'whatsapp',
      phone: '+8801888000222',
      conversationId: id,
    });
    const order = await salesA.client.request('POST', '/v1/orders', {
      body: {
        channel: draft.channel,
        source: { inboxConversationId: id },
        customer: { phone: draft.phone, name: 'Nadia' },
        shipTo: {
          districtId: area?.district_id ?? 1,
          thanaId: area?.thana_id ?? 1,
          addressLine: 'House 3, Road 2',
        },
        lines: [{ skuId, qty: 1 }],
        assignedTo: salesA.userId,
      },
    });
    expect(order.statusCode, order.body).toBe(201);
    const orderId = json<{ id: string }>(order).id;

    // The worker hears `order.created` from the outbox; here the listener is handed that row.
    const event = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{
          id: string;
          org_id: string;
          payload: unknown;
          rooms: string[];
          created_at: Date;
        }>(sql`
        select id, org_id, payload, rooms, created_at from events.outbox
        where name = 'order.created' and payload ->> 'id' = ${orderId}
      `);
        return rows[0];
      },
      { orgId: ORG_A },
    );
    if (event === undefined) throw new Error('no order.created in the outbox');
    const delivered: DeliveredEvent = {
      id: event.id,
      orgId: event.org_id,
      name: 'order.created',
      payload: event.payload,
      rooms: event.rooms,
      attempts: 0,
      occurredAt: new Date(event.created_at),
      actorUserId: salesA.userId,
    };
    await harness.app.get(InboxOrderListener).onOrderCreated(delivered);
    await harness.app.get(InboxOrderListener).onOrderCreated(delivered);

    const panel = json<{
      contact: { stage: string };
      customer: { orders: number; recentOrders: { id: string; status: string }[] };
    }>(await salesA.client.request('GET', `/v1/inbox/conversations/${id}/panel`));
    expect(panel.contact.stage).toBe('customer');
    expect(panel.customer.orders).toBe(1);
    expect(panel.customer.recentOrders[0]?.id).toBe(orderId);
    const stage = await salesA.client.request(
      'PUT',
      `/v1/inbox/conversations/${id}/contact/stage`,
      { body: { stage: 'lead' } },
    );
    expect(stage.statusCode).toBe(409);
    expect(json<{ code: string }>(stage).code).toBe('INBOX_STAGE_INVALID');

    // Fraud sticks through an order, and the desk is warned for that phone.
    expect(
      (
        await salesA.client.request('PUT', `/v1/inbox/conversations/${id}/contact/stage`, {
          body: { stage: 'fraud' },
        })
      ).statusCode,
    ).toBe(200);
    await harness.app.get(InboxOrderListener).onOrderCreated(delivered);
    const flags = json<{ fraud: boolean; contacts: { conversationId: string }[] }>(
      await salesB.client.request('GET', '/v1/inbox/phone-flags?phone=01888000222'),
    );
    expect(flags.fraud).toBe(true);
    expect(flags.contacts[0]?.conversationId).toBe(id);
    const clean = json<{ fraud: boolean }>(
      await salesB.client.request('GET', '/v1/inbox/phone-flags?phone=01999999999'),
    );
    expect(clean.fraud).toBe(false);
  });
});

describe('check 4: notes and product interests, with live catalog data and no cost', () => {
  it('saves dated notes with their author, and interests with price, stock and photo', async () => {
    const psid = '6578123456733333';
    await deliverAndThread(
      messengerText({
        pageId: PAGE,
        psid,
        mid: `m_${randomUUID()}`,
        text: 'Do you have this in M?',
      }),
    );
    const id = await conversationFor(psid);
    await salesA.client.request('POST', `/v1/inbox/conversations/${id}/take`);
    const note = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/notes`, {
      body: { body: 'Wants the black kurti in M; call after 6 pm.' },
    });
    expect(note.statusCode, note.body).toBe(201);
    const interest = await salesA.client.request(
      'POST',
      `/v1/inbox/conversations/${id}/interests`,
      {
        body: { productId, skuId },
      },
    );
    expect(interest.statusCode, interest.body).toBe(201);
    const twice = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/interests`, {
      body: { productId },
    });
    expect(json<{ added: boolean }>(twice).added).toBe(false);
    const tags = await salesA.client.request('PUT', `/v1/inbox/conversations/${id}/contact/tags`, {
      body: { tags: ['vip', 'eid'] },
    });
    expect(tags.statusCode).toBe(200);

    // Org B's product is refused.
    const foreign = await seedProductWithSkus(ORG_B, 'm42other', 1);
    const refused = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/interests`, {
      body: { productId: foreign.productId },
    });
    expect(refused.statusCode).toBe(400);

    for (const viewer of [salesA, salesB]) {
      const response = await viewer.client.request('GET', `/v1/inbox/conversations/${id}/panel`);
      expect(response.statusCode).toBe(200);
      const panel = json<{
        notes: { body: string; at: string; author: { userId: string; name: string | null } }[];
        interests: {
          product: {
            name: string;
            variants: { skuId: string; pricePoisha: string; available: number }[];
          };
        }[];
        contact: { tags: string[] };
      }>(response);
      expect(panel.notes[0]).toMatchObject({
        body: 'Wants the black kurti in M; call after 6 pm.',
        author: { userId: salesA.userId },
      });
      expect(Number.isNaN(Date.parse(panel.notes[0]?.at ?? ''))).toBe(false);
      const variants = panel.interests[0]?.product.variants ?? [];
      expect(variants.find((variant) => variant.skuId === skuId)?.available).toBe(7);
      expect(variants.every((variant) => /^\d+$/.test(variant.pricePoisha))).toBe(true);
      expect(panel.contact.tags).toEqual(['vip', 'eid']);
      expect(findCostFields(panel)).toEqual([]);
      expect(response.body).not.toContain('55500');
    }

    // Live: a new price shows at once.
    await withSystem(
      (tx) => tx.execute(sql`update catalog.skus set price_poisha = 199900 where id = ${skuId}`),
      { orgId: ORG_A },
    );
    const live = json<{
      interests: { product: { variants: { skuId: string; pricePoisha: string }[] } }[];
    }>(await salesA.client.request('GET', `/v1/inbox/conversations/${id}/panel`));
    expect(
      live.interests[0]?.product.variants.find((variant) => variant.skuId === skuId)?.pricePoisha,
    ).toBe('199900');
  });
});

describe('check 5: tenancy and permissions', () => {
  it('another brand sees none of it, at the routes and in the tables', async () => {
    const psid = '6578123456744444';
    await deliverAndThread(
      messengerText({ pageId: PAGE, psid, mid: `m_${randomUUID()}`, text: 'brand A only' }),
    );
    const id = await conversationFor(psid);
    expect((await adminB.client.request('GET', `/v1/inbox/conversations/${id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await adminB.client.request('GET', `/v1/inbox/conversations/${id}/panel`)).statusCode,
    ).toBe(404);
    expect(
      (await adminB.client.request('POST', `/v1/inbox/conversations/${id}/take`)).statusCode,
    ).toBe(404);
    const list = json<{ items: unknown[] }>(
      await adminB.client.request('GET', '/v1/inbox/conversations?status=any'),
    );
    expect(list.items).toEqual([]);
    const seenFromB = await withOrg({ orgId: ORG_B }, async (tx) => {
      const counts = await tx.execute<{ n: number }>(sql`
        select (select count(*) from inbox.conversations)::int + (select count(*) from inbox.messages)::int
             + (select count(*) from inbox.contacts)::int + (select count(*) from inbox.channels)::int
             + (select count(*) from inbox.settings)::int as n
      `);
      return counts[0]?.n;
    });
    expect(seenFromB).toBe(0);
  });

  it('roles without the inbox are refused at the guard', async () => {
    const warehouse = await harness.asRole('warehouse', ORG_A);
    expect((await warehouse.client.request('GET', '/v1/inbox/conversations')).statusCode).toBe(403);
    const accounts = await harness.asRole('accounts', ORG_A);
    expect((await accounts.client.request('GET', '/v1/inbox/team')).statusCode).toBe(403);
    const team = json<{ items: { userId: string }[] }>(
      await salesA.client.request('GET', '/v1/inbox/team'),
    );
    expect(team.items.map((member) => member.userId)).toEqual(
      expect.arrayContaining([salesA.userId, salesB.userId, admin.userId]),
    );
  });
});
