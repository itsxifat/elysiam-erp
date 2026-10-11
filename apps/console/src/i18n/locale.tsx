import { DEFAULT_LOCALE, type Locale, type MessageKey } from '@elysium/i18n';
import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

import { catalogueFor } from './catalogue.js';

/**
 * The console's locale, and the lookup every screen uses (§24; D-750).
 *
 * English only: the owner's decision of 2026-10-11 is that the brands never wanted Bangla,
 * so there is no language switch and one catalogue. The locale still lives in context, and
 * `useT()` still closes over it, because every screen already reads `locale` for its dates
 * and counts; it is simply always English now.
 *
 * The key type is `MessageKey`, the shared catalogue's own. What matters is that the type is
 * not `string`: that would turn the missing-key check into a CI grep, and the failure it
 * guards against — `nav.orders` rendered literally on screen — is one a user finds, not a
 * test.
 */

interface LocaleContextValue {
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

function lookup(key: MessageKey, locale: Locale): string {
  const value = catalogueFor(locale)[key] as string | undefined;
  if (value === undefined) {
    // Unreachable while the key type holds. Thrown rather than returned so a catalogue edit
    // that breaks it fails loudly in development instead of shipping a screen that reads
    // like a variable name.
    throw new Error(`No ${locale} message for "${key}".`);
  }
  return value;
}

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const locale = DEFAULT_LOCALE;

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.add('font-sans');
    root.classList.remove('font-bangla');
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, t: (key: MessageKey) => lookup(key, locale) }),
    [locale],
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

export type { MessageKey as ConsoleT };
