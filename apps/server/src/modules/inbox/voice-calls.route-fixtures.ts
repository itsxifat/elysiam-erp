import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite and the cost sweep call M45's routes (D-070). They run after M42's
 * `prepareInboxFixtures`, which saves the brand's Messenger channel (with no token, so nothing is
 * ever sent to Meta). Each call is about a call of its own, made fresh: ringing for nobody (an
 * org admin may still pick it up or decline it as a supervisor; anyone else is told it is not
 * ringing for them), or missed with its call-back open. The voice message is asked of a
 * conversation whose customer wrote two days ago, so the window refuses it before any file is
 * looked at; the media route is asked for a file that is not there.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const SDP = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';

/** A conversation on the Messenger channel whose customer wrote `hoursAgo` hours ago. */
async function freshConversation(hoursAgo = 1): Promise<{ id: string; channelId: string }> {
  return withSystem(
    async (tx) => {
      const channelId =
        (
          await tx.execute<{ id: string }>(sql`
            select id from inbox.channels where org_id = ${ORG_A} and kind = 'messenger'
          `)
        )[0]?.id ?? '';
      const contact = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.contacts (org_id, display_name) values (${ORG_A}, 'Matrix caller')
          returning id
        `)
      )[0]?.id;
      const identity = (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.identities (org_id, contact_id, channel_id, external_user_id)
          values (${ORG_A}, ${contact}, ${channelId}, ${`psid-${randomUUID()}`})
          returning id
        `)
      )[0]?.id;
      const id =
        (
          await tx.execute<{ id: string }>(sql`
            insert into inbox.conversations
              (org_id, channel_id, contact_id, identity_id, last_inbound_at, last_message_at)
            values (${ORG_A}, ${channelId}, ${contact}, ${identity},
                    now() - make_interval(hours => ${hoursAgo}),
                    now() - make_interval(hours => ${hoursAgo}))
            returning id
          `)
        )[0]?.id ?? '';
      return { id, channelId };
    },
    { orgId: ORG_A },
  );
}

/** A call on a fresh conversation: ringing for nobody, or missed with its call-back open. */
async function freshCall(state: 'ringing' | 'missed' = 'ringing'): Promise<string> {
  const conversation = await freshConversation();
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into inbox.calls
            (org_id, conversation_id, channel_id, provider_call_id, status, started_at, ended_at,
             callback_needed)
          values (${ORG_A}, ${conversation.id}, ${conversation.channelId},
                  ${`c_matrix_${randomUUID()}`}, ${state}, now(),
                  ${state === 'missed' ? sql`now()` : sql`null`}, ${state === 'missed'})
          returning id
        `)
      )[0]?.id ?? randomUUID(),
    { orgId: ORG_A },
  );
}

const onCall = async (suffix: string, body?: unknown, state?: 'ringing' | 'missed') => ({
  url: `/v1/inbox/calls/${await freshCall(state)}${suffix}`,
  ...(body === undefined ? {} : { body }),
});

export const VOICE_CALLS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/inbox/media/:fileId': () => ({ url: `/v1/inbox/media/${randomUUID()}` }),
  'POST /v1/inbox/conversations/:id/voice': async () => ({
    url: `/v1/inbox/conversations/${(await freshConversation(48)).id}/voice`,
    body: { id: randomUUID(), fileId: randomUUID(), durationMs: 3_000 },
  }),
  'GET /v1/inbox/calls/live': () => ({ url: '/v1/inbox/calls/live' }),
  'GET /v1/inbox/calls/:id': () => onCall(''),
  'POST /v1/inbox/calls/:id/claim': () => onCall('/claim'),
  'POST /v1/inbox/calls/:id/answer': () => onCall('/answer', { step: 'pre_accept', sdp: SDP }),
  'POST /v1/inbox/calls/:id/release': () => onCall('/release'),
  'POST /v1/inbox/calls/:id/decline': () => onCall('/decline'),
  'POST /v1/inbox/calls/:id/hang-up': () => onCall('/hang-up'),
  'POST /v1/inbox/calls/:id/callback-done': () => onCall('/callback-done', undefined, 'missed'),
};
