import type { InboxChannelKind } from '@elysium/domain/inbox';

import { open, seal, type SealBinding } from '../../platform/crypto/sealed-box.js';
import type { SealedValue } from './inbox.repository.js';

/**
 * The brand's Meta secrets at rest (M42, D-733): the platform's sealed box (AES-256-GCM under
 * `STOREFRONT_CREDENTIALS_KEY`, as the website's, ncom's and the cameras' secrets are), each
 * bound to the brand, its row and its field, so a ciphertext copied into another brand's row or
 * another column does not open. A channel's row is named by its kind, which is unique per brand,
 * so the binding is known before the row exists.
 */

export function appSecretBinding(orgId: string): SealBinding {
  return { orgId, row: 'inbox_settings', field: 'app_secret' };
}

export function verifyTokenBinding(orgId: string): SealBinding {
  return { orgId, row: 'inbox_settings', field: 'verify_token' };
}

export function channelTokenBinding(orgId: string, kind: InboxChannelKind): SealBinding {
  return { orgId, row: `inbox_channels:${kind}`, field: 'access_token' };
}

export function sealSecret(plaintext: string, binding: SealBinding): SealedValue {
  const sealed = seal(plaintext, binding);
  return { ciphertext: sealed.ciphertext, keyId: sealed.keyId, fingerprint: sealed.fingerprint };
}

/**
 * The plaintext, or null when it is not stored or cannot be opened (no key, another key, a
 * tampered row): every caller treats that as "not set", and the public webhook answers it with
 * its one refusal rather than a 500 (M42 ledger audit).
 */
export function openSecret(sealed: Buffer | null, binding: SealBinding): string | null {
  if (sealed === null) return null;
  try {
    return open(sealed, binding);
  } catch {
    return null;
  }
}
