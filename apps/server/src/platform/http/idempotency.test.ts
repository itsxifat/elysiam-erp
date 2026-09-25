import { describe, expect, it } from 'vitest';

import { canonicalJson, checkKey, fingerprint, isMutation, routeOf } from './idempotency.js';

describe('which requests get a record (§23)', () => {
  it('covers the mutations and nothing else', () => {
    for (const method of ['POST', 'put', 'PATCH', 'delete']) {
      expect(isMutation(method), method).toBe(true);
    }
    // A GET has no effect to avoid repeating, and caching one would turn the
    // table into a response cache with no invalidation.
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(isMutation(method), method).toBe(false);
    }
  });
});

describe('the key itself', () => {
  it('accepts a uuid, which is what a client should send', () => {
    const check = checkKey(' 0b7d2a2e-6d0e-4a6f-9f1e-1f0b5c6d7e8f ');
    expect(check).toEqual({ ok: true, key: '0b7d2a2e-6d0e-4a6f-9f1e-1f0b5c6d7e8f' });
  });

  it('refuses the keys a hurried frontend reaches for', () => {
    // These collide between one person's own two submissions, which is the
    // failure the record exists to prevent.
    for (const key of ['1', 'retry', 'abc']) {
      expect(checkKey(key).ok, key).toBe(false);
    }
  });

  it('refuses a key long enough to bloat the unique index', () => {
    expect(checkKey('k'.repeat(256)).ok).toBe(false);
    expect(checkKey('k'.repeat(255)).ok).toBe(true);
  });

  it('refuses a newline, which would split a log line in two', () => {
    expect(checkKey('good-key\nfake log entry').ok).toBe(false);
    expect(checkKey('has a space').ok).toBe(false);
  });

  it('refuses a repeated header, which arrives as an array', () => {
    expect(checkKey(['key-one-aaaa', 'key-two-bbbb']).ok).toBe(false);
    expect(checkKey(undefined).ok).toBe(false);
  });
});

describe('the request fingerprint', () => {
  it('is blind to the order a client happened to build its object in', () => {
    // A manual retry rebuilds the body from state in a different order. Without
    // this the retry looks like a *different* request under the same key, and
    // the operator is told IDEMPOTENCY_CONFLICT on a payment they are resending.
    const a = { walletAccountId: 'w', amountPoisha: '5000', memo: 'cash' };
    const b = { memo: 'cash', amountPoisha: '5000', walletAccountId: 'w' };
    expect(fingerprint('POST', '/v1/ledger/cash-in', a)).toBe(
      fingerprint('POST', '/v1/ledger/cash-in', b),
    );
  });

  it('is not blind to array order, where order is meaning', () => {
    expect(fingerprint('POST', '/p', { lines: [1, 2] })).not.toBe(
      fingerprint('POST', '/p', { lines: [2, 1] }),
    );
  });

  it('changes when the amount changes, which is the whole point', () => {
    expect(fingerprint('POST', '/p', { amountPoisha: '50000000' })).not.toBe(
      fingerprint('POST', '/p', { amountPoisha: '50000' }),
    );
  });

  it('separates the same body sent to two different records', () => {
    // The record is keyed by the route *template*, so without the concrete path
    // in the fingerprint one key could run against order 7 and then order 8.
    expect(fingerprint('PUT', '/v1/orders/7', { status: 'confirmed' })).not.toBe(
      fingerprint('PUT', '/v1/orders/8', { status: 'confirmed' }),
    );
  });

  it('separates the same path under two different methods', () => {
    expect(fingerprint('POST', '/p', {})).not.toBe(fingerprint('DELETE', '/p', {}));
  });

  it('ignores a member that JSON.stringify would have dropped anyway', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('handles the bodies that are not objects at all', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson('text')).toBe('"text"');
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('is a sha256 hex digest, so the body itself is never stored', () => {
    // The row outlives the request by a day and bodies carry addresses and
    // phone numbers (invariant 10).
    expect(fingerprint('POST', '/p', { phone: '01712345678' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the record scope', () => {
  it('is the method and the route template, upper-cased', () => {
    expect(routeOf('post', '/v1/ledger/cash-in')).toBe('POST /v1/ledger/cash-in');
    expect(routeOf('PUT', '/v1/orders/:id')).toBe('PUT /v1/orders/:id');
  });
});
