import { base32 } from '@better-auth/utils/base32';
import { withSystem } from '@elysium/db';
import { createTestUser } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditRowsFor,
  ORG_A,
  PASSWORD,
  startHttpHarness,
  type Client,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';

/**
 * The admins' trust votes against real Postgres (D-654 to D-656).
 *
 * The owner invited Riya; Riya invited Faisal and two puppets. Faisal can never approve
 * Riya's requests (the grant lineage, D-077, D-410). No admin in that chain can vouch for him
 * — not Riya, not the puppets who share Riya as inviter — so Nadia (Sam's admin) is the one
 * independent admin, and one admin's vote is never enough. A super admin's vote counts for
 * anyone and is enough on its own (D-657, the owner's decision of 2026-10-07).
 */

let harness: HttpHarness;
let owner: Actor;
let sam: Actor;
let riya: RoleClient;
let faisal: RoleClient;
let puppet1: RoleClient;
let puppet2: RoleClient;
let nadia: RoleClient;

interface Actor {
  readonly client: Client;
  readonly userId: string;
}

interface Trust {
  votes: number;
  needed: number;
  trusted: boolean;
  votedByMe: boolean;
  canVote: boolean;
  reason: string | null;
}

function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

/** A super admin with a password and an enrolled second factor, inside ORG_A. */
async function superAdmin(name: string): Promise<Actor> {
  const user = await createTestUser({ name, isSuperAdmin: true });
  await harness.auth.auth.api.requestPasswordReset({
    body: { email: user.email, redirectTo: '/accept-invite' },
    headers: new Headers(),
  });
  const token = harness.tokens.take(user.email);
  if (token === undefined) throw new Error(`no token for ${user.email}`);
  await harness.auth.auth.api.resetPassword({ body: { newPassword: PASSWORD, token } });

  const client = harness.client();
  await client.request('GET', '/v1/auth/login-branding');
  await client.request('POST', '/api/auth/sign-in/email', {
    body: { email: user.email, password: PASSWORD },
  });
  const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
    body: { password: PASSWORD, method: 'totp' },
  });
  const { totpURI } = json<{ totpURI: string }>(enabled);
  const secret = new TextDecoder().decode(
    base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''),
  );
  const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret } });
  await client.request('POST', '/api/auth/two-factor/verify-totp', { body: { code } });
  const entered = await client.request('POST', '/v1/me/active-org', { body: { orgId: ORG_A } });
  expect(entered.statusCode, entered.body).toBe(201);
  return { client, userId: user.id };
}

/** Record that `grantedBy` invited `userId`, as the invite route would (D-410). */
async function invited(userId: string, grantedBy: string): Promise<void> {
  await withSystem(
    async (tx) =>
      tx.execute(sql`
        insert into iam.membership_granters (org_id, user_id, granted_by, reason)
        values (${ORG_A}, ${userId}, ${grantedBy}, 'role_granted')
      `),
    { orgId: ORG_A },
  );
}

async function raise(maker: Client): Promise<string> {
  const raised = await maker.request('POST', '/v1/approvals', {
    body: { type: 'closing_variance', amountPoisha: '900000' },
  });
  expect(raised.statusCode, raised.body).toBe(201);
  return json<{ id: string }>(raised).id;
}

async function decide(checker: Client, id: string): Promise<InjectedResponse> {
  return checker.request('POST', `/v1/approvals/${id}/decide`, { body: { decision: 'approved' } });
}

async function vote(voter: Client, candidate: string): Promise<InjectedResponse> {
  return voter.request('POST', `/v1/users/${candidate}/trust`);
}

async function trustOf(viewer: Client, candidate: string): Promise<Trust | null> {
  const listed = await viewer.request('GET', '/v1/users');
  expect(listed.statusCode, listed.body).toBe(200);
  const row = json<{ items: { userId: string; trust: Trust | null }[] }>(listed).items.find(
    (item) => item.userId === candidate,
  );
  return row?.trust ?? null;
}

