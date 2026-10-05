import { createPublicKey, type KeyObject } from 'node:crypto';

import { BRAND_SLUG_PATTERN } from '@elysium/domain/iam';

/**
 * The owner sign-in link's configuration (M31, D-473). Parsed apart from `serverEnv()`,
 * as the courier and intake configs are, and at boot: a key that cannot be read stops the
 * process rather than refusing every owner later.
 *
 * - `OWNER_LINK_PUBLIC_KEY`: the base64 of an Ed25519 public key in SPKI DER. Unset turns
 *   the feature off, and the route answers 404. Only a public key ever lives on a brand:
 *   it can check a link, never mint one.
 * - `ERP_BRAND_SLUG`: the audience every link must name. Required when the key is set.
 */

export interface OwnerLinkConfig {
  /** Undefined: the feature is off. */
  readonly publicKey: KeyObject | undefined;
  /** The brand a link must name (`aud`). */
  readonly audience: string | undefined;
}

export const OWNER_LINK_CONFIG = Symbol('OWNER_LINK_CONFIG');

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function ownerLinkConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OwnerLinkConfig {
  const raw = (env.OWNER_LINK_PUBLIC_KEY ?? '').trim();
  const slug = (env.ERP_BRAND_SLUG ?? '').trim();
  const audience = slug === '' ? undefined : slug;
  if (raw === '') return { publicKey: undefined, audience };

  if (!BASE64.test(raw)) {
    throw new Error(
      'OWNER_LINK_PUBLIC_KEY must be base64 (an Ed25519 public key in SPKI DER, about 60 characters).',
    );
  }
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki' });
  } catch {
    throw new Error('OWNER_LINK_PUBLIC_KEY is not a public key in SPKI DER.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('OWNER_LINK_PUBLIC_KEY must be an Ed25519 key.');
  }
  if (audience === undefined || !BRAND_SLUG_PATTERN.test(audience)) {
    throw new Error(
      'OWNER_LINK_PUBLIC_KEY needs ERP_BRAND_SLUG: a link names the one brand it opens.',
    );
  }
  return { publicKey, audience };
}
