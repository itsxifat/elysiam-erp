import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { credentialRateLimitsEnabled } from '../http/rate-limit.js';
import { parseServerEnv } from './env.js';

/**
 * `CREDENTIAL_RATE_LIMITS`, the console's real-stack run's switch for the credential
 * limits: on unless told otherwise, and impossible to turn off in production.
 */

const BASE = {
  DATABASE_URL: 'postgres://erp_app:x@127.0.0.1:5432/unused',
  APP_DOMAIN: 'localhost',
  API_PUBLIC_URL: 'http://localhost:3000',
  AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  TRUSTED_ORIGINS: 'http://localhost:5173',
};

const REPO = path.resolve(import.meta.dirname, '../../../../..');

describe('the credential rate limits switch', () => {
  it('leaves the limits on when nothing sets it, or when compose writes it empty', () => {
    for (const source of [
      BASE,
      { ...BASE, CREDENTIAL_RATE_LIMITS: '' },
      { ...BASE, NODE_ENV: 'production' },
    ]) {
      const env = parseServerEnv(source);
      expect(env.CREDENTIAL_RATE_LIMITS).toBe('on');
      expect(credentialRateLimitsEnabled(env)).toBe(true);
    }
  });

  it('refuses to boot a production process with the limits off', () => {
    expect(() =>
      parseServerEnv({ ...BASE, NODE_ENV: 'production', CREDENTIAL_RATE_LIMITS: 'off' }),
    ).toThrow(/CREDENTIAL_RATE_LIMITS=off is for a throwaway test stack/);
    // And again where the decision is made, for an environment parsed some other way.
    expect(() =>
      credentialRateLimitsEnabled({ NODE_ENV: 'production', CREDENTIAL_RATE_LIMITS: 'off' }),
    ).toThrow(/refused in production/);
  });

  it('turns them off for a development or test stack that asks', () => {
    for (const NODE_ENV of ['development', 'test']) {
      const env = parseServerEnv({ ...BASE, NODE_ENV, CREDENTIAL_RATE_LIMITS: 'off' });
      expect(credentialRateLimitsEnabled(env)).toBe(false);
    }
  });

  it('refuses a spelling it does not know, rather than guessing which way it meant', () => {
    for (const value of ['false', '0', 'OFF', 'disabled']) {
      expect(() => parseServerEnv({ ...BASE, CREDENTIAL_RATE_LIMITS: value })).toThrow(
        /CREDENTIAL_RATE_LIMITS/,
      );
    }
  });

  it('is passed by no deployment', () => {
    // Every deployment runs NODE_ENV=production, so the refusal above already stops one;
    // this keeps the switch from being written into a deploy file in the first place.
    for (const file of [
      'infra/brand/docker-compose.brand.yml',
      'infra/docker-compose.preview.yml',
      'infra/kamal/deploy.yml',
      'infra/mother/docker-compose.yml',
    ]) {
      expect(readFileSync(path.join(REPO, file), 'utf8'), file).not.toMatch(
        /CREDENTIAL_RATE_LIMITS/,
      );
    }
  });
});