async function votesStored(): Promise<number> {
  const [row] = await withSystem(
    async (tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from iam.trust_votes`),
    { orgId: ORG_A },
  );
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  harness = await startHttpHarness('trust');
  owner = await superAdmin('Owner');
  sam = await superAdmin('Sam');
  riya = await harness.asRole('org_admin', ORG_A);
  faisal = await harness.asRole('org_admin', ORG_A);
  puppet1 = await harness.asRole('org_admin', ORG_A);
  puppet2 = await harness.asRole('org_admin', ORG_A);
  nadia = await harness.asRole('org_admin', ORG_A);
  await invited(riya.userId, owner.userId);
  await invited(faisal.userId, riya.userId);
  await invited(puppet1.userId, riya.userId);
  await invited(puppet2.userId, riya.userId);
  await invited(nadia.userId, sam.userId);
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('trust votes (D-654 to D-656)', () => {
  it('refuses every vote from inside the invitation chain, and stores none', async () => {
    const riyaRequest = await raise(riya.client);
    const refused = await decide(faisal.client, riyaRequest);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatch(/granted you your role/);

    const cases: [Client, string, string][] = [
      [puppet1.client, faisal.userId, 'You were both invited by the same person.'],
      [puppet2.client, faisal.userId, 'You were both invited by the same person.'],
      [riya.client, faisal.userId, 'You invited this person.'],
      [faisal.client, riya.userId, 'This person invited you.'],
    ];
    for (const [voter, candidate, reason] of cases) {
      const response = await vote(voter, candidate);
      expect(response.statusCode, response.body).toBe(403);
      expect(json<{ code: string }>(response).code).toBe('TRUST_VOTE_REFUSED');
      expect(response.body).toContain(reason);
    }
    const self = await vote(faisal.client, faisal.userId);
    expect(self.statusCode).toBe(403);
    expect(json<{ code: string }>(self).code).toBe('USER_SELF_MANAGEMENT');
    expect(await votesStored()).toBe(0);

    // The puppets cannot make him trusted, so he is still refused.
    expect((await decide(faisal.client, riyaRequest)).statusCode).toBe(403);
    expect(await trustOf(puppet1.client, faisal.userId)).toMatchObject({
      votes: 0,
      needed: 2,
      trusted: false,
      canVote: false,
      reason: 'You were both invited by the same person.',
    });
    expect(await trustOf(sam.client, faisal.userId)).toMatchObject({
      votes: 0,
      needed: 2,
      trusted: false,
      votedByMe: false,
      canVote: true,
      reason: null,
    });
  });

  it('one admin is not enough; a super admin vote is; a withdrawal undoes it; never his own', async () => {
    const first = await raise(riya.client);

    const nadiaVote = await vote(nadia.client, faisal.userId);
    expect(nadiaVote.statusCode, nadiaVote.body).toBe(201);
    expect(json<{ trust: Trust }>(nadiaVote).trust).toMatchObject({ votes: 1, trusted: false });
    // One admin's vote is never enough, whatever the count of voters (the quorum).
    expect((await decide(faisal.client, first)).statusCode).toBe(403);

    const samVote = await vote(sam.client, faisal.userId);
    expect(samVote.statusCode, samVote.body).toBe(201);
    expect(json<{ trust: Trust }>(samVote).trust).toMatchObject({
      votes: 2,
      trusted: true,
      votedByMe: true,
    });
    const approved = await decide(faisal.client, first);
    expect(approved.statusCode, approved.body).toBe(201);

    const audited = await auditRowsFor(ORG_A, faisal.userId);
    expect(audited.filter((row) => row.action === 'iam.trust_voted')).toHaveLength(2);

    // The super admin withdraws: refused again at once.
    const second = await raise(riya.client);
    const withdrawn = await sam.client.request('DELETE', `/v1/users/${faisal.userId}/trust`);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);
    expect(json<{ trust: Trust }>(withdrawn).trust).toMatchObject({ votes: 1, trusted: false });
    expect((await decide(faisal.client, second)).statusCode).toBe(403);
    const again = await sam.client.request('DELETE', `/v1/users/${faisal.userId}/trust`);
    expect(again.statusCode).toBe(409);

    // Trusted again, and still never the checker of his own request.
    expect((await vote(sam.client, faisal.userId)).statusCode).toBe(201);
    const own = await raise(faisal.client);
    const ownDecided = await decide(faisal.client, own);
    expect(ownDecided.statusCode).toBe(403);
    expect((await decide(faisal.client, second)).statusCode).toBe(201);
  });

  it('a super admin vouches for anyone, even someone they invited (D-657)', async () => {
    const owned = await vote(owner.client, riya.userId);
    expect(owned.statusCode, owned.body).toBe(201);
    expect(json<{ trust: Trust }>(owned).trust).toMatchObject({ trusted: true, votedByMe: true });
  });
});
