import { describe, expect, it } from 'vitest';

import { FLAG_OVERRIDES_ENV, flagOverridesFromEnv, parseFlagOverrides } from './overrides.js';

/**
 * The per-environment override half of D-031.
 *
 * Every case here is "the operator typed it slightly wrong", because that is
 * when this mechanism gets used: during an incident, from a phone, into a deploy
 * config. Silently ignoring a malformed kill switch would be the one outcome
 * worse than not having one.
 */

describe('parseFlagOverrides', () => {
  it('is empty when the variable is unset or blank', () => {
    expect(parseFlagOverrides(undefined).size).toBe(0);
    expect(parseFlagOverrides('').size).toBe(0);
    expect(parseFlagOverrides('   ').size).toBe(0);
  });

  it('reads a list of known flags, tolerating spacing and trailing commas', () => {
    const overrides = parseFlagOverrides(' courier.auto_book = on , inbox.chatwoot=off, ');
    expect(overrides.get('courier.auto_book')).toBe(true);
    expect(overrides.get('inbox.chatwoot')).toBe(false);
    expect(overrides.size).toBe(2);
  });

  it('accepts the spellings of yes and no a human would reach for', () => {
    for (const on of ['on', 'ON', 'true', '1', 'yes', 'enabled']) {
      expect(parseFlagOverrides(`fraud.phone_check=${on}`).get('fraud.phone_check'), on).toBe(true);
    }
    for (const off of ['off', 'FALSE', '0', 'no', 'disabled']) {
      expect(parseFlagOverrides(`fraud.phone_check=${off}`).get('fraud.phone_check'), off).toBe(
        false,
      );
    }
  });

  it('refuses a flag nobody declared, and says what is declared', () => {
    expect(() => parseFlagOverrides('reseler.portal=on')).toThrow(/not a known flag/);
    expect(() => parseFlagOverrides('reseler.portal=on')).toThrow(/reseller\.portal/);
  });

  it('refuses a clause with no value, and a value that is neither on nor off', () => {
    expect(() => parseFlagOverrides('courier.auto_book')).toThrow(/not key=value/);
    expect(() => parseFlagOverrides('courier.auto_book=maybe')).toThrow(/neither on nor off/);
  });

  /*
   * `courier.auto_book=on,courier.auto_book=off` has an answer — last wins — but
   * nobody reading the deploy config would know which, and the two halves of a
   * kill switch disagreeing is precisely the moment to stop the process.
   */
  it('refuses the same flag twice rather than picking one', () => {
    expect(() => parseFlagOverrides('pos.offline_queue=on,pos.offline_queue=off')).toThrow(
      /set twice/,
    );
  });
});

describe('flagOverridesFromEnv', () => {
  it('reads the variable out of an environment it is handed', () => {
    const overrides = flagOverridesFromEnv({ [FLAG_OVERRIDES_ENV]: 'reseller.portal=on' });
    expect(overrides.get('reseller.portal')).toBe(true);
  });

  it('is empty for an environment that sets nothing', () => {
    expect(flagOverridesFromEnv({}).size).toBe(0);
  });
});
