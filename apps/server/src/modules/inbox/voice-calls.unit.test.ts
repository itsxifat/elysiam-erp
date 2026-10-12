import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';

import { voiceFormatFor } from '@elysium/domain/inbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCallWebhook } from './call-payload.js';
import { keptMime } from './media.service.js';
import { MessagingError } from './providers/meta-messaging.js';
import { GraphMetaMediaGateway, isMetaMediaUrl, MediaTooLarge } from './providers/meta-media.js';
import { transcodeVoice, TranscodeFailed, voiceArgs, type SpawnFn } from './transcode.js';

/**
 * M45's pure parts and its Meta adapter (D-780 to D-788): the call webhooks as Meta documents
 * them, what a downloaded attachment is kept as, ffmpeg's arguments and the transcoder's run
 * (against a stand-in), and the Graph adapter against a stand-in for Meta on this machine —
 * downloads, voice sends and call actions, with the token only where it belongs.
 */

const PAGE = '104512345678901';
const PHONE_ID = '106540352242922';
const SDP_OFFER =
  'v=0\r\no=- 7 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';

describe('Meta’s call webhooks (D-784)', () => {
  const now = new Date('2026-10-12T10:00:00.000Z');

  it('reads a WhatsApp user-initiated connect with its SDP offer and the caller’s name', () => {
    const parsed = parseCallWebhook(
      {
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
                  contacts: [{ profile: { name: 'Rahim' }, wa_id: '8801712345678' }],
                  calls: [
                    {
                      id: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
                      to: '8801700000000',
                      from: '8801712345678',
                      event: 'connect',
                      direction: 'USER_INITIATED',
                      timestamp: '1791789000',
                      session: { sdp_type: 'offer', sdp: SDP_OFFER },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      now,
    );
    expect(parsed.skipped).toBe(0);
    expect(parsed.events).toEqual([
      {
        kind: 'call_connect',
        channel: 'whatsapp',
        accountId: PHONE_ID,
        userId: '8801712345678',
        providerCallId: 'wacid.ABGGFjFVU2AfAgo6V-Hc5eCgK5Gh',
        offerSdp: SDP_OFFER,
        occurredAt: new Date(1791789000 * 1000),
        profileName: 'Rahim',
      },
    ]);
  });

  it('reads a WhatsApp terminate, its status given as an array, with Meta’s duration', () => {
    const parsed = parseCallWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'calls',
              value: {
                metadata: { phone_number_id: PHONE_ID },
                calls: [
                  {
                    id: 'wacid.X1',
                    from: '8801712345678',
                    event: 'terminate',
                    direction: 'USER_INITIATED',
                    timestamp: '1791789120',
                    status: ['Failed'],
                    start_time: '1791789000',
                    end_time: '1791789120',
                    duration: 95,
                    errors: [{ code: 138021, title: 'Media receive timeout' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.events[0]).toMatchObject({
      kind: 'call_terminate',
      providerCallId: 'wacid.X1',
      status: 'failed',
      durationSeconds: 95,
      endedAt: new Date(1791789120 * 1000),
      errorCode: 'meta:138021',
    });
  });

  it('reads Messenger’s connect (no SDP: the business offers) and terminate', () => {
    const parsed = parseCallWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE,
          time: 1671644824,
          calls: [
            {
              id: 'c_M5YPhGE5jm0L_PMQdScLlYJlR7tU_f0rgXiTQ',
              to: PAGE,
              from: '5275811702471834',
              event: 'connect',
              timestamp: 1671644824,
              call_direction: 'user_initiated',
            },
            {
              id: 'c_M5YPhGE5jm0L_PMQdScLlYJlR7tU_f0rgXiTQ',
              event: 'terminate',
              timestamp: 1671644944,
              status: 'Completed',
              start_time: 1671644824,
              end_time: 1671644944,
              duration: 120,
            },
          ],
        },
      ],
    });
    expect(parsed.events.map((event) => event.kind)).toEqual(['call_connect', 'call_terminate']);
    expect(parsed.events[0]).toMatchObject({
      channel: 'messenger',
      accountId: PAGE,
      userId: '5275811702471834',
      offerSdp: null,
    });
    expect(parsed.events[1]).toMatchObject({
      userId: null,
      status: 'completed',
      durationSeconds: 120,
    });
  });

  it('skips calls the business placed, the business-call events and anything it does not know', () => {
    const parsed = parseCallWebhook({
      object: 'page',
      entry: [
        {
          id: PAGE,
          calls: [
            { id: 'c_1', from: PAGE, event: 'connect', call_direction: 'business_initiated' },
            { id: 'c_2', event: 'call_status', call_status: 'ringing' },
            { id: 'c_3', event: 'media_update' },
            { event: 'connect' },
          ],
        },
      ],
    });
    expect(parsed.events).toEqual([]);
    expect(parsed.skipped).toBe(4);
    expect(parseCallWebhook({ object: 'instagram', entry: [{ calls: [{ id: 'x' }] }] })).toEqual({
      events: [],
      skipped: 0,
    });
    expect(parseCallWebhook('nonsense')).toEqual({ events: [], skipped: 0 });
    // A message body is not a call.
    expect(
      parseCallWebhook({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { messages: [] } }] }],
      }).events,
    ).toEqual([]);
  });

  it('keeps no SDP that is not an offer', () => {
    const parsed = parseCallWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'calls',
              value: {
                metadata: { phone_number_id: PHONE_ID },
                calls: [
                  {
                    id: 'wacid.Y',
                    from: '8801712345678',
                    event: 'connect',
                    direction: 'USER_INITIATED',
                    session: { sdp_type: 'answer', sdp: '<script>' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(parsed.events[0]).toMatchObject({ offerSdp: null });
  });
});

describe('what a downloaded attachment is kept as (D-780)', () => {
  it('names an audio container as audio, and refuses what is neither', () => {
    expect(keptMime('audio', 'audio/ogg')).toBe('audio/ogg');
    expect(keptMime('audio', 'video/mp4')).toBe('audio/mp4');
    expect(keptMime('audio', 'video/webm')).toBe('audio/webm');
    expect(keptMime('audio', 'application/pdf')).toBeNull();
    expect(keptMime('audio', null)).toBeNull();
    expect(keptMime('image', 'image/png')).toBe('image/png');
    expect(keptMime('image', 'image/avif')).toBeNull();
  });

  it('fetches only from Meta’s own hosts, over https', () => {
    expect(isMetaMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1')).toBe(
      true,
    );
    expect(isMetaMediaUrl('https://scontent.xx.fbcdn.net/v/t1/a.mp4')).toBe(true);
    expect(isMetaMediaUrl('https://cdn.fbsbx.com/v/t59/audioclip.mp4')).toBe(true);
    expect(isMetaMediaUrl('http://cdn.fbsbx.com/a')).toBe(false);
    expect(isMetaMediaUrl('https://fbsbx.com.attacker.example/a')).toBe(false);
    expect(isMetaMediaUrl('https://user:pass@cdn.fbsbx.com/a')).toBe(false);
    expect(isMetaMediaUrl('https://169.254.169.254/latest')).toBe(false);
    expect(isMetaMediaUrl('not a url')).toBe(false);
  });
});

describe('the transcoder (D-781)', () => {
  it('asks ffmpeg for mono Ogg/Opus for WhatsApp and M4A for Messenger, local files only', () => {
    const ogg = voiceArgs('/tmp/in', '/tmp/out.ogg', voiceFormatFor('whatsapp'));
    expect(ogg).toEqual(expect.arrayContaining(['libopus', 'ogg', '-ac', '1']));
    expect(
      ogg.slice(ogg.indexOf('-protocol_whitelist'), ogg.indexOf('-protocol_whitelist') + 2),
    ).toEqual(['-protocol_whitelist', 'file']);
    const m4a = voiceArgs('/tmp/in', '/tmp/out.m4a', voiceFormatFor('messenger'));
    expect(m4a).toEqual(expect.arrayContaining(['aac', 'ipod', '+faststart']));
    expect(m4a.at(-1)).toBe('/tmp/out.m4a');
  });

  /** A stand-in ffmpeg: writes `bytes` to the output path it was given, then exits `code`. */
  function standIn(
    bytes: Uint8Array,
    code: number,
  ): { spawn: SpawnFn; env: () => NodeJS.ProcessEnv } {
    let seen: NodeJS.ProcessEnv = {};
    const spawn: SpawnFn = (_command, args, options) => {
      seen = options.env;
      const child = new EventEmitter() as unknown as ChildProcess;
      setImmediate(() => {
        if (code === 0) writeFileSync(args[args.length - 1] ?? '', bytes);
        child.emit('exit', code, null);
      });
      return child;
    };
    return { spawn, env: () => seen };
  }

  it('returns what ffmpeg wrote, with none of the server’s secrets in its environment', async () => {
    process.env.INBOX_TEST_SECRET = 'do-not-leak';
    const fake = standIn(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1]), 0);
    const out = await transcodeVoice(new Uint8Array([1, 2, 3]), voiceFormatFor('whatsapp'), {
      ffmpegPath: 'ffmpeg',
      spawn: fake.spawn,
    });
    expect([...out]).toEqual([0x4f, 0x67, 0x67, 0x53, 1]);
    expect(Object.keys(fake.env())).not.toContain('INBOX_TEST_SECRET');
    delete process.env.INBOX_TEST_SECRET;
  });

  it('fails cleanly when ffmpeg does', async () => {
    const fake = standIn(new Uint8Array(), 1);
    await expect(
      transcodeVoice(new Uint8Array([1]), voiceFormatFor('messenger'), {
        ffmpegPath: 'ffmpeg',
        spawn: fake.spawn,
      }),
    ).rejects.toBeInstanceOf(TranscodeFailed);
  });
});

// --- the Graph adapter against a stand-in -------------------------------------------------------

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

const seen: Seen[] = [];
let server: Server;
let base = '';
let answer: (request: Seen) => {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
} = () => ({ status: 404, body: {} });

function collect(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function formOf(request: Seen): Promise<FormData> {
  return new Response(request.body, {
    headers: { 'content-type': request.contentType ?? '' },
  }).formData();
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void collect(request).then((body) => {
      const call: Seen = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      };
      seen.push(call);
      const reply = answer(call);
      if (reply.body instanceof Uint8Array) {
        response.writeHead(reply.status, reply.headers ?? {});
        response.end(Buffer.from(reply.body));
        return;
      }
      response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function gateway(options: { allowAll?: boolean } = {}): GraphMetaMediaGateway {
  return new GraphMetaMediaGateway({
    baseUrl: base,
    apiVersion: 'v25.0',
    timeoutMs: 5_000,
    ...(options.allowAll === true ? { mediaUrlAllowed: () => true } : {}),
  });
}

describe('the Graph media and calls adapter (UNVERIFIED, against a stand-in)', () => {
  const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 9, 9]);

  it('downloads a WhatsApp voice note by its media id, with the token to Graph alone', async () => {
    seen.length = 0;
    answer = (request) =>
      request.url === '/v25.0/1003383421387256'
        ? {
            status: 200,
            body: { url: `${base}/media/voice`, mime_type: 'audio/ogg; codecs=opus', file_size: 8 },
          }
        : request.url === '/media/voice'
          ? { status: 200, body: OGG, headers: { 'content-type': 'audio/ogg' } }
          : { status: 404, body: {} };
    const got = await gateway().download({
      channel: 'whatsapp',
      mediaId: '1003383421387256',
      token: 'EAAG-secret',
      maxBytes: 1_000,
    });
    expect([...got.bytes]).toEqual([...OGG]);
    expect(got.declaredMime).toBe('audio/ogg');
    expect(seen[0]?.authorization).toBe('Bearer EAAG-secret');
    expect(seen[1]?.authorization).toBe('Bearer EAAG-secret');
  });

  it('refuses an attachment larger than the inbox keeps, by Meta’s size or by its bytes', async () => {
    answer = (request) =>
      request.url.startsWith('/v25.0/')
        ? { status: 200, body: { url: `${base}/media/big`, file_size: 50_000 } }
        : { status: 200, body: new Uint8Array(5_000) };
    await expect(
      gateway().download({ channel: 'whatsapp', mediaId: '1', token: 't', maxBytes: 1_000 }),
    ).rejects.toBeInstanceOf(MediaTooLarge);
    answer = () => ({ status: 200, body: new Uint8Array(5_000) });
    await expect(
      gateway({ allowAll: true }).download({
        channel: 'messenger',
        url: `${base}/cdn/clip.mp4`,
        token: null,
        maxBytes: 1_000,
      }),
    ).rejects.toBeInstanceOf(MediaTooLarge);
  });

  it('never fetches a Messenger link that is not on Meta’s hosts, nor follows a redirect off them', async () => {
    seen.length = 0;
    await expect(
      gateway().download({
        channel: 'messenger',
        url: 'https://attacker.example/x.mp4',
        token: null,
        maxBytes: 1_000,
      }),
    ).rejects.toBeInstanceOf(MessagingError);
    expect(seen).toHaveLength(0);
    // Graph's own origin redirecting to another host: the next hop is refused unfetched.
    answer = () => ({ status: 302, body: {}, headers: { location: 'http://10.0.0.1/secret' } });
    await expect(
      gateway().download({ channel: 'whatsapp', mediaId: '9', token: 't', maxBytes: 1_000 }),
    ).rejects.toThrow();
    expect(seen.every((request) => request.url.startsWith('/v25.0/'))).toBe(true);
  });

  it('sends a WhatsApp voice note: the upload as multipart, then the message by id with voice', async () => {
    seen.length = 0;
    answer = (request) =>
      request.url === `/v25.0/${PHONE_ID}/media`
        ? { status: 200, body: { id: '1013859600285441' } }
        : { status: 200, body: { messages: [{ id: 'wamid.HBgLMTY1MDM4' }] } };
    const sent = await gateway().sendVoice({
      channel: 'whatsapp',
      senderId: PHONE_ID,
      token: 'EAAG-secret',
      recipientId: '8801712345678',
      bytes: OGG,
      mime: 'audio/ogg',
      filename: 'voice.ogg',
      voiceNote: true,
    });
    expect(sent.providerMessageId).toBe('wamid.HBgLMTY1MDM4');
    const upload = await formOf(seen[0]!);
    expect(upload.get('messaging_product')).toBe('whatsapp');
    expect(upload.get('type')).toBe('audio/ogg');
    const file = upload.get('file') as File;
    expect(file.type).toBe('audio/ogg');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(OGG);
    expect(JSON.parse(seen[1]!.body.toString('utf8'))).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '8801712345678',
      type: 'audio',
      audio: { id: '1013859600285441', voice: true },
    });
    expect(seen.every((request) => request.authorization === 'Bearer EAAG-secret')).toBe(true);
  });

  it('sends a Messenger or Instagram voice message as one upload-and-send, M4A as audio', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { recipient_id: 'psid', message_id: 'm_AG5Hz2U' } });
    const sent = await gateway().sendVoice({
      channel: 'instagram',
      senderId: PAGE,
      token: 'EAAB-page',
      recipientId: '17841400000000999',
      bytes: new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]),
      mime: 'audio/mp4',
      filename: 'voice.m4a',
      voiceNote: false,
    });
    expect(sent.providerMessageId).toBe('m_AG5Hz2U');
    const request = seen[0]!;
    expect(request.url.startsWith(`/v25.0/${PAGE}/messages?access_token=`)).toBe(true);
    const form = await formOf(request);
    expect(JSON.parse(form.get('recipient') as string)).toEqual({ id: '17841400000000999' });
    expect(JSON.parse(form.get('message') as string)).toEqual({
      attachment: { type: 'audio', payload: {} },
    });
    expect((form.get('filedata') as File).type).toBe('audio/mp4');
  });

  it('turns Meta’s refusal into an error that names no token', async () => {
    answer = () => ({ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } });
    const failure = await gateway()
      .sendVoice({
        channel: 'messenger',
        senderId: PAGE,
        token: 'EAAB-very-secret',
        recipientId: 'psid',
        bytes: new Uint8Array([1]),
        mime: 'audio/mp4',
        filename: 'voice.m4a',
        voiceNote: false,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MessagingError);
    expect((failure as MessagingError).metaCode).toBe(100);
    expect((failure as MessagingError).retryable).toBe(false);
    expect(String((failure as Error).message)).not.toContain('EAAB-very-secret');
  });

  it('pre-accepts and accepts a WhatsApp call with the browser’s SDP answer', async () => {
    seen.length = 0;
    answer = () => ({ status: 200, body: { messaging_product: 'whatsapp', success: true } });
    for (const action of ['pre_accept', 'accept', 'reject', 'terminate'] as const) {
      await gateway().callAction({
        channel: 'whatsapp',
        senderId: PHONE_ID,
        token: 'EAAG-secret',
        providerCallId: 'wacid.ABC',
        action,
        ...(action === 'pre_accept' || action === 'accept' ? { sdp: SDP_OFFER } : {}),
      });
    }
    const bodies = seen.map((request) => JSON.parse(request.body.toString('utf8')) as unknown);
    expect(seen.every((request) => request.url === `/v25.0/${PHONE_ID}/calls`)).toBe(true);
    expect(bodies[0]).toEqual({
      messaging_product: 'whatsapp',
      call_id: 'wacid.ABC',
      action: 'pre_accept',
      session: { sdp_type: 'answer', sdp: SDP_OFFER },
    });
    expect(bodies[3]).toEqual({
      messaging_product: 'whatsapp',
      call_id: 'wacid.ABC',
      action: 'terminate',
    });
  });

  it('accepts a Messenger call with the browser’s offer and hands back Meta’s answer', async () => {
    seen.length = 0;
    answer = () => ({
      status: 200,
      body: { success: true, session: { sdp_response: 'v=0\r\nanswer', sdp_renegotiation: '' } },
    });
    const result = await gateway().callAction({
      channel: 'messenger',
      senderId: PAGE,
      token: 'EAAB-page',
      providerCallId: 'c_M5Y',
      action: 'accept',
      sdp: SDP_OFFER,
    });
    expect(result).toEqual({ sdpAnswer: 'v=0\r\nanswer', sdpRenegotiation: null });
    expect(JSON.parse(seen[0]!.body.toString('utf8'))).toEqual({
      platform: 'messenger',
      call_id: 'c_M5Y',
      action: 'accept',
      session: { sdp_type: 'offer', sdp: SDP_OFFER },
    });
    // Messenger has no pre-accept: nothing is sent for one.
    seen.length = 0;
    await gateway().callAction({
      channel: 'messenger',
      senderId: PAGE,
      token: 'EAAB-page',
      providerCallId: 'c_M5Y',
      action: 'pre_accept',
      sdp: SDP_OFFER,
    });
    expect(seen).toHaveLength(0);
  });
});
