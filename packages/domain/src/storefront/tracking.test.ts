import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha } from '../money/index.js';
import {
  boundedCustomData,
  combinedTrackingStatus,
  defaultEventRoutes,
  eventRouteFor,
  ga4EventName,
  ga4Payload,
  metaEvent,
  metaUserData,
  purchaseCustomData,
  purchaseEventId,
  retentionDays,
  splitName,
  trackingMaskedUser,
  trackingMatchKeys,
  trackingPhone,
  trackingTargets,
} from './tracking.js';

/** The website's tracking, the pure half (M35b, D-552), against the old site's behaviour. */

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('the shopper, as Meta matches them', () => {
  it('hashes normalised identifiers and passes the browser ids in the clear', () => {
    const data = metaUserData(
      {
        email: '  Rahim@Example.COM ',
        phone: '01712-345678',
        firstName: 'Rahim',
        lastName: 'Uddin',
        city: 'Dhaka',
        country: 'BD',
        externalId: 'Cust-1',
        fbp: 'fb.1.123.456',
        fbc: 'fb.1.123.abc',
        clientIpAddress: '203.0.113.7',
        clientUserAgent: 'Mozilla/5.0',
      },
      sha,
    );
    expect(data).toEqual({
      em: sha('rahim@example.com'),
      ph: sha('8801712345678'),
      fn: sha('rahim'),
      ln: sha('uddin'),
      ct: sha('dhaka'),
      country: sha('bd'),
      external_id: sha('cust-1'),
      fbp: 'fb.1.123.456',
      fbc: 'fb.1.123.abc',
      client_ip_address: '203.0.113.7',
      client_user_agent: 'Mozilla/5.0',
    });
  });

  it('puts the country code on a phone the old way', () => {
    expect(trackingPhone('01712345678')).toBe('8801712345678');
    expect(trackingPhone('+880 1712 345678')).toBe('8801712345678');
    expect(trackingPhone('008801712345678')).toBe('8801712345678');
    expect(trackingPhone('1712345678')).toBe('8801712345678');
    expect(trackingPhone('')).toBe('');
  });

  it('never stores a raw identifier: every hashed field is a digest, whatever was typed', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (email, phone, name) => {
        const data = metaUserData({ email, phone, firstName: name }, sha);
        for (const key of ['em', 'ph', 'fn'] as const) {
          if (data[key] !== undefined) expect(data[key]).toMatch(/^[0-9a-f]{64}$/);
        }
      }),
    );
  });

  it('logs a masked view and which match keys were present', () => {
    const user = { email: 'rahim@example.com', phone: '+8801712345678', fbp: 'x' };
    expect(trackingMaskedUser(user)).toEqual({ email: 'r***@example.com', phone: '880********78' });
    expect(trackingMatchKeys(user)).toMatchObject({
      email: true,
      phone: true,
      fbp: true,
      fbc: false,
    });
  });
});

describe('routing and payloads', () => {
  it('sends a server event only where its route and the brand’s switches allow', () => {
    const routes = defaultEventRoutes().map((route) =>
      route.name === 'AddToCart' ? { ...route, server: false } : route,
    );
    const on = { capiEnabled: true, capiReady: true, mpEnabled: true, mpReady: false };
    expect(trackingTargets(eventRouteFor(routes, 'Purchase'), on)).toEqual({
      meta: true,
      ga4: false,
    });
    expect(trackingTargets(eventRouteFor(routes, 'AddToCart'), on)).toEqual({
      meta: false,
      ga4: false,
    });
    // A custom event is routed everywhere, as the old site did.
    expect(eventRouteFor(routes, 'WishlistAdd')).toMatchObject({ enabled: true, server: true });
  });

  it('names events as GA4 recommends', () => {
    expect(ga4EventName('Purchase')).toBe('purchase');
    expect(ga4EventName('WishlistAdd')).toBe('wishlist_add');
  });

  it('keeps only bounded custom data', () => {
    const bounded = boundedCustomData({
      value: '1250.5',
      currency: 'BDT',
      contents: Array.from({ length: 80 }, (_, index) => ({ id: index, quantity: 1, price: 10 })),
      nested: { no: true },
      'bad key': 1,
      campaign: 'eid',
    });
    expect(bounded.value).toBe(1250.5);
    expect((bounded.contents as unknown[]).length).toBe(50);
    expect(bounded).not.toHaveProperty('nested');
    expect(bounded).not.toHaveProperty('bad key');
    expect(bounded.campaign).toBe('eid');
  });

  it('builds Meta’s event and GA4’s body from the same facts', () => {
    const customData = purchaseCustomData({
      orderNo: 'LP-0001',
      totalPoisha: poisha(262_000),
      lines: [{ productId: 'p1', name: 'Shirt', qty: 2, unitPricePoisha: poisha(129_000) }],
    });
    expect(
      metaEvent({
        eventName: 'Purchase',
        eventId: purchaseEventId('LP-0001'),
        eventTime: 1_790_000_000,
        actionSource: 'website',
        userData: { ph: 'x' },
        customData,
      }),
    ).toMatchObject({
      event_name: 'Purchase',
      event_id: 'purchase_LP-0001',
      custom_data: { value: 2620, currency: 'BDT', order_id: 'LP-0001', num_items: 2 },
    });
    expect(
      ga4Payload({
        eventName: 'Purchase',
        eventId: 'purchase_LP-0001',
        clientId: '123.456',
        customData,
        eventTime: 1_790_000_000,
      }),
    ).toMatchObject({
      client_id: '123.456',
      timestamp_micros: 1_790_000_000_000_000,
      events: [
        {
          name: 'purchase',
          params: {
            transaction_id: 'LP-0001',
            value: 2620,
            items: [{ item_id: 'p1', item_name: 'Shirt', price: 1290, quantity: 2 }],
          },
        },
      ],
    });
  });

  it('combines the two platforms’ results the old way', () => {
    expect(combinedTrackingStatus('skipped', 'skipped')).toBe('skipped');
    expect(combinedTrackingStatus('success', 'skipped')).toBe('success');
    expect(combinedTrackingStatus('success', 'error')).toBe('partial');
    expect(combinedTrackingStatus('error', 'error')).toBe('error');
  });

  it('splits a name and bounds the retention', () => {
    expect(splitName('  Rahim  Uddin Khan ')).toEqual({
      firstName: 'Rahim',
      lastName: 'Uddin Khan',
    });
    expect(retentionDays(0)).toBe(1);
    expect(retentionDays(9999)).toBe(365);
  });
});
