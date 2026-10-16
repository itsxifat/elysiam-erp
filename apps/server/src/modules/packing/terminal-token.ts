import { createHash, randomBytes } from 'node:crypto';

/**
 * A bound computer's token (M46, D-803): `tdt_<org id, 32 hex>_<43 random characters>`, as a
 * scanner device's (D-554). The brand is in the token, so it is looked up inside that brand
 * only; it is kept as its SHA-256 and shown once, when a supervisor binds the computer.
 */

const SHAPE = /^tdt_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export function newTerminalToken(orgId: string): string {
  return `tdt_${orgId.replace(/-/g, '').toLowerCase()}_${randomBytes(32).toString('base64url')}`;
}

export function terminalTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The brand a token names, or null for anything that is not a terminal token. */
export function orgIdOfTerminalToken(token: string): string | null {
  const hex = SHAPE.exec(token)?.[1];
  if (hex === undefined) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The token a request's `x-terminal-device` header carries, or null. */
export function terminalTokenOf(header: string | string[] | undefined): string | null {
  const value = (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
  return value === '' ? null : value;
}
