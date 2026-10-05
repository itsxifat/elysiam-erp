import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ownerLinkConfig } from './owner-link.config.js';

/** The owner sign-in link's configuration (M31, D-473): off by default, strict when on. */

const spki = (key: ReturnType<typeof generateKeyPairSync>['publicKey']) =>
  key.export({ format: 'der', type: 'spki' }).toString('base64');

describe('ownerLinkConfig', () => {
  it('is off without a public key, whatever the slug', () => {
    expect(ownerLinkConfig({}).publicKey).toBeUndefined();
    expect(ownerLinkConfig({ ERP_BRAND_SLUG: 'acme', OWNER_LINK_PUBLIC_KEY: '' })).toEqual({
      publicKey: undefined,
      audience: 'acme',
    });
  });

  it('reads an Ed25519 public key in SPKI DER, with the brand as the audience', () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const config = ownerLinkConfig({
      OWNER_LINK_PUBLIC_KEY: spki(publicKey),
      ERP_BRAND_SLUG: 'acme-lifestyle',
    });
    expect(config.publicKey?.asymmetricKeyType).toBe('ed25519');
    expect(config.audience).toBe('acme-lifestyle');
  });

  it('stops the process on a key it cannot use, rather than refusing every owner later', () => {
    const { publicKey: p256 } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    expect(() =>
      ownerLinkConfig({ OWNER_LINK_PUBLIC_KEY: 'not base64!', ERP_BRAND_SLUG: 'acme' }),
    ).toThrow(/base64/);
    expect(() =>
      ownerLinkConfig({ OWNER_LINK_PUBLIC_KEY: 'AAAA', ERP_BRAND_SLUG: 'acme' }),
    ).toThrow(/SPKI/);
    expect(() =>
      ownerLinkConfig({ OWNER_LINK_PUBLIC_KEY: spki(p256), ERP_BRAND_SLUG: 'acme' }),
    ).toThrow(/Ed25519/);
    // A private key never belongs on a brand: PKCS#8 is not SPKI.
    expect(() =>
      ownerLinkConfig({
        OWNER_LINK_PUBLIC_KEY: privateKey
          .export({ format: 'der', type: 'pkcs8' })
          .toString('base64'),
        ERP_BRAND_SLUG: 'acme',
      }),
    ).toThrow();
    expect(() => ownerLinkConfig({ OWNER_LINK_PUBLIC_KEY: spki(publicKey) })).toThrow(
      /ERP_BRAND_SLUG/,
    );
  });
});
