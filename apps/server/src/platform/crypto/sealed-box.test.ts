import { describe, expect, it } from 'vitest';

import { open, seal, SealedBoxUnavailable, sealedBoxConfigured } from './sealed-box.js';

const env = { STOREFRONT_CREDENTIALS_KEY: Buffer.alloc(32, 3).toString('base64') };
const bound = { orgId: 'org-a', row: 'storefront.gateway_settings', field: 'store_password' };

describe('the website’s sealed secrets (D-528)', () => {
  it('opens what it sealed, and nothing else', () => {
    const sealed = seal('store-secret', bound, env);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('store-secret');
    expect(sealed.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(open(sealed.ciphertext, bound, env)).toBe('store-secret');
  });

  it('refuses a value moved to another brand, row or field, or tampered with', () => {
    const sealed = seal('store-secret', bound, env);
    expect(() => open(sealed.ciphertext, { ...bound, orgId: 'org-b' }, env)).toThrow(
      SealedBoxUnavailable,
    );
    expect(() => open(sealed.ciphertext, { ...bound, field: 'other' }, env)).toThrow(
      SealedBoxUnavailable,
    );
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => open(flipped, bound, env)).toThrow(SealedBoxUnavailable);
    const otherKey = { STOREFRONT_CREDENTIALS_KEY: Buffer.alloc(32, 4).toString('base64') };
    expect(() => open(sealed.ciphertext, bound, otherKey)).toThrow(SealedBoxUnavailable);
  });

  it('seals nothing without a key, rather than store a secret in the clear', () => {
    expect(sealedBoxConfigured({})).toBe(false);
    expect(() => seal('x', bound, {})).toThrow(SealedBoxUnavailable);
    expect(() => seal('x', bound, { STOREFRONT_CREDENTIALS_KEY: 'short' })).toThrow(
      SealedBoxUnavailable,
    );
  });
});
