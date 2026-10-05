import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
} from 'node:crypto';

import {
  assembleOwnerLink,
  encodeOwnerLinkPayload,
  OWNER_LINK_MAX_LIFETIME_SECONDS,
  OWNER_LINK_VERSION,
  type OwnerLinkClaims,
} from '@elysium/domain/iam';

import { fingerprint } from './secrets.js';

/**
 * Minting the owner sign-in link (D-473's format; D-490).
 *
 * Each brand has its own Ed25519 key pair. The mother keeps the private key, sealed; the
 * brand keeps only the public key, in `OWNER_LINK_PUBLIC_KEY`, so a brand can check a link
 * and can never make one. The format and the claim rules are the shared ones in
 * `@elysium/domain/iam` — this file only fills them in and signs: Ed25519 over the
 * payload's base64url text, exactly the bytes before the dot.
 */

/** Well inside the brand's 120-second ceiling: a redirect needs seconds, not minutes. */
export const OWNER_LINK_LIFETIME_SECONDS = 60;

export interface OwnerLinkKeyPair {
  /** PKCS#8 DER: what is sealed and stored. */
  readonly privateKeyDer: Buffer;
  /** SPKI DER as base64: what the brand's `OWNER_LINK_PUBLIC_KEY` holds. */
  readonly publicKeyBase64: string;
  /** 16 hex characters of the public key's digest, kept to match against the brand. */
  readonly fingerprint: string;
}

export function generateOwnerLinkKeyPair(): OwnerLinkKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKeyDer: privateKey.export({ format: 'der', type: 'pkcs8' }),
    publicKeyBase64: spki.toString('base64'),
    fingerprint: fingerprint(spki, 16),
  };
}

/** The public half of a stored private key, for a check that the two still match. */
export function publicKeyFingerprintOf(privateKeyDer: Buffer): string {
  const publicKey = createPublicKey(
    createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }),
  );
  return fingerprint(publicKey.export({ format: 'der', type: 'spki' }), 16);
}

export interface MintInput {
  readonly privateKeyDer: Buffer;
  /** The brand's slug: the link's audience. */
  readonly audience: string;
  readonly email: string;
  readonly name: string;
  readonly nowSeconds: number;
  readonly lifetimeSeconds?: number;
  readonly jti?: string;
}

export interface MintedOwnerLink {
  readonly token: string;
  readonly claims: OwnerLinkClaims;
}

export function mintOwnerLink(input: MintInput): MintedOwnerLink {
  const lifetime = input.lifetimeSeconds ?? OWNER_LINK_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > OWNER_LINK_MAX_LIFETIME_SECONDS) {
    throw new RangeError(
      `An owner link lives 1-${String(OWNER_LINK_MAX_LIFETIME_SECONDS)} seconds.`,
    );
  }
  const claims: OwnerLinkClaims = {
    v: OWNER_LINK_VERSION,
    aud: input.audience,
    sub: input.email.trim().toLowerCase(),
    // The brand refuses an empty or over-long name; keep within its rule.
    name: input.name.trim().slice(0, 200),
    jti: input.jti ?? randomUUID(),
    iat: input.nowSeconds,
    exp: input.nowSeconds + lifetime,
  };
  const payloadText = encodeOwnerLinkPayload(claims);
  const key = createPrivateKey({ key: input.privateKeyDer, format: 'der', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(payloadText, 'utf8'), key);
  return { token: assembleOwnerLink(payloadText, new Uint8Array(signature)), claims };
}

/**
 * Where the browser goes: the brand console's `/owner-link` page with the token in the
 * fragment, which a browser never sends to any server and nginx never logs (D-490).
 */
export function ownerLinkUrl(adminUrl: string, token: string): string {
  return `${adminUrl.replace(/\/+$/, '')}/owner-link#token=${token}`;
}
