import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { MarketingError } from './marketing.errors.js';

/**
 * A brand's Meta token at rest (architecture §21 "System-user tokens per org", §25;
 * invariant 10).
 *
 * The courier credentials' scheme (`courier/credentials.ts`, where the reasoning is
 * written out): AES-256-GCM, `[iv 12][tag 16][ciphertext]`, with the org bound in as
 * associated data so a ciphertext copied into another brand's row does not decrypt. A
 * system-user token can spend a brand's ad budget and read its customers' audiences, so it
 * is never in a readable column, a log line, an error message or a response.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedToken {
  readonly ciphertext: Buffer;
  readonly keyId: string;
  /** 12 hex characters of SHA-256: enough to recognise a token, too little to be one. */
  readonly fingerprint: string;
}

export interface TokenKey {
  readonly key: string | undefined;
  readonly keyId: string;
}

function keyBytes(config: TokenKey): Buffer {
  if (config.key === undefined) {
    throw new MarketingError(
      'MARKETING_CREDENTIALS_MISSING',
      'This installation has no MARKETING_CREDENTIALS_KEY, so a Meta token cannot be stored.',
    );
  }
  return Buffer.from(config.key, 'base64');
}

function associatedData(orgId: string): Buffer {
  return Buffer.from(`${orgId}:meta_connection:token`, 'utf8');
}

export function sealToken(token: string, orgId: string, config: TokenKey): SealedToken {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(config), iv);
  cipher.setAAD(associatedData(orgId));
  const body = Buffer.concat([cipher.update(Buffer.from(token, 'utf8')), cipher.final()]);
  return {
    ciphertext: Buffer.concat([iv, cipher.getAuthTag(), body]),
    keyId: config.keyId,
    fingerprint: createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 12),
  };
}

export function openToken(sealed: Buffer, orgId: string, config: TokenKey): string {
  if (sealed.length < IV_BYTES + TAG_BYTES) {
    throw new MarketingError('MARKETING_CREDENTIALS_MISSING', 'The stored Meta token is malformed.');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyBytes(config),
    sealed.subarray(0, IV_BYTES),
  );
  decipher.setAuthTag(sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  decipher.setAAD(associatedData(orgId));
  try {
    return Buffer.concat([
      decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Node's own message says nothing useful and anything more would be an oracle.
    throw new MarketingError(
      'MARKETING_CREDENTIALS_MISSING',
      'The stored Meta token could not be decrypted with this installation’s key.',
    );
  }
}

/** SHA-256 hex of an already-normalised identifier: what Meta's `user_data` takes. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
