import { createHmac, timingSafeEqual } from 'node:crypto';

import { StorageError } from './driver.js';

/**
 * The local driver's signed tokens (architecture §22).
 *
 * R2 presigning is AWS SigV4 against Cloudflare's endpoint. The local driver has
 * no third party to sign for, so it signs its own: a token the API process
 * issues and the API process verifies, carrying the key, the method and an
 * expiry.
 *
 * The reason this exists at all — rather than the local driver simply serving
 * `/files/<key>` — is that acceptance check 4 asserts a real expiry, and a
 * development driver with no expiry would make that assertion pass against
 * nothing. Worse, it would mean the code path tests exercise is not the one
 * production runs: production's URL stops working, development's never does,
 * and every bug about a stale URL shows up only in production.
 *
 * ## What is signed
 *
 * Everything that decides what the URL does: the key, the method, the expiry,
 * the content type a PUT must carry, and the filename a GET forces. An
 * unsigned field is a field the holder of the URL can change, and the
 * interesting change is `key`.
 */

export interface LocalTokenClaims {
  readonly key: string;
  readonly method: 'GET' | 'PUT';
  /** Seconds since the epoch. Integer, so the token is byte-stable. */
  readonly expiresAt: number;
  readonly contentType?: string | undefined;
  readonly downloadFilename?: string | undefined;
}

function base64url(value: Buffer): string {
  return value.toString('base64url');
}

/**
 * The exact bytes the HMAC covers.
 *
 * Built field by field with a separator rather than by `JSON.stringify`, because
 * two JSON encoders can order keys differently and a signature over
 * canonically-ambiguous input is a signature that verifies sometimes. The
 * separator is a newline and every field is length-prefixed, so a value
 * containing a newline cannot be split into two fields — the classic way a
 * "sign the concatenation" scheme lets one field eat the next.
 */
function canonicalClaims(claims: LocalTokenClaims): string {
  const fields = [
    claims.key,
    claims.method,
    String(claims.expiresAt),
    claims.contentType ?? '',
    claims.downloadFilename ?? '',
  ];
  return fields.map((field) => `${String(field.length)}:${field}`).join('\n');
}

function sign(secret: string, claims: LocalTokenClaims): string {
  return base64url(createHmac('sha256', secret).update(canonicalClaims(claims)).digest());
}

/** A URL-safe token: the claims, then the signature over them. */
export function issueLocalToken(secret: string, claims: LocalTokenClaims): string {
  const body = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${body}.${sign(secret, claims)}`;
}

/**
 * Verify a token and return what it allows, or throw.
 *
 * The order matters and is the opposite of the obvious one: the signature is
 * checked *before* the expiry. Checking expiry first would mean an unsigned,
 * attacker-written token with a future expiry gets further into this function
 * than it should, and — more practically — it makes the error message leak
 * whether a forged key happened to name a real object.
 *
 * `now` is a parameter so the expiry can be tested without waiting for it.
 */
export function verifyLocalToken(
  secret: string,
  token: string,
  now: Date = new Date(),
): LocalTokenClaims {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    throw new StorageError('signature-invalid', 'Malformed download token.');
  }

  const body = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  let claims: LocalTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LocalTokenClaims;
  } catch {
    throw new StorageError('signature-invalid', 'Malformed download token.');
  }

  if (
    typeof claims !== 'object' ||
    typeof claims.key !== 'string' ||
    typeof claims.expiresAt !== 'number' ||
    (claims.method !== 'GET' && claims.method !== 'PUT')
  ) {
    throw new StorageError('signature-invalid', 'Malformed download token.');
  }

  const expected = Buffer.from(sign(secret, claims), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  // Length is compared first because timingSafeEqual throws on a mismatch
  // rather than returning false, and a thrown RangeError here would surface as
  // a 500 on a forged token instead of a refusal.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new StorageError('signature-invalid', 'This link is not valid.');
  }

  if (claims.expiresAt * 1000 <= now.getTime()) {
    throw new StorageError('expired', 'This link has expired. Ask for a new one.');
  }

  return claims;
}
