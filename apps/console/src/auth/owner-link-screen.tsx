import { useEffect, useRef, useState } from 'react';

import { csrfToken, endpoints, NetworkError, type LoginBranding } from '../api.js';
import { useT } from '../i18n/locale.js';
import { Alert, Button } from '../ui/primitives.js';
import { BrandMark } from './login-screen.js';
import { tokenFromHash } from './password-link.js';

/**
 * The owner sign-in link's page (M31, D-473): `/owner-link#token=…`.
 *
 * The token rides in the fragment, which no browser sends to a server, so it reaches no
 * access log, proxy or `Referer`. It is read once into memory and the address bar is
 * rewritten without it before anything else happens; then it is posted, once, and a good
 * link lands on the console's home with a session. A link is two minutes long and single
 * use, so a refused one is asked for again rather than retried.
 *
 * Its own chunk: only an owner ever opens it, and the console's first screen should not
 * carry it.
 */

type State = 'working' | 'refused' | 'offline' | 'missing';

/** Take the token out of the address bar, once it is in memory. */
function readTokenOnce(): string | null {
  const token = tokenFromHash(window.location.hash);
  if (window.location.hash !== '') {
    window.history.replaceState(null, '', window.location.pathname);
  }
  return token;
}

export function OwnerLinkScreen({ branding }: { readonly branding: LoginBranding | null }) {
  const t = useT();
  const [token] = useState(readTokenOnce);
  const [state, setState] = useState<State>(token === null ? 'missing' : 'working');
  // Once, even under React's development double effects: a link is single use.
  const posted = useRef(false);

  useEffect(() => {
    if (token === null || posted.current) return;
    posted.current = true;
    void (async () => {
      try {
        // The CSRF cookie arrives with the first GET; a fresh tab may not have made one.
        if (csrfToken() === '') await endpoints.branding(window.location.host);
        await endpoints.ownerLink(token);
        window.location.replace('/');
      } catch (cause) {
        setState(cause instanceof NetworkError ? 'offline' : 'refused');
      }
    })();
  }, [token]);

  return (
    <div className="grid min-h-dvh place-items-center bg-canvas px-4 py-10">
      <div className="w-full max-w-sm">
        <BrandMark branding={branding} />
        <main
          className="mt-8 rounded-xl border border-border bg-card p-7 shadow-popover"
          aria-busy={state === 'working'}
        >
          <h1 className="text-base font-semibold tracking-tight text-card-foreground">
            {t('ownerLink.title')}
          </h1>
          {state === 'working' ? (
            <p className="mt-1 text-sm text-muted-foreground" role="status">
              {t('ownerLink.working')}
            </p>
          ) : (
            <div className="mt-5 space-y-4">
              <Alert>
                {state === 'missing'
                  ? t('ownerLink.noToken')
                  : state === 'offline'
                    ? t('ownerLink.offline')
                    : t('ownerLink.refused')}
              </Alert>
              <Button variant="ghost" onClick={() => window.location.assign('/')}>
                {t('ownerLink.toSignIn')}
              </Button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
