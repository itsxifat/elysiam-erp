import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, LOCALES, isLocale, messages, t } from './index.js';
import { en } from './locales/en.js';

/**
 * The catalogue's invariants (D-750, M04 check 6).
 *
 * `scripts/check-i18n.mjs` and the console's provider both assume this shape at
 * *runtime*: one English catalogue, no empty values, and no Bangla. The owner's
 * decision of 2026-10-11 is that the brands never wanted Bangla, so a Bangla
 * string anywhere in the catalogue is a regression, not a translation.
 */

/**
 * Bangla letters, vowel signs and digits: the Bengali block without the taka sign (U+09F3),
 * which a staff screen's `<Money>` and a few column headers still show (D-751).
 */
const BANGLA = /[\u0980-\u09F2\u09F4-\u09FF]/;

describe('the catalogues are the same shape', () => {
  it('is English and nothing else (D-750)', () => {
    expect([...LOCALES]).toEqual(['en']);
    expect(Object.keys(messages)).toEqual(['en']);
  });

  it('holds no Bangla text in any value', () => {
    const bangla = Object.entries(messages.en)
      .filter(([, value]) => BANGLA.test(value))
      .map(([key]) => key);
    expect(bangla).toEqual([]);
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

describe('document copy', () => {
  it('has the doc.* keys the console names documents by, in English', () => {
    const docs = Object.keys(en).filter((key) => key.startsWith('doc.'));
    expect(docs.length).toBeGreaterThan(10);
    for (const key of docs) expect(BANGLA.test(en[key as keyof typeof en]), key).toBe(false);
  });
});

describe('t()', () => {
  it('reads English, the one locale', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(t('common.cancel')).toBe('Cancel');
    expect(t('common.cancel', 'en')).toBe('Cancel');
  });

  it('knows a locale from a string off the wire, and Bangla is not one', () => {
    expect(isLocale('bn')).toBe(false);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('en-GB')).toBe(false);
    expect(isLocale('')).toBe(false);
  });
});
