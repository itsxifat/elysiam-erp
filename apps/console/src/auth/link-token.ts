import { useEffect, useState } from 'react';

import { tokenFromHash } from './password-link.js';

/**
 * The token a link page was opened with (`#token=…`), held in memory, and the address bar
 * rewritten without it once the page is on screen (D-402, D-473).
 *
 * The read is pure and the rewrite waits for the commit, and the order matters. React may
 * render a screen more than once before it shows one: it holds back a Suspense reveal for a
 * moment, and an update that lands meanwhile (the branding, the session check) throws the
 * finished render away and mounts the screen again, calling the state initializer again.
 * When the initializer itself emptied the address bar, that second mount found no fragment,
 * and a whole, unused link said it was incomplete.
 */
export function useLinkToken(): string | null {
  const [token] = useState(() => tokenFromHash(window.location.hash));

  useEffect(() => {
    if (window.location.hash !== '') {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  return token;
}
