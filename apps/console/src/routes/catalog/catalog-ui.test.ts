import { describe, expect, it } from 'vitest';

import { catalogEn, catalogMessages } from './messages.js';
import { slugify } from './slug.js';

/**
 * The catalog screens' two pure pieces.
 *
 * The rest of these screens is React talking to an endpoint the server suite
 * already covers; these two are the bits that can be wrong on their own, and both
 * have a failure mode a manual click-through would not show:
 *
 * - a missing key throws at render time, on whichever screen happens to need it;
 * - a slug that does not match the server's `^[a-z0-9]+(-[a-z0-9]+)*$` is a 400 on
 *   create, and the operator reads it as "the product name is invalid".
 */

describe('the catalog catalogue', () => {
  it('is English only (D-750)', () => {
    expect(Object.keys(catalogMessages)).toEqual(['en']);
    expect(Object.keys(catalogEn).length).toBeGreaterThan(10);
  });

  it('has a non-empty value for every key', () => {
    const empty: string[] = [];
    for (const [locale, catalogue] of Object.entries(catalogMessages)) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (value.trim() === '') empty.push(`${locale}:${key}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('names the columns the way Dhaka ops staff say them', () => {
    expect(catalogEn['catalog.colCode']).toContain('SKU');
    expect(catalogEn['catalog.labelsHelp']).toContain('Code 128');
  });
});

describe('slugify', () => {
  it('produces what the server’s slug schema accepts', () => {
    const shape = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const name of [
      'Oxford Shirt',
      "  Men's  shirts  ",
      'Panjabi — embroidered',
      'Café kurta',
      'XXL',
      '2026 collection',
    ]) {
      expect(slugify(name)).toMatch(shape);
    }
  });

  it('never returns an empty slug, even for a name with no ASCII at all', () => {
    // Bangla drops out rather than being transliterated: a guessed transliteration
    // is a web address nobody can predict. The fallback is ugly and unique, which
    // is the right trade against a 400 the operator cannot act on.
    const slug = slugify('লাল পাঞাবি');
    expect(slug).not.toBe('');
    expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});
