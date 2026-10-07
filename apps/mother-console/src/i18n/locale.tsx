import { isLocale, type Locale } from '@elysium/i18n';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { bn } from './locales/bn.js';
import { en, type MessageKey } from './locales/en.js';

/**
 * The console's language (D-036, D-494): English by default, Bangla on request, both
 * bundled (the catalogue is small). `<html lang>` and the Bangla font class follow it.
 */

const STORAGE_KEY = 'owner-locale';
const catalogues: Record<Locale, Record<MessageKey, string>> = { en, bn };

export type { MessageKey };

interface LocaleValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: (key: MessageKey) => string;
}

const LocaleContext = createContext<LocaleValue | null>(null);

function stored(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && isLocale(saved)) return saved;
  } catch {
    // Storage denied: English for this visit.
  }
  return 'en';
}

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(stored);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.toggle('font-bangla', locale === 'bn');
    root.classList.toggle('font-sans', locale !== 'bn');
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still holds for this visit.
    }
  }, []);

  const value = useMemo<LocaleValue>(
    () => ({ locale, setLocale, t: (key: MessageKey) => catalogues[locale][key] }),
    [locale, setLocale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext);
  if (value === null) throw new Error('useLocale needs a <LocaleProvider> above it.');
  return value;
}

export function useT(): (key: MessageKey) => string {
  return useLocale().t;
}
