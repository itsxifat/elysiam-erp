import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@elysium/ui/styles/tailwind.css';

import { ConsoleApp } from './console-app.js';
import { preloadStoredLocale } from './i18n/locale.js';

/**
 * The browser entry point.
 *
 * It waits for the stored locale's strings before mounting. English is bundled, so
 * for most sessions that is already resolved; a Bangla session fetches its
 * catalogue first, so no screen ever renders before its strings exist. A failed
 * fetch still mounts, in English, rather than leaving a blank page.
 */
const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

const mount = () =>
  createRoot(container).render(
    <StrictMode>
      <ConsoleApp />
    </StrictMode>,
  );

preloadStoredLocale().then(mount, () => {
  try {
    localStorage.removeItem('elysium-locale');
  } catch {
    // Storage denied: the default applies anyway.
  }
  mount();
});
