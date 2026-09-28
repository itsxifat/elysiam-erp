import { LOCALES } from '@elysium/i18n';
import { describe, expect, it } from 'vitest';

import { consoleBn, consoleEn, consoleMessages } from './messages.js';

/**
 * M05 acceptance checks 3 and 4, for the console's own catalogue.
 *
 * Check 3 is "every UI string key exists in both bn and en"; check 4 is the lint
 * rule that forbids emoji in UI source. `consoleBn`'s type already makes a missing
 * key a compile error, so what is left to assert at runtime is the two things a
 * type cannot see: that no value was left as an empty string or as the English
 * text pasted into the Bangla file, and that no emoji crept in.
 *
 * The empty-string case matters because it type-checks perfectly and renders as a
 * missing label — a button with no words on it.
 */

describe('the console catalogue is complete in both locales (check 3)', () => {
  it('has both locales', () => {
    expect(Object.keys(consoleMessages).sort()).toStrictEqual([...LOCALES].sort());
  });

  it('has the same key set in bn and en', () => {
    expect(Object.keys(consoleBn).sort()).toStrictEqual(Object.keys(consoleEn).sort());
  });

  it('leaves no value empty in either locale', () => {
    for (const [locale, catalogue] of Object.entries(consoleMessages)) {
      for (const [key, value] of Object.entries(catalogue)) {
        expect(value.trim(), `${locale}:${key}`).not.toBe('');
      }
    }
  });

  it('actually translated the Bangla values', () => {
    /*
     * A Bangla catalogue that is a copy of the English one passes every other
     * check here and every CI key check, and a Bangladeshi user opening the
     * console in Bangla sees English. Exempting the handful of values that are
     * *supposed* to be identical — a keyboard shortcut, a role identifier — keeps
     * this honest rather than making it noise.
     */
    const identicalByDesign = new Set(['shell.paletteHint']);

    const untranslated = Object.keys(consoleEn).filter(
      (key) =>
        !identicalByDesign.has(key) &&
        consoleBn[key as keyof typeof consoleBn] === consoleEn[key as keyof typeof consoleEn],
    );

    expect(untranslated).toStrictEqual([]);
  });
});

describe('no emoji in user-facing strings (check 4)', () => {
  it('has none in either catalogue', () => {
    // §24: icons are lucide-react, never emoji. A catalogue is the one place the
    // ESLint rule cannot see a difference between a decorative glyph and text, so
    // it is asserted here as well.
    const emoji = /\p{Extended_Pictographic}/u;
    for (const [locale, catalogue] of Object.entries(consoleMessages)) {
      for (const [key, value] of Object.entries(catalogue)) {
        expect(emoji.test(value), `${locale}:${key}`).toBe(false);
      }
    }
  });
});
