import { createHmac } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { poisha, ZERO, type Poisha } from '../money/index.js';
import { ORDER_STATUSES } from '../orders/state.js';
import {
  decodeNcomCursor,
  encodeNcomCursor,
  matchDistrict,
  matchThana,
  mergeNcomLines,
  ncomDeliveryOutcome,
  ncomHexEquals,
  ncomIdsFrom,
  ncomOrderMoney,
  ncomPrice,
  ncomSecretEquals,
  ncomSign,
  ncomSignatureHeader,
  ncomStatusFor,
  NCOM_OUTBOX_MAX_ATTEMPTS,
  parseNcomSignatureHeader,
  verifyNcomSignature,
} from './ncom.js';

/**
 * ncom's contract 1, the pure half (M35b, D-553, D-556). The connector over HTTP, and the old
 * site's own `ncom-check.mjs` run against it, are `marketplace.e2e.test.ts`.
 */

const NOW = 1_790_000_000_000;
const SECRET = 'ncomsec_test_only_0000000000000000';

describe('the signature', () => {
  it('is HMAC-SHA256 over "<t>." and the raw body, exactly as the old site signed', () => {
    const body = '{"ids":["a"]}';
    const expected = createHmac('sha256', SECRET).update(`1790000000.${body}`).digest('hex');
    expect(ncomSign(SECRET, 1_790_000_000, body)).toBe(expected);
    expect(ncomSignatureHeader(SECRET, body, 1_790_000_000)).toBe(`t=1790000000,v1=${expected}`);
    // A GET signs the empty body.
    expect(ncomSign(SECRET, '1790000000')).toBe(
      createHmac('sha256', SECRET).update('1790000000.').digest('hex'),
    );
  });

  it('verifies any body it signed, within five minutes either side, and nothing else', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 512 }),
        fc.integer({ min: -300, max: 300 }),
        (bytes, skew) => {
          const body = Buffer.from(bytes);
          const t = Math.floor(NOW / 1000) + skew;
          const header = ncomSignatureHeader(SECRET, body, t);
          expect(verifyNcomSignature(SECRET, body, header, NOW).ok).toBe(true);
          // One byte more, another secret, or another timestamp token: refused.
          expect(
            verifyNcomSignature(SECRET, Buffer.concat([body, Buffer.from(' ')]), header, NOW).ok,
          ).toBe(false);
          expect(verifyNcomSignature(`${SECRET}x`, body, header, NOW).ok).toBe(false);
          const moved = header.replace(`t=${String(t)}`, `t=${String(t + 1)}`);
          expect(verifyNcomSignature(SECRET, body, moved, NOW).ok).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refuses a stale or future request, a malformed header and a missing secret, with a reason', () => {
    const old = ncomSignatureHeader(SECRET, '', Math.floor(NOW / 1000) - 3_600);
    expect(verifyNcomSignature(SECRET, '', old, NOW)).toMatchObject({ ok: false });
    expect(verifyNcomSignature(SECRET, '', 'v1=abc', NOW)).toEqual({
      ok: false,
      reason: 'malformed signature header',
    });
    expect(verifyNcomSignature(SECRET, '', 't=1e9,v1=00', NOW)).toEqual({
      ok: false,
      reason: 'malformed timestamp',
    });
    expect(verifyNcomSignature('', '', old, NOW)).toEqual({
      ok: false,
      reason: 'no signing secret configured',
    });
  });

  it('parses the header loosely and compares in constant time without throwing', () => {
    expect(parseNcomSignatureHeader(' t = 12 , v1=ab, extra=1')).toEqual({
      t: '12',
      v1: 'ab',
      extra: '1',
    });
    expect(ncomHexEquals('zz', 'zz')).toBe(false);
    expect(ncomHexEquals('a'.repeat(64), 'A'.repeat(64))).toBe(true);
    expect(ncomSecretEquals('ncomcat_1', 'ncomcat_1')).toBe(true);
    expect(ncomSecretEquals('ncomcat_1', 'ncomcat_12')).toBe(false);
  });
});

describe('the connector’s shapes', () => {
  it('sends prices as taka decimals', () => {
    expect(ncomPrice(poisha(129_000))).toBe('1290.00');
    expect(ncomPrice(poisha(5))).toBe('0.05');
  });

  it('reads repeated and comma-joined ids in order, without repeats, up to a cap', () => {
    expect(ncomIdsFrom(['a,b', ' c ', 'a', ''], 10)).toEqual(['a', 'b', 'c']);
    expect(ncomIdsFrom(['a,b,c'], 2)).toEqual(['a', 'b']);
  });

  it('round-trips a page cursor and refuses anything else', () => {
    const id = '0f3c8b5e-6a6f-4f2a-9a43-0d0c7c8d9e10';
    expect(decodeNcomCursor(encodeNcomCursor(id))).toBe(id);
    expect(decodeNcomCursor('not-a-cursor')).toBeNull();
    expect(decodeNcomCursor(Buffer.from('{"id":"x"}').toString('base64url'))).toBeNull();
  });

  it('merges a basket’s lines per variant before anything is held', () => {
    expect(
      mergeNcomLines([
        { variantId: 'v1', quantity: 2 },
        { id: 'v1', quantity: '1' },
        { variantId: 'v2', quantity: 0 },
        { quantity: 3 },
        null,
      ]),
    ).toEqual([{ variantId: 'v1', quantity: 3 }]);
    expect(mergeNcomLines('nope')).toEqual([]);
  });
});

