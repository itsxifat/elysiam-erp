import { DEFAULT_LOCALE, type Locale } from '@elysium/i18n';
import {
  Button,
  EmptyState,
  ErrorState,
  Monogram,
  PermissionDeniedState,
  Skeleton,
  STORAGE_KEYS,
  cn,
  writeStored,
} from '@elysium/ui';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Landmark, LogOut, Moon, Sun } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';

import { applyTheme, isDark } from '../theme.js';
import { ApiError } from '../http.js';
import { auth, type AvailableOrg, type RequestContext } from './api.js';
import { Dashboard } from './dashboard.js';
import { portalTranslator, type Translate } from './messages.js';
import { brandPlan, investorOrgs } from './model.js';
import { SignIn } from './sign-in.js';
import { FOCUS } from './ui.js';

/**
 * The investor portal at `/investor` (M25, §15).
 *
 * It answers one question before anything else renders — is there a session, and is it an
 * investor's — because the answer chooses between the sign-in and the dashboard. Everything
 * an investor sees is the server's answer to their own session: the role is `read Investor`
 * at `own` scope, so the API has already narrowed every list to their rows (check 1), and
 * the role is behind §6's enrolment wall, so nothing arrives until a second factor exists.
 *
 * One brand at a time (D-311). A person can hold a stake in several of the five brands; the
 * session carries one active org, as the console's does, and the switcher changes it. The
 * server answers for whichever brand is active when a request arrives, and its answers do not
 * name the brand, so a switch is careful about order: the dashboard is unmounted first (so no
 * query of the brand being left can start again), every such query is cancelled and dropped,
 * and only then does the session move. For the same reason the figures are not refetched on
 * window focus — the session is, and a brand changed in another tab remounts the dashboard
 * under the new brand's keys rather than refreshing the old brand's keys with new figures.
 *
 * Every figure is cached under the signed-in user as well as the brand, and dropped as soon
 * as the session is not that user's: on a shared browser, the next person to sign in after a
 * session ends must not be shown the last one's figures from cache.
 */

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // 401, 403 and 404 are answers, not hiccups; retrying them only delays the message.
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
    },
  });
}

export function InvestorPortal() {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <Portal />
    </QueryClientProvider>
  );
}

type SessionState =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'not_investor' }
  | {
      readonly kind: 'investor';
      readonly brands: readonly AvailableOrg[];
      readonly context: RequestContext;
      /** The active brand is one where this person is staff: ask, do not move it (D-311). */
      readonly chooseBrand: boolean;
    };

const SESSION_KEY = ['portal-session'] as const;

/**
 * Resolve the session. A 401 or the enrolment wall's 403 both mean "sign in": the second
 * case is a person who signed in earlier and never finished enrolling, and enrolling needs
 * their password again.
 */
async function loadSession(): Promise<SessionState> {
  let orgs: AvailableOrg[];
  try {
    orgs = (await auth.myOrgs()).orgs;
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
      return { kind: 'anonymous' };
    }
    throw cause;
  }

  const brands = investorOrgs(orgs);
  if (brands.length === 0) return { kind: 'not_investor' };

  let context: RequestContext | null = null;
  try {
    context = await auth.me();
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
  }

  const plan = brandPlan(brands, context?.orgId ?? null);
  if (plan.kind === 'open') {
    await auth.setActiveOrg(plan.orgId);
    context = await auth.me();
  }
  if (context === null) return { kind: 'anonymous' };
  return { kind: 'investor', brands, context, chooseBrand: plan.kind === 'choose' };
}

