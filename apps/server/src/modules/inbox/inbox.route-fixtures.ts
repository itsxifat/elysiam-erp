import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withGlobal, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite and the cost sweep call M42's inbox routes (D-070).
 *
 * Every conversation route is asked about a conversation of its own, made fresh for the call
 * (nobody's yet, its customer wrote an hour ago), so each admitted role's write succeeds and is
 * audited rather than meeting the previous role's ownership. The reply is asked of a
 * conversation whose customer last wrote two days ago: the window refusal (409) needs no job
 * runtime, which this suite does not start. The channels are saved for real, with no token
 * (so no key is needed).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const TEAMMATE = 'usr_inbox_fixture_teammate';
const PAGE_ID = '900000000000001';

/** A Page channel, and a sales teammate to hand conversations to; idempotent. */
export async function prepareInboxFixtures(): Promise<void> {
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${TEAMMATE}, 'inbox-fixture@example.invalid', 'Inbox teammate', true)
      on conflict (id) do nothing
    `);
  });
  const member = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          select id from iam.memberships
          where org_id = ${ORG_A} and user_id = ${TEAMMATE} and role = 'sales'
        `)
      )[0]?.id,
    { orgId: ORG_A },
  );
  if (member === undefined)
    await grantMembership({ userId: TEAMMATE, orgId: ORG_A, role: 'sales' });
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into inbox.channels (org_id, kind, external_id, enabled, updated_by)
        values (${ORG_A}, 'messenger', ${PAGE_ID}, true, 'usr_inbox_fixture')
        on conflict (org_id, kind) do nothing
      `);
    },
    { orgId: ORG_A },
  );
}

/** A conversation nobody has, whose customer wrote `hoursAgo` hours ago. */
async function freshConversation(hoursAgo = 1): Promise<{ id: string; contactId: string }> {
  return withSystem(
    async (tx) => {
      const channel = (
        await tx.execute<{ id: string }>(sql`
          select id from inbox.channels where org_id = ${ORG_A} and kind = 'messenger'
        `)
      )[0]?.id;
      const contact = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.contacts (org_id, display_name) values (${ORG_A}, 'Matrix contact')
          returning id
        `)
      )[0]?.id;
      const identity = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.identities (org_id, contact_id, channel_id, external_user_id)
          values (${ORG_A}, ${contact}, ${channel}, ${`psid-${randomUUID()}`})
          returning id
        `)
      )[0]?.id;
      const conversation = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.conversations
            (org_id, channel_id, contact_id, identity_id, last_inbound_at, last_message_at,
             last_preview, last_direction, unread_count)
          values (${ORG_A}, ${channel}, ${contact}, ${identity},
                  now() - make_interval(hours => ${hoursAgo}),
                  now() - make_interval(hours => ${hoursAgo}), 'hello', 'inbound', 1)
          returning id
        `)
      )[0]?.id;
      await tx.execute(sql`
        insert into inbox.messages
          (org_id, conversation_id, direction, body, provider_message_id, status, occurred_at)
        values (${ORG_A}, ${conversation}, 'inbound', 'call me on 01712345678',
                ${`m_${randomUUID()}`}, 'received', now() - make_interval(hours => ${hoursAgo}))
      `);
      return { id: conversation ?? '', contactId: contact ?? '' };
    },
    { orgId: ORG_A },
  );
}

async function anyProductId(): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          select id from catalog.products where org_id = ${ORG_A} order by created_at limit 1
        `)
      )[0]?.id ?? randomUUID(),
    { orgId: ORG_A },
  );
}

async function interestOn(conversation: { id: string; contactId: string }): Promise<string> {
  const productId = await anyProductId();
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.interests (org_id, contact_id, product_id, added_by)
          values (${ORG_A}, ${conversation.contactId}, ${productId}, ${TEAMMATE})
          returning id
        `)
      )[0]?.id ?? randomUUID(),
    { orgId: ORG_A },
  );
}

/**
 * D-748: a live offer of a fresh conversation to a fresh agent, so every caller is someone else.
 * Its own agent each time: a person holds one live conversation offer at a time.
 */
