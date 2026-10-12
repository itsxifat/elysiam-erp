import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_QUEUES } from '../../job-queues.js';
import type { OutboxDispatcher } from '../../platform/events/dispatcher.js';
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
import { InboxCallsService } from './calls.service.js';
import { ConversationOffersService } from './conversation-offers.service.js';
import { registerInboxJobs } from './inbox.worker.js';
import { InboxMediaService } from './media.service.js';
import { whatsAppStatus, whatsAppText } from './meta-fixtures.js';
import { InboxOrderListener } from './order-listener.service.js';
import { InboxSendService } from './send.service.js';
import { metaSignatureFor } from './signature.js';
import { registerVoiceCallsJobs } from './voice-calls.worker.js';
import { InboxWebhookService } from './webhook.service.js';

/**
 * M45's acceptance checks on real Postgres, through the real routes and jobs, with the real
 * Graph adapters pointed at a stand-in for Meta on this machine (D-780 to D-788):
 *
 * 1. A WhatsApp voice note is downloaded by its media id, kept, and plays through the media
 *    route; a Messenger link off Meta's hosts is never fetched. A recorded voice message is
 *    uploaded, converted (a stand-in for ffmpeg here), uploaded to WhatsApp and sent by id as a
 *    voice note, and its delivery recorded; outside the window it is refused, and nobody sends
 *    someone else's recording.
 * 2. A call rings the active messages desk when nobody has the conversation and its owner when
 *    someone does; two agents picking it up at once: one gets it (and WhatsApp's offer), the
 *    other is told; the answer goes to Meta as pre-accept then accept; Meta's terminate ends it
 *    with its duration; a missed call leaves a call-back item that is dealt with once; a decline
 *    goes to Meta; a call that rings out is missed; Messenger's accept carries the browser's
 *    offer and returns Meta's answer; another brand sees none of it.
 */

const APP_SECRET = 'm45-test-app-secret-0123456789abcdef';
const PAGE = '104512345678902';
const PHONE_ID = '106540352242923';
const OGG = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]);
const SDP_OFFER =
  'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const SDP_ANSWER =
  'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=setup:active\r\n';

interface MetaCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

const metaCalls: MetaCall[] = [];
let metaServer: Server;
let metaBase = '';
let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let salesA: RoleClient;
let salesB: RoleClient;
let adminB: RoleClient;

