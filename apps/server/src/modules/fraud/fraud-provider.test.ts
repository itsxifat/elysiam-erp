import { describe, expect, it } from 'vitest';

import { fraudConfig, type FraudConfig } from './fraud.config.js';
import { FakeFraudProvider } from './providers/fake.provider.js';
import { scalarsOnly } from './providers/fraud-signal.provider.js';
import { ProviderGateway } from './providers/provider-gateway.js';
import { parse } from './providers/steadfast.provider.js';

/**
 * The provider layer, without a database (architecture §10, §21; M13 check 3).
 *
 * Check 3's own assertion — the badge falling back and the desk still working — needs the
 * service and is in `fraud.e2e.test.ts`. This suite covers the half underneath it: that a
 * timeout, a throttle and a malformed body each become "no answer" rather than an
 * exception, and that nothing a provider sends can put personal data in a table four other
 * brands read.
 */

function config(overrides: Partial<FraudConfig> = {}): FraudConfig {
  process.env.FRAUD_PHONE_HASH_KEY ??= 'fraud-test-hmac-key-at-least-32-chars';
  return { ...fraudConfig(), FRAUD_PROVIDER_TIMEOUT_MS: 50, ...overrides };
}

describe('the gateway turns every provider failure into one branch', () => {
  it('reports a timeout rather than throwing, and does not wait for the provider', async () => {
    const slow = new FakeFraudProvider('slow').stall();
    const gateway = new ProviderGateway(config(), [slow]);

    const started = Date.now();
    const results = await gateway.lookupAll('+8801711111111');
    const elapsed = Date.now() - started;

    expect(results.get('slow')).toEqual({ status: 'unavailable', reason: 'timeout' });
    // The budget, not the provider's own pace. A `Promise.race` would have returned here
    // too while leaving the request running — which is how a slow afternoon at a third
    // party accumulates sockets until this process falls over.
    expect(elapsed).toBeLessThan(1_000);
  });

  it('keeps the answers that did arrive when one provider fails', async () => {
    const good = new FakeFraudProvider('good').returns({
      total: 10,
      delivered: 9,
      returnedOrCancelled: 1,
      ratio: 0.9,
      raw: { total: 10 },
    });
    const bad = new FakeFraudProvider('bad').fails('error');

    const results = await ProviderGateway.prototype.lookupAll.call(
      new ProviderGateway(config(), [good, bad]),
      '+8801711111111',
    );

    expect(results.get('good')).toMatchObject({ status: 'ok' });
    expect(results.get('bad')).toEqual({ status: 'unavailable', reason: 'error' });
  });

  it('survives a provider that breaks the contract and throws', async () => {
    // The interface says never throw. This asserts the belt on top of it: one badly
    // written adapter must not reject the whole batch and lose the answers that arrived.
    const rude: FakeFraudProvider = Object.assign(new FakeFraudProvider('rude'), {
      lookup: () => Promise.reject(new Error('phone +8801711111111 not found')),
    });
    const gateway = new ProviderGateway(config(), [rude]);

    const results = await gateway.lookupAll('+8801711111111');
    expect(results.get('rude')).toEqual({ status: 'unavailable', reason: 'error' });
  });

  it('throttles itself before the provider throttles us', async () => {
    // A provider that rate-limits us eventually blocks us, and then every org loses the
    // check at once. So the ceiling is ours to enforce.
    const provider = new FakeFraudProvider('metered');
    const gateway = new ProviderGateway(config({ FRAUD_PROVIDER_RATE_PER_MINUTE: 2 }), [provider]);

    await gateway.lookupAll('+8801711111111');
    await gateway.lookupAll('+8801722222222');
    const third = await gateway.lookupAll('+8801733333333');

    expect(third.get('metered')).toEqual({ status: 'unavailable', reason: 'throttled' });
    // Two calls made, not three: the third never left the process.
    expect(provider.calls).toHaveLength(2);
  });

  it('says nothing about providers when none is configured', async () => {
    // The distinction the badge needs: "no provider set up here" is not the same fact as
    // "a provider is set up and did not answer", and only the second belongs on a screen.
    const gateway = new ProviderGateway(config(), [new FakeFraudProvider('off', false)]);

    expect(gateway.anyConfigured).toBe(false);
    expect(gateway.names).toEqual([]);
    expect([...(await gateway.lookupAll('+8801711111111'))]).toEqual([]);
  });
});

