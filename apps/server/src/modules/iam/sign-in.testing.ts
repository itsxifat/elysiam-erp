import { base32 } from '@better-auth/utils/base32';
import type { MembershipRole } from '@elysium/contracts';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { expect } from 'vitest';

import {
  ORG_A,
  PASSWORD,
  type Client,
  type HttpHarness,
  type InjectedResponse,
} from '../../testing/http-harness.js';

/**
 * Signing people in for real in the account and security suites (M40): a password set through
 * Better Auth's own reset, the credential sign-in, the second factor, and the brand switch —
 * keeping the authenticator secret so a test can make the codes a phone would show.
 */

export function json<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

export interface Person {
  readonly userId: string;
  readonly email: string;
}

/** A person with roles in a brand and a password set (`PASSWORD` unless given). */
export async function person(
  harness: HttpHarness,
  roles: readonly MembershipRole[],
  options: {
    readonly orgId?: string;
    readonly isSuperAdmin?: boolean;
    readonly password?: string;
  } = {},
): Promise<Person> {
  const user = await createTestUser({
    name: `Person ${roles.join('+') || 'super admin'}`,
    ...(options.isSuperAdmin === undefined ? {} : { isSuperAdmin: options.isSuperAdmin }),
  });
  for (const role of roles) {
    await grantMembership({ userId: user.id, orgId: options.orgId ?? ORG_A, role });
  }
  await setPasswordFor(harness, user.email, options.password ?? PASSWORD);
  return { userId: user.id, email: user.email };
}

export async function setPasswordFor(
  harness: HttpHarness,
  email: string,
  password: string = PASSWORD,
): Promise<void> {
  await harness.auth.auth.api.requestPasswordReset({
    body: { email, redirectTo: '/accept-invite' },
    headers: new Headers(),
  });
  const token = harness.tokens.take(email);
  if (token === undefined) throw new Error(`no token for ${email}`);
  await harness.auth.auth.api.resetPassword({ body: { newPassword: password, token } });
}

/** The first factor only: the response says whether a code is owed. */
export async function signIn(
  harness: HttpHarness,
  email: string,
  password: string = PASSWORD,
): Promise<{ client: Client; response: InjectedResponse }> {
  const client = harness.client();
  await client.request('GET', '/v1/auth/login-branding');
  const response = await client.request('POST', '/api/auth/sign-in/email', {
    body: { email, password },
  });
  return { client, response };
}

/** The raw secret behind an `otpauth://` URI, as the authenticator app reads it. */
export function secretOf(totpURI: string): string {
  return new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get('secret') ?? ''));
}

/** The code an authenticator holding this secret shows now. */
export async function codeFor(harness: HttpHarness, secret: string): Promise<string> {
  const { code } = await harness.auth.auth.api.generateTOTP({ body: { secret } });
  return code;
}

/** Set up two-step sign-in the way the console does; returns the secret and backup codes. */
export async function enrol(
  harness: HttpHarness,
  client: Client,
  password: string = PASSWORD,
): Promise<{ secret: string; backupCodes: string[] }> {
  const enabled = await client.request('POST', '/api/auth/two-factor/enable', {
    body: { password, method: 'totp' },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const { totpURI, backupCodes } = json<{ totpURI: string; backupCodes: string[] }>(enabled);
  const secret = secretOf(totpURI);
  const verified = await client.request('POST', '/api/auth/two-factor/verify-totp', {
    body: { code: await codeFor(harness, secret) },
  });
  expect(verified.statusCode, verified.body).toBe(200);
  return { secret, backupCodes };
}

/** Into a brand; the session is walled (403) when a second factor is owed and missing. */
export async function enter(client: Client, orgId: string = ORG_A): Promise<InjectedResponse> {
  return client.request('POST', '/v1/me/active-org', { body: { orgId } });
}

/**
 * Signed in all the way: the password, then the code when one is owed, then the brand.
 * `secret` is the person's authenticator secret when they have one.
 */
export async function signInFully(
  harness: HttpHarness,
  email: string,
  options: { readonly secret?: string; readonly password?: string; readonly orgId?: string } = {},
): Promise<Client> {
  const { client, response } = await signIn(harness, email, options.password ?? PASSWORD);
  expect(response.statusCode, response.body).toBe(200);
  if (json<{ twoFactorRedirect?: boolean }>(response).twoFactorRedirect === true) {
    if (options.secret === undefined) throw new Error(`${email} owes a code and has no secret`);
    const verified = await client.request('POST', '/api/auth/two-factor/verify-totp', {
      body: { code: await codeFor(harness, options.secret) },
    });
    expect(verified.statusCode, verified.body).toBe(200);
  }
  const entered = await enter(client, options.orgId ?? ORG_A);
  expect(entered.statusCode, entered.body).toBe(201);
  return client;
}
