import { describe, expect, it } from 'vitest';

import { banglaCharactersIn, isFreeOfBangla } from './index.js';

/** D-750: the check every document, message and receipt test relies on. */
describe('English-only text', () => {
  it('passes English and flags every Bengali-block character, the taka sign included', () => {
    expect(isFreeOfBangla('Order ELY-2610-00042 · Tk 1,250.00 — Dhaka')).toBe(true);
    const taka = String.fromCodePoint(0x09f3);
    const ka = String.fromCodePoint(0x0995);
    const one = String.fromCodePoint(0x09e7);
    expect(isFreeOfBangla(`${taka}1,250`)).toBe(false);
    expect(banglaCharactersIn(`${ka}${one} and ${ka} again ${taka}`)).toEqual([ka, one, taka]);
  });

  it('covers the whole block, U+0980 to U+09FF, and nothing either side of it', () => {
    for (let code = 0x0980; code <= 0x09ff; code += 1) {
      expect(isFreeOfBangla(String.fromCodePoint(code)), code.toString(16)).toBe(false);
    }
    expect(isFreeOfBangla(String.fromCodePoint(0x097f))).toBe(true);
    expect(isFreeOfBangla(String.fromCodePoint(0x0a00))).toBe(true);
  });
});
