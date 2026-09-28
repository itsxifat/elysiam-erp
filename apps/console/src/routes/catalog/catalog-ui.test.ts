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
 * - a missing Bangla key throws at render time, on whichever screen happens to
 *   need it, for whichever user switched language;
 * - a slug that does not match the server's `^[a-z0-9]+(-[a-z0-9]+)*$` is a 400 on
 *   create, and the operator reads it as "the product name is invalid".
 */

describe('the catalog catalogue', () => {
  it('has the same keys in bn as in en', () => {
    const english = Object.keys(catalogEn).sort();
    const bangla = Object.keys(catalogMessages.bn).sort();
    expect(bangla).toEqual(english);
  });

  it('has a non-empty value for every key in both locales', () => {
    const empty: string[] = [];
    for (const [locale, catalogue] of Object.entries(catalogMessages)) {
      for (const [key, value] of Object.entries(catalogue)) {
        if (value.trim() === '') empty.push(`${locale}:${key}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('leaves ERP nouns in English inside the Bangla strings', () => {
    // Not pedantry: Dhaka ops staff say "SKU" and "barcode" in English, and D-036's
    // reasoning is that translated jargon slows an operator down rather than
    // helping. A Bangla transliteration here would be a regression nobody would
    // notice until a picker could not find the column they were told about.
    expect(catalogMessages.bn['catalog.colCode']).toContain('SKU');
    expect(catalogMessages.bn['catalog.labelsHelp']).toContain('Code 128');
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
