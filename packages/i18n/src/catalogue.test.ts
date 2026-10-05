import { describe, expect, it } from 'vitest';

import { CUSTOMER_LOCALE, DEFAULT_LOCALE, LOCALES, isLocale, messages, t } from './index.js';
import { bn } from './locales/bn.js';
import { en } from './locales/en.js';

/**
 * The catalogue's invariants (D-036, M04 check 6).
 *
 * The compiler already enforces key parity — `bn` is `Record<MessageKey,
 * string>` — so half of this is belt and braces. It is here anyway because
 * `scripts/check-i18n.mjs` and the console's provider both assume this shape at
 * *runtime*: same keys, no empty values, and Bangla that is actually Bangla. A
 * type can be widened in one careless edit; this fails instead.
 */

/** Anything in the Bengali block, including the digits and the ৳ sign's neighbours. */
const BANGLA = /[ঀ-৿]/;

describe('the catalogues are the same shape', () => {
  it('has the same keys in every locale', () => {
    // Every key: the core catalogue's and its sections' (M38a, D-607).
    const keys = Object.keys(messages.en).sort();
    for (const locale of LOCALES) {
      expect(Object.keys(messages[locale]).sort(), `${locale} keys`).toEqual(keys);
    }
  });

  it('never maps a key to an empty or padded string', () => {
    const bad: string[] = [];
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(messages[locale])) {
        if (value.trim() === '' || value !== value.trim()) bad.push(`${locale}:${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('names keys the one way — lowerCamel segments separated by dots', () => {
    /*
     * The one exception is the *last* segment, which may be snake_case, because a
     * family of status labels is built straight from a domain enum value:
     * `hr.run.${run.status}` reaches `hr.run.pending_approval` with no lookup
     * table in between. Spelling the key `pendingApproval` would need one table
     * per enum, and a table is a second list to forget when a status is added —
     * which fails silently, because those call sites cast to the key type. An
     * interior segment stays lowerCamel: nothing builds a key out of two holes.
     */
    const wrong = Object.keys(messages.en).filter(
      (key) =>
        !/^[a-z][a-zA-Z0-9]*(\.[a-z0-9][a-zA-Z0-9]*)*\.[a-z0-9][a-zA-Z0-9]*(?:_[a-z0-9][a-zA-Z0-9]*)*$/.test(
          key,
        ),
    );
    expect(wrong).toEqual([]);
  });
});

describe('customer-facing copy is Bangla', () => {
  /*
   * D-036 says every document a customer receives is Bangla. An English string
   * left in `doc.*` is not a cosmetic slip: it ships on an invoice inside a
   * parcel, where nobody sees it until the customer does. The English side of
   * `doc.*` exists only so a super admin can review a rendered document.
   */
  it('translates every doc.* string', () => {
    const untranslated = Object.keys(en)
      .filter((key) => key.startsWith('doc.'))
      .filter((key) => !BANGLA.test(bn[key as keyof typeof bn]));
    expect(untranslated).toEqual([]);
  });

  it('and has documents to translate at all, so the check above cannot pass vacuously', () => {
    expect(Object.keys(en).filter((key) => key.startsWith('doc.')).length).toBeGreaterThan(10);
  });
});

describe('t()', () => {
  it('defaults to the console locale and takes an explicit one', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(CUSTOMER_LOCALE).toBe('bn');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('common.cancel', 'en')).toBe('Cancel');
    expect(t('common.cancel', 'bn')).toBe(bn['common.cancel']);
    expect(BANGLA.test(t('common.cancel', 'bn'))).toBe(true);
  });

  it('knows a locale from a string off the wire', () => {
    expect(isLocale('bn')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('en-GB')).toBe(false);
    expect(isLocale('')).toBe(false);
  });
});
