import { lazy, Suspense } from 'react';

import { closeCallerPanel, useOpenCallerPanel } from './caller-panel-store.js';

// M47 (D-860): the panel's own chunk, fetched the first time a panel opens.
const CallerPanel = lazy(() =>
  import('./caller-panel.js').then((module) => ({ default: module.CallerPanel })),
);

/** Draws the caller panel that is open, if any (mounted once, by the console's phone). */
export function CallerPanelHost() {
  const open = useOpenCallerPanel();
  if (open === null) return null;
  return (
    <Suspense fallback={null}>
      <CallerPanel
        key={open.seq}
        target={open.target}
        auto={open.auto}
        onClose={closeCallerPanel}
      />
    </Suspense>
  );
}