describe('the Steadfast adapter reads a body, or says it could not', () => {
  it('reads the aggregator shape the published spec documents', () => {
    // `data.totalSummary`, from the one vendor in this market that publishes field names.
    // The adapter is still unverified for Steadfast itself (see its header and the decision
    // row); this asserts that the shape it *was* written against parses.
    const result = parse({
      status: true,
      message: 'Courier info retrieved successfully.',
      data: {
        Summaries: { Pathao: { total: 3, success: 3, cancel: 0 } },
        totalSummary: { total: 12, success: 4, cancel: 8, successRate: 33.33, cancelRate: 66.67 },
      },
    });

    expect(result).toMatchObject({
      status: 'ok',
      counts: { total: 12, delivered: 4, returnedOrCancelled: 8 },
    });
    // A percentage, normalised to a fraction. `33.33` and `0.3333` are both plausible
    // readings of "33%", and the score wants a fraction.
    expect(result.status === 'ok' ? result.counts.ratio : null).toBeCloseTo(0.3333, 3);
  });

  it("does not mistake one courier's figures for the whole market's", () => {
    // The trap a recursive search for `total` would fall into: `data.Summaries.Pathao.total`
    // is 3 and `data.totalSummary.total` is 12. Picking the first one found would present
    // one courier's record as everybody's, which is a wrong answer that looks right.
    const result = parse({
      data: {
        Summaries: { Pathao: { total: 3, success: 3, cancel: 0 } },
        totalSummary: { total: 12, success: 4, cancel: 8 },
      },
    });
    expect(result.status === 'ok' ? result.counts.total : null).toBe(12);
  });

  it('reads counters sent as strings, which providers in this market do', () => {
    const result = parse({ total_parcel: '20', total_delivered: '18', total_cancelled: '2' });
    expect(result).toMatchObject({
      status: 'ok',
      counts: { total: 20, delivered: 18, returnedOrCancelled: 2 },
    });
  });

  it('says unparsable rather than zero when the counters are missing', () => {
    /*
     * The single most important assertion in this file.
     *
     * Zero reads as "this buyer has a clean record". If a provider renamed a field, or
     * answered with an error object, treating the absence as zero would turn every flagged
     * number into a passing check — and it would stay that way for the whole TTL, because a
     * stored zero row suppresses the next refresh. Failing to parse is loud and harmless.
     */
    for (const body of [
      {},
      { error: 'not found' },
      { data: { message: 'no records' } },
      null,
      'nonsense',
      [1, 2, 3],
    ]) {
      expect(parse(body)).toEqual({ status: 'unavailable', reason: 'unparsable' });
    }
  });

  it('discards a ratio that cannot be one', () => {
    // Above 100 means the field was not the ratio at all, so it is dropped rather than
    // clamped: a clamped 1.0 would read as a perfect customer.
    const result = parse({ total: 5, success: 5, cancel: 0, ratio: 4200 });
    expect(result.status === 'ok' ? result.counts.ratio : 'x').toBeNull();
  });
});

describe('nothing personal reaches the cross-org raw column', () => {
  it('keeps numbers, booleans and status tokens, and drops everything else', () => {
    // `provider_checks.raw` is readable by every org (§5 exception 1), so the projection is
    // the control. A provider that started returning a name or an address must not be able
    // to put it there by adding a field.
    //
    // This test caught a real hole: the first version of the filter allowed any string
    // under 40 characters without a long run of digits, and the Dhanmondi address below is
    // 39 characters with none. The rule is now a machine token — lowercase, no spaces —
    // which an address and a person's name both fail and every status word passes.
    const projected = scalarsOnly({
      total: 12,
      success: 4,
      status: 'delivered',
      customer_rating: 'excellent_customer',
      risk_level: 'low',
      is_fraud: true,
      customer_name: 'Rehana Chowdhury',
      address: 'House 41, Road 7, Dhanmondi, Dhaka 1209',
      phone: '01711111111',
      tracking: 'SF1234567890',
      note: 'Refused the parcel at the door and would not answer the rider afterwards',
      nested: { anything: 'at all' },
      list: [1, 2, 3],
    });

    expect(projected).toEqual({
      total: 12,
      success: 4,
      status: 'delivered',
      customer_rating: 'excellent_customer',
      risk_level: 'low',
      is_fraud: true,
    });
  });

  it('drops anything that is not a machine token, however short', () => {
    // Each of these is a plausible field a provider could add, and each one is personal
    // data about a buyer in a table five brands read.
    for (const value of [
      'Rehana',
      'Rehana Chowdhury',
      '01711111111',
      '+8801711111111',
      'Dhanmondi 1209',
      'House 41',
      'dhaka, bangladesh',
      'refused at door',
      'A',
    ]) {
      expect(scalarsOnly({ field: value }), `"${value}" must not survive`).toEqual({});
    }
  });
});

describe('the hash key is required, loudly', () => {
  it('refuses to build a configuration without one', () => {
    // Not a default, not a warning. A fallback key produces different hashes, so the system
    // keeps working while every phone number silently becomes a new person and five brands'
    // history detaches from the buyers it describes — unrecoverably, because a hash cannot
    // be reversed to compare.
    expect(() => fraudConfig({})).toThrow(/FRAUD_PHONE_HASH_KEY/);
    expect(() => fraudConfig({ FRAUD_PHONE_HASH_KEY: 'too-short' })).toThrow(/32 characters/);
  });

  it('never echoes the key it rejected', () => {
    // A configuration error is the one event guaranteed to be logged (invariant 10).
    const secret = 'x'.repeat(31);
    try {
      fraudConfig({ FRAUD_PHONE_HASH_KEY: secret });
      expect.unreachable('a 31-character key must be refused');
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});
