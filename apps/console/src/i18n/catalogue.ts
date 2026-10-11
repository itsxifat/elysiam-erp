import type { Locale, MessageKey } from '@elysium/i18n';
import { en } from '@elysium/i18n/locales/en';

/**
 * The shared message catalogue (M05 check 5; D-750: English only).
 *
 * The core catalogue is bundled, because a first paint must not wait for a download. Each
 * area's section (M38a, D-607) is shipped in the chunk of the screens that use it and merged
 * in as that chunk loads (`registerSection`), so the initial route stays inside its budget as
 * the product grows. Reads are synchronous: a section registers before any of its screens
 * renders, so a screen never renders a key that is still on its way.
 */

/*
 * A copy, not the module's own object: sections are merged into it as their screens load,
 * and the imported catalogue stays as it was shipped.
 */
const loaded: Record<Locale, Record<MessageKey, string>> = {
  en: { ...en } as Record<MessageKey, string>,
};

/** Merge one area's section catalogue in. Registering twice is harmless. */
export function registerSection(
  strings: Readonly<Record<Locale, Readonly<Record<string, string>>>>,
): void {
  for (const locale of Object.keys(strings) as Locale[]) {
    Object.assign(loaded[locale], strings[locale]);
  }
}

export function catalogueFor(locale: Locale): Record<MessageKey, string> {
  return loaded[locale];
}
