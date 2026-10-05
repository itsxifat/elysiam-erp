import { readStored, STORAGE_KEYS, writeStored } from '@elysium/ui';

import { reapplyBrand } from './brand.js';

export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * Dark mode is a class on <html> (architecture §24). Values live once in
 * tokens.css; this only decides when to apply them.
 *
 * M05 moves this into the console shell with a proper per-user setting. Until
 * then it is the smallest thing that proves both themes render.
 */
export function applyTheme(preference: ThemePreference): void {
  const dark =
    preference === 'dark' ||
    (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  document.documentElement.classList.toggle('dark', dark);
  // The brand's accent is solved per theme; solve it again for this one.
  reapplyBrand();

  // Private browsing denies storage; the theme still applies for this session.
  writeStored(STORAGE_KEYS.theme, preference === 'system' ? null : preference);
}

export function readThemePreference(): ThemePreference {
  const saved = readStored(STORAGE_KEYS.theme);
  if (saved === 'light' || saved === 'dark') return saved;
  return 'system';
}

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}
