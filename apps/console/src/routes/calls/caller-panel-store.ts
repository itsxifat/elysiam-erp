import { useSyncExternalStore } from 'react';

import type { CallerPanelTarget } from './api.js';

/**
 * Which caller panel is open (M47, D-860), shared by the screens that open it: the phone's card
 * (by itself when a call rings or a Call is placed, and its Details), the Calls page's rows and
 * an order's calls. One panel at a time; the console's phone draws it (`CallerPanelHost`). Plain
 * module state with no dependencies, so a screen that opens the panel loads nothing of it.
 */
export interface OpenCallerPanel {
  readonly target: CallerPanelTarget;
  /** Opened by a ringing or placed call rather than by the person: it never takes focus. */
  readonly auto: boolean;
  /** A new number for every open, so the panel starts afresh for another party. */
  readonly seq: number;
}

let open: OpenCallerPanel | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function sameTarget(a: CallerPanelTarget, b: CallerPanelTarget): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changed(next: OpenCallerPanel | null): void {
  open = next;
  for (const listener of listeners) listener();
}

/** Open the panel for this party; the same party already open is left as it is. */
export function openCallerPanel(
  target: CallerPanelTarget,
  options: { readonly auto?: boolean } = {},
): void {
  if (open !== null && sameTarget(open.target, target)) return;
  seq += 1;
  changed({ target, auto: options.auto === true, seq });
}

export function closeCallerPanel(): void {
  if (open !== null) changed(null);
}

/** The panel open now, or null. */
export function openCallerPanelNow(): OpenCallerPanel | null {
  return open;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenCallerPanel(): OpenCallerPanel | null {
  return useSyncExternalStore(subscribe, openCallerPanelNow, () => null);
}
