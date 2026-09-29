import { describe, expect, it } from 'vitest';

import {
  intakeConfig,
  TURNSTILE_SITEVERIFY_URL,
  UnsafeIntakeConfigError,
} from './intake.config.js';
import {
  bodyHash,
  deriveSecret,
  fingerprint,
  isKeyId,
  newKeyId,
  orgIdOf,
  sign,
  signatureMatches,
  timestampFresh,
} from './signature.js';

/**
 * The intake's credential and signature rules (architecture §23), without a server.
 *
 * Each case below is a way a forged or replayed request could be accepted if the rule were
 * written slightly differently — a body re-serialised instead of hashed as bytes, an
 * idempotency key left out of the signed string, a window checked on one side only.
 */

const ORG = '0b4c2a6e-2f7e-4f8e-9d7c-3a1b2c3d4e5f';
const MASTER = 'a-master-key-for-tests-that-is-long-enough';
const BODY = Buffer.from('{"customer":{"name":"Rahima","phone":"01711223344"}}', 'utf8');

describe('key ids', () => {
  it('carry their org and nothing else anyone could guess', () => {
    const first = newKeyId(ORG);
    const second = newKeyId(ORG);
    expect(isKeyId(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(orgIdOf(first)).toBe(ORG);
    expect(first).toMatch(/^pk_[0-9a-f]{32}_[a-z2-7]{20}$/);
  });

  it('reads no org out of anything that is not a key id', () => {
    for (const value of [
      '',
      'pk_',
      `pk_${'0'.repeat(32)}`,
      `sk_${'0'.repeat(32)}_abcdefghijklmnopqrst`,
      `pk_${'g'.repeat(32)}_abcdefghijklmnopqrst`,
    ]) {
      expect(orgIdOf(value)).toBeNull();
    }
  });
});

describe('the derived secret', () => {
  it('is a function of the master key and the key id, so nothing stored can produce it', () => {
    const keyId = newKeyId(ORG);
    expect(deriveSecret(MASTER, keyId)).toBe(deriveSecret(MASTER, keyId));
    expect(deriveSecret(MASTER, keyId)).not.toBe(deriveSecret(`${MASTER}!`, keyId));
    expect(deriveSecret(MASTER, keyId)).not.toBe(deriveSecret(MASTER, newKeyId(ORG)));
    // The fingerprint is what the table holds; it is not the secret.
    expect(fingerprint(deriveSecret(MASTER, keyId))).not.toContain(deriveSecret(MASTER, keyId));
  });
});

describe('signatures', () => {
  const keyId = newKeyId(ORG);
  const secret = deriveSecret(MASTER, keyId);
  const timestamp = '1790000000';
  const key = 'order-7f3c-0001';

  it('accept exactly the bytes that were signed', () => {
    const header = sign(secret, timestamp, key, BODY);
    expect(
      signatureMatches({ secret, header, timestamp, idempotencyKey: key, rawBody: BODY }),
    ).toBe(true);
  });

  it('refuse a body that parses to the same object but is not the same bytes', () => {
    const header = sign(secret, timestamp, key, BODY);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(BODY.toString()), null, 2));
    expect(
      signatureMatches({ secret, header, timestamp, idempotencyKey: key, rawBody: reformatted }),
    ).toBe(false);
  });

  it('bind the idempotency key, so a captured request cannot be replayed as a new order', () => {
    const header = sign(secret, timestamp, key, BODY);
    expect(
      signatureMatches({ secret, header, timestamp, idempotencyKey: `${key}-2`, rawBody: BODY }),
    ).toBe(false);
  });

  it('bind the timestamp and the secret', () => {
    const header = sign(secret, timestamp, key, BODY);
    expect(
      signatureMatches({
        secret,
        header,
        timestamp: '1790000001',
        idempotencyKey: key,
        rawBody: BODY,
      }),
    ).toBe(false);
    expect(
      signatureMatches({
        secret: deriveSecret(MASTER, newKeyId(ORG)),
        header,
        timestamp,
        idempotencyKey: key,
        rawBody: BODY,
      }),
    ).toBe(false);
  });

  it('refuse a header in any other shape, without throwing', () => {
    for (const header of ['', 'sha256=', 'sha256=zz', `sha1=${'a'.repeat(64)}`, 'a'.repeat(64)]) {
      expect(
        signatureMatches({ secret, header, timestamp, idempotencyKey: key, rawBody: BODY }),
      ).toBe(false);
    }
  });

  it('hash the body as bytes for the idempotency record', () => {
    expect(bodyHash(BODY)).toMatch(/^[0-9a-f]{64}$/);
    expect(bodyHash(BODY)).not.toBe(bodyHash(Buffer.concat([BODY, Buffer.from(' ')])));
  });
});

describe('the timestamp window (§23: five minutes)', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const seconds = Math.floor(now.getTime() / 1000);

  it('holds on both sides of now', () => {
    expect(timestampFresh(String(seconds - 300), now, 300)).toBe(true);
    expect(timestampFresh(String(seconds + 300), now, 300)).toBe(true);
    expect(timestampFresh(String(seconds - 301), now, 300)).toBe(false);
    expect(timestampFresh(String(seconds + 301), now, 300)).toBe(false);
  });

  it('accepts one spelling of a moment only', () => {
    for (const value of [
      '',
      '1.79e9',
      '0x6aa3',
      `${String(seconds)}.0`,
      ` ${String(seconds)}`,
      String(seconds * 1000),
    ]) {
      expect(timestampFresh(value, now, 300)).toBe(false);
    }
  });
});

describe('configuration production refuses to start with', () => {
  const base = { NODE_ENV: 'production', INTAKE_KEY_SECRET: MASTER };

  it('refuses a Turnstile bypass in production, and allows it anywhere else', () => {
    expect(() => intakeConfig({ ...base, INTAKE_TURNSTILE_BYPASS: 'true' })).toThrow(
      UnsafeIntakeConfigError,
    );
    expect(() => intakeConfig({ ...base, INTAKE_TURNSTILE_BYPASS: '1' })).toThrow(
      UnsafeIntakeConfigError,
    );
    expect(
      intakeConfig({ NODE_ENV: 'test', INTAKE_TURNSTILE_BYPASS: 'true' }).INTAKE_TURNSTILE_BYPASS,
    ).toBe(true);
  });

  it('refuses a siteverify URL that is not Cloudflare’s in production', () => {
    expect(() =>
      intakeConfig({ ...base, INTAKE_TURNSTILE_VERIFY_URL: 'http://127.0.0.1:9/siteverify' }),
    ).toThrow(UnsafeIntakeConfigError);
    expect(intakeConfig(base).INTAKE_TURNSTILE_VERIFY_URL).toBe(TURNSTILE_SITEVERIFY_URL);
  });

  it('refuses per-process rate limits in production', () => {
    expect(() => intakeConfig({ ...base, INTAKE_RATE_LIMIT_STORE: 'memory' })).toThrow(
      UnsafeIntakeConfigError,
    );
  });

  it('boots with the intake switched off when its secrets are simply missing', () => {
    const config = intakeConfig({ NODE_ENV: 'production' });
    expect(config.INTAKE_KEY_SECRET).toBeUndefined();
    expect(config.TURNSTILE_SECRET_KEY).toBeUndefined();
  });

  it('refuses a master key short enough to brute-force', () => {
    expect(() => intakeConfig({ INTAKE_KEY_SECRET: 'short' })).toThrow(/at least 32/);
  });
});