async function freshOffer(): Promise<string> {
  const conversation = await freshConversation();
  const agent = await createTestUser({ name: 'Route matrix conversation offeree' });
  await grantMembership({ userId: agent.id, orgId: ORG_A, role: 'sales' });
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.conversation_offers (org_id, conversation_id, user_id, expires_at)
          values (${ORG_A}, ${conversation.id}, ${agent.id}, now() + interval '10 minutes')
          returning id
        `)
      )[0]?.id ?? randomUUID(),
    { orgId: ORG_A },
  );
}

const at = async (suffix: string, body?: unknown): Promise<Call> => {
  const conversation = await freshConversation();
  return {
    url: `/v1/inbox/conversations/${conversation.id}${suffix}`,
    ...(body === undefined ? {} : { body }),
  };
};

export const INBOX_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/inbox/conversations': () => ({ url: '/v1/inbox/conversations?view=all&status=any' }),
  'GET /v1/inbox/conversations/:id': () => at(''),
  'GET /v1/inbox/conversations/:id/panel': () => at('/panel'),
  'GET /v1/inbox/conversations/:id/order-draft': () => at('/order-draft'),
  'GET /v1/inbox/team': () => ({ url: '/v1/inbox/team' }),
  'GET /v1/inbox/phone-flags': () => ({ url: '/v1/inbox/phone-flags?phone=01712345678' }),
  // D-748: the auto-offer's card. Offered to the teammate, so an accept or a decline by anyone
  // the matrix signs in is a refusal (409), never a 5xx.
  'GET /v1/inbox/offers/mine': () => ({ url: '/v1/inbox/offers/mine' }),
  'POST /v1/inbox/offers/:id/accept': async () => ({
    url: `/v1/inbox/offers/${await freshOffer()}/accept`,
  }),
  'POST /v1/inbox/offers/:id/decline': async () => ({
    url: `/v1/inbox/offers/${await freshOffer()}/decline`,
  }),
  'POST /v1/inbox/conversations/:id/take': () => at('/take'),
  'POST /v1/inbox/conversations/:id/release': () => at('/release'),
  'POST /v1/inbox/conversations/:id/hand-over': () => at('/hand-over', { userId: TEAMMATE }),
  'POST /v1/inbox/conversations/:id/close': () => at('/close'),
  'POST /v1/inbox/conversations/:id/reopen': () => at('/reopen'),
  'POST /v1/inbox/conversations/:id/read': () => at('/read'),
  'POST /v1/inbox/conversations/:id/messages': async () => {
    const conversation = await freshConversation(48);
    return {
      url: `/v1/inbox/conversations/${conversation.id}/messages`,
      body: { id: randomUUID(), text: 'Outside the window' },
    };
  },
  'PUT /v1/inbox/conversations/:id/contact/phone': () =>
    at('/contact/phone', { phone: '01712345678' }),
  'PUT /v1/inbox/conversations/:id/contact/address': async () => {
    const area = await withSystem(async (tx) => {
      const rows = await tx.execute<{ district_id: number; thana_id: number }>(sql`
        select district_id, id as thana_id from ref.thanas order by id limit 1
      `);
      return rows[0];
    });
    return at('/contact/address', {
      districtId: area?.district_id ?? 1,
      thanaId: area?.thana_id ?? 1,
      addressLine: 'House 1, Road 1',
    });
  },
  'PUT /v1/inbox/conversations/:id/contact/stage': () => at('/contact/stage', { stage: 'lead' }),
  'PUT /v1/inbox/conversations/:id/contact/tags': () => at('/contact/tags', { tags: ['matrix'] }),
  'POST /v1/inbox/conversations/:id/notes': () => at('/notes', { body: 'A matrix note' }),
  'POST /v1/inbox/conversations/:id/interests': async () =>
    at('/interests', { productId: await anyProductId() }),
  'DELETE /v1/inbox/conversations/:id/interests/:interestId': async () => {
    const conversation = await freshConversation();
    const interest = await interestOn(conversation);
    return { url: `/v1/inbox/conversations/${conversation.id}/interests/${interest}` };
  },
  'GET /v1/inbox/channels': () => ({ url: '/v1/inbox/channels' }),
  'PUT /v1/inbox/channels/:kind': () => ({
    url: '/v1/inbox/channels/whatsapp',
    body: { externalId: '900000000000002', enabled: false },
  }),
  'PUT /v1/inbox/meta-app': () => ({
    url: '/v1/inbox/meta-app',
    body: { verifyToken: `matrix-verify-${randomUUID()}` },
  }),
};
