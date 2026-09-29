/**
 * The tracking page's pure pieces, apart from React so a test can import them (M15).
 */

/**
 * The brand a tracking link is for, from `/track/<brand-slug>`.
 *
 * The brand is in the path because every brand's website links to its own tracking page,
 * and an order number is only unique within one brand. A slug is lower-case letters, digits
 * and hyphens, exactly as `org.organizations.slug` stores it; anything else is no brand.
 */
export function brandFromPath(pathname: string): string | null {
  const match = /^\/track\/([a-z0-9][a-z0-9-]{1,79})\/?$/.exec(pathname);
  return match?.[1] ?? null;
}

/** Whether a path is the tracking page at all, with or without a brand. */
export function isTrackingPath(pathname: string): boolean {
  return pathname === '/track' || pathname.startsWith('/track/');
}

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Bangla digits as ASCII, spaces and dashes dropped: what a customer typed, as a number. */
export function digitsOf(input: string): string {
  let out = '';
  for (const char of input) {
    const index = BANGLA_DIGITS.indexOf(char);
    out += index >= 0 ? String(index) : char;
  }
  return out.replace(/[\s\-‐-―]/g, '');
}

/**
 * Whether the form is worth sending.
 *
 * Deliberately loose — the server normalises and decides — and only here so a customer who
 * typed three digits is told so at once instead of spending one of their rate-limited tries.
 */
export function readyToSubmit(orderNo: string, phoneLast4: string): boolean {
  return orderNo.trim().length >= 3 && /^\d{4}$/.test(digitsOf(phoneLast4.trim()));
}
