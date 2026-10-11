import { STORAGE_KEYS, writeStored } from '@elysium/ui';
import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';

import { POS_MESSAGES, type PosMessageKey } from './messages.js';

/**
 * The till's language, and the lookup every screen uses (D-750).
 *
 * English only: the brands never wanted Bangla, so the cashier's screens and the customer's
 * receipt are both formal English and there is no switch.
 */

export type PosLocale = 'en';

type Translate = (key: PosMessageKey, values?: Readonly<Record<string, string>>) => string;

interface LocaleValue {
  readonly locale: PosLocale;
  readonly t: Translate;
}

const LocaleContext = createContext<LocaleValue | null>(null);

/** A message, with `{name}` placeholders filled. */
export function translate(
  locale: PosLocale,
  key: PosMessageKey,
  values: Readonly<Record<string, string>> = {},
): string {
  const template = POS_MESSAGES[locale][key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const locale: PosLocale = 'en';

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.add('font-sans');
    root.classList.remove('font-bangla');
    // A language chosen before D-750 is forgotten: there is only English now.
    writeStored(STORAGE_KEYS.tillLocale, null);
  }, [locale]);

  const value = useMemo<LocaleValue>(
    () => ({ locale, t: (key, values) => translate(locale, key, values) }),
    [locale],
  );
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext);
  if (value === null) throw new Error('useLocale needs a <LocaleProvider> above it.');
  return value;
}

export function usePosT(): Translate {
  return useLocale().t;
}
