import { createHash } from 'node:crypto';

/**
 * The five sister brands (architecture §1).
 *
 * Ids are derived from the slug rather than generated, so running the seed on
 * a fresh database twice — or on two machines — produces the same ids. That is
 * what lets fixtures, tests and an operator's bookmarked URL all keep working,
 * and it is why the seed can be idempotent without a lookup.
 */

/** Fixed namespace, so the derivation never changes. */
const NAMESPACE = 'elysium-erp/org';

/**
 * A deterministic, RFC-4122-shaped v5 UUID.
 *
 * Written out rather than pulled from a package: it is a hash, a handful of
 * bit twiddles, and a format string, and a dependency here would be one more
 * thing to audit for something this load-bearing.
 */
export function deterministicUuid(namespace: string, name: string): string {
  const digest = createHash('sha1').update(`${namespace}:${name}`).digest();

  // Version 5, variant RFC 4122.
  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export interface SeedOrg {
  readonly slug: string;
  readonly legalName: string;
  readonly displayName: string;
  /** OKLCH hue and chroma for the accent (D-034). */
  readonly brandHue: number;
  readonly brandChroma: number;
}

/**
 * Brand hues are spread around the colour circle as placeholders until the
 * client supplies real brand colours (D-034 follow-up). They are only ever
 * input: `resolveBrandAccent()` in packages/ui solves for a lightness at which
 * the accent stays legible, so a placeholder cannot produce an unreadable UI.
 */
export const SEED_ORGS: readonly SeedOrg[] = [
  {
    slug: 'elysium-lifestyle-bd',
    legalName: 'Elysiam Lifestyle BD',
    displayName: 'Elysiam Lifestyle BD',
    brandHue: 259,
    brandChroma: 0.17,
  },
  {
    slug: 'oura-lifestyle',
    legalName: 'Oura Lifestyle',
    displayName: 'Oura',
    brandHue: 25,
    brandChroma: 0.17,
  },
  {
    slug: 'orvo',
    legalName: 'Orvo',
    displayName: 'Orvo',
    brandHue: 152,
    brandChroma: 0.15,
  },
  {
    slug: 'wear-x-clothing',
    legalName: 'Wear X Clothing',
    displayName: 'Wear X',
    brandHue: 300,
    brandChroma: 0.16,
  },
  {
    slug: 'beownz',
    legalName: 'Beownz',
    displayName: 'Beownz',
    brandHue: 75,
    brandChroma: 0.16,
  },
];

export function seedOrgId(slug: string): string {
  return deterministicUuid(NAMESPACE, slug);
}

/** Ids the tests and later seeds refer to by name. */
export const SEED_ORG_IDS = Object.fromEntries(
  SEED_ORGS.map((org) => [org.slug, seedOrgId(org.slug)]),
) as Record<string, string>;
