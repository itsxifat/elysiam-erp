import { Skeleton } from '@elysium/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useState } from 'react';

import { ApiError, endpoints, type LoginBranding } from './api.js';
import { applyBrand, clearBrand } from './brand.js';
import { LoginScreen } from './auth/login-screen.js';
import { isOwnerLinkPage, passwordLinkPage } from './auth/password-link.js';
import { SessionProvider, useSessionQuery } from './auth/session.js';
import { LocaleProvider, useT } from './i18n/locale.js';
import { router } from './routes/router.js';

/**
 * The console's root (architecture §6, §24).
 *
 * It answers one question before anything else renders — is there a session, and
 * in which org — because the answer decides between two entirely different trees:
 * the branded login, or the shell with its router. Rendering the shell first and
 * redirecting on a 401 is the alternative, and it means every module screen has to
 * tolerate a null context; this way none of them do.
 *
 * The provider order is not arbitrary. Locale is outermost, because the login
 * screen needs it and it has no dependencies. Query is next, because the session
 * *is* a query — which is what lets an org switch be `invalidateQueries()` rather
 * than a hand-written cascade of refetches. The session provider and the router
 * are innermost, so every route can assume both.
 */

/**
 * Its own chunk, like the owner's screen below: only somebody redeeming an invite or a reset
 * link opens it, and the first download of everyone else's console stays inside its budget
 * (M41 moved it out to make room for the work dock).
 */
const SetPasswordScreen = lazy(() =>
  import('./auth/set-password-screen.js').then((module) => ({
    default: module.SetPasswordScreen,
  })),
);

/** Its own chunk: only an owner ever opens it (M31, D-473). */
const OwnerLinkScreen = lazy(() =>
  import('./auth/owner-link-screen.js').then((module) => ({ default: module.OwnerLinkScreen })),
);

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /*
         * No retry by default, and this is a deliberate inversion of the library's
         * default. Most failures in this application are 401, 403 and 422 — a
         * revoked membership, a role that may not read the list, a bad filter —
         * and retrying any of them three times turns one honest error into three
         * identical log lines and a three-second delay before the user is told.
         * The places where a retry is right (a flaky COD sync) ask for it.
         */
        retry: false,
        // A staff console is a set of tabs someone leaves open for a day.
        // Refetching when a tab regains focus is what keeps a stale approvals
        // inbox from being trusted.
        refetchOnWindowFocus: true,
        staleTime: 10_000,
      },
    },
  });
}

export function ConsoleApp() {
  const [queryClient] = useState(createQueryClient);

  return (
    <LocaleProvider>
      <QueryClientProvider client={queryClient}>
        <Boot />
      </QueryClientProvider>
    </LocaleProvider>
  );
}

function Boot() {
  const [branding, setBranding] = useState<LoginBranding | null>(null);
  const session = useSessionQuery();

  /*
   * Branding is resolved from the hostname the *console* is served on, not the
   * API's — they are different origins, so the server cannot infer it (D-035).
   *
   * A branding failure must never block sign-in. An unreachable lookup falls back
   * to the shipped accent and carries on, because the alternative is a brand whose
   * staff cannot log in because a colour could not be fetched.
   */
  useEffect(() => {
    let cancelled = false;

    endpoints
      .branding(window.location.host)
      .then((resolved) => {
        if (cancelled) return;
        setBranding(resolved);
        applyBrand(resolved);
      })
      .catch(() => {
        if (!cancelled) clearBrand();
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * A link an admin gave — an invite or a password reset — is answered before the
   * session is: the person opening it has none, and must not be asked to sign in to
   * set the password they would sign in with (gaps-users-auth).
   */
  const linkPage = passwordLinkPage(window.location.pathname);
  if (linkPage !== null) {
    return (
      <Suspense fallback={<BootSkeleton />}>
        <SetPasswordScreen page={linkPage} branding={branding} />
      </Suspense>
    );
  }

  // An owner sign-in link (M31, D-473): it makes the session, so it comes before one is read.
  if (isOwnerLinkPage(window.location.pathname)) {
    return (
      <Suspense fallback={<BootSkeleton />}>
        <OwnerLinkScreen branding={branding} />
      </Suspense>
    );
  }

  if (session.isPending) return <BootSkeleton />;

  // Any failure to resolve the session is treated as anonymous, including a
  // network error. Showing the shell with an error banner would leave an
  // unauthenticated user looking at a navigation computed from no roles at all.
  if (session.isError || session.data === undefined) {
    // A session the brand's security setting now walls (M40): straight to setting it up.
    const walled =
      session.error instanceof ApiError && session.error.code === 'TWO_FACTOR_ENROLMENT_REQUIRED';
    return (
      <LoginScreen
        key={walled ? 'walled' : 'signed-out'}
        branding={branding}
        walled={walled}
        onAuthenticated={async () => {
          await session.refetch();
        }}
      />
    );
  }

  if (session.data.orgs.length === 0) {
    return (
      <LoginScreen
        branding={branding}
        onAuthenticated={async () => {
          await session.refetch();
        }}
      />
    );
  }

  return (
    <SessionProvider value={session.data}>
      <RouterProvider router={router} />
    </SessionProvider>
  );
}

function BootSkeleton() {
  const t = useT();
  return (
    <div className="min-h-dvh bg-background" aria-busy="true" aria-label={t('common.loading')}>
      <div className="flex h-14 items-center justify-between border-b border-border px-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-8" />
      </div>
      <div className="flex">
        <div className="hidden w-60 shrink-0 space-y-2 border-r border-border p-4 md:block">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-control w-full" />
          ))}
        </div>
        <div className="flex-1 space-y-4 px-6 py-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
