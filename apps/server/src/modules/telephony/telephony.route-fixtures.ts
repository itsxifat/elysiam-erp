import { randomInt } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';

import { connectionBinding, sealSecret } from './telephony-secrets.js';

/**
 * How the route-matrix suite and the cost sweep call M47's routes (D-070). The test environment
 * runs the fake Envo (`TELEPHONY_ENVO_PROVIDER=fake`), so nothing here rings a phone or calls
 * the owner's SIP server. One connection is saved for real (its key sealed); an extension is
 * given to and taken off a fresh person of its own each time, so each admitted role's write
 * succeeds and is audited; every call route is asked about a call of its own. Nobody under test
 * has an extension, so Call is refused with `TELEPHONY_NO_EXTENSION` (still an admission).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const CONNECTION = '0f5a8a64-4d0b-4a5e-9a4f-7a3b2c1d0e47';
const NAME = 'Route matrix Envo';

/** The brand's connection, with a sealed key and webhook secret; idempotent. */
export async function prepareTelephonyFixtures(): Promise<void> {
  const key = sealSecret(
    'envo_live_route_matrix_0000000000',
    connectionBinding(ORG_A, CONNECTION, 'api_key'),
  );
  const secret = sealSecret(
    'whsec_route_matrix_00000000',
    connectionBinding(ORG_A, CONNECTION, 'webhook_secret'),
  );
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into telephony.connections
          (id, org_id, name, base_url, enabled, api_key_sealed, api_key_key_id, api_key_fingerprint,
           webhook_secret_sealed, webhook_secret_key_id, webhook_secret_fingerprint,
           created_by, updated_by)
        values (${CONNECTION}, ${ORG_A}, ${NAME}, 'https://envo.enfinito.cloud', true,
                ${key.ciphertext}, ${key.keyId}, ${key.fingerprint},
                ${secret.ciphertext}, ${secret.keyId}, ${secret.fingerprint},
                'usr_route_matrix', 'usr_route_matrix')
        on conflict (id) do nothing
      `);
    },
    { orgId: ORG_A },
  );
}

/** A sales person of the brand with no extension yet. */
async function freshPerson(): Promise<string> {
  const user = await createTestUser({ name: 'Telephony fixture' });
  await grantMembership({ userId: user.id, orgId: ORG_A, role: 'sales' });
  return user.id;
}

function freshExtension(): string {
  return String(randomInt(100_000, 99_999_999));
}

/** A call Envo told us about, linked to nobody. */
async function freshCall(): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into telephony.calls
            (org_id, connection_id, envo_call_id, first_seen, direction, status, from_number,
             to_number, occurred_at, started_at)
          values (${ORG_A}, ${CONNECTION}, ${`${String(Date.now())}.${String(randomInt(1, 1_000_000))}`},
                  'webhook', 'inbound', 'ended', '+8801712345678', '09600000000', now(), now())
          returning id
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
}

export const TELEPHONY_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/telephony/connections': () => ({ url: '/v1/telephony/connections' }),
  'POST /v1/telephony/connections': () => ({
    url: '/v1/telephony/connections',
    body: {
      name: `Matrix ${String(randomInt(1, 1_000_000_000))}`,
      baseUrl: 'https://envo.enfinito.cloud',
      apiKey: 'envo_live_route_matrix_new_000000',
      webhookSecret: 'whsec_route_matrix_new_0000',
    },
  }),
  'PUT /v1/telephony/connections/:id': () => ({
    url: `/v1/telephony/connections/${CONNECTION}`,
    body: {
      name: NAME,
      baseUrl: 'https://envo.enfinito.cloud',
      enabled: true,
      recordingRetentionDays: 365,
    },
  }),
  'POST /v1/telephony/connections/:id/test': () => ({
    url: `/v1/telephony/connections/${CONNECTION}/test`,
  }),
  'GET /v1/telephony/connections/:id/extensions': () => ({
    url: `/v1/telephony/connections/${CONNECTION}/extensions`,
  }),
  'PUT /v1/telephony/connections/:id/extensions/:extension': async () => ({
    url: `/v1/telephony/connections/${CONNECTION}/extensions/${freshExtension()}`,
    body: { userId: await freshPerson() },
  }),
  'DELETE /v1/telephony/connections/:id/extensions/:extension': async () => {
    const extension = freshExtension();
    const userId = await freshPerson();
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into telephony.extension_assignments
            (org_id, connection_id, extension, user_id, assigned_by)
          values (${ORG_A}, ${CONNECTION}, ${extension}, ${userId}, 'usr_route_matrix')
        `);
      },
      { orgId: ORG_A },
    );
    return { url: `/v1/telephony/connections/${CONNECTION}/extensions/${extension}` };
  },
  'GET /v1/telephony/assignments': () => ({ url: '/v1/telephony/assignments' }),
  'GET /v1/telephony/connections/:id/live': () => ({
    url: `/v1/telephony/connections/${CONNECTION}/live`,
  }),
  'POST /v1/telephony/connections/:id/live/:callId/hangup': () => ({
    url: `/v1/telephony/connections/${CONNECTION}/live/1789455634.59/hangup`,
  }),
  'GET /v1/telephony/me': () => ({ url: '/v1/telephony/me' }),
  'GET /v1/telephony/phone/token': () => ({ url: '/v1/telephony/phone/token' }),
  'GET /v1/telephony/lookup': () => ({ url: '/v1/telephony/lookup?phone=01712345678' }),
  'POST /v1/telephony/calls': () => ({
    url: '/v1/telephony/calls',
    body: { phone: '01712345678' },
  }),
  'POST /v1/telephony/calls/answered': () => ({
    url: '/v1/telephony/calls/answered',
    body: { from: '01712345678' },
  }),
  'GET /v1/telephony/calls': () => ({ url: '/v1/telephony/calls?limit=5' }),
  'GET /v1/telephony/calls/:id': async () => ({ url: `/v1/telephony/calls/${await freshCall()}` }),
  'GET /v1/telephony/calls/:id/recording': async () => ({
    url: `/v1/telephony/calls/${await freshCall()}/recording`,
  }),
  'POST /v1/telephony/calls/:id/outcome': async () => ({
    url: `/v1/telephony/calls/${await freshCall()}/outcome`,
    body: { outcome: 'reached' },
  }),
};
