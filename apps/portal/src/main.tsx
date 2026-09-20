import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@elysium/ui/styles/tailwind.css';

import { App } from './app.js';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
