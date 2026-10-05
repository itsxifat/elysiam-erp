/**
 * A product's old web addresses (M33, D-500).
 *
 * A product's slug is its address on the website (`/shop/<slug>`). Renaming it must not
 * break the links already shared on Facebook, printed on a card or indexed by Google, so the
 * old slug is kept in `previous_slugs` and answers with a redirect to the new one.
 *
 * Two rules, and the second is the one that is easy to miss:
 *
 * 1. **A rename keeps the old slug.** The slug the product leaves goes to the front of its
 *    history; the slug it arrives at leaves its history (renaming back is not a redirect to
 *    itself).
 * 2. **Taking a slug releases it everywhere else.** When a product becomes `x`, any other
 *    product that used to be `x` stops redirecting from it — the address now belongs to the
 *    product that is there. Without this, `x` would sit in one product's current slug and in
 *    another's history, and which one a shopper reached would depend on query order.
 *
 * Together they keep one invariant, which the database trigger in the M33 migration enforces
 * the same way and the property test checks: **within a brand, a slug is in at most one place
 * across every product's current slug and history.** `resolveSlug` then never has to choose.
 */

/** How many old addresses a product keeps. The oldest fall off. */
export const SLUG_HISTORY_LIMIT = 20;

/** The history after a product's slug changes from `from` to `to`. */
export function recordSlugChange(
  previous: readonly string[],
  from: string,
  to: string,
  limit: number = SLUG_HISTORY_LIMIT,
): string[] {
  if (from === to) return dedupe(previous.filter((slug) => slug !== to)).slice(0, limit);
  return dedupe([from, ...previous].filter((slug) => slug !== to)).slice(0, limit);
}

/** Another product's history once `taken` has become somebody's current slug. */
export function releaseSlug(previous: readonly string[], taken: string): string[] {
  return previous.filter((slug) => slug !== taken);
}

function dedupe(slugs: readonly string[]): string[] {
  return [...new Set(slugs)];
}

export interface SlugOwner {
  readonly id: string;
  readonly slug: string;
  readonly previousSlugs: readonly string[];
}

export type SlugResolution =
  | { readonly kind: 'current'; readonly id: string }
  | { readonly kind: 'redirect'; readonly id: string; readonly slug: string }
  | { readonly kind: 'none' };

/**
 * Where an address leads: the product that is there now, the product that used to be there
 * (a redirect to its current slug), or nothing.
 *
 * The current slug always wins, which is rule 2 read from the other side. Should the
 * invariant ever be broken (two histories naming the same slug), the answer is `none`
 * rather than a guess: a 404 is a smaller harm than sending a shopper to the wrong product.
 */
export function resolveSlug(slug: string, owners: readonly SlugOwner[]): SlugResolution {
  const current = owners.find((owner) => owner.slug === slug);
  if (current !== undefined) return { kind: 'current', id: current.id };
  const former = owners.filter((owner) => owner.previousSlugs.includes(slug));
  const only = former[0];
  if (former.length !== 1 || only === undefined || only.slug === slug) return { kind: 'none' };
  return { kind: 'redirect', id: only.id, slug: only.slug };
}
