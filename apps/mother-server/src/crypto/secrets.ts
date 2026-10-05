import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { MotherError } from '../http/errors.js';

/**
 * The mother's secrets at rest (D-481, D-490): every brand's read connection and every
 * brand's owner-link private key. The mother holds the keys to every brand, so these are
 * the most sensitive bytes in the system.
 *
 * AES-256-GCM, as the brand seals its courier credentials: authenticated, so a flipped
 * byte is an error rather than a wrong secret, and bound by associated data to the brand
 * row and the field it belongs to, so a ciphertext copied from one brand's row (or from the
 * connection column into the key column) does not open.
 *
 * Layout: `[ 12-byte iv ][ 16-byte tag ][ ciphertext ]`. The key is `MOTHER_SECRETS_KEY`,
 * base64 of 32 bytes; it is never defaulted, because a key in the repository is a key
 * everybody has.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SecretField = 'read_connection' | 'owner_link_key';

export interface SecretsKey {
  readonly key: Buffer;
  readonly keyId: string;
}

export function secretsKeyFrom(base64: string | undefined, keyId: string): SecretsKey {
  if (base64 === undefined || base64 === '') {
    throw new MotherError(
      'SECRETS_KEY_INVALID',
      'MOTHER_SECRETS_KEY is not set, so brand connections and keys cannot be stored or read.',
      500,
    );
  }
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new MotherError('SECRETS_KEY_INVALID', 'MOTHER_SECRETS_KEY is not 32 bytes.', 500);
  }
  return { key, keyId };
}

function associatedData(brandId: string, field: SecretField): Buffer {
  return Buffer.from(`mother:${brandId}:${field}`, 'utf8');
}

export function seal(
  secrets: SecretsKey,
  plaintext: Buffer,
  bound: { readonly brandId: string; readonly field: SecretField },
): { readonly ciphertext: Buffer; readonly keyId: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', secrets.key, iv);
  cipher.setAAD(associatedData(bound.brandId, bound.field));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]), keyId: secrets.keyId };
}

export function open(
  secrets: SecretsKey,
  ciphertext: Buffer,
  bound: { readonly brandId: string; readonly field: SecretField },
): Buffer {
  if (ciphertext.length <= IV_BYTES + TAG_BYTES) {
    throw new MotherError('SECRETS_KEY_INVALID', 'A stored secret is truncated.', 500);
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', secrets.key, ciphertext.subarray(0, IV_BYTES));
    decipher.setAAD(associatedData(bound.brandId, bound.field));
    decipher.setAuthTag(ciphertext.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(ciphertext.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    // Wrong key, wrong row or a tampered byte: all one answer, with nothing from the blob.
    throw new MotherError(
      'SECRETS_KEY_INVALID',
      'A stored secret could not be opened with MOTHER_SECRETS_KEY.',
      500,
    );
  }
}

/**
 * A short digest to say which secret is set without showing it: 12 hex characters (48
 * bits), enough to compare with what was pasted, too short to be a dictionary target.
 */
export function fingerprint(value: Buffer | string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}
