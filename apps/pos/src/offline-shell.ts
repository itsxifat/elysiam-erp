/**
 * The offline shell (architecture §24 "PWAs": installable, with an offline shell).
 *
 * A till that loses its connection must still *start*: a tablet that restarts
 * mid-shift has to come back to the sale screen, not to the browser's offline
 * page. The hand-written worker in `public/sw.js` serves the shell from the Cache
 * API; this file registers it and puts the files of the page that is already
 * running into that cache.
 *
 * The second step is the one a worker cannot do for itself. The first visit's
 * scripts and styles were fetched before any worker controlled the page, so the
 * worker never saw them — and Vite's file names are content hashes it has no list
 * of. The page knows exactly what it loaded, so the page caches it.
 *
 * Production builds only: under the dev server the modules are unbundled and
 * change on every save, and a worker caching them would serve stale code.
 */

const SHELL_CACHE = 'elysium-pos-shell-v1';

export function registerOfflineShell(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      // No worker means no offline start; the till still works while it stays open.
    });
    void cacheRunningPage();
  });
}

async function cacheRunningPage(): Promise<void> {
  if (!('caches' in window)) return;
  const urls = new Set<string>(['/']);
  for (const element of document.querySelectorAll(
    'script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href], link[rel="manifest"][href]',
  )) {
    const url = element.getAttribute('src') ?? element.getAttribute('href');
    if (url !== null) urls.add(new URL(url, location.href).pathname);
  }
  for (const entry of performance.getEntriesByType('resource')) {
    const url = new URL(entry.name);
    // Same-origin files only: API responses are never cached here. What the till
    // may use offline is in IndexedDB, written on purpose, not a copy of whatever
    // the last request happened to return.
    if (url.origin === location.origin) urls.add(url.pathname);
  }
  /*
   * Every font the stylesheet names, not only the ones this visit happened to use.
   * A browser fetches a face when text first needs it, so a till that has only
   * shown English has never downloaded Hind Siliguri — and the receipt is Bangla.
   * Without this the first Bangla receipt printed offline falls back to whatever
   * the tablet has, on the one document the customer takes away.
   */
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // A cross-origin sheet: not ours, and not readable.
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      for (const match of rule.style
        .getPropertyValue('src')
        .matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
        const url = new URL(match[1] ?? '', sheet.href ?? location.href);
        if (url.origin === location.origin) urls.add(url.pathname);
      }
    }
  }
  try {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all([...urls].map((url) => cache.add(url).catch(() => undefined)));
  } catch {
    // Storage denied (private browsing): online-only, which is where we started.
  }
}
