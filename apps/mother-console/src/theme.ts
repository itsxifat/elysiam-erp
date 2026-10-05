/**
 * Light and dark (§24): a class on <html>, the values in the kit's tokens. Follows the OS
 * until the owner picks; `index.html` applies the saved choice before first paint.
 */
const STORAGE_KEY = 'owner-theme';

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function setTheme(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  try {
    localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
  } catch {
    // Storage denied: the theme holds for this visit.
  }
}
