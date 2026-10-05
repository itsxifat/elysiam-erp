import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assembleOwnerLink,
  checkOwnerLinkClaims,
  encodeOwnerLinkPayload,
  fromBase64Url,
  OWNER_LINK_CLOCK_SKEW_SECONDS,
  OWNER_LINK_MAX_LIFETIME_SECONDS,
  type OwnerLinkClaims,
  parseOwnerLink,
  toBase64Url,
} from './index.js';

/**
 * The owner link's format and rules (D-473). The signature is checked by the server with
 * `node:crypto`; these tests fix what is signed and what is refused around it.
 */

const SIGNATURE = new Uint8Array(64).fill(7);

const claims = (overrides: Partial<OwnerLinkClaims> = {}): OwnerLinkClaims => ({
  v: 1,
  aud: 'oura-lifestyle',
  sub: 'owner@example.com',
  name: 'The Owner',
  jti: '6f1c2b3a-1d2e-4f5a-8b9c-0d1e2f3a4b5c',
  iat: 1_790_000_000,
  exp: 1_790_000_060,
  ...overrides,
});

const token = (c: OwnerLinkClaims) => assembleOwnerLink(encodeOwnerLinkPayload(c), SIGNATURE);

describe('base64url', () => {
  it('round-trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const back = fromBase64Url(toBase64Url(bytes) || 'AA');
        if (bytes.length === 0) return;
        expect(back).toEqual(bytes);
      }),
    );
  });

  it('refuses characters outside the alphabet', () => {
    expect(fromBase64Url('ab+c')).toBeUndefined();
    expect(fromBase64Url('ab/c')).toBeUndefined();
    expect(fromBase64Url('abc=')).toBeUndefined();
  });
});

describe('parseOwnerLink', () => {
  it('reads back exactly the claims that were encoded, and the text that was signed', () => {
    const c = claims();
    const parsed = parseOwnerLink(token(c));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.claims).toEqual(c);
    expect(parsed.signedText).toBe(encodeOwnerLinkPayload(c));
    expect(parsed.signature).toEqual(SIGNATURE);
  });

  it('encodes the same claims to the same text whatever order they were built in', () => {
    const c = claims();
    const reordered = {
      exp: c.exp,
      iat: c.iat,
      jti: c.jti,
      name: c.name,
      sub: c.sub,
      aud: c.aud,
      v: c.v,
    } as OwnerLinkClaims;
    expect(encodeOwnerLinkPayload(reordered)).toBe(encodeOwnerLinkPayload(c));
  });

  it('refuses a token that is not two base64url parts with a 64-byte signature', () => {
    const good = token(claims());
    const [payload] = good.split('.') as [string];
    for (const bad of [
      '',
      payload,
      `${good}.extra`,
      `${payload}.${toBase64Url(new Uint8Array(63))}`,
      `${payload}!.${toBase64Url(SIGNATURE)}`,
      `${toBase64Url('not json')}.${toBase64Url(SIGNATURE)}`,
      `${toBase64Url('[1]')}.${toBase64Url(SIGNATURE)}`,
      'x'.repeat(3000),
    ]) {
      expect(parseOwnerLink(bad)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses another version', () => {
    const payload = toBase64Url(JSON.stringify({ ...claims(), v: 2 }));
    expect(parseOwnerLink(`${payload}.${toBase64Url(SIGNATURE)}`)).toEqual({
      ok: false,
      reason: 'bad_version',
    });
  });

  it('refuses claims of the wrong shape', () => {
    for (const bad of [
      { aud: 'Oura Lifestyle' },
      { sub: 'Owner@Example.com' },
      { sub: 'not-an-email' },
      { name: '   ' },
      { jti: 'not-a-uuid' },
      { iat: 1.5 },
      { exp: -1 },
    ]) {
      const payload = toBase64Url(JSON.stringify({ ...claims(), ...bad }));
      expect(parseOwnerLink(`${payload}.${toBase64Url(SIGNATURE)}`)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

describe('checkOwnerLinkClaims', () => {
  const at = (now: number, c = claims()) =>
    checkOwnerLinkClaims(c, { audience: 'oura-lifestyle', nowSeconds: now });

  it('accepts a link inside its lifetime, for its own brand', () => {
    expect(at(1_790_000_000)).toBeUndefined();
    expect(at(1_790_000_059)).toBeUndefined();
  });

  it('refuses another brand', () => {
    expect(checkOwnerLinkClaims(claims(), { audience: 'orvo', nowSeconds: 1_790_000_010 })).toBe(
      'wrong_audience',
    );
  });

  it('refuses from the second it expires', () => {
    expect(at(1_790_000_060)).toBe('expired');
  });

  it('never accepts a link whose lifetime is longer than the limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: OWNER_LINK_MAX_LIFETIME_SECONDS + 1, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (lifetime, offset) => {
          const c = claims({ iat: 1_790_000_000, exp: 1_790_000_000 + lifetime });
          expect(at(1_790_000_000 + (offset % lifetime), c)).toBeDefined();
        },
      ),
    );
  });

  it('accepts only inside [iat − skew, exp)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: OWNER_LINK_MAX_LIFETIME_SECONDS }),
        fc.integer({ min: -1000, max: 1000 }),
        (lifetime, offset) => {
          const c = claims({ iat: 1_790_000_000, exp: 1_790_000_000 + lifetime });
          const now = 1_790_000_000 + offset;
          const accepted = at(now, c) === undefined;
          const inside = now >= c.iat - OWNER_LINK_CLOCK_SKEW_SECONDS && now < c.exp;
          expect(accepted).toBe(inside);
        },
      ),
    );
  });

  it('refuses a link that ends before it starts', () => {
    expect(at(1_790_000_000, claims({ exp: 1_790_000_000 }))).toBe('malformed');
  });
});
