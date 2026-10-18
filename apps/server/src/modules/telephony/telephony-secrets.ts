import { open, seal, type SealBinding } from '../../platform/crypto/sealed-box.js';

/**
 * A connection's API key and webhook secret at rest (M47, D-830): the platform's sealed box
 * (AES-256-GCM under `STOREFRONT_CREDENTIALS_KEY`, as M42's Meta secrets), each bound to the
 * brand, the connection and the field, so a ciphertext copied into another brand's row, another
 * connection or the other column does not open. The service picks the connection's id before
 * the row exists, so the binding is known when the secret is sealed.
 */

export type ConnectionSecretField = 'api_key' | 'webhook_secret';

export function connectionBinding(
  orgId: string,
  connectionId: string,
  field: ConnectionSecretField,
): SealBinding {
  return { orgId, row: `telephony_connections:${connectionId}`, field };
}

export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly keyId: string;
  readonly fingerprint: string;
}

export function sealSecret(plaintext: string, binding: SealBinding): SealedSecret {
  const sealed = seal(plaintext, binding);
  return { ciphertext: sealed.ciphertext, keyId: sealed.keyId, fingerprint: sealed.fingerprint };
}

/**
 * The plaintext, or null when it is not stored or cannot be opened (no key, another key, a
 * tampered row): every caller treats that as "not set", and the public webhook answers it with
 * its one refusal rather than a 500.
 */
export function openSecret(sealed: Buffer | null, binding: SealBinding): string | null {
  if (sealed === null) return null;
  try {
    return open(sealed, binding);
  } catch {
    return null;
  }
}
