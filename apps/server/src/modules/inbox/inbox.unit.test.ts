import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { INBOX_CHANNEL_KINDS, INBOX_CONTACT_STAGES } from '@elysium/contracts';
import {
  CONTACT_STAGES,
  INBOX_CHANNEL_KINDS as DOMAIN_KINDS,
  OUTBOUND_STATUSES,
} from '@elysium/domain/inbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inboxConfig } from './inbox.config.js';
import {
  instagramText,
  messengerDelivery,
  messengerImage,
  messengerRead,
  messengerText,
  whatsAppImage,
  whatsAppStatus,
  whatsAppText,
} from './meta-fixtures.js';
import { ownershipFor } from './ownership.js';
import { GraphMessagingGateway, MessagingError } from './providers/meta-messaging.js';
import { escapedUnicode, metaSignatureFor, metaSignatureMatches } from './signature.js';
import { parseMetaWebhook, previewOf } from './webhook-payload.js';

const SECRET = 'a3f1c0d9e8b7a6f5e4d3c2b1a0f9e8d7';
const PAGE = '104512345678901';
const PSID = '6578123456789012';
const IG = '17841400000000001';
const IGSID = '5432109876543210';
const PHONE_ID = '106540352242922';
const NOW = new Date('2026-10-11T12:00:00.000Z');

describe('the lists the contracts and the domain both keep agree', () => {
  it('channels, stages and statuses', () => {
    expect([...INBOX_CHANNEL_KINDS]).toEqual([...DOMAIN_KINDS]);
    expect([...INBOX_CONTACT_STAGES]).toEqual([...CONTACT_STAGES]);
    expect(OUTBOUND_STATUSES).toContain('failed');
  });
});

describe('the webhook signature (D-732)', () => {
  it('matches an HMAC-SHA256 of the raw body under the app secret, sha256= first', () => {
    const body = Buffer.from(
      JSON.stringify(messengerText({ pageId: PAGE, psid: PSID, mid: 'm_1', text: 'hi' })),
    );
    const header = metaSignatureFor(body, SECRET);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(metaSignatureMatches(body, header, SECRET)).toBe(true);
  });

  it('refuses a wrong secret, a changed byte, a missing or malformed header', () => {
    const body = Buffer.from('{"object":"page","entry":[]}');
    const header = metaSignatureFor(body, SECRET);
    expect(metaSignatureMatches(body, header, 'another-secret-entirely-0000000')).toBe(false);
    expect(metaSignatureMatches(Buffer.from('{"object":"page","entry":[ ]}'), header, SECRET)).toBe(
      false,
    );
    expect(metaSignatureMatches(body, undefined, SECRET)).toBe(false);
    expect(metaSignatureMatches(body, header.replace('sha256=', 'sha1='), SECRET)).toBe(false);
    expect(metaSignatureMatches(body, 'sha256=zz', SECRET)).toBe(false);
    expect(metaSignatureMatches(body, header, '')).toBe(false);
  });

  it('accepts the escaped-unicode form Meta signs for non-ASCII text (Messenger webhooks)', () => {
    expect(escapedUnicode('äöå')).toBe('\\u00e4\\u00f6\\u00e5');
    expect(escapedUnicode(`আমি ${String.fromCodePoint(0x1f600)}`)).toBe(
      '\\u0986\\u09ae\\u09bf \\ud83d\\ude00',
    );
    const raw = Buffer.from(
      JSON.stringify(messengerText({ pageId: PAGE, psid: PSID, mid: 'm_2', text: 'দাম কত?' })),
      'utf8',
    );
    // Meta's signature over the escaped form, the bytes as they arrived unescaped.
    const escapedSignature = metaSignatureFor(escapedUnicode(raw.toString('utf8')), SECRET);
    expect(metaSignatureMatches(raw, escapedSignature, SECRET)).toBe(true);
    expect(metaSignatureMatches(raw, metaSignatureFor(raw, SECRET), SECRET)).toBe(true);
  });
});

