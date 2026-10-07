import { ErrorState, Skeleton } from '@elysium/ui';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError, endpoints } from './api.js';
import { isInvitePath, SetPasswordScreen } from './auth/set-password.js';
import { SignInScreen } from './auth/sign-in.js';
import { LocaleProvider, useT } from './i18n/locale.js';
import { router } from './router.js';
import { SessionContext } from './session.js';

/**
 * The owner console's root (D-480, D-487): who is asking decides between the invite page,
 * the sign-in (with its second-factor and enrolment steps) and the console itself.
 */

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: true, staleTime: 15_000 },
    },
  });
}

export function App() {
  const [client] = useState(createQueryClient);
  return (
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <Boot />
      </QueryClientProvider>
    </LocaleProvider>
  );
}

function Boot() {
  const t = useT();
  const [invite, setInvite] = useState(() => isInvitePath(window.location.pathname));
  const me = useQuery({ queryKey: ['me'], queryFn: endpoints.me, enabled: !invite });

  if (invite) {
    return (
      <SetPasswordScreen
        onDone={() => {
          window.history.replaceState(null, '', '/');
          setInvite(false);
        }}
      />
    );
  }

  if (me.isPending) {
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas" aria-busy="true">
        <Skeleton className="h-6 w-48" />
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    );
  }

  if (me.isError) {
    const error = me.error;
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return (
        <SignInScreen
          initialStep={error.code === 'TWO_FACTOR_ENROLMENT_REQUIRED' ? 'enrol' : 'credentials'}
          onSignedIn={async () => {
            await me.refetch();
          }}
        />
      );
    }
    return (
      <div className="grid min-h-dvh place-items-center bg-canvas px-4">
        <ErrorState
          title={t('common.error')}
          detail={t('auth.unreachable')}
          action={
            <button
              type="button"
              className="text-sm text-primary underline-offset-4 hover:underline"
              onClick={() => void me.refetch()}
            >
              {t('common.retry')}
            </button>
          }
        />
      </div>
    );
  }

  return (
    <SessionContext.Provider value={me.data}>
      <RouterProvider router={router} />
    </SessionContext.Provider>
  );
}
