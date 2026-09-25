/**
 * The locale type, on its own so nothing has to import the catalogue to get it.
 *
 * It used to live in `index.ts`, which meant `money.ts` imported its own
 * barrel: harmless while the import was type-only, but the moment a formatter
 * needed a value from the barrel — a digit table, a default locale — the cycle
 * would have become real, and an ESM cycle resolves to `undefined` at module
 * evaluation time rather than throwing. Splitting the type out keeps the
 * package's import graph a tree.
 */

export const LOCALES = ['en', 'bn'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * The staff console defaults to English (D-036).
 *
 * Not a compromise: Bangladeshi ops speech already uses the English ERP nouns,
 * and translated jargon measurably slows staff down. Per-user override
 * everywhere.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * Everything a customer or partner receives is Bangla (D-036): invoices,
 * courier labels, payslips, SMS, notifications, the reseller portal, the
 * landing pages.
 *
 * Read this constant rather than writing `'bn'` at a call site, so that the day
 * one brand ships an English-first storefront there is one place to argue about
 * rather than forty string literals to find.
 */
export const CUSTOMER_LOCALE: Locale = 'bn';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * Bangla needs its own font stack and a different `size-adjust` (§24), so the
 * app has to know which script it is rendering, not only which locale. The
 * classes are defined by the token layer in `packages/ui`.
 */
export function fontClassFor(locale: Locale): string {
  return locale === 'bn' ? 'font-bangla' : 'font-sans';
}
