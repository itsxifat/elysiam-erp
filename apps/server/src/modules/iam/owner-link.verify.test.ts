import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

import {
  assembleOwnerLink,
  encodeOwnerLinkPayload,
  OWNER_LINK_MAX_LIFETIME_SECONDS,
  type OwnerLinkClaims,
} from '@elysium/domain/iam';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { verifyOwnerLink } from './owner-link.verify.js';

/**
 * The owner link's checks without the database (M31 check 4, D-473), as properties: a link
 * the key signed for this brand, inside its window, passes; changing any one character of
 * it, signing it with any other key, naming any other brand or presenting it outside its
 * window does not.
 */

const NOW = 1_790_000_000;
const AUDIENCE = 'acme-lifestyle';
const keys = generateKeyPairSync('ed25519');

const claimsArb: fc.Arbitrary<OwnerLinkClaims> = fc
  .record({
    v: fc.constant(1 as const),
    aud: fc.constant(AUDIENCE),
    sub: fc.stringMatching(/^[a-z0-9.]{1,20}@[a-z0-9]{1,10}\.[a-z]{2,4}$/),
    name: fc.string({ minLength: 1, maxLength: 60 }).filter((name) => name.trim() !== ''),
    jti: fc.uuid({ version: 4 }),
    iat: fc.integer({ min: NOW - 60, max: NOW }),
    exp: fc.constant(0),
  })
  .map((c) => ({ ...c, exp: c.iat + 90 }));

function mint(c: OwnerLinkClaims, key = keys.privateKey): string {
  const payload = encodeOwnerLinkPayload(c);
  return assembleOwnerLink(payload, sign(null, Buffer.from(payload, 'utf8'), key));
}

const options = { publicKey: keys.publicKey, audience: AUDIENCE, nowSeconds: NOW };

describe('verifyOwnerLink', () => {
  it('accepts a link the key signed for this brand, inside its window', () => {
    fc.assert(
      fc.property(claimsArb, (c) => {
        expect(verifyOwnerLink(mint(c), options)).toEqual({ ok: true, claims: c });
      }),
    );
  });

  it('refuses the link with any one character changed (but the padding bits)', () => {
    fc.assert(
      fc.property(
        claimsArb,
        fc.nat(),
        fc.constantFrom('A', 'B', '-', '_', 'z', '0'),
        (c, at, ch) => {
          const token = mint(c);
          // Not the last character: it carries two bits of the signature and four of padding,
          // which base64 decoding drops, so some changes there name the same bytes. That is no
          // second link — the `jti` is the same and spent once — so it is not asked of here.
          const index = at % (token.length - 1);
          if (token[index] === ch || token[index] === '.') return;
          const changed = `${token.slice(0, index)}${ch}${token.slice(index + 1)}`;
          expect(verifyOwnerLink(changed, options).ok).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses any other key, any other brand, and any time outside the window', () => {
    fc.assert(
      fc.property(claimsArb, fc.integer({ min: 1, max: 100_000 }), (c, drift) => {
        const other = generateKeyPairSync('ed25519').privateKey;
        expect(verifyOwnerLink(mint(c, other), options)).toEqual({
          ok: false,
          reason: 'bad_signature',
        });
        expect(verifyOwnerLink(mint({ ...c, aud: 'other-brand' }), options)).toEqual({
          ok: false,
          reason: 'wrong_audience',
        });
        expect(verifyOwnerLink(mint(c), { ...options, nowSeconds: c.exp + drift - 1 }).ok).toBe(
          false,
        );
      }),
      { numRuns: 30 },
    );
  });

  it('refuses a link living longer than two minutes, however well signed', () => {
    const c: OwnerLinkClaims = {
      v: 1,
      aud: AUDIENCE,
      sub: 'owner@example.com',
      name: 'Owner',
      jti: randomUUID(),
      iat: NOW,
      exp: NOW + OWNER_LINK_MAX_LIFETIME_SECONDS + 1,
    };
    expect(verifyOwnerLink(mint(c), options)).toEqual({ ok: false, reason: 'lifetime_too_long' });
  });

  it('never believes an unsigned payload, even one naming this brand', () => {
    const payload = encodeOwnerLinkPayload({
      v: 1,
      aud: AUDIENCE,
      sub: 'owner@example.com',
      name: 'Owner',
      jti: randomUUID(),
      iat: NOW,
      exp: NOW + 60,
    });
    expect(verifyOwnerLink(assembleOwnerLink(payload, new Uint8Array(64)), options)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
