import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@elysium/ui/styles/tailwind.css';
import { STORAGE_KEYS, writeStored } from '@elysium/ui';

import { ConsoleApp } from './console-app.js';

/**
 * The browser entry point. The console is English only (D-750), so its strings are bundled
 * and nothing waits before mounting.
 */
const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

// A language chosen before D-750 is forgotten: there is only English now.
writeStored(STORAGE_KEYS.consoleLocale, null);

createRoot(container).render(
  <StrictMode>
    <ConsoleApp />
  </StrictMode>,
);
