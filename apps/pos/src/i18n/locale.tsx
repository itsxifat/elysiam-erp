import { readStored, STORAGE_KEYS, writeStored } from '@elysium/ui';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { POS_MESSAGES, type PosMessageKey } from './messages.js';

/**
 * The till's screen language, and the lookup every screen uses (D-036).
 *
 * Staff screens default to English like the console; the cashier can switch. The
 * receipt does **not** follow this: it is customer-facing and prints in Bangla
 * unless changed on the receipt itself (`receiptT`).
 */

export type PosLocale = 'en' | 'bn';

type Translate = (key: PosMessageKey, values?: Readonly<Record<string, string>>) => string;

interface LocaleValue {
  readonly locale: PosLocale;
  readonly setLocale: (locale: PosLocale) => void;
  readonly t: Translate;
}

const LocaleContext = createContext<LocaleValue | null>(null);

/** A message in a given locale, with `{name}` placeholders filled. */
export function translate(
  locale: PosLocale,
  key: PosMessageKey,
  values: Readonly<Record<string, string>> = {},
): string {
  const template = POS_MESSAGES[locale][key];
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

function stored(): PosLocale {
  // Storage denied: English for this session.
  const value = readStored(STORAGE_KEYS.tillLocale);
  if (value === 'bn' || value === 'en') return value;
  return 'en';
}

export function LocaleProvider({ children }: { readonly children: ReactNode }) {
  const [locale, setState] = useState<PosLocale>(stored);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    // The Bangla stack replaces the Latin one, so its `size-adjust` applies.
    root.classList.toggle('font-bangla', locale === 'bn');
    root.classList.toggle('font-sans', locale !== 'bn');
  }, [locale]);

  const setLocale = useCallback((next: PosLocale) => {
    setState(next);
    // Storage denied: still applies to this session.
    writeStored(STORAGE_KEYS.tillLocale, next);
  }, []);

  const value = useMemo<LocaleValue>(
    () => ({ locale, setLocale, t: (key, values) => translate(locale, key, values) }),
    [locale, setLocale],
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
