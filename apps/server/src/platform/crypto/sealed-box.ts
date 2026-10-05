import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * The website's secrets at rest (M34, D-528): the SSLCommerz store password, the email
 * server's password and the bodies of emails still waiting to go (which can carry a one-time
 * code or a link).
 *
 * The courier's arrangement (`modules/courier/credentials.ts`, §25): AES-256-GCM under a key
 * from the environment, `[12-byte iv][16-byte tag][ciphertext]`, and associated data that binds
 * the ciphertext to its brand, its row and its field — a password copied into another brand's
 * row, or into another column, does not decrypt. The key is `STOREFRONT_CREDENTIALS_KEY` (32
 * bytes, base64) with `STOREFRONT_CREDENTIALS_KEY_ID` naming it for rotation; with no key,
 * nothing is sealed and the screens that need one say so (`WEBSITE_CREDENTIALS_MISSING`) rather
 * than store a secret in the clear.
 *
 * Shared by two modules (the storefront's gateway settings, notify's email channel) because it
 * is one key and one format, kept in the platform layer like the logger rather than copied.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SealedBoxUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedBoxUnavailable';
  }
}

export interface Sealed {
  readonly ciphertext: Buffer;
  readonly keyId: string;
  /** 12 hex of a keyed hash of the plaintext: "which one is set", never the secret itself. */
  readonly fingerprint: string;
}

export interface SealBinding {
  readonly orgId: string;
  /** The row: a table and its key (`gateway_settings`, `email:<id>`). */
  readonly row: string;
  readonly field: string;
}

function keyFrom(env: NodeJS.ProcessEnv): Buffer {
  const configured = env.STOREFRONT_CREDENTIALS_KEY;
  if (configured === undefined || configured === '') {
    throw new SealedBoxUnavailable(
      'This installation has no STOREFRONT_CREDENTIALS_KEY, so website credentials cannot be kept.',
    );
  }
  const bytes = Buffer.from(configured, 'base64');
  if (bytes.length !== KEY_BYTES) {
    throw new SealedBoxUnavailable('STOREFRONT_CREDENTIALS_KEY is not 32 bytes of base64.');
  }
  return bytes;
}

/** Whether a key is configured, for a screen that says "set up" or "not available". */
export function sealedBoxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    keyFrom(env);
    return true;
  } catch {
    return false;
  }
}

function binding(bound: SealBinding): Buffer {
  return Buffer.from(`${bound.orgId}:${bound.row}:${bound.field}`, 'utf8');
}

export function seal(
  plaintext: string,
  bound: SealBinding,
  env: NodeJS.ProcessEnv = process.env,
): Sealed {
  const key = keyFrom(env);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(binding(bound));
  const bytes = Buffer.from(plaintext, 'utf8');
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]),
    keyId: env.STOREFRONT_CREDENTIALS_KEY_ID ?? 'k1',
    fingerprint: fingerprintOf(key, bytes),
  };
}

/**
 * "Which password is set", for a screen: a keyed hash (HMAC under a key derived from the
 * installation's key), so the 48 bits shown cannot be used to guess a weak password offline by
 * anyone who reads the screen (M34 ledger audit W7).
 */
function fingerprintOf(key: Buffer, plaintext: Buffer): string {
  const derived = createHash('sha256').update('sealed-box.fingerprint.v1:').update(key).digest();
  return createHmac('sha256', derived).update(plaintext).digest('hex').slice(0, 12);
}

/** The plaintext, or a throw that says nothing about why (no oracle for a tampered row). */
export function open(
  sealed: Buffer,
  bound: SealBinding,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = keyFrom(env);
  if (sealed.length < IV_BYTES + TAG_BYTES) {
    throw new SealedBoxUnavailable('A sealed value is malformed.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_BYTES));
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  decipher.setAAD(binding(bound));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new SealedBoxUnavailable(
      'A sealed value could not be opened with this installation’s key.',
    );
  }
}