describe('reading Meta webhook bodies (fixtures from the docs)', () => {
  it('Messenger: a text message', () => {
    const parsed = parseMetaWebhook(
      messengerText({
        pageId: PAGE,
        psid: PSID,
        mid: 'mid.1457764197618:41d102a3e1ae206a38',
        text: 'hello, world!',
        timestamp: 1458692752478,
      }),
      NOW,
    );
    expect(parsed.object).toBe('page');
    expect(parsed.skipped).toBe(0);
    expect(parsed.events).toEqual([
      {
        kind: 'message',
        channel: 'messenger',
        accountId: PAGE,
        userId: PSID,
        providerMessageId: 'mid.1457764197618:41d102a3e1ae206a38',
        text: 'hello, world!',
        attachments: [],
        occurredAt: new Date(1458692752478),
        profileName: null,
        echo: false,
      },
    ]);
  });

  it('Messenger: an attachment keeps only its type and an https URL', () => {
    const parsed = parseMetaWebhook(
      messengerImage({
        pageId: PAGE,
        psid: PSID,
        mid: 'mid.$cAAJdkrCd2ORnva8ErFhjGm0X_Q_c',
        url: 'https://scontent.example/x.jpg',
      }),
      NOW,
    );
    const [event] = parsed.events;
    expect(event?.kind === 'message' ? event.attachments : null).toEqual([
      { type: 'image', url: 'https://scontent.example/x.jpg' },
    ]);
    expect(previewOf(null, event?.kind === 'message' ? event.attachments : [])).toBe('[image]');
    const insecure = parseMetaWebhook(
      messengerImage({ pageId: PAGE, psid: PSID, mid: 'm_3', url: 'http://plain.example/x.jpg' }),
      NOW,
    );
    expect(insecure.events[0]?.kind === 'message' ? insecure.events[0].attachments : null).toEqual([
      { type: 'image' },
    ]);
  });

  it('Messenger: an echo is ours, addressed to the person', () => {
    const body = messengerText({
      pageId: PAGE,
      psid: PSID,
      mid: 'm_echo',
      text: 'Sent from the Page',
    });
    const messaging = body.entry[0]?.messaging[0];
    if (messaging === undefined) throw new Error('fixture');
    const echoed = {
      ...body,
      entry: [
        {
          ...body.entry[0],
          messaging: [
            {
              sender: { id: PAGE },
              recipient: { id: PSID },
              timestamp: messaging.timestamp,
              message: { ...messaging.message, is_echo: true },
            },
          ],
        },
      ],
    };
    const [event] = parseMetaWebhook(echoed, NOW).events;
    expect(event).toMatchObject({ kind: 'message', echo: true, userId: PSID });
  });

  it('Messenger: delivery (mids and watermark) and read receipts', () => {
    const delivered = parseMetaWebhook(
      messengerDelivery({
        pageId: PAGE,
        psid: PSID,
        mids: ['mid.1458668856218:ed81099e15d3f4f233'],
        watermark: 1458668856253,
      }),
      NOW,
    );
    expect(delivered.events).toEqual([
      {
        kind: 'receipt',
        channel: 'messenger',
        accountId: PAGE,
        userId: PSID,
        status: 'delivered',
        providerMessageIds: ['mid.1458668856218:ed81099e15d3f4f233'],
        watermark: new Date(1458668856253),
        occurredAt: NOW,
        error: null,
      },
    ]);
    const read = parseMetaWebhook(
      messengerRead({ pageId: PAGE, psid: PSID, watermark: 1458668856253 }),
      NOW,
    );
    expect(read.events[0]).toMatchObject({
      kind: 'receipt',
      status: 'read',
      providerMessageIds: [],
    });
  });

  it('Instagram: a text message with the IGSID as the sender', () => {
    const [event] = parseMetaWebhook(
      instagramText({
        igAccountId: IG,
        igsid: IGSID,
        mid: 'aWdfZAG1faWQ6MTIzNDU2Nzg5',
        text: 'price?',
      }),
      NOW,
    ).events;
    expect(event).toMatchObject({
      kind: 'message',
      channel: 'instagram',
      accountId: IG,
      userId: IGSID,
      text: 'price?',
    });
  });

  it('WhatsApp: the docs’ text message, with the profile name', () => {
    const parsed = parseMetaWebhook(
      whatsAppText({
        phoneNumberId: PHONE_ID,
        waId: '16505551234',
        name: 'Sheena Nelson',
        wamid: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
        text: 'Does it come in another color?',
        timestamp: '1749416383',
      }),
      NOW,
    );
    expect(parsed.object).toBe('whatsapp_business_account');
    expect(parsed.events).toEqual([
      {
        kind: 'message',
        channel: 'whatsapp',
        accountId: PHONE_ID,
        userId: '16505551234',
        providerMessageId: 'wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=',
        text: 'Does it come in another color?',
        attachments: [],
        occurredAt: new Date(1749416383 * 1000),
        profileName: 'Sheena Nelson',
        echo: false,
      },
    ]);
  });

  it('WhatsApp: an image keeps its media id, type and caption', () => {
    const [event] = parseMetaWebhook(
      whatsAppImage({
        phoneNumberId: PHONE_ID,
        waId: '8801712345678',
        wamid: 'wamid.IMG1',
        caption: 'Taj Mahal',
      }),
      NOW,
    ).events;
    expect(event).toMatchObject({
      kind: 'message',
      text: 'Taj Mahal',
      attachments: [
        {
          type: 'image',
          mediaId: '1003383421387256',
          mimeType: 'image/jpeg',
          caption: 'Taj Mahal',
        },
      ],
    });
  });

  it('WhatsApp: statuses map through the table, failures keep their code', () => {
    const delivered = parseMetaWebhook(
      whatsAppStatus({
        phoneNumberId: PHONE_ID,
        waId: '16505551234',
        wamid: 'wamid.X',
        status: 'delivered',
        timestamp: '1750263773',
      }),
      NOW,
    );
    expect(delivered.events).toEqual([
      {
        kind: 'receipt',
        channel: 'whatsapp',
        accountId: PHONE_ID,
        userId: '16505551234',
        status: 'delivered',
        providerMessageIds: ['wamid.X'],
        watermark: null,
        occurredAt: new Date(1750263773 * 1000),
        error: null,
      },
    ]);
    const failed = parseMetaWebhook(
      whatsAppStatus({
        phoneNumberId: PHONE_ID,
        waId: '16505551234',
        wamid: 'wamid.Y',
        status: 'failed',
        errors: [
          {
            code: 131047,
            title: 'Re-engagement message',
            error_data: { details: 'More than 24 hours have passed' },
          },
        ],
      }),
      NOW,
    );
    expect(failed.events[0]).toMatchObject({
      status: 'failed',
      error: { code: 'meta:131047', detail: 'More than 24 hours have passed' },
    });
    const unknown = parseMetaWebhook(
      whatsAppStatus({ phoneNumberId: PHONE_ID, waId: '1', wamid: 'wamid.Z', status: 'deleted' }),
      NOW,
    );
    expect(unknown.events).toEqual([]);
    expect(unknown.skipped).toBe(1);
  });

  it('skips what it does not read, and never throws', () => {
    expect(parseMetaWebhook(null)).toEqual({ object: null, events: [], skipped: 1 });
    expect(parseMetaWebhook({ object: 'user', entry: [] }).object).toBeNull();
    expect(parseMetaWebhook('garbage').events).toEqual([]);
    const postback = {
      object: 'page',
      entry: [
        {
          id: PAGE,
          messaging: [
            { sender: { id: PSID }, recipient: { id: PAGE }, postback: { title: 'Get Started' } },
          ],
        },
      ],
    };
    expect(parseMetaWebhook(postback)).toEqual({ object: 'page', events: [], skipped: 1 });
    const reaction = whatsAppText({
      phoneNumberId: PHONE_ID,
      waId: '1',
      name: 'x',
      wamid: 'wamid.R',
      text: 'x',
    });
    const message = reaction.entry[0]?.changes[0]?.value.messages[0] as
      Record<string, unknown> | undefined;
    if (message === undefined) throw new Error('fixture');
    message.type = 'reaction';
    expect(parseMetaWebhook(reaction).events).toEqual([]);
  });
});

