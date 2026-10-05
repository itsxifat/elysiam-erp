import { describe, expect, it } from 'vitest';

import { seedBrandsFrom, seedOrgsFor } from './index.js';

/** `pnpm db:seed --brand <slug>` and `SEED_BRANDS` (D-470, M31). */
describe('seedBrandsFrom', () => {
  it('reads --brand, --brand=, repeats, and falls back to SEED_BRANDS', () => {
    expect(seedBrandsFrom(['--brand', 'orvo'], {})).toEqual(['orvo']);
    expect(seedBrandsFrom(['--brand=orvo', '--brand', 'beownz'], {})).toEqual(['orvo', 'beownz']);
    expect(seedBrandsFrom([], { SEED_BRANDS: ' orvo , beownz ' })).toEqual(['orvo', 'beownz']);
    expect(seedBrandsFrom(['--brand', 'orvo'], { SEED_BRANDS: 'beownz' })).toEqual(['orvo']);
    expect(seedBrandsFrom([], {})).toBeUndefined();
    expect(seedBrandsFrom([], { SEED_BRANDS: '' })).toBeUndefined();
  });

  it('refuses --brand without a slug', () => {
    expect(() => seedBrandsFrom(['--brand'], {})).toThrow(/needs a slug/);
    expect(() => seedBrandsFrom(['--brand', '--other'], {})).toThrow(/needs a slug/);
  });
});

describe('seedOrgsFor', () => {
  it('is all five without a filter and exactly the named ones with it', () => {
    expect(seedOrgsFor(undefined)).toHaveLength(5);
    expect(seedOrgsFor(['orvo']).map((org) => org.slug)).toEqual(['orvo']);
  });

  it('refuses an unknown slug rather than seeding nothing', () => {
    expect(() => seedOrgsFor(['no-such-brand'])).toThrow(/no brand with the slug no-such-brand/);
    expect(() => seedOrgsFor([])).toThrow();
  });
});
