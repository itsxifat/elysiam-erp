import { CUSTOMER_LOCALE, fontClassFor, isLocale, type Locale } from '@elysium/i18n';
import { Button, ErrorState, PermissionDeniedState, Skeleton } from '@elysium/ui';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Landmark, Languages, LogOut, Moon, Sun } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { applyTheme, isDark } from '../theme.js';
import { ApiError } from '../http.js';
import { auth, type AvailableOrg, type RequestContext } from './api.js';
import { Dashboard } from './dashboard.js';
import { portalTranslator, type Translate } from './messages.js';
import { brandToOpen, investorOrgs } from './model.js';
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
 * session carries one active org, as the console's does, and the switcher changes it. Before
 * a switch, every query of the brand being left is cancelled and dropped, so an answer that
 * was in flight cannot land under the next brand's name.
 */

const LOCALE_KEY = 'elysium-portal-locale';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // 401, 403 and 404 are answers, not hiccups; retrying them only delays the message.
      queries: { retry: false, refetchOnWindowFocus: true, staleTime: 30_000 },
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

  const target = brandToOpen(brands, context?.orgId ?? null);
  if (target !== null) {
    await auth.setActiveOrg(target);
    context = await auth.me();
  }
  if (context === null) return { kind: 'anonymous' };
  return { kind: 'investor', brands, context };
}

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved !== null && isLocale(saved)) return saved;
  } catch {
    // Storage can be denied; Bangla it is.
  }
  return CUSTOMER_LOCALE;
}

function Portal() {
  const queryClient = useQueryClient();
  const [locale, setLocale] = useState<Locale>(readLocale);
  const [dark, setDark] = useState(isDark);
  const t = useMemo(() => portalTranslator(locale), [locale]);
  const session = useQuery({ queryKey: SESSION_KEY, queryFn: loadSession });

  // `<html lang>` and the font stack follow the language: Bangla renders in Hind Siliguri
  // with its own size-adjust, and a Latin stack on a Bangla line puts it on two baselines.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.toggle('font-bangla', fontClassFor(locale) === 'font-bangla');
    root.classList.toggle('font-sans', fontClassFor(locale) === 'font-sans');
    document.title = t('portal.investor.title');
    try {
      localStorage.setItem(LOCALE_KEY, locale);
    } catch {
      // The choice still holds for this visit.
    }
  }, [locale, t]);

  async function refreshSession(): Promise<void> {
    await queryClient.refetchQueries({ queryKey: SESSION_KEY });
  }

  async function signOut(): Promise<void> {
    try {
      await auth.signOut();
    } finally {
      queryClient.clear();
      await refreshSession();
    }
  }

  const state = session.data;
  const signedIn = state !== undefined && state.kind !== 'anonymous';

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex h-14 items-center justify-between gap-2 border-b border-border px-4 sm:px-6">
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold tracking-tight">
          <Landmark aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <span className="truncate">{t('portal.investor.title')}</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setLocale(locale === 'bn' ? 'en' : 'bn')}
            aria-label={t('portal.languageLabel')}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${FOCUS}`}
          >
            <Languages aria-hidden="true" className="size-4" />
            {t('portal.language')}
          </button>
          <button
            type="button"
            onClick={() => {
              applyTheme(dark ? 'light' : 'dark');
              setDark(!dark);
            }}
            aria-label={dark ? t('portal.themeLight') : t('portal.themeDark')}
            className={`inline-flex size-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-accent-foreground ${FOCUS}`}
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
              className={`inline-flex size-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-accent-foreground ${FOCUS}`}
            >
              <LogOut aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </div>
      </header>

      {session.isPending ? (
        <main className="mx-auto max-w-5xl space-y-4 px-4 py-8 sm:px-6" aria-busy="true">
          <span className="sr-only">{t('common.loading')}</span>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
        </main>
      ) : session.isError || state === undefined ? (
        <main className="mx-auto max-w-lg px-4 py-12 sm:px-6">
          <ErrorState
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
            title={t('portal.investor.notInvestorTitle')}
            detail={t('portal.investor.notInvestorDetail')}
          />
        </main>
      ) : (
        <main className="mx-auto max-w-5xl space-y-8 px-4 py-8 sm:px-6">
          <BrandSwitcher
            t={t}
            brands={state.brands}
            activeOrgId={state.context.orgId}
            onSwitched={refreshSession}
          />
          <Dashboard
            key={state.context.orgId}
            t={t}
            locale={locale}
            context={state.context}
            brandName={
              state.brands.find((brand) => brand.orgId === state.context.orgId)?.displayName ?? ''
            }
          />
        </main>
      )}
    </div>
  );
}

/**
 * The brands this person has a stake in, as a row of buttons. With one brand there is no
 * choice to offer, so it only says where they are.
 */
function BrandSwitcher({
  t,
  brands,
  activeOrgId,
  onSwitched,
}: {
  readonly t: Translate;
  readonly brands: readonly AvailableOrg[];
  readonly activeOrgId: string;
  readonly onSwitched: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  if (brands.length <= 1) return null;

  async function switchTo(orgId: string): Promise<void> {
    setBusy(orgId);
    setFailed(false);
    try {
      // Nothing of the brand being left may arrive after this point (see the file note).
      await queryClient.cancelQueries({ queryKey: ['investor'] });
      queryClient.removeQueries({ queryKey: ['investor'] });
      await auth.setActiveOrg(orgId);
      await onSwitched();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <nav aria-label={t('portal.investor.brands')} className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{t('portal.investor.brands')}</p>
      <ul className="flex flex-wrap gap-2">
        {brands.map((brand) => {
          const current = brand.orgId === activeOrgId;
          return (
            <li key={brand.orgId}>
              <button
                type="button"
                aria-current={current ? 'true' : undefined}
                disabled={busy !== null}
                onClick={() => {
                  if (!current) void switchTo(brand.orgId);
                }}
                className={`inline-flex h-control items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors disabled:opacity-60 ${FOCUS} ${
                  current
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                <Building2 aria-hidden="true" className="size-4" />
                {busy === brand.orgId ? t('portal.investor.switching') : brand.displayName}
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