function Portal() {
  const queryClient = useQueryClient();
  // English only (D-750): an investor reads the same formal English as everyone else.
  const locale: Locale = DEFAULT_LOCALE;
  const [dark, setDark] = useState(isDark);
  const t = useMemo(() => portalTranslator(locale), [locale]);
  const session = useQuery({
    queryKey: SESSION_KEY,
    queryFn: loadSession,
    refetchOnWindowFocus: 'always',
  });
  const [switching, setSwitching] = useState<string | null>(null);
  const [switchFailed, setSwitchFailed] = useState(false);
  const userId = session.data?.kind === 'investor' ? session.data.context.userId : null;

  // Whatever is cached for anybody but the person signed in now goes (see the file note).
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: ['investor'],
      predicate: (query) => query.queryKey[1] !== userId,
    });
  }, [queryClient, userId]);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.add('font-sans');
    root.classList.remove('font-bangla');
    document.title = t('portal.investor.title');
    // A language chosen before D-750 is forgotten: there is only English now.
    writeStored(STORAGE_KEYS.portalLocale, null);
  }, [locale, t]);

  async function refreshSession(): Promise<void> {
    await queryClient.refetchQueries({ queryKey: SESSION_KEY });
  }

  /** Move the session to another brand, in the order the note at the top explains. */
  async function switchBrand(orgId: string): Promise<void> {
    flushSync(() => {
      setSwitching(orgId);
      setSwitchFailed(false);
    });
    try {
      await queryClient.cancelQueries({ queryKey: ['investor'] });
      queryClient.removeQueries({ queryKey: ['investor'] });
      await auth.setActiveOrg(orgId);
      await refreshSession();
    } catch {
      setSwitchFailed(true);
    } finally {
      setSwitching(null);
    }
  }

  /**
   * Sign out, then let the server say what the session now is. The session is refetched
   * before anything is dropped: dropping it first left the dashboard on screen, because a
   * mounted query keeps showing its last answer when its cache entry is removed (found by
   * the stack spec's sign-out). Once the sign-in is drawn, nothing holds the figures, and
   * they are dropped so the next person at this browser cannot be shown them from cache.
   */
  async function signOut(): Promise<void> {
    try {
      await auth.signOut();
    } finally {
      await refreshSession();
      queryClient.removeQueries({ queryKey: ['investor'] });
    }
  }

  const state = session.data;
  const signedIn = state !== undefined && state.kind !== 'anonymous';

  const activeBrand =
    state?.kind === 'investor'
      ? (state.brands.find((brand) => brand.orgId === state.context.orgId)?.displayName ?? null)
      : null;

  /*
   * The portal sits on the warm canvas, its content in white cards at a reading width
   * (D-459). The top bar is slim and quiet: whose portal this is on the left, the
   * language, the theme and sign out on the right, all as plain icon or text buttons.
   */
  return (
    <div className="min-h-dvh bg-canvas text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-canvas">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 px-4 sm:px-6">
          <span className="flex min-w-0 items-center gap-2.5">
            {activeBrand === null ? (
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
              >
                <Landmark className="size-4" />
              </span>
            ) : (
              <Monogram name={activeBrand} tone="brand" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold tracking-tight">
                {t('portal.investor.title')}
              </span>
              {activeBrand === null ? null : (
                <span className="block truncate text-xs text-muted-foreground">{activeBrand}</span>
              )}
            </span>
          </span>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                applyTheme(dark ? 'light' : 'dark');
                setDark(!dark);
              }}
              aria-label={dark ? t('portal.themeLight') : t('portal.themeDark')}
              title={dark ? t('portal.themeLight') : t('portal.themeDark')}
              className={`inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${FOCUS}`}
            >
              {dark ? (
                <Sun aria-hidden="true" className="size-4" />
              ) : (
                <Moon aria-hidden="true" className="size-4" />
              )}
            </button>
            {signedIn ? (
              <button
                type="button"
                onClick={() => void signOut()}
                aria-label={t('auth.signOut')}
                title={t('auth.signOut')}
                className={`inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${FOCUS}`}
              >
                <LogOut aria-hidden="true" className="size-4" />
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {session.isPending ? (
        <main className="mx-auto max-w-5xl space-y-4 px-4 py-10 sm:px-6" aria-busy="true">
          <span className="sr-only">{t('common.loading')}</span>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
        </main>
      ) : session.isError || state === undefined ? (
        <main className="mx-auto max-w-lg px-4 py-12 sm:px-6">
          <ErrorState
            className="bg-card"
            title={t('portal.investor.errorTitle')}
            detail={t('portal.investor.errorDetail')}
            action={
              <Button variant="outline" onClick={() => void refreshSession()}>
                {t('portal.investor.retry')}
              </Button>
            }
          />
        </main>
      ) : state.kind === 'anonymous' ? (
        <SignIn t={t} onAuthenticated={refreshSession} />
      ) : state.kind === 'not_investor' ? (
        <main className="mx-auto max-w-lg px-4 py-12 sm:px-6">
          <PermissionDeniedState
            className="bg-card"
            title={t('portal.investor.notInvestorTitle')}
            detail={t('portal.investor.notInvestorDetail')}
          />
        </main>
      ) : (
        <main className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6">
          <BrandSwitcher
            t={t}
            brands={state.brands}
            activeOrgId={state.context.orgId}
            switching={switching}
            failed={switchFailed}
            alwaysShow={state.chooseBrand}
            onSwitch={(orgId) => void switchBrand(orgId)}
          />
          {state.chooseBrand && switching === null ? (
            <EmptyState
              className="bg-card"
              title={t('portal.investor.chooseBrandTitle')}
              detail={t('portal.investor.chooseBrandDetail')}
            />
          ) : switching === null ? (
            <Dashboard
              key={`${state.context.userId}:${state.context.orgId}`}
              t={t}
              locale={locale}
              context={state.context}
              brandName={
                state.brands.find((brand) => brand.orgId === state.context.orgId)?.displayName ?? ''
              }
            />
          ) : (
            <div className="space-y-6" aria-busy="true">
              <span className="sr-only">{t('portal.investor.switching')}</span>
              <Skeleton className="h-7 w-56" />
              <Skeleton className="h-36 w-full" />
            </div>
          )}
        </main>
      )}
    </div>
  );
}

/**
 * The brands this person has a stake in, as a row of buttons. With one brand there is no
 * choice to offer, so there is nothing to draw — unless the session is open in a brand that
 * is not theirs, when even one brand is a choice to make.
 */
function BrandSwitcher({
  t,
  brands,
  activeOrgId,
  switching,
  failed,
  alwaysShow,
  onSwitch,
}: {
  readonly t: Translate;
  readonly brands: readonly AvailableOrg[];
  readonly activeOrgId: string;
  readonly switching: string | null;
  readonly failed: boolean;
  readonly alwaysShow: boolean;
  readonly onSwitch: (orgId: string) => void;
}) {
  if (brands.length <= 1 && !alwaysShow) return null;

  return (
    <nav aria-label={t('portal.investor.brands')} className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{t('portal.investor.brands')}</p>
      <ul className="flex flex-wrap gap-1.5">
        {brands.map((brand) => {
          const current = brand.orgId === activeOrgId;
          return (
            <li key={brand.orgId}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                disabled={switching !== null}
                onClick={() => {
                  if (!current) onSwitch(brand.orgId);
                }}
                className={cn(
                  'inline-flex h-control items-center gap-2 rounded-lg border pr-3 pl-1.5 text-sm font-medium transition-colors disabled:opacity-60',
                  FOCUS,
                  current
                    ? 'border-transparent bg-selected text-selected-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <Monogram name={brand.displayName} size="sm" tone={current ? 'brand' : 'neutral'} />
                {switching === brand.orgId ? t('portal.investor.switching') : brand.displayName}
              </button>
            </li>
          );
        })}
      </ul>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('portal.investor.switchFailed')}
        </p>
      ) : null}
    </nav>
  );
}
