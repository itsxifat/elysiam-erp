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
  type NcomOrderMoney,
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
  const ok = (money: NcomOrderMoney) => {
    if (!money.ok) throw new Error(money.reason);
    return money;
  };

  it('collects exactly ncom’s total for the old order check’s order', () => {
    // ৳1,500 of ours, a free gift ncom stores; ৳60 delivery; ৳1,560 total. The gift's own ৳500
    // saving is inside its line total (0), and `discountTotalCents` repeats it.
    const money = ok(
      ncomOrderMoney({
        lines: [
          { ours: true, quantity: 1, unitPriceCents: 150_000, totalCents: 150_000 },
          { ours: false, quantity: 1, unitPriceCents: 50_000, totalCents: 0 },
        ],
        shippingTotalCents: 6_000,
        discountTotalCents: 50_000,
        taxTotalCents: 0,
        totalCents: 156_000,
      }),
    );
    expect(money.codPoisha).toBe(t(1560));
    expect(money.foreignPoisha).toBe(ZERO);
    expect(money.deliveryPoisha).toBe(t(60));
    expect(money.lines.map((line) => line.valuePoisha)).toEqual([t(1500), ZERO]);
  });

  it('takes a discount off units when the lines carry no totals', () => {
    const money = ok(
      ncomOrderMoney({
        lines: [{ ours: true, quantity: 2, unitPriceCents: 125_000, totalCents: undefined }],
        shippingTotalCents: 6_000,
        discountTotalCents: 50_000,
        taxTotalCents: 0,
        totalCents: 206_000,
      }),
    );
    expect(money.oursDiscountPoisha).toBe(t(500));
    expect(money.codPoisha).toBe(t(2060));
  });

  it('refuses a missing or malformed amount rather than reading it as nothing', () => {
    const base = {
      lines: [{ ours: true, quantity: 2, unitPriceCents: 125_000, totalCents: 250_000 }],
      shippingTotalCents: 6_000,
      discountTotalCents: 0,
      taxTotalCents: 0,
      totalCents: 256_000,
    };
    expect(ncomOrderMoney(base).ok).toBe(true);
    for (const broken of [
      { ...base, totalCents: undefined },
      { ...base, totalCents: '2560.00' },
      { ...base, totalCents: -1 },
      { ...base, shippingTotalCents: undefined },
      { ...base, shippingTotalCents: 1.5 },
      { ...base, taxTotalCents: 100 },
      { ...base, totalCents: 6_000 },
      {
        ...base,
        lines: [{ ours: true, quantity: 2, unitPriceCents: undefined, totalCents: undefined }],
      },
      {
        ...base,
        lines: [{ ours: true, quantity: 2, unitPriceCents: 'free', totalCents: 250_000 }],
      },
      { ...base, lines: [{ ours: true, quantity: 0, unitPriceCents: 125_000, totalCents: 0 }] },
      {
        ...base,
        lines: [{ ours: true, quantity: 20_000, unitPriceCents: 1, totalCents: 20_000 }],
      },
      { ...base, lines: [] },
    ]) {
      expect(ncomOrderMoney(broken).ok).toBe(false);
    }
  });

  it('splits a discount between the brand’s goods and another shop’s, exactly', () => {
    // The ledger audit's W3: ours ৳1,500, theirs ৳300, delivery ৳60, ৳400 off, total ৳1,460.
    const money = ok(
      ncomOrderMoney({
        lines: [
          { ours: true, quantity: 1, unitPriceCents: 150_000, totalCents: undefined },
          { ours: false, quantity: 1, unitPriceCents: 30_000, totalCents: undefined },
        ],
        shippingTotalCents: 6_000,
        discountTotalCents: 40_000,
        taxTotalCents: 0,
        totalCents: 146_000,
      }),
    );
    expect(money.oursDiscountPoisha + (t(300) - money.foreignPoisha)).toBe(t(400));
    expect(money.codPoisha + money.foreignPoisha).toBe(t(1460));
    expect(money.foreignPoisha > ZERO).toBe(true);
  });

  it('always collects exactly ncom’s total between the brand and other shops', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ours: fc.boolean(),
            quantity: fc.integer({ min: 1, max: 5 }),
            unit: fc.integer({ min: 0, max: 500_000 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 30_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        (lines, shipping, discountWish) => {
          const gross = lines.reduce((total, line) => total + line.unit * line.quantity, 0);
          const discount = Math.min(discountWish * 100, gross + shipping);
          const total = gross + shipping - discount;
          const money = ok(
            ncomOrderMoney({
              lines: lines.map((line) => ({
                ours: line.ours,
                quantity: line.quantity,
                unitPriceCents: line.unit,
                totalCents: undefined,
              })),
              shippingTotalCents: shipping,
              discountTotalCents: discount,
              taxTotalCents: 0,
              totalCents: total,
            }),
          );
          expect(money.codPoisha + money.foreignPoisha).toBe(poisha(total));
          expect(money.codPoisha >= money.deliveryPoisha).toBe(true);
          expect(money.deliveryPoisha <= poisha(shipping)).toBe(true);
          expect(money.oursDiscountPoisha <= money.oursPoisha).toBe(true);
          // Every order line's value fits under its unit price, so the order's own discount
          // (its goods less what is collected for them) is never negative.
          for (const line of money.lines) {
            expect(line.unitPricePoisha * BigInt(line.quantity) >= line.valuePoisha).toBe(true);
          }
        },
      ),
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
