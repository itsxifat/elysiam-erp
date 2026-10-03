import { reapplyBrand } from './brand.js';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'elysium-theme';

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

  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Private browsing denies storage; the theme still applies for this session.
  }
}

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Fall through to the OS preference.
  }
  return 'system';
}

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}
