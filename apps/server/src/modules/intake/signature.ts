import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Site keys and request signatures for the public intake (architecture §23).
 *
 * Pure functions over bytes, so every rule here is unit-tested without a database or a
 * server — and so the landing-page developer's side (`docs/public-api.md`) can be checked
 * against the exact function the server runs.
 *
 * ## The credential
 *
 * A site holds two strings: a **key id** (`pk_…`, public, sent on every request) and a
 * **secret** (`sk_…`, shown once, never sent). The secret is
 * `HMAC-SHA256(INTAKE_KEY_SECRET, "elysium.intake.site-key.v1:" + keyId)`, so the server can
 * recompute it from the key id and nothing it stores can. See the schema comment in
 * `packages/db/src/schema/intake` for why that beats storing it encrypted.
 *
 * ## The signature
 *
 * `sha256=` + hex `HMAC-SHA256(secret, timestamp + "." + idempotencyKey + "." + rawBody)`.
 *
 * * The **raw bytes** of the body, not a re-serialised object: a signature over
 *   `JSON.stringify(parsed)` breaks the day a library reorders keys or changes number
 *   formatting, on either side.
 * * The **timestamp**, so a captured request stops working after the window (§23: five
 *   minutes).
 * * The **idempotency key**, because it is a header and headers are not in the body. Left
 *   out, a captured request could be replayed inside the window with a *new* key — and a
 *   new key is a new order. With it in, the only replay possible is one that returns the
 *   order that already exists.
 */

const KEY_ID_SHAPE = /^pk_([0-9a-f]{32})_([a-z2-7]{20})$/;
const SIGNATURE_SHAPE = /^sha256=([0-9a-f]{64})$/;
const DERIVATION_LABEL = 'elysium.intake.site-key.v1:';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower-case, no padding: 20 characters carry 100 bits. */
function base32(bytes: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (out.length < length) throw new Error('not enough random bytes for a key id');
  return out;
}

/** A fresh key id for an org. The org is in it so a public request can find its tenant. */
export function newKeyId(orgId: string): string {
  const hex = orgId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('newKeyId needs an org uuid');
  return `pk_${hex}_${base32(randomBytes(13), 20)}`;
}

/** The org a key id names, as a uuid, or null for anything that is not a key id. */
export function orgIdOf(keyId: string): string | null {
  const match = KEY_ID_SHAPE.exec(keyId);
  const hex = match?.[1];
  if (hex === undefined) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isKeyId(value: string): boolean {
  return KEY_ID_SHAPE.test(value);
}

/** The site's signing secret, derived — never stored (see the file comment). */
export function deriveSecret(masterKey: string, keyId: string): string {
  const digest = createHmac('sha256', masterKey).update(`${DERIVATION_LABEL}${keyId}`).digest();
  return `sk_${digest.toString('base64url')}`;
}

/** What `site_keys.secret_sha256` holds: enough to notice a changed master key, no more. */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** SHA-256 of the raw body, for the idempotency record's "same request" test. */
export function bodyHash(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

/** The exact bytes that are signed. */
export function signingBase(timestamp: string, idempotencyKey: string, rawBody: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.${idempotencyKey}.`, 'utf8'), rawBody]);
}

/** The header value a correct client sends. Used by the tests and the docs' reference. */
export function sign(
  secret: string,
  timestamp: string,
  idempotencyKey: string,
  rawBody: Buffer,
): string {
  const mac = createHmac('sha256', secret)
    .update(signingBase(timestamp, idempotencyKey, rawBody))
    .digest('hex');
  return `sha256=${mac}`;
}

/**
 * Whether the signature header is the right one for these bytes.
 *
 * Constant time over the digest, so the comparison cannot be used to learn the right
 * signature a byte at a time. The header's *shape* is checked first and in ordinary time,
 * which leaks nothing: every correct header has the same shape.
 */
export function signatureMatches(input: {
  readonly secret: string;
  readonly header: string;
  readonly timestamp: string;
  readonly idempotencyKey: string;
  readonly rawBody: Buffer;
}): boolean {
  const match = SIGNATURE_SHAPE.exec(input.header.trim());
  const given = match?.[1];
  if (given === undefined) return false;
  const expected = createHmac('sha256', input.secret)
    .update(signingBase(input.timestamp, input.idempotencyKey, input.rawBody))
    .digest();
  return timingSafeEqual(Buffer.from(given, 'hex'), expected);
}

/**
 * Whether a timestamp is inside the window, either side of now.
 *
 * Both sides, because a clock running fast on the landing page's server is as ordinary as
 * one running slow, and refusing only the future would make the window asymmetric in a way
 * nobody would think to look for. Unix seconds as decimal digits only: `1e9`, `0x…` and a
 * float all fail, so there is exactly one spelling of a moment.
 */
export function timestampFresh(timestamp: string, now: Date, windowSeconds: number): boolean {
  if (!/^\d{9,11}$/.test(timestamp)) return false;
  const seconds = Number(timestamp);
  return Math.abs(Math.floor(now.getTime() / 1000) - seconds) <= windowSeconds;
}
