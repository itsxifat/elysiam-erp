import { describe, expect, it } from 'vitest';

import { trackingBn, trackingEn } from './messages.js';
import {
  brandFromPath,
  digitsOf,
  isTrackingPath,
  pathWithinBase,
  readyToSubmit,
} from './tracking-input.js';

/**
 * The tracking page's pure pieces (M15).
 *
 * The page's security is the server's (the byte-identical negative answer and the rate limit
 * are proven in `courier.m15.db.test.ts`); these are the parts a customer meets first — the
 * brand read from the link, the digits read the way they were typed on a Bangla keyboard,
 * and a catalogue with no key missing on either side.
 */

describe('the tracking link', () => {
  it('reads the brand from /track/<slug>', () => {
    expect(brandFromPath('/track/oura-lifestyle')).toBe('oura-lifestyle');
    expect(brandFromPath('/track/oura-lifestyle/')).toBe('oura-lifestyle');
  });

  it('reads no brand from anything else', () => {
    expect(brandFromPath('/track')).toBeNull();
    expect(brandFromPath('/track/')).toBeNull();
    expect(brandFromPath('/track/Oura')).toBeNull();
    expect(brandFromPath('/track/oura/extra')).toBeNull();
    expect(brandFromPath('/track/../admin')).toBeNull();
  });

  it('knows which paths are the tracking page', () => {
    expect(isTrackingPath('/track')).toBe(true);
    expect(isTrackingPath('/track/oura-lifestyle')).toBe(true);
    expect(isTrackingPath('/tracker')).toBe(false);
    expect(isTrackingPath('/')).toBe(false);
  });
});

describe('what a customer typed', () => {
  it('reads Bangla digits, spaces and dashes', () => {
    expect(digitsOf('৫৬ ৭৮')).toBe('5678');
    expect(digitsOf('56-78')).toBe('5678');
  });

  it('is ready only with an order number and exactly four digits', () => {
    expect(readyToSubmit('OUR-2609-00042', '৫৬৭৮')).toBe(true);
    expect(readyToSubmit('OUR-2609-00042', '567')).toBe(false);
    expect(readyToSubmit('OUR-2609-00042', '56789')).toBe(false);
    expect(readyToSubmit('', '5678')).toBe(false);
  });
});

describe('the tracking catalogue', () => {
  it('has the same keys in bn and en, and no empty string', () => {
    expect(Object.keys(trackingEn).sort()).toEqual(Object.keys(trackingBn).sort());
    for (const catalogue of [trackingBn, trackingEn]) {
      for (const [key, value] of Object.entries(catalogue)) {
        expect(value.trim(), key).not.toBe('');
      }
    }
  });

  it('names every stage the server can send', () => {
    for (const stage of [
      'received',
      'processing',
      'with_courier',
      'out_for_delivery',
      'delivered',
      'returned',
      'cancelled',
    ]) {
      expect(Object.hasOwn(trackingBn, `tracking.stage.${stage}`), stage).toBe(true);
    }
  });
});

describe('pathWithinBase (D-352)', () => {
  it('is the path itself when the portal is served from the root', () => {
    expect(pathWithinBase('/track/orvo', '/')).toBe('/track/orvo');
    expect(pathWithinBase('/investor', '/')).toBe('/investor');
  });

  it('drops the base the portal is served under, and only that', () => {
    expect(pathWithinBase('/portal/track/orvo', '/portal/')).toBe('/track/orvo');
    expect(pathWithinBase('/portal/investor', '/portal/')).toBe('/investor');
    expect(pathWithinBase('/portal/', '/portal/')).toBe('/');
    expect(pathWithinBase('/portal', '/portal/')).toBe('/');
    // A path that merely starts with the same letters is not under the base.
    expect(pathWithinBase('/portaledge', '/portal/')).toBe('/portaledge');
  });
});
