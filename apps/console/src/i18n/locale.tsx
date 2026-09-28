import {
  DEFAULT_LOCALE,
  fontClassFor,
  isLocale,
  messages as sharedMessages,
  type Locale,
  type MessageKey,
} from '@elysium/i18n';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * The console's locale, and the lookup every screen uses (D-036, §24).
 *
 * `t()` from `@elysium/i18n` is a pure function of (key, locale), which is right
 * for a server rendering an invoice and wrong for a React tree: every component
 * would have to be handed the locale, and the one that forgot would render half
 * the screen in English inside a Bangla page. So the locale lives in context and
 * `useT()` closes over it.
 *
 * The key type is `MessageKey`, the shared catalogue's own. It was a union with a
 * console-local key type while the console kept its strings in
 * `apps/console/src/i18n/messages.ts`; now that they are in the catalogue the
 * union would only widen what a section may pass without adding a key to it. What
 * matters is that the type is not `string`: that would turn the missing-key check
 * into a CI grep, and the failure it guards against — `nav.orders` rendered
 * literally on screen — is one a user finds, not a test.
 *
 * `<html lang>` and the font class are set from the same state. The font class is
 * not cosmetic: Bangla renders in Hind Siliguri with its own `size-adjust`, and
 * without it a mixed bn/en string sits on two optical baselines (check 9).
 */

const STORAGE_KEY = 'elysium-locale';

interface LocaleContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function lookup(key: MessageKey, locale: Locale): string {
  const value = sharedMessages[locale][key] as string | undefined;
  if (value === undefined) {
    // Unreachable while the key type holds. Thrown rather than returned so a
    // catalogue edit that breaks it fails loudly in development instead of
    // shipping a screen that reads like a variable name.
    throw new Error(`No ${locale} message for "${key}".`);
  }
  return value;
}

export function readStoredLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && isLocale(saved)) return saved;
  } catch {
    // Private browsing denies storage. English for this session, per D-036.
  }
  return DEFAULT_LOCALE;
}

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    // Both classes are toggled rather than one being set, because the Bangla
    // stack has to *replace* the Latin one — leaving `font-sans` on means the
    // Bangla glyphs fall through to Inter's fallback and the `size-adjust` never
    // applies.
    root.classList.toggle('font-bangla', locale === 'bn');
    root.classList.toggle('font-sans', locale !== 'bn');
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies to this session.
    }
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: (key: MessageKey) => lookup(key, locale) }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (value === null) throw new Error('useLocale needs a <LocaleProvider> above it.');
  return value;
}

/** Just the lookup, which is what most components want. */
export function useT(): (key: MessageKey) => string {
  return useLocale().t;
}

export { fontClassFor };
export type { MessageKey as ConsoleT };
