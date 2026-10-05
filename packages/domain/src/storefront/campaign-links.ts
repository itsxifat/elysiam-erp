/**
 * The website's campaign links (M35b, D-551), ported from the old site's `lib/customUrl.js`.
 *
 * A campaign link is a marketing campaign laid over an existing shop address: a category, the
 * shop, or any path that lists products, with highlighted products, a banner and a pop-up. Each
 * has a five-digit code, and the address shared is the base path with `?cu=<code>`; the website
 * reads the campaign by its code and renders the extras.
 */

/** A campaign link's five-digit code, from a random integer (the old `generateUniqueCode`). */
export function campaignLinkCodeFrom(random: number): string {
  const value = 10_000 + (Math.abs(Math.trunc(random)) % 90_000);
  return String(value);
}

export const CAMPAIGN_LINK_CODE = /^\d{5}$/;

/**
 * A campaign's address on the website without its `?cu=` (the old `buildBasePath`): the
 * category's shop page, the shop, or the custom path.
 */
export function campaignBasePath(input: {
  readonly baseType: 'category' | 'shop' | 'custom';
  readonly categorySlug: string | null;
  readonly customPath: string | null;
}): string {
  if (input.baseType === 'category' && input.categorySlug !== null && input.categorySlug !== '') {
    return `/shop?category=${encodeURIComponent(input.categorySlug)}`;
  }
  if (input.baseType === 'custom' && input.customPath !== null && input.customPath !== '') {
    return input.customPath.startsWith('/') ? input.customPath : `/${input.customPath}`;
  }
  return '/shop';
}

/** The shareable address: the base path with `cu=<code>` joined correctly. */
export function campaignFullPath(basePath: string, code: string): string {
  return `${basePath}${basePath.includes('?') ? '&' : '?'}cu=${code}`;
}