describe('ownership (D-737)', () => {
  it('owner and nobody’s pass; someone else’s needs the acknowledgement', () => {
    expect(ownershipFor('usr_a', 'usr_a', false, null)).toEqual({ kind: 'owner' });
    expect(ownershipFor(null, 'usr_a', false, null)).toEqual({ kind: 'unassigned' });
    expect(() => ownershipFor('usr_b', 'usr_a', false, 'Rahim')).toThrow(
      /Rahim has this conversation/,
    );
    expect(ownershipFor('usr_b', 'usr_a', true, 'Rahim')).toEqual({
      kind: 'acknowledged',
      ownerUserId: 'usr_b',
    });
  });
});

describe('the configuration (D-731)', () => {
  it('is the fake gateway by default, and refuses Graph without the second key', () => {
    expect(inboxConfig({}).INBOX_META_PROVIDER).toBe('fake');
    expect(() => inboxConfig({ INBOX_META_PROVIDER: 'graph' })).toThrow(/INBOX_META_ENABLED/);
    expect(
      inboxConfig({ INBOX_META_PROVIDER: 'graph', INBOX_META_ENABLED: 'true' })
        .INBOX_META_API_VERSION,
    ).toBe('v25.0');
  });
});

describe('the Graph gateway, against a stand-in HTTP server', () => {
  interface Seen {
    readonly method: string;
    readonly url: string;
    readonly authorization: string | undefined;
    readonly body: unknown;
  }
  const seen: Seen[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  let server: Server;
  let base = '';

  const read = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      request.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      request.on('end', () => resolve(text));
    });

  beforeAll(async () => {
    server = createServer((request, response) => {
      void read(request).then((text) => {
        seen.push({
          method: request.method ?? '',
          url: request.url ?? '',
          authorization: request.headers.authorization,
          body: text === '' ? null : (JSON.parse(text) as unknown),
        });
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const gateway = () =>
    new GraphMessagingGateway({ baseUrl: base, apiVersion: 'v25.0', timeoutMs: 2000 });

  it('sends Messenger as the Send API documents: the Page’s messages edge, RESPONSE, the token in the query', async () => {
    seen.length = 0;
    answer = { status: 200, body: { recipient_id: PSID, message_id: 'm_sent_1' } };
    const result = await gateway().sendText({
      channel: 'messenger',
      senderId: PAGE,
      token: 'EAAB-page-token-0000000000',
      recipientId: PSID,
      text: 'Ji, available.',
    });
    expect(result).toEqual({ providerMessageId: 'm_sent_1' });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe(`/v25.0/${PAGE}/messages?access_token=EAAB-page-token-0000000000`);
    expect(seen[0]?.body).toEqual({
      recipient: { id: PSID },
      messaging_type: 'RESPONSE',
      message: { text: 'Ji, available.' },
    });
  });

  it('sends Instagram through the Page with the IGSID', async () => {
    seen.length = 0;
    answer = { status: 200, body: { recipient_id: IGSID, message_id: 'aWdf_sent' } };
    await gateway().sendText({
      channel: 'instagram',
      senderId: PAGE,
      token: 'EAAB-page-token-0000000000',
      recipientId: IGSID,
      text: 'Yes',
    });
    expect(seen[0]?.url.startsWith(`/v25.0/${PAGE}/messages?`)).toBe(true);
    expect(seen[0]?.body).toMatchObject({ recipient: { id: IGSID } });
  });

  it('sends WhatsApp as the Cloud API documents: Bearer, messaging_product, to, text.body', async () => {
    seen.length = 0;
    answer = {
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: '8801712345678', wa_id: '8801712345678' }],
        messages: [{ id: 'wamid.SENT1' }],
      },
    };
    const result = await gateway().sendText({
      channel: 'whatsapp',
      senderId: PHONE_ID,
      token: 'EAAG-wa-token-000000000000',
      recipientId: '8801712345678',
      text: 'Hello',
    });
    expect(result).toEqual({ providerMessageId: 'wamid.SENT1' });
    expect(seen[0]?.url).toBe(`/v25.0/${PHONE_ID}/messages`);
    expect(seen[0]?.authorization).toBe('Bearer EAAG-wa-token-000000000000');
    expect(seen[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '8801712345678',
      type: 'text',
      text: { preview_url: false, body: 'Hello' },
    });
  });

  it('a 4xx is permanent, a 5xx retryable, and no error carries the token', async () => {
    answer = {
      status: 400,
      body: {
        error: {
          message: 'Message failed to send because more than 24 hours have passed',
          code: 10,
        },
      },
    };
    const refused = await gateway()
      .sendText({
        channel: 'messenger',
        senderId: PAGE,
        token: 'EAAB-secret-token-9999999',
        recipientId: PSID,
        text: 'x',
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MessagingError);
    expect((refused as MessagingError).retryable).toBe(false);
    expect((refused as MessagingError).metaCode).toBe(10);
    expect(String((refused as Error).message)).not.toContain('EAAB-secret-token');
    answer = { status: 503, body: {} };
    const later = await gateway()
      .sendText({
        channel: 'whatsapp',
        senderId: PHONE_ID,
        token: 't'.repeat(30),
        recipientId: '1',
        text: 'x',
      })
      .catch((error: unknown) => error);
    expect((later as MessagingError).retryable).toBe(true);
    answer = { status: 200, body: {} };
    const noId = await gateway()
      .sendText({
        channel: 'whatsapp',
        senderId: PHONE_ID,
        token: 't'.repeat(30),
        recipientId: '1',
        text: 'x',
      })
      .catch((error: unknown) => error);
    expect((noId as MessagingError).retryable).toBe(false);
  });
});
