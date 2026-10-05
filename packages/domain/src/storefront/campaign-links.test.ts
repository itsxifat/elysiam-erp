import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CAMPAIGN_LINK_CODE,
  campaignBasePath,
  campaignFullPath,
  campaignLinkCodeFrom,
} from './campaign-links.js';

/** Campaign links (M35b, D-551), against the old site's `lib/customUrl.js`. */
describe('a campaign link', () => {
  it('draws a five-digit code from 10000 to 99999', () => {
    fc.assert(
      fc.property(fc.integer(), (random) => {
        const code = campaignLinkCodeFrom(random);
        expect(code).toMatch(CAMPAIGN_LINK_CODE);
        expect(Number(code)).toBeGreaterThanOrEqual(10_000);
      }),
    );
  });

  it('builds the address the old way: category, shop or custom path, then ?cu= or &cu=', () => {
    const category = campaignBasePath({
      baseType: 'category',
      categorySlug: 'shirts',
      customPath: null,
    });
    expect(category).toBe('/shop?category=shirts');
    expect(campaignFullPath(category, '12345')).toBe('/shop?category=shirts&cu=12345');
    expect(campaignBasePath({ baseType: 'shop', categorySlug: 'x', customPath: null })).toBe(
      '/shop',
    );
    const custom = campaignBasePath({ baseType: 'custom', categorySlug: null, customPath: 'eid' });
    expect(campaignFullPath(custom, '54321')).toBe('/eid?cu=54321');
    // A category link whose category has gone falls back to the shop, as the old site did.
    expect(campaignBasePath({ baseType: 'category', categorySlug: null, customPath: null })).toBe(
      '/shop',
    );
  });
});
