import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deriveSecret as deriveIntakeSecret } from '../intake/signature.js';
import {
  deriveStorefrontSecret,
  etagOf,
  newKeyId,
  orgIdOf,
  signStorefront,
  storefrontSignatureMatches,
  storefrontSigningBase,
} from './signature.js';

const ORG = '0b3f1d2e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const MASTER = 'a-master-key-that-is-at-least-32-characters';

describe('the storefront signature', () => {
  const keyId = newKeyId(ORG);
  const secret = deriveStorefrontSecret(MASTER, keyId);
  const request = {
    timestamp: '1780000000',
    method: 'GET',
    pathAndQuery: '/storefront/v1/catalog/products?category=men&sort=newest',
  };

  it('carries its brand in the key id, like the intake’s', () => {
    expect(orgIdOf(keyId)).toBe(ORG);
  });

  it('derives a different secret from the intake’s for the same key id and master key', () => {
    expect(secret).not.toBe(deriveIntakeSecret(MASTER, keyId));
    expect(secret).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
  });

  it('signs the timestamp, the method and the exact target of a read', () => {
    expect(storefrontSigningBase(request).toString('utf8')).toBe(
      '1780000000.GET./storefront/v1/catalog/products?category=men&sort=newest',
    );
    const header = signStorefront(secret, request);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(storefrontSignatureMatches(secret, header, request)).toBe(true);
  });

  it('signs the idempotency key and the raw body of a write after them', () => {
    const base = storefrontSigningBase({
      ...request,
      method: 'post',
      idempotencyKey: 'order-123',
      rawBody: Buffer.from('{"a":1}'),
    });
    expect(base.toString('utf8')).toBe(
      '1780000000.POST./storefront/v1/catalog/products?category=men&sort=newest.order-123.{"a":1}',
    );
  });

  it('fails on any change to what was signed, and on any other secret', () => {
    fc.assert(
      fc.property(
        fc.record({
          timestamp: fc.integer({ min: 1_000_000_000, max: 9_999_999_999 }).map(String),
          path: fc.webPath(),
          query: fc.webQueryParameters(),
        }),
        fc.string({ minLength: 1, maxLength: 4 }),
        ({ timestamp, path, query }, extra) => {
          const signedRequest = {
            timestamp,
            method: 'GET',
            pathAndQuery: `/storefront/v1${path}?${query}`,
          };
          const header = signStorefront(secret, signedRequest);
          expect(storefrontSignatureMatches(secret, header, signedRequest)).toBe(true);
          expect(
            storefrontSignatureMatches(secret, header, {
              ...signedRequest,
              pathAndQuery: `${signedRequest.pathAndQuery}${extra}`,
            }),
          ).toBe(false);
          expect(
            storefrontSignatureMatches(secret, header, {
              ...signedRequest,
              timestamp: String(Number(timestamp) + 1),
            }),
          ).toBe(false);
          expect(storefrontSignatureMatches(`${secret}x`, header, signedRequest)).toBe(false);
        },
      ),
    );
  });

  it('refuses a malformed header without throwing', () => {
    for (const header of ['', 'sha256=', 'sha256=zz', 'md5=abc', `sha256=${'0'.repeat(63)}`]) {
      expect(storefrontSignatureMatches(secret, header, request)).toBe(false);
    }
  });

  it('gives equal bodies equal ETags and different bodies different ones', () => {
    expect(etagOf('{"a":1}')).toBe(etagOf('{"a":1}'));
    expect(etagOf('{"a":1}')).not.toBe(etagOf('{"a":2}'));
    expect(etagOf('x')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });
});
