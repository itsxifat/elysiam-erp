import { describe, expect, it } from 'vitest';

import { openToken, sealToken } from './credentials.js';
import { marketingConfig, metaGatewayFor } from './marketing.config.js';
import { FakeMetaGateway, GraphMetaGateway } from './providers/meta-gateway.js';

/**
 * D-257's two promises: the unverified Graph adapters need two switches, and a brand's
 * sealed token opens only for that brand, with this installation's key.
 */

const KEY = Buffer.alloc(32, 3).toString('base64');
const ORG = '0e180000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '0e180000-0000-4000-8000-0000000000b2';
const TOKEN = 'EAAB-config-test-token-not-real-000001';

describe('the Meta provider switches (D-257)', () => {
  it('defaults to the fake, which sends nothing', () => {
    const config = marketingConfig({});
    expect(config.MARKETING_META_PROVIDER).toBe('fake');
    expect(metaGatewayFor(config)).toBeInstanceOf(FakeMetaGateway);
  });

  it('refuses to boot on the Graph adapters without the second switch', () => {
    expect(() => marketingConfig({ MARKETING_META_PROVIDER: 'graph' })).toThrow(
      /MARKETING_META_ENABLED/,
    );
    expect(() =>
      marketingConfig({ MARKETING_META_PROVIDER: 'graph', MARKETING_META_ENABLED: 'false' }),
    ).toThrow(/unverified/);
  });

  it('uses the Graph adapters when both switches are set on purpose', () => {
    const config = marketingConfig({
      MARKETING_META_PROVIDER: 'graph',
      MARKETING_META_ENABLED: 'true',
    });
    expect(metaGatewayFor(config)).toBeInstanceOf(GraphMetaGateway);
  });

  it('reads an empty key from a dotenv file as absent, and refuses a short one', () => {
    expect(marketingConfig({ MARKETING_CREDENTIALS_KEY: '' }).MARKETING_CREDENTIALS_KEY).toBe(
      undefined,
    );
    expect(() => marketingConfig({ MARKETING_CREDENTIALS_KEY: 'c2hvcnQ=' })).toThrow();
  });
});

describe('a sealed Meta token', () => {
  const key = { key: KEY, keyId: 'v1' };

  it('opens for its own brand, and the ciphertext and fingerprint carry no token', () => {
    const sealed = sealToken(TOKEN, ORG, key);
    expect(openToken(sealed.ciphertext, ORG, key)).toBe(TOKEN);
    expect(sealed.ciphertext.toString('utf8')).not.toContain('EAAB');
    expect(sealed.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('does not open when copied into another brand’s row', () => {
    const sealed = sealToken(TOKEN, ORG, key);
    expect(() => openToken(sealed.ciphertext, OTHER_ORG, key)).toThrow(
      expect.objectContaining({ code: 'MARKETING_CREDENTIALS_MISSING' }) as Error,
    );
  });

  it('does not open under another installation’s key, and says nothing of the token', () => {
    const sealed = sealToken(TOKEN, ORG, key);
    const other = { key: Buffer.alloc(32, 4).toString('base64'), keyId: 'v1' };
    let message = '';
    try {
      openToken(sealed.ciphertext, ORG, other);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/could not be decrypted/);
    expect(message).not.toContain('EAAB');
  });

  it('cannot be stored without a key', () => {
    expect(() => sealToken(TOKEN, ORG, { key: undefined, keyId: 'v1' })).toThrow(
      /MARKETING_CREDENTIALS_KEY/,
    );
  });
});
