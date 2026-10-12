import { randomUUID } from 'node:crypto';

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
import { applyOrderMigrations } from '../orders/orders.testing.js';
import { ConversationOffersService } from './conversation-offers.service.js';
import { registerInboxJobs } from './inbox.worker.js';
import { messengerText } from './meta-fixtures.js';
import { InboxOrderListener } from './order-listener.service.js';
import { InboxProfileService } from './profile.service.js';
import { FakeMessagingGateway, MESSAGING_GATEWAY } from './providers/meta-messaging.js';
import { InboxSendService } from './send.service.js';
import { metaSignatureFor } from './signature.js';
import { InboxWebhookService } from './webhook.service.js';

/**
 * M44a on real Postgres, through the real routes and jobs (D-761, D-763, D-764):
 *
 * - a Messenger sender's name and photo are fetched by a job after their first message and kept
 *   on the contact (the fake gateway stands in for Meta's User Profile API);
 * - the brand's saved replies: org_admin writes them (Bangla included), a shortcut is the
 *   brand's once, sales reads and uses them (counted) but cannot write them, and another brand
 *   sees none;
 * - the unread counts for the tab's title.
 */

const APP_SECRET = 'm44a-test-app-secret-0123456789abcdef';
const PAGE = '104512345678777';
const PSID = '7712345678900001';

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let sales: RoleClient;
let adminB: RoleClient;
let gateway: FakeMessagingGateway;

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