describe('an order ncom hands over', () => {
  const t = (taka: number): Poisha => poisha(BigInt(taka) * 100n);

  it('collects exactly ncom’s total when the brand sells every line', () => {
    // The old order check's order: ৳1,500 of ours and a free gift; ৳60 delivery; ৳1,560 total.
    const money = ncomOrderMoney({
      ours: [{ qty: 1, unitPricePoisha: t(1500) }],
      shippingTotalCents: 6_000,
      totalCents: 156_000,
    });
    expect(money).toEqual({
      itemsPoisha: t(1500),
      deliveryPoisha: t(60),
      discountPoisha: ZERO,
      codPoisha: t(1560),
      foreignPoisha: ZERO,
    });
  });

  it('turns a bundle price into the order discount, and never discounts below the goods', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 5 }),
            price: fc.integer({ min: 0, max: 5_000 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 40_000 }),
        (lines, shipping, total) => {
          const money = ncomOrderMoney({
            ours: lines.map((line) => ({ qty: line.qty, unitPricePoisha: t(line.price) })),
            shippingTotalCents: shipping * 100,
            totalCents: total * 100,
          });
          expect(money.discountPoisha >= 0n && money.discountPoisha <= money.itemsPoisha).toBe(
            true,
          );
          expect(money.codPoisha).toBe(
            money.itemsPoisha - money.discountPoisha + money.deliveryPoisha,
          );
          // The brand collects ncom's total, or its own goods and delivery when ncom's total
          // carries goods the brand does not sell.
          if (money.foreignPoisha === 0n && money.discountPoisha < money.itemsPoisha) {
            expect(money.codPoisha).toBe(t(total));
          }
          if (money.foreignPoisha > 0n) {
            expect(money.codPoisha + money.foreignPoisha).toBe(t(total));
          }
        },
      ),
    );
  });

  it('reads only integer cents', () => {
    expect(ncomOrderMoney({ ours: [], shippingTotalCents: 1.5, totalCents: '-3' }).codPoisha).toBe(
      ZERO,
    );
  });

  it('reports every status in ncom’s five words', () => {
    const words = new Set(ORDER_STATUSES.map((status) => ncomStatusFor(status)));
    expect([...words].sort()).toEqual([
      'cancelled',
      'delivered',
      'pending',
      'processing',
      'shipped',
    ]);
    expect(ncomStatusFor('returned')).toBe('cancelled');
  });
});

describe('the outbox’s answer to an attempt', () => {
  it('delivers on 2xx, stops for a person on 409 and other 4xx, and retries the rest on the old backoff', () => {
    expect(ncomDeliveryOutcome(200, 1)).toEqual({ state: 'delivered' });
    expect(ncomDeliveryOutcome(409, 1)).toEqual({ state: 'refused', reason: 'version_conflict' });
    expect(ncomDeliveryOutcome(422, 3)).toEqual({ state: 'refused', reason: 'http_422' });
    expect(ncomDeliveryOutcome(503, 1)).toEqual({ state: 'retry', afterSeconds: 15 });
    expect(ncomDeliveryOutcome(429, 2)).toEqual({ state: 'retry', afterSeconds: 60 });
    expect(ncomDeliveryOutcome(null, 7)).toEqual({ state: 'retry', afterSeconds: 21_600 });
    expect(ncomDeliveryOutcome(null, NCOM_OUTBOX_MAX_ATTEMPTS)).toEqual({
      state: 'failed',
      reason: 'unreachable',
    });
  });
});

describe('a free-text address', () => {
  const districts = [
    { id: 47, nameEn: 'Dhaka', nameBn: 'ঢাকা' },
    { id: 12, nameEn: 'Chattogram', nameBn: 'চট্টগ্রাম' },
    { id: 70, nameEn: 'Chapai Nawabganj', nameBn: 'চাঁপাইনবাবগঞ্জ' },
  ];

  it('finds the district by name, by an old spelling, or inside the text', () => {
    expect(matchDistrict(['Dhaka'], districts)?.id).toBe(47);
    expect(matchDistrict(['chittagong'], districts)?.id).toBe(12);
    expect(matchDistrict(['ঢাকা'], districts)?.id).toBe(47);
    expect(matchDistrict([null, 'House 4, Road 2, Chapai Nawabganj Sadar'], districts)?.id).toBe(
      70,
    );
    expect(matchDistrict(['Atlantis'], districts)).toBeNull();
  });

  it('finds the thana the address names, longest first', () => {
    const thanas = [
      { id: 1, nameEn: 'Mirpur', nameBn: 'মিরপুর' },
      { id: 2, nameEn: 'Mirpur Model', nameBn: 'মিরপুর মডেল' },
      { id: 3, nameEn: 'Dhanmondi', nameBn: 'ধানমন্ডি' },
    ];
    expect(matchThana(['House 5, Mirpur Model, Dhaka'], thanas)?.id).toBe(2);
    expect(matchThana(['Road 27, dhanmondi'], thanas)?.id).toBe(3);
    expect(matchThana(['Somewhere'], thanas)).toBeNull();
  });
});
