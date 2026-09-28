import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@elysium/ui/styles/tailwind.css';

import { ConsoleApp } from './console-app.js';

/**
 * The browser entry point.
 *
 * Separate from `main.tsx` — which M02a wrote and which mounts that milestone's
 * placeholder shell — because `main.tsx` and `app.tsx` are shared files this
 * session and a concurrent edit to either would be lost silently. `index.html`
 * points here; the INTEGRATION section of this milestone's report says to delete
 * the two superseded files.
 */
const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <ConsoleApp />
  </StrictMode>,
);
