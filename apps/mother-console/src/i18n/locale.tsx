import { type Locale } from '@elysium/i18n';
import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

import { en, type MessageKey } from './locales/en.js';

/**
 * The console's language (D-494; D-750: English only). The owner's decision of 2026-10-11 is
 * that the brands never wanted Bangla, so there is one catalogue and no switch.
 */

const catalogues: Record<Locale, Record<MessageKey, string>> = { en };

export type { MessageKey };

interface LocaleValue {
  readonly locale: Locale;
  readonly t: (key: MessageKey) => string;
}

const LocaleContext = createContext<LocaleValue | null>(null);

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const locale: Locale = 'en';

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.add('font-sans');
    root.classList.remove('font-bangla');
    try {
      // A language chosen before D-750 is forgotten: there is only English now.
      localStorage.removeItem('owner-locale');
    } catch {
      // Storage denied: nothing was kept.
    }
  }, [locale]);

  const value = useMemo<LocaleValue>(
    () => ({ locale, t: (key: MessageKey) => catalogues[locale][key] }),
    [locale],
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