function collect(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

function jsonOf(call: MetaCall | undefined): Record<string, unknown> {
  return JSON.parse(call?.body.toString('utf8') ?? '{}') as Record<string, unknown>;
}

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function deliver(body: unknown): Promise<void> {
  const raw = JSON.stringify(body);
  const response = await harness.server.inject({
    method: 'POST',
    url: `/webhooks/meta/${ORG_A}`,
    headers: {
      host: APP_DOMAIN,
      'content-type': 'application/json',
      'x-forwarded-for': '10.9.9.9',
      'x-hub-signature-256': metaSignatureFor(raw, APP_SECRET),
    },
    payload: raw,
  });
  expect(response.statusCode, response.body).toBe(200);
  await until(
    () =>
      withOrg({ orgId: ORG_A }, async (tx) => {
        const rows = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from inbox.webhook_events where processed_at is null`,
        );
        return rows[0]?.n === 0 ? true : undefined;
      }),
    'the webhook job',
  );
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

async function one<T extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<T>(query);
      const row = rows[0] as T | undefined;
      if (row === undefined) throw new Error('no row');
      return row;
    },
    { orgId: ORG_A },
  );
}

async function outboxRows(
  name: string,
): Promise<{ payload: Record<string, unknown>; rooms: string[] }[]> {
  return withSystem(
    async (tx) => [
      ...(await tx.execute<{ payload: Record<string, unknown>; rooms: string[] }>(sql`
        select payload, rooms from events.outbox where name = ${name} order by created_at
      `)),
    ],
    { orgId: ORG_A },
  );
}

/** The call webhooks, as WhatsApp's Calling API documents them. */
function whatsAppCall(
  event: 'connect' | 'terminate',
  callId: string,
  waId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '366634483210360',
        changes: [
          {
            field: 'calls',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '8801700000000', phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: 'Caller' }, wa_id: waId }],
              calls: [
                {
                  id: callId,
                  to: '8801700000000',
                  from: waId,
                  event,
                  direction: 'USER_INITIATED',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  ...(event === 'connect'
                    ? { session: { sdp_type: 'offer', sdp: SDP_OFFER } }
                    : {}),
                  ...extra,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function callByProvider(providerCallId: string) {
  return until(
    () =>
      withOrg({ orgId: ORG_A }, async (tx) => {
        const rows = await tx.execute<{
          id: string;
          status: string;
          rang_user_ids: string[];
          answered_by: string | null;
          declined_by: string | null;
          duration_seconds: number | null;
          callback_needed: boolean;
          conversation_id: string;
          offer_sdp: string | null;
        }>(sql`
          select id, status, rang_user_ids, answered_by, declined_by, duration_seconds,
                 callback_needed, conversation_id, offer_sdp
          from inbox.calls where provider_call_id = ${providerCallId}
        `);
        return rows[0];
      }),
    `the call ${providerCallId}`,
  );
}

async function threadOf(client: RoleClient, conversationId: string) {
  const response = await client.client.request('GET', `/v1/inbox/conversations/${conversationId}`);
  expect(response.statusCode, response.body).toBe(200);
  return json<{
    conversation: { unreadCount: number; lastPreview: string | null };
    messages: {
      id: string;
      status: string;
      attachments: Record<string, unknown>[];
    }[];
  }>(response);
}

/** Upload a recording the way the composer does: ticket, PUT, finalize. */
async function uploadRecording(actor: RoleClient, bytes: Buffer): Promise<string> {
  const ticket = await actor.client.request('POST', '/v1/files', {
    body: {
      purpose: 'inbox-media',
      contentType: 'audio/webm',
      sizeBytes: bytes.byteLength,
      visibility: 'private',
      originalName: 'voice.webm',
    },
  });
  expect(ticket.statusCode, ticket.body).toBe(201);
  const parsed = json<{ fileId: string; url: string; headers: Record<string, string> }>(ticket);
  const target = new URL(parsed.url);
  const put = await harness.server.inject({
    method: 'PUT',
    url: `${target.pathname}${target.search}`,
    headers: { ...parsed.headers, host: target.host },
    payload: bytes,
  });
  expect(put.statusCode, put.body).toBe(200);
  const finalized = await actor.client.request('POST', `/v1/files/${parsed.fileId}/finalize`);
  expect(finalized.statusCode, finalized.body).toBe(201);
  return parsed.fileId;
}

/** What a browser's MediaRecorder writes: an EBML header naming the WebM doctype. */
function webmRecording(): Buffer {
  return Buffer.from([
    0x1a,
    0x45,
    0xdf,
    0xa3,
    0x9f,
    0x42,
    0x86,
    0x81,
    0x01,
    0x42,
    0x82,
    0x84,
    ...Buffer.from('webm'),
    ...new Array<number>(64).fill(0),
  ]);
}

beforeAll(async () => {
  metaServer = createServer((request, response) => {
    void collect(request).then((body) => {
      const call: MetaCall = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      };
      metaCalls.push(call);
      const url = call.url;
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (call.method === 'GET' && url === '/v25.0/1003383421387256') {
        send(200, { url: `${metaBase}/media/voice-1`, mime_type: 'audio/ogg; codecs=opus' });
      } else if (call.method === 'GET' && url === '/media/voice-1') {
        response.writeHead(200, { 'content-type': 'audio/ogg' });
        response.end(OGG);
      } else if (url === `/v25.0/${PHONE_ID}/media`) {
        send(200, { id: '1013859600285441' });
      } else if (url === `/v25.0/${PHONE_ID}/messages`) {
        send(200, { messages: [{ id: `wamid.voice.${randomUUID()}` }] });
      } else if (url === `/v25.0/${PHONE_ID}/calls`) {
        send(200, { messaging_product: 'whatsapp', success: true });
      } else if (url.startsWith(`/v25.0/${PAGE}/calls`)) {
        send(200, { success: true, session: { sdp_response: SDP_ANSWER } });
      } else {
        send(404, { error: { message: 'unknown', code: 100 } });
      }
    });
  });
  await new Promise<void>((resolve) => metaServer.listen(0, '127.0.0.1', resolve));
  metaBase = `http://127.0.0.1:${String((metaServer.address() as AddressInfo).port)}`;
  process.env.INBOX_META_PROVIDER = 'graph';
  process.env.INBOX_META_ENABLED = 'true';
  process.env.INBOX_META_BASE_URL = metaBase;

  harness = await startHttpHarness('m45-voice-calls');
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
    offers: harness.app.get(ConversationOffersService),
    report: () => Promise.resolve(),
  });
  const media = harness.app.get(InboxMediaService);
  // No ffmpeg on every machine that runs this: a stand-in that "converts" to an Ogg header.
  media.transcode = () => Promise.resolve(new Uint8Array(OGG));
  await registerVoiceCallsJobs({
    jobs,
    media,
    calls: harness.app.get(InboxCallsService),
    report: () => Promise.resolve(),
  });

  admin = await harness.asRole('org_admin', ORG_A);
  salesA = await harness.asRole('sales', ORG_A);
  salesB = await harness.asRole('sales', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);
  for (const agent of [salesA, salesB]) {
    const beat = await agent.client.request('POST', '/v1/team/presence', {
      body: { visible: true, idleSeconds: 0 },
    });
    expect(beat.statusCode, beat.body).toBe(201);
  }

  const app = await admin.client.request('PUT', '/v1/inbox/meta-app', {
    body: { appSecret: APP_SECRET, verifyToken: 'm45-verify-token-for-the-suite' },
  });
  expect(app.statusCode, app.body).toBe(200);
  for (const [kind, externalId, token] of [
    ['messenger', PAGE, 'EAAB-messenger-page-token-000000'],
    ['whatsapp', PHONE_ID, 'EAAG-whatsapp-cloud-token-000000'],
  ] as const) {
    const saved = await admin.client.request('PUT', `/v1/inbox/channels/${kind}`, {
      body: { externalId, enabled: true, accessToken: token },
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

describe('voice messages (M45 check 1)', () => {
  const WA_ID = '8801712000001';
  let conversationId = '';
  let keptFileId = '';

  it('keeps a WhatsApp voice note and plays it through the media route', async () => {
    await deliver({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '8801700000000', phone_number_id: PHONE_ID },
                contacts: [{ profile: { name: 'Karim' }, wa_id: WA_ID }],
                messages: [
                  {
                    from: WA_ID,
                    id: `wamid.in.${randomUUID()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'audio',
                    audio: {
                      id: '1003383421387256',
                      mime_type: 'audio/ogg; codecs=opus',
                      sha256: 'x',
                      voice: true,
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    conversationId = await conversationFor(WA_ID);
    const kept = await until(async () => {
      const row = await one<{ status: string; file_id: string | null }>(
        sql`select status, file_id from inbox.media where conversation_id = ${conversationId}`,
      );
      return row.status === 'stored' ? row : undefined;
    }, 'the voice note kept');
    keptFileId = kept.file_id ?? '';
    // Downloaded by its media id, with the WhatsApp token, and never by anyone else's.
    const downloads = metaCalls.filter((call) => call.method === 'GET');
    expect(downloads.map((call) => call.url)).toEqual([
      '/v25.0/1003383421387256',
      '/media/voice-1',
    ]);
    expect(
      downloads.every((call) => call.authorization === 'Bearer EAAG-whatsapp-cloud-token-000000'),
    ).toBe(true);

    const thread = await threadOf(salesA, conversationId);
    expect(thread.messages[0]?.attachments[0]).toMatchObject({
      type: 'audio',
      media: 'stored',
      fileId: keptFileId,
      mimeType: 'audio/ogg',
    });
    const played = await salesA.client.request('GET', `/v1/inbox/media/${keptFileId}`);
    expect(played.statusCode, played.body).toBe(200);
    expect(played.headers['content-type']).toBe('audio/ogg');
    expect(played.headers['x-content-type-options']).toBe('nosniff');
    // The injected response carries the bytes as they were sent.
    expect(Buffer.from((played as unknown as { rawPayload: Buffer }).rawPayload)).toEqual(OGG);
    expect((await outboxRows('inbox.media_ready')).at(-1)?.payload).toMatchObject({
      conversationId,
      status: 'stored',
    });
    // Another brand: not found, as if it did not exist.
    expect((await adminB.client.request('GET', `/v1/inbox/media/${keptFileId}`)).statusCode).toBe(
      404,
    );
  });

  it('never fetches a Messenger attachment that is not on Meta’s hosts', async () => {
    const before = metaCalls.length;
    const psid = `psid-${randomUUID()}`;
    await deliver({
      object: 'page',
      entry: [
        {
          id: PAGE,
          time: Date.now(),
          messaging: [
            {
              sender: { id: psid },
              recipient: { id: PAGE },
              timestamp: Date.now(),
              message: {
                mid: `m_${randomUUID()}`,
                attachments: [
                  { type: 'audio', payload: { url: 'https://attacker.example/a.mp4' } },
                ],
              },
            },
          ],
        },
      ],
    });
    const id = await conversationFor(psid);
    const row = await until(async () => {
      const found = await one<{ status: string; error_code: string | null }>(
        sql`select status, error_code from inbox.media where conversation_id = ${id}`,
      );
      return found.status === 'failed' ? found : undefined;
    }, 'the refused attachment');
    expect(row.error_code).toBe('meta_refused');
    expect(metaCalls.length).toBe(before);
  });

  it('sends a recorded voice message as a WhatsApp voice note, by a job, and records its delivery', async () => {
    const fileId = await uploadRecording(salesA, webmRecording());
    const messageId = randomUUID();
    const sent = await salesA.client.request(
      'POST',
      `/v1/inbox/conversations/${conversationId}/voice`,
      { body: { id: messageId, fileId, durationMs: 4_200 } },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    expect(json<{ status: string }>(sent).status).toBe('queued');

    const wamid = await until(async () => {
      const row = await one<{ status: string; provider_message_id: string | null }>(
        sql`select status, provider_message_id from inbox.messages where id = ${messageId}`,
      );
      return row.status === 'sent' ? row.provider_message_id : undefined;
    }, 'the voice message sent');
    const upload = metaCalls.find((call) => call.url === `/v25.0/${PHONE_ID}/media`);
    const form = await new Response(upload?.body, {
      headers: { 'content-type': upload?.contentType ?? '' },
    }).formData();
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect((form.get('file') as File).type).toBe('audio/ogg');
    const message = metaCalls.filter((call) => call.url === `/v25.0/${PHONE_ID}/messages`).at(-1);
    expect(jsonOf(message)).toMatchObject({
      to: WA_ID,
      type: 'audio',
      audio: { id: '1013859600285441', voice: true },
    });

    await deliver(
      whatsAppStatus({
        phoneNumberId: PHONE_ID,
        waId: WA_ID,
        wamid: wamid ?? '',
        status: 'delivered',
      }),
    );
    const delivered = await one<{ status: string }>(
      sql`select status from inbox.messages where id = ${messageId}`,
    );
    expect(delivered.status).toBe('delivered');

    const thread = await threadOf(salesA, conversationId);
    const bubble = thread.messages.find((item) => item.id === messageId);
    expect(bubble?.attachments[0]).toMatchObject({ type: 'audio', fileId, durationMs: 4_200 });

    // The same recording again, or someone else's: refused.
    const again = await salesA.client.request(
      'POST',
      `/v1/inbox/conversations/${conversationId}/voice`,
      { body: { id: randomUUID(), fileId, durationMs: 4_200 } },
    );
    expect(again.statusCode).toBe(400);
    expect(json<{ code: string }>(again).code).toBe('INBOX_MEDIA_INVALID');
    const othersFile = await uploadRecording(salesA, webmRecording());
    const stolen = await salesB.client.request(
      'POST',
      `/v1/inbox/conversations/${conversationId}/voice`,
      {
        body: { id: randomUUID(), fileId: othersFile, durationMs: 1_000 },
        headers: { 'x-acknowledge-owner': '1' },
      },
    );
    expect(json<{ code: string }>(stolen).code).toBe('INBOX_MEDIA_INVALID');
  });

  it('refuses a voice message outside the 24-hour window', async () => {
    const waId = '8801712000002';
    await deliver(
      whatsAppText({
        phoneNumberId: PHONE_ID,
        waId,
        name: 'Old',
        wamid: `wamid.old.${randomUUID()}`,
        text: 'hello',
        timestamp: String(Math.floor(Date.now() / 1000) - 3 * 24 * 3600),
      }),
    );
    const id = await conversationFor(waId);
    const fileId = await uploadRecording(salesA, webmRecording());
    const refused = await salesA.client.request('POST', `/v1/inbox/conversations/${id}/voice`, {
      body: { id: randomUUID(), fileId, durationMs: 2_000 },
    });
    expect(refused.statusCode).toBe(409);
    expect(json<{ code: string }>(refused).code).toBe('INBOX_WINDOW_CLOSED');
  });
});

describe('calls (M45 check 2)', () => {
  const CALLER = '8801712000010';

  it('rings the active messages desk, gives the call to one of two agents, and connects it through Meta', async () => {
    const callId = `wacid.${randomUUID()}`;
    await deliver(whatsAppCall('connect', callId, CALLER));
    const call = await callByProvider(callId);
    expect(call.status).toBe('ringing');
    expect([...call.rang_user_ids].sort()).toEqual([salesA.userId, salesB.userId].sort());
    const ringing = (await outboxRows('inbox.call_ringing')).at(-1);
    expect(ringing?.rooms).toEqual(
      expect.arrayContaining([`user:${salesA.userId}`, `user:${salesB.userId}`]),
    );
    // No SDP, no name, no number on the socket.
    expect(JSON.stringify(ringing?.payload)).not.toContain('v=0');

    const live = await salesA.client.request('GET', '/v1/inbox/calls/live');
    expect(json<{ items: { id: string; ringingForMe: boolean }[] }>(live).items).toEqual([
      expect.objectContaining({ id: call.id, ringingForMe: true }),
    ]);

    const [first, second] = await Promise.all([
      salesA.client.request('POST', `/v1/inbox/calls/${call.id}/claim`),
      salesB.client.request('POST', `/v1/inbox/calls/${call.id}/claim`),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = first.statusCode === 200 ? salesA : salesB;
    const loser = first.statusCode === 200 ? second : first;
    expect(json<{ code: string }>(loser).code).toBe('INBOX_CALL_TAKEN');
    const claimed = json<{ offerSdp: string; mine: boolean }>(
      first.statusCode === 200 ? first : second,
    );
    expect(claimed.offerSdp).toBe(SDP_OFFER);
    expect(claimed.mine).toBe(true);

    for (const step of ['pre_accept', 'accept'] as const) {
      const answered = await winner.client.request('POST', `/v1/inbox/calls/${call.id}/answer`, {
        body: { step, sdp: SDP_ANSWER },
      });
      expect(answered.statusCode, answered.body).toBe(200);
    }
    const actions = metaCalls
      .filter((item) => item.url === `/v25.0/${PHONE_ID}/calls`)
      .slice(-2)
      .map(jsonOf);
    expect(actions).toEqual([
      {
        messaging_product: 'whatsapp',
        call_id: callId,
        action: 'pre_accept',
        session: { sdp_type: 'answer', sdp: SDP_ANSWER },
      },
      {
        messaging_product: 'whatsapp',
        call_id: callId,
        action: 'accept',
        session: { sdp_type: 'answer', sdp: SDP_ANSWER },
      },
    ]);
    const connected = await callByProvider(callId);
    expect(connected.status).toBe('connected');
    expect(connected.answered_by).toBe(winner.userId);
    expect(connected.offer_sdp).toBeNull();
    const owner = await one<{ assigned_to: string | null }>(
      sql`select assigned_to from inbox.conversations where id = ${call.conversation_id}`,
    );
    expect(owner.assigned_to).toBe(winner.userId);

    await deliver(
      whatsAppCall('terminate', callId, CALLER, {
        status: ['Completed'],
        start_time: String(Math.floor(Date.now() / 1000) - 42),
        end_time: String(Math.floor(Date.now() / 1000)),
        duration: 42,
      }),
    );
    const ended = await callByProvider(callId);
    expect(ended.status).toBe('completed');
    expect(ended.duration_seconds).toBe(42);
    const thread = await threadOf(winner, call.conversation_id);
    expect(thread.messages.at(-1)?.attachments[0]).toMatchObject({
      type: 'call',
      call: {
        status: 'completed',
        durationSeconds: 42,
        answeredBy: { userId: winner.userId },
        callbackNeeded: false,
      },
    });

    // The conversation is the winner's now: the next call rings them alone; they decline it.
    const next = `wacid.${randomUUID()}`;
    await deliver(whatsAppCall('connect', next, CALLER));
    const second2 = await callByProvider(next);
    expect(second2.rang_user_ids).toEqual([winner.userId]);
    const other = winner === salesA ? salesB : salesA;
    const notYours = await other.client.request('POST', `/v1/inbox/calls/${second2.id}/claim`);
    expect(notYours.statusCode).toBe(409);
    const declined = await winner.client.request('POST', `/v1/inbox/calls/${second2.id}/decline`);
    expect(declined.statusCode, declined.body).toBe(200);
    expect(
      jsonOf(metaCalls.filter((item) => item.url === `/v25.0/${PHONE_ID}/calls`).at(-1)),
    ).toEqual({ messaging_product: 'whatsapp', call_id: next, action: 'reject' });
    expect((await callByProvider(next)).status).toBe('declined');
    expect((await callByProvider(next)).declined_by).toBe(winner.userId);
  });

  it('leaves a missed call as an unread call-back item, dealt with once', async () => {
    const caller = '8801712000011';
    const callId = `wacid.${randomUUID()}`;
    await deliver(whatsAppCall('connect', callId, caller));
    await deliver(whatsAppCall('terminate', callId, caller, { status: 'Completed' }));
    const missed = await callByProvider(callId);
    expect(missed.status).toBe('missed');
    expect(missed.callback_needed).toBe(true);
    const thread = await threadOf(salesA, missed.conversation_id);
    expect(thread.conversation.unreadCount).toBeGreaterThanOrEqual(1);
    expect(thread.conversation.lastPreview).toBe('[missed call]');
    expect(thread.messages.at(-1)?.attachments[0]).toMatchObject({
      type: 'call',
      call: { status: 'missed', callbackNeeded: true, callbackPhone: `+${caller}` },
    });

    const done = await salesA.client.request('POST', `/v1/inbox/calls/${missed.id}/callback-done`);
    expect(done.statusCode, done.body).toBe(200);
    expect((await callByProvider(callId)).callback_needed).toBe(false);
    const audited = await one<{ n: number }>(sql`
      select count(*)::int as n from audit.audit_log
      where action = 'inbox.call_back' and entity_id = ${missed.id}
    `);
    expect(audited.n).toBe(1);
  });

  it('calls a call missed when it rings out with no word from Meta', async () => {
    const callId = `wacid.${randomUUID()}`;
    await deliver(whatsAppCall('connect', callId, '8801712000012'));
    const call = await callByProvider(callId);
    const service = harness.app.get(InboxCallsService);
    expect(await service.timeout(ORG_A, call.id, new Date())).toBe(false);
    expect(await service.timeout(ORG_A, call.id, new Date(Date.now() + 120_000))).toBe(true);
    const after = await callByProvider(callId);
    expect(after.status).toBe('missed');
    expect(after.callback_needed).toBe(true);
    // Meta's terminate, arriving after, keeps the outcome.
    await deliver(whatsAppCall('terminate', callId, '8801712000012', { status: 'Completed' }));
    expect((await callByProvider(callId)).status).toBe('missed');
  });

  it('accepts a Messenger call with the browser’s offer and hands back Meta’s answer', async () => {
    const psid = `5275811702${String(Date.now()).slice(-6)}`;
    const callId = `c_${randomUUID().replace(/-/g, '')}`;
    await deliver({
      object: 'page',
      entry: [
        {
          id: PAGE,
          time: Math.floor(Date.now() / 1000),
          calls: [
            {
              id: callId,
              to: PAGE,
              from: psid,
              event: 'connect',
              timestamp: Math.floor(Date.now() / 1000),
              call_direction: 'user_initiated',
            },
          ],
        },
      ],
    });
    const call = await callByProvider(callId);
    expect(call.offer_sdp).toBeNull();
    const claimed = await salesA.client.request('POST', `/v1/inbox/calls/${call.id}/claim`);
    expect(claimed.statusCode, claimed.body).toBe(200);
    const answered = await salesA.client.request('POST', `/v1/inbox/calls/${call.id}/answer`, {
      body: { step: 'accept', sdp: SDP_OFFER },
    });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(json<{ sdpAnswer: string }>(answered).sdpAnswer).toBe(SDP_ANSWER);
    const sent = metaCalls.filter((item) => item.url.startsWith(`/v25.0/${PAGE}/calls`)).at(-1);
    expect(jsonOf(sent)).toEqual({
      platform: 'messenger',
      call_id: callId,
      action: 'accept',
      session: { sdp_type: 'offer', sdp: SDP_OFFER },
    });
    expect(sent?.url).toContain('access_token=');

    const hungUp = await salesA.client.request('POST', `/v1/inbox/calls/${call.id}/hang-up`);
    expect(hungUp.statusCode, hungUp.body).toBe(200);
    expect((await callByProvider(callId)).status).toBe('completed');

    // Another brand: not found.
    expect((await adminB.client.request('GET', `/v1/inbox/calls/${call.id}`)).statusCode).toBe(404);
  });

  it('keeps every call and kept attachment from being deleted', async () => {
    await expect(
      withOrg({ orgId: ORG_A }, (tx) => tx.execute(sql`delete from inbox.calls`)),
    ).rejects.toThrow();
    await expect(
      withOrg({ orgId: ORG_A }, (tx) => tx.execute(sql`delete from inbox.media`)),
    ).rejects.toThrow();
  });
});
