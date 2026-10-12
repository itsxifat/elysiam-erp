import { useEffect, useRef } from 'react';

import { isTypingTarget } from './thread-logic.js';

/**
 * Single-key shortcuts for the inbox (M44a, D-767): j and k between chats, a to take, e to
 * close, / to write. Only when nobody is typing (an input, a text box, an editable region), no
 * modifier is held and no dialog or menu is open, so a shortcut never eats a letter of a reply.
 */
export function useSingleKeys(
  handlers: Readonly<Partial<Record<string, () => void>>>,
  enabled = true,
): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null) {
        return;
      }
      const handler = latest.current[event.key];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled]);
}
