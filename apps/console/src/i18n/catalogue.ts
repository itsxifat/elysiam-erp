import type { Locale, MessageKey } from '@elysium/i18n';
import { en } from '@elysium/i18n/locales/en';

/**
 * The shared message catalogue, one locale at a time (M05 check 5, D-036).
 *
 * English is bundled, because the console defaults to it (D-036) and a first paint
 * must not wait for a download. Bangla is fetched the first time it is needed: when
 * the stored preference is Bangla, before the first render, and when someone
 * switches. Shipping both up front put the initial route at 277 KB gzipped against
 * a 250 KB budget on 2026-09-30, and every milestone after M23 adds strings in both.
 *
 * Reads are synchronous, so a screen never renders a key that is still loading:
 * `LocaleProvider` switches only after `loadLocale` resolves, and `entry.tsx` waits
 * for the stored locale before it mounts anything. A read of a locale that was
 * never loaded is a bug in that ordering, and throws rather than falling back to
 * English inside a Bangla page.
 */

/*
 * A copy, not the module's own object: sections are merged into it as their screens load
 * (`registerSection`), and the imported catalogue stays as it was shipped.
 */
const loaded: Partial<Record<Locale, Record<MessageKey, string>>> = {
  en: { ...en } as Record<MessageKey, string>,
};

/** Section strings that arrived before their locale did (Bangla loads on demand). */
const pending: Partial<Record<Locale, Record<string, string>>> = {};

export async function loadLocale(locale: Locale): Promise<void> {
  if (loaded[locale] !== undefined) return;
  if (locale === 'bn') {
    const bn = (await import('@elysium/i18n/locales/bn')).bn;
    loaded.bn = { ...bn, ...pending.bn } as Record<MessageKey, string>;
  }
}

/**
 * Merge one area's section catalogue into both locales (M38a, D-607).
 *
 * A section is shipped in the chunk of the screens that use it, not in the first download,
 * so the initial route stays inside its budget as the product grows. The module that holds a
 * section calls this as it loads, before any of its screens renders, so a read stays
 * synchronous: a screen never renders a key that is still on its way.
 */
export function registerSection(
  strings: Readonly<Record<Locale, Readonly<Record<string, string>>>>,
): void {
  for (const locale of Object.keys(strings) as Locale[]) {
    const target = loaded[locale];
    if (target === undefined) pending[locale] = { ...pending[locale], ...strings[locale] };
    else Object.assign(target, strings[locale]);
  }
}

export function catalogueFor(locale: Locale): Record<MessageKey, string> {
  const catalogue = loaded[locale];
  if (catalogue === undefined) {
    throw new Error(`The ${locale} catalogue was read before loadLocale('${locale}') resolved.`);
  }
  return catalogue;
}
