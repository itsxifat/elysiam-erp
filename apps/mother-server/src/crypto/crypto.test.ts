import { createPublicKey, randomBytes, verify } from 'node:crypto';

import {
  checkOwnerLinkClaims,
  OWNER_LINK_MAX_LIFETIME_SECONDS,
  parseOwnerLink,
} from '@elysium/domain/iam';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  generateOwnerLinkKeyPair,
  mintOwnerLink,
  ownerLinkUrl,
  publicKeyFingerprintOf,
} from './owner-link.js';
import { fingerprint, open, seal, secretsKeyFrom } from './secrets.js';

/**
 * The brand's side of the check, as M31 does it: parse, verify the Ed25519 signature over
 * the payload text with the public key from `OWNER_LINK_PUBLIC_KEY` (base64 SPKI DER), then
 * the claim rules. Written here from the shared format only, so a link this file mints and
 * this function accepts is a link any conforming brand accepts.
 */
function brandAccepts(
  token: string,
  publicKeyBase64: string,
  audience: string,
  nowSeconds: number,
): string | undefined {
  const parsed = parseOwnerLink(token);
  if (!parsed.ok) return parsed.reason;
  const publicKey = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const good = verify(null, Buffer.from(parsed.signedText, 'utf8'), publicKey, parsed.signature);
  if (!good) return 'bad_signature';
  return checkOwnerLinkClaims(parsed.claims, { audience, nowSeconds });
}

describe('the owner sign-in link (D-473, D-490)', () => {
  const keys = generateOwnerLinkKeyPair();
  const now = 1_790_000_000;

  it('mints a link the brand verifies with its public key', () => {
    const { token, claims } = mintOwnerLink({
      privateKeyDer: keys.privateKeyDer,
      audience: 'oura-lifestyle',
      email: '  Owner@Example.COM ',
      name: 'The Owner',
      nowSeconds: now,
    });
    expect(brandAccepts(token, keys.publicKeyBase64, 'oura-lifestyle', now + 5)).toBeUndefined();
    expect(claims.sub).toBe('owner@example.com');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(OWNER_LINK_MAX_LIFETIME_SECONDS);
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is refused by another brand, after expiry, under another key, or tampered', () => {
    const { token } = mintOwnerLink({
      privateKeyDer: keys.privateKeyDer,
      audience: 'oura-lifestyle',
      email: 'owner@example.com',
      name: 'The Owner',
      nowSeconds: now,
    });
    expect(brandAccepts(token, keys.publicKeyBase64, 'orvo', now)).toBe('wrong_audience');
    expect(brandAccepts(token, keys.publicKeyBase64, 'oura-lifestyle', now + 61)).toBe('expired');
    const other = generateOwnerLinkKeyPair();
    expect(brandAccepts(token, other.publicKeyBase64, 'oura-lifestyle', now)).toBe('bad_signature');
    const [payload, signature] = token.split('.') as [string, string];
    const flipped = `${payload.slice(0, -2)}${payload.endsWith('A') ? 'B' : 'A'}${payload.slice(-1)}`;
    expect(
      brandAccepts(`${flipped}.${signature}`, keys.publicKeyBase64, 'oura-lifestyle', now),
    ).not.toBeUndefined();
  });

  it('gives every link its own id', () => {
    const ids = new Set(
      Array.from(
        { length: 50 },
        () =>
          mintOwnerLink({
            privateKeyDer: keys.privateKeyDer,
            audience: 'orvo',
            email: 'owner@example.com',
            name: 'Owner',
            nowSeconds: now,
          }).claims.jti,
      ),
    );
    expect(ids.size).toBe(50);
  });

  it('refuses a lifetime past the brand ceiling', () => {
    expect(() =>
      mintOwnerLink({
        privateKeyDer: keys.privateKeyDer,
        audience: 'orvo',
        email: 'owner@example.com',
        name: 'Owner',
        nowSeconds: now,
        lifetimeSeconds: OWNER_LINK_MAX_LIFETIME_SECONDS + 1,
      }),
    ).toThrow(RangeError);
  });

  it('puts the token in the fragment, never the query', () => {
    const url = ownerLinkUrl('https://admin.oura.example/', 'abc.def');
    expect(url).toBe('https://admin.oura.example/owner-link#token=abc.def');
    expect(new URL(url).search).toBe('');
  });

  it('keeps a fingerprint that matches the stored private key', () => {
    expect(publicKeyFingerprintOf(keys.privateKeyDer)).toBe(keys.fingerprint);
  });
});

describe('secrets at rest (D-481)', () => {
  const secrets = secretsKeyFrom(randomBytes(32).toString('base64'), 'k1');
  const brandId = '0f8c3d55-6d0b-4f4e-9c1a-1a1a1a1a1a1a';

  it('opens what it sealed, for that brand and field only', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 300 }), (bytes) => {
        const plaintext = Buffer.from(bytes);
        const sealed = seal(secrets, plaintext, { brandId, field: 'read_connection' });
        expect(open(secrets, sealed.ciphertext, { brandId, field: 'read_connection' })).toEqual(
          plaintext,
        );
        expect(() =>
          open(secrets, sealed.ciphertext, { brandId, field: 'owner_link_key' }),
        ).toThrow();
        expect(() =>
          open(secrets, sealed.ciphertext, {
            brandId: '11111111-2222-4333-8444-555555555555',
            field: 'read_connection',
          }),
        ).toThrow();
      }),
      { numRuns: 50 },
    );
  });

  it('refuses a tampered byte and a different key', () => {
    const sealed = seal(secrets, Buffer.from('postgres://erp_analytics:x@h/db'), {
      brandId,
      field: 'read_connection',
    });
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(() => open(secrets, tampered, { brandId, field: 'read_connection' })).toThrow();
    const other = secretsKeyFrom(randomBytes(32).toString('base64'), 'k2');
    expect(() => open(other, sealed.ciphertext, { brandId, field: 'read_connection' })).toThrow();
  });

  it('never runs without a real key', () => {
    expect(() => secretsKeyFrom(undefined, 'k1')).toThrow(/MOTHER_SECRETS_KEY/);
    expect(() => secretsKeyFrom(Buffer.alloc(16).toString('base64'), 'k1')).toThrow(/32 bytes/);
  });

  it('fingerprints without revealing', () => {
    expect(fingerprint('postgres://erp_analytics:secret@h/db')).toMatch(/^[0-9a-f]{12}$/);
  });
});
