import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GraphMessagingGateway, MessagingError } from './providers/meta-messaging.js';

/**
 * M44a (D-761): the User Profile API calls, against a stand-in for Meta on this machine, as
 * Meta's pages document them (read 2026-10-12). Never against Meta.
 */
describe('the Graph adapter asks for a sender’s profile', () => {
  const PSID = '7712345678901234';
  const IGSID = '17841400000000099';
  const TOKEN = 'EAAB-page-token-profile-0000';
  const seen: { method: string; url: string }[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ method: request.method ?? '', url: request.url ?? '' });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const gateway = () =>
    new GraphMessagingGateway({ baseUrl: base, apiVersion: 'v25.0', timeoutMs: 2000 });

  it('Messenger: GET /<PSID>?fields=first_name,last_name,profile_pic with the Page token', async () => {
    seen.length = 0;
    answer = {
      status: 200,
      body: { first_name: 'Peter', last_name: 'Chang', profile_pic: 'https://cdn.example/p.jpg' },
    };
    const profile = await gateway().fetchProfile({
      channel: 'messenger',
      userId: PSID,
      token: TOKEN,
    });
    expect(profile).toEqual({
      name: null,
      firstName: 'Peter',
      lastName: 'Chang',
      username: null,
      pictureUrl: 'https://cdn.example/p.jpg',
    });
    expect(seen[0]?.method).toBe('GET');
    const url = new URL(seen[0]?.url ?? '', base);
    expect(url.pathname).toBe(`/v25.0/${PSID}`);
    expect(url.searchParams.get('fields')).toBe('first_name,last_name,profile_pic');
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
  });

  it('Instagram: GET /<IGSID>?fields=name,username,profile_pic', async () => {
    seen.length = 0;
    answer = {
      status: 200,
      body: { name: 'রহিম', username: 'rahim.bd', profile_pic: 'https://cdn.example/r.jpg' },
    };
    const profile = await gateway().fetchProfile({
      channel: 'instagram',
      userId: IGSID,
      token: TOKEN,
    });
    expect(profile?.name).toBe('রহিম');
    expect(profile?.username).toBe('rahim.bd');
    const url = new URL(seen[0]?.url ?? '', base);
    expect(url.pathname).toBe(`/v25.0/${IGSID}`);
    expect(url.searchParams.get('fields')).toBe('name,username,profile_pic');
  });

  it('an empty answer or a refusal is no profile; a 5xx is retried; no error carries the token', async () => {
    answer = { status: 200, body: {} };
    expect(await gateway().fetchProfile({ channel: 'messenger', userId: PSID, token: TOKEN })).toBe(
      null,
    );
    answer = {
      status: 400,
      body: { error: { message: 'No profile available for this user.', code: 2018218 } },
    };
    expect(await gateway().fetchProfile({ channel: 'messenger', userId: PSID, token: TOKEN })).toBe(
      null,
    );
    answer = { status: 503, body: {} };
    const later = await gateway()
      .fetchProfile({ channel: 'messenger', userId: PSID, token: TOKEN })
      .catch((error: unknown) => error);
    expect(later).toBeInstanceOf(MessagingError);
    expect((later as MessagingError).retryable).toBe(true);
    expect(String((later as Error).message)).not.toContain(TOKEN);
  });
});
