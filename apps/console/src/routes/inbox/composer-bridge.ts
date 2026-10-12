import { useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Putting text into a conversation's reply box from elsewhere on the page (M44b, D-775): the
 * panel's "Send order summary" fills the composer, and the agent reads it and presses Send.
 *
 * The composer is the thread's (M44a's), so the two meet through a window event instead of an
 * import either way: the panel calls `fillComposer`, the composer calls `useComposerFill` with
 * its setter. The answer says whether a composer for that conversation took it; when none did
 * (an older composer, the conversation not open), the caller copies the text instead.
 */

export const COMPOSE_EVENT = 'elysium:inbox-compose';

export interface ComposeRequest {
  readonly conversationId: string;
  readonly text: string;
  /** Set by the composer that took it. */
  handled: boolean;
}

/** Ask the open composer of this conversation to take `text`. True when one did. */
export function fillComposer(conversationId: string, text: string): boolean {
  if (typeof window === 'undefined') return false;
  const detail: ComposeRequest = { conversationId, text, handled: false };
  window.dispatchEvent(new CustomEvent<ComposeRequest>(COMPOSE_EVENT, { detail }));
  return detail.handled;
}

/**
 * For the composer: take text sent to this conversation. `apply` receives it (replace the draft,
 * or append to it, as the composer prefers) and should focus the reply box; it returns `false`
 * to decline (a reply box that takes nothing now), and the caller copies the text instead.
 */
export function useComposerFill(
  conversationId: string,
  apply: (text: string) => boolean | void,
): void {
  const latest = useRef(apply);
  useLayoutEffect(() => {
    latest.current = apply;
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const request = (event as CustomEvent<ComposeRequest>).detail;
      if (request.conversationId !== conversationId || request.handled) return;
      if (latest.current(request.text) === false) return;
      request.handled = true;
    };
    window.addEventListener(COMPOSE_EVENT, listener);
    return () => window.removeEventListener(COMPOSE_EVENT, listener);
  }, [conversationId]);
}
