/**
 * The locale type, on its own so nothing has to import the catalogue to get it.
 *
 * It used to live in `index.ts`, which meant `money.ts` imported its own
 * barrel: harmless while the import was type-only, but the moment a formatter
 * needed a value from the barrel the cycle would have become real, and an ESM
 * cycle resolves to `undefined` at module evaluation time rather than throwing.
 * Splitting the type out keeps the package's import graph a tree.
 *
 * ## English only (D-750)
 *
 * The owner, 2026-10-11: the brands never wanted Bangla, invoices above all.
 * Everything — the console, the till, the portal, every document, SMS and
 * email — is formal English, so there is one locale. The type is kept, rather
 * than every call site losing its `locale` argument, because a date or a count
 * still asks "in which locale" and the answer is now always this one.
 */

export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];

/** The one locale every surface renders in (D-750). */
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