async function deliver(body: unknown): Promise<InjectedResponse> {
  const raw = JSON.stringify(body);
  return harness.server.inject({
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
}

beforeAll(async () => {
  harness = await startHttpHarness('m44a-alive');
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
    offers: harness.app.get(ConversationOffersService),
    profiles: harness.app.get(InboxProfileService),
    report: () => Promise.resolve(),
  });
  gateway = harness.app.get<FakeMessagingGateway>(MESSAGING_GATEWAY);
  expect(gateway).toBeInstanceOf(FakeMessagingGateway);

  admin = await harness.asRole('org_admin', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);

  const app = await admin.client.request('PUT', '/v1/inbox/meta-app', {
    body: { appSecret: APP_SECRET, verifyToken: 'm44a-verify-token-for-the-suite' },
  });
  expect(app.statusCode, app.body).toBe(200);
  const channel = await admin.client.request('PUT', '/v1/inbox/channels/messenger', {
    body: { externalId: PAGE, enabled: true, accessToken: 'EAAB-m44a-page-token-0000000000' },
  });
  expect(channel.statusCode, channel.body).toBe(200);
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

describe('senders’ names and photos (D-761)', () => {
  it('fetches a Messenger sender’s profile after their first message, by a job', async () => {
    gateway.profiles.set(PSID, {
      name: null,
      firstName: 'রহিম',
      lastName: 'Uddin',
      username: null,
      pictureUrl: 'https://scontent.example/rahim.jpg',
    });
    const response = await deliver(
      messengerText({ pageId: PAGE, psid: PSID, mid: `m_${randomUUID()}`, text: 'দাম কত?' }),
    );
    expect(response.statusCode, response.body).toBe(200);

    const contact = await until(
      () =>
        withOrg({ orgId: ORG_A }, async (tx) => {
          const rows = await tx.execute<{
            display_name: string | null;
            avatar_url: string | null;
            profile_fetched_at: Date | null;
          }>(sql`
            select c.display_name, c.avatar_url, c.profile_fetched_at
            from inbox.contacts c
            join inbox.identities i on i.org_id = c.org_id and i.contact_id = c.id
            where i.external_user_id = ${PSID}
          `);
          const row = rows[0];
          return row?.profile_fetched_at == null ? undefined : row;
        }),
      'the profile job',
    );
    expect(contact.display_name).toBe('রহিম Uddin');
    expect(contact.avatar_url).toBe('https://scontent.example/rahim.jpg');
    expect(gateway.profileRequests.at(-1)).toMatchObject({
      channel: 'messenger',
      userId: PSID,
      token: 'EAAB-m44a-page-token-0000000000',
    });

    // The list shows the name and the photo.
    const list = await sales.client.request('GET', '/v1/inbox/conversations?view=all');
    expect(list.statusCode).toBe(200);
    const item = json<{
      items: { contact: { name: string | null; avatarUrl: string | null } }[];
    }>(list).items.find((one) => one.contact.name === 'রহিম Uddin');
    expect(item?.contact.avatarUrl).toBe('https://scontent.example/rahim.jpg');

    // A second message soon after asks Meta nothing more.
    const asked = gateway.profileRequests.length;
    await deliver(messengerText({ pageId: PAGE, psid: PSID, mid: `m_${randomUUID()}`, text: 'L' }));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(gateway.profileRequests.length).toBe(asked);

    // The screens were told, and the message event says it came from the customer.
    const events = await withSystem(
      async (tx) =>
        tx.execute<{ name: string; payload: Record<string, unknown> }>(sql`
          select name, payload from events.outbox
          where name in ('inbox.contact_updated', 'inbox.message_received')
          order by created_at
        `),
      { orgId: ORG_A },
    );
    expect(events.some((event) => event.name === 'inbox.contact_updated')).toBe(true);
    expect(
      events.find((event) => event.name === 'inbox.message_received')?.payload.direction,
    ).toBe('inbound');
  });

  it('counts unread messages for the title: the caller’s and nobody’s', async () => {
    const response = await sales.client.request('GET', '/v1/inbox/unread');
    expect(response.statusCode).toBe(200);
    const counts = json<{ mine: number; unassigned: number }>(response);
    expect(counts.mine).toBe(0);
    expect(counts.unassigned).toBeGreaterThanOrEqual(2);
  });
});

describe('saved replies (D-763)', () => {
  interface Reply {
    id: string;
    shortcut: string;
    body: string;
    category: string | null;
    usageCount: number;
  }

  it('org_admin writes them, sales reads and uses them, and nobody else sees them', async () => {
    const created = await admin.client.request('POST', '/v1/inbox/saved-replies', {
      body: {
        title: 'Price',
        shortcut: ' Price ',
        body: 'আসসালামু আলাইকুম {name}, দাম {total}।',
        category: 'Sales',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const reply = json<Reply>(created);
    expect(reply.shortcut).toBe('price');
    expect(reply.body).toBe('আসসালামু আলাইকুম {name}, দাম {total}।');

    const twice = await admin.client.request('POST', '/v1/inbox/saved-replies', {
      body: { title: 'Again', shortcut: 'price', body: 'x' },
    });
    expect(twice.statusCode).toBe(409);
    expect(json<{ code: string }>(twice).code).toBe('INBOX_SHORTCUT_TAKEN');

    const refused = await sales.client.request('POST', '/v1/inbox/saved-replies', {
      body: { title: 'Mine', shortcut: 'mine', body: 'x' },
    });
    expect(refused.statusCode).toBe(403);

    const used = await sales.client.request('POST', `/v1/inbox/saved-replies/${reply.id}/use`);
    expect(used.statusCode, used.body).toBe(200);
    expect(json<{ usageCount: number }>(used).usageCount).toBe(1);

    const listed = await sales.client.request('GET', '/v1/inbox/saved-replies');
    expect(listed.statusCode).toBe(200);
    expect(json<{ items: Reply[] }>(listed).items.find((one) => one.id === reply.id)).toMatchObject(
      { usageCount: 1, category: 'Sales' },
    );

    const other = await adminB.client.request('GET', '/v1/inbox/saved-replies');
    expect(json<{ items: Reply[] }>(other).items.some((one) => one.id === reply.id)).toBe(false);
    const otherUse = await adminB.client.request('POST', `/v1/inbox/saved-replies/${reply.id}/use`);
    expect(otherUse.statusCode).toBe(404);

    const changed = await admin.client.request('PUT', `/v1/inbox/saved-replies/${reply.id}`, {
      body: { title: 'Price list', shortcut: 'dam', body: 'দাম {total}' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json<Reply>(changed)).toMatchObject({ shortcut: 'dam', category: null, usageCount: 1 });

    const removed = await admin.client.request('DELETE', `/v1/inbox/saved-replies/${reply.id}`);
    expect(removed.statusCode).toBe(200);
    const audit = await withSystem(
      async (tx) =>
        tx.execute<{ action: string }>(sql`
          select action from audit.audit_log
          where entity_type = 'inbox_saved_reply' and entity_id = ${reply.id}
          order by created_at, id
        `),
      { orgId: ORG_A },
    );
    expect(audit.map((row) => row.action)).toEqual([
      'inbox.saved_reply.create',
      'inbox.saved_reply.update',
      'inbox.saved_reply.delete',
    ]);
  });
});
