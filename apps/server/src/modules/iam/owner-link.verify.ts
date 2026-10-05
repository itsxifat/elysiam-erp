import { verify, type KeyObject } from 'node:crypto';

import {
  checkOwnerLinkClaims,
  parseOwnerLink,
  type OwnerLinkClaims,
  type OwnerLinkRefusal,
} from '@elysium/domain/iam';

/**
 * An owner sign-in link's token, checked without the database (M31, D-473): the format, the
 * Ed25519 signature over the payload's base64url text, then the audience and time rules.
 * Single use is the route's, because it needs the database.
 *
 * The signature is checked before any claim is believed: an unsigned payload's audience or
 * expiry says nothing.
 */
export type OwnerLinkVerdict =
  | { readonly ok: true; readonly claims: OwnerLinkClaims }
  | { readonly ok: false; readonly reason: OwnerLinkRefusal };

export function verifyOwnerLink(
  token: string,
  options: {
    readonly publicKey: KeyObject;
    readonly audience: string;
    readonly nowSeconds: number;
  },
): OwnerLinkVerdict {
  const parsed = parseOwnerLink(token);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (!signatureHolds(parsed.signedText, parsed.signature, options.publicKey)) {
    return { ok: false, reason: 'bad_signature' };
  }
  const refusal = checkOwnerLinkClaims(parsed.claims, {
    audience: options.audience,
    nowSeconds: options.nowSeconds,
  });
  return refusal === undefined
    ? { ok: true, claims: parsed.claims }
    : { ok: false, reason: refusal };
}

/** Ed25519 over the payload's text; a key or signature node:crypto cannot read is a no. */
function signatureHolds(signedText: string, signature: Uint8Array, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(signedText, 'utf8'), publicKey, Buffer.from(signature));
  } catch {
    return false;
  }
}
