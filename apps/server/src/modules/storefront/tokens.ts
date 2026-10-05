import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';

import { HttpException } from '@nestjs/common';

/**
 * The website's one-time secrets (M34, D-522, D-524), and how they are stored: never as given.
 *
 * - **Order view tokens and reset links** are 32 random bytes (base64url, 43 characters) and
 *   kept as their SHA-256: guessing one is guessing 256 bits.
 * - **Six-digit email codes** are a million possibilities, so a plain hash would be a lookup
 *   table. They are kept as `HMAC-SHA256(key, purpose:account:code)` under a key derived from
 *   the server's `INTAKE_KEY_SECRET` with its own label, so a copy of the table without the
 *   server's secret says nothing.
 */

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Six digits, uniformly drawn. */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

const CODE_LABEL = 'storefront.account-code.v1:';

export function codeHash(
  masterKey: string,
  input: { readonly purpose: string; readonly accountId: string; readonly code: string },
): string {
  const key = createHmac('sha256', masterKey).update(CODE_LABEL).digest();
  return createHmac('sha256', key)
    .update(`${input.purpose}:${input.accountId}:${input.code}`)
    .digest('hex');
}

/** The code an `HttpException` from another module's API carries, if any. */
export function httpCodeOf(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  const code =
    typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
}
