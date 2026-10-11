import { LOCALES } from '@elysium/i18n';
import { describe, expect, it } from 'vitest';

import { consoleEn, consoleMessages } from './messages.js';

/**
 * M05 acceptance checks 3 and 4, for the console's own catalogue, English only (D-750).
 *
 * Check 3 is "every UI string key exists"; check 4 is the lint rule that forbids emoji in
 * UI source. What is left to assert at runtime is what a type cannot see: that no value was
 * left as an empty string (it type-checks perfectly and renders as a button with no words on
 * it), and that no emoji crept in.
 */

describe('the console catalogue is complete and English (check 3, D-750)', () => {
  it('has English and nothing else', () => {
    expect(Object.keys(consoleMessages)).toStrictEqual([...LOCALES]);
    expect([...LOCALES]).toStrictEqual(['en']);
  });

  it('leaves no value empty', () => {
    for (const [key, value] of Object.entries(consoleEn)) {
      expect(value.trim(), key).not.toBe('');
    }
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
