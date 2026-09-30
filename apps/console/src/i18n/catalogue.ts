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

const loaded: Partial<Record<Locale, Record<MessageKey, string>>> = { en };

export async function loadLocale(locale: Locale): Promise<void> {
  if (loaded[locale] !== undefined) return;
  if (locale === 'bn') {
    loaded.bn = (await import('@elysium/i18n/locales/bn')).bn;
  }
}

export function catalogueFor(locale: Locale): Record<MessageKey, string> {
  const catalogue = loaded[locale];
  if (catalogue === undefined) {
    throw new Error(`The ${locale} catalogue was read before loadLocale('${locale}') resolved.`);
  }
  return catalogue;
}
