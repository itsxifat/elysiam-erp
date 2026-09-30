import {
  DEFAULT_LOCALE,
  fontClassFor,
  isLocale,
  type Locale,
  type MessageKey,
} from '@elysium/i18n';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { catalogueFor, loadLocale } from './catalogue.js';

/**
 * The console's locale, and the lookup every screen uses (D-036, §24).
 *
 * `t()` from `@elysium/i18n` is a pure function of (key, locale), which is right
 * for a server rendering an invoice and wrong for a React tree: every component
 * would have to be handed the locale, and the one that forgot would render half
 * the screen in English inside a Bangla page. So the locale lives in context and
 * `useT()` closes over it. The console never imports that `t`: it defaults to
 * English, and three components that did rendered the login screen in English for
 * a Bangla user until 2026-09-30.
 *
 * The key type is `MessageKey`, the shared catalogue's own. What matters is that
 * the type is not `string`: that would turn the missing-key check into a CI grep,
 * and the failure it guards against — `nav.orders` rendered literally on screen —
 * is one a user finds, not a test.
 *
 * `<html lang>` and the font class are set from the same state. The font class is
 * not cosmetic: Bangla renders in Hind Siliguri with its own `size-adjust`, and
 * without it a mixed bn/en string sits on two optical baselines (check 9).
 *
 * Bangla is fetched on demand (`catalogue.ts`), so switching waits for it: the
 * locale changes only once its strings are here, and never renders a half-loaded
 * screen.
 */

const STORAGE_KEY = 'elysium-locale';

interface LocaleContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function lookup(key: MessageKey, locale: Locale): string {
  const value = catalogueFor(locale)[key] as string | undefined;
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

/** Fetch the stored locale's strings. `entry.tsx` awaits this before mounting. */
export function preloadStoredLocale(): Promise<void> {
  return loadLocale(readStoredLocale());
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
    void loadLocale(next)
      .then(() => {
        setLocaleState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // The choice still applies to this session.
        }
      })
      .catch(() => {
        // The strings could not be fetched (offline). Stay in the current locale
        // rather than switch to a screen of missing keys.
      });
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
