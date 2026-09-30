import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@elysium/ui/styles/tailwind.css';
import './print.css';

import { App } from './app.js';
import { registerOfflineShell } from './offline-shell.js';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerOfflineShell();
