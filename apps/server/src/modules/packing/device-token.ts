import { createHash, randomBytes } from 'node:crypto';

/**
 * A scanner device's bearer token (M35b, D-554): `sdt_<org id, 32 hex>_<43 random characters>`.
 *
 * The brand is in the token, as a website key carries its brand (D-509), so the lookup runs
 * inside that brand only and another brand's table is never read. The token is kept as its
 * SHA-256 and shown once; 32 random bytes are not guessable, so a plain hash is enough.
 */

const SHAPE = /^sdt_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

/** Thirty days, the old site's token life. */
export const DEVICE_TOKEN_DAYS = 30;

export function newDeviceToken(orgId: string): string {
  return `sdt_${orgId.replace(/-/g, '').toLowerCase()}_${randomBytes(32).toString('base64url')}`;
}

export function deviceTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The brand a token names, or null for anything that is not a device token. */
export function orgIdOfDeviceToken(token: string): string | null {
  const match = SHAPE.exec(token);
  const hex = match?.[1];
  if (hex === undefined) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The token a request's `Authorization: Bearer …` carries, or null. */
export function bearerOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  const token = value.slice(7).trim();
  return token === '' ? null : token;
}
