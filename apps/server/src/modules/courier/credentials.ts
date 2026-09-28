import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { courierEnv } from './courier.config.js';
import { courierHttpError } from './courier.errors.js';

/**
 * Courier credentials at rest (architecture §25; invariant 10).
 *
 * An API key that books parcels and reads a merchant's COD balance is as sensitive as a
 * password, and the failure it enables is not abstract: with Steadfast's key a third
 * party can create parcels against the brand's account and change where the cash goes.
 * So it is never in a readable column, never in a log line, never in an error message,
 * and never in a response.
 *
 * ## AES-256-GCM, and why not something simpler
 *
 * The obvious cheaper options are both wrong here. Storing a hash is impossible — we
 * have to *send* the key to the courier, so it has to be recoverable. Storing it in
 * plaintext behind RLS protects it from another tenant and from nothing else: a
 * `pg_dump`, a read replica, a backup on someone's laptop and a support engineer's
 * `select *` all see it.
 *
 * GCM rather than CBC because the ciphertext has to be *authenticated*. Without the tag,
 * a row somebody flipped a byte in decrypts to different bytes and we send those to the
 * courier as a key — which fails in a way that looks like the courier being down, five
 * retries and a dead-letter later. With it, tampering is a thrown error at the row.
 *
 * The associated data binds the ciphertext to the row it belongs to: org, account and
 * field. Without it, a ciphertext copied from one org's account into another's would
 * decrypt perfectly, and one brand would be booking parcels on another brand's account.
 *
 * ## The layout
 *
 *     [ 12-byte iv ][ 16-byte tag ][ ciphertext ]
 *
 * Fixed-width prefixes rather than a length-prefixed or JSON envelope, because the
 * parse has to be unambiguous on bytes that may have been corrupted — a self-describing
 * format invites a parser that trusts a length it read out of the untrusted blob.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** What an adapter needs to talk to its courier. Opaque to everything but the adapter. */
export type CourierCredentials = Readonly<Record<string, string>>;

export interface SealedCredentials {
  readonly ciphertext: Buffer;
  readonly keyId: string;
  /**
   * A short digest of the plaintext, so an operator can confirm *which* key is
   * configured without ever being shown one.
   *
   * Truncated to 12 hex characters on purpose. A full SHA-256 of a low-entropy secret
   * is a secret — it is one dictionary away from the plaintext — and 48 bits is plenty
   * to answer "is this the key I put in the vault".
   */
  readonly fingerprint: string;
}

function key(): Buffer {
  const configured = courierEnv().COURIER_CREDENTIALS_KEY;
  if (configured === undefined) {
    /*
     * Refused rather than defaulted. A development default would be a key committed to
     * the repository, and the one thing worse than no encryption is encryption
     * everybody has the key to — because the column then *looks* protected.
     */
    throw courierHttpError(
      'COURIER_CREDENTIALS_MISSING',
      'This installation has no COURIER_CREDENTIALS_KEY, so courier credentials cannot be stored.',
    );
  }
  const bytes = Buffer.from(configured, 'base64');
  if (bytes.length !== KEY_BYTES) {
    throw courierHttpError(
      'COURIER_CREDENTIALS_MISSING',
      'COURIER_CREDENTIALS_KEY is not 32 bytes.',
    );
  }
  return bytes;
}

/**
 * What the ciphertext is bound to.
 *
 * `field` is in here because an account holds two secrets — the API credentials and the
 * webhook secret — and without it the webhook secret could be swapped into the
 * credentials column, where it would decrypt cleanly and be sent to the courier as a
 * key.
 */
function associatedData(input: { orgId: string; accountId: string; field: string }): Buffer {
  return Buffer.from(`${input.orgId}:${input.accountId}:${input.field}`, 'utf8');
}

export function sealCredentials(
  plaintext: CourierCredentials,
  bound: { orgId: string; accountId: string; field: string },
): SealedCredentials {
  const json = Buffer.from(JSON.stringify(plaintext), 'utf8');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(associatedData(bound));
  const body = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([iv, tag, body]),
    keyId: courierEnv().COURIER_CREDENTIALS_KEY_ID,
    fingerprint: createHash('sha256').update(json).digest('hex').slice(0, 12),
  };
}

export function openCredentials(
  sealed: Buffer,
  bound: { orgId: string; accountId: string; field: string },
): CourierCredentials {
  if (sealed.length < IV_BYTES + TAG_BYTES) {
    throw courierHttpError('COURIER_CREDENTIALS_MISSING', 'That credential blob is malformed.');
  }
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(associatedData(bound));

  let json: Buffer;
  try {
    json = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    /*
     * The tag did not verify, or the key is not the key that sealed it.
     *
     * The original error is swallowed deliberately: node's message
     * ("Unsupported state or unable to authenticate data") says nothing useful and
     * everything it *could* say — which key, which bytes — is the kind of detail an
     * attacker with write access to the column would use as an oracle.
     */
    throw courierHttpError(
      'COURIER_CREDENTIALS_MISSING',
      'These courier credentials could not be decrypted with this installation’s key.',
    );
  }

  const parsed: unknown = JSON.parse(json.toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw courierHttpError('COURIER_CREDENTIALS_MISSING', 'That credential blob is malformed.');
  }
  for (const value of Object.values(parsed)) {
    if (typeof value !== 'string') {
      throw courierHttpError('COURIER_CREDENTIALS_MISSING', 'That credential blob is malformed.');
    }
  }
  return parsed as CourierCredentials;
}

/**
 * Compare a presented webhook secret against the stored one, in constant time.
 *
 * `timingSafeEqual` and not `===`. A courier's webhook endpoint is a public URL, so an
 * attacker can call it as often as they like and measure how long the refusal takes; a
 * byte-by-byte comparison that returns early leaks the secret one character at a time.
 * It throws on different lengths, which would itself be a length oracle — so both sides
 * are hashed to a fixed width first.
 */
export function secretMatches(presented: string, stored: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(stored, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * A digest of a webhook body, for recognising a retransmission.
 *
 * Over the raw bytes, not over a re-serialised object: `JSON.stringify` of a parsed body
 * reorders nothing today and may tomorrow, and a hash that changes when a library
 * upgrades would let every stored webhook be stored a second time.
 */
export function bodyHash(raw: Buffer | string): string {
  return createHash('sha256').update(raw).digest('hex');
}
