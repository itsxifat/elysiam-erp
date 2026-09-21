import { t } from '@elysium/i18n';
import { LogOut, Moon, Sun } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  ApiError,
  endpoints,
  type AvailableOrg,
  type LoginBranding,
  type RequestContext,
} from './api.js';
import { applyBrand, clearBrand } from './brand.js';
import { LoginScreen } from './auth/login-screen.js';
import { OrgSwitcher } from './auth/org-switcher.js';
import { applyTheme, isDark } from './theme.js';
import { Button, Skeleton } from './ui/primitives.js';

/**
 * The console shell, as far as M02a takes it (architecture §6, §24).
 *
 * It answers one question — who is signed in, and in which org — and renders
 * either the branded login or the placeholder workspace. M05 replaces the
 * workspace with the real shell and TanStack Router; the session handling here
 * is what it will be built on.
 *
 * There is deliberately no client-side "is this user allowed" logic. The server
 * decides, on every request, from the session's active org; this reads the
 * answer and renders it.
 */

type Session =
  | { readonly state: 'loading' }
  | { readonly state: 'anonymous' }
  | {
      readonly state: 'signedIn';
      readonly orgs: readonly AvailableOrg[];
      readonly context: RequestContext | null;
    };

export function App() {
  const [session, setSession] = useState<Session>({ state: 'loading' });
  const [branding, setBranding] = useState<LoginBranding | null>(null);

  /**
   * Re-read who we are from the server.
   *
   * `/v1/me` answers 401 until an org is chosen, which is not an error: a fresh
   * session legitimately has no active org, and a user with exactly one
   * membership is switched into it here rather than being shown a chooser with
   * one option in it.
   */
  const refresh = useCallback(async (): Promise<Session> => {
    try {
      const { orgs } = await endpoints.myOrgs();

      let context: RequestContext | null = null;
      try {
        context = await endpoints.me();
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
      }

      if (context === null && orgs.length === 1 && orgs[0] !== undefined) {
        await endpoints.setActiveOrg(orgs[0].orgId);
        context = await endpoints.me();
      }

      return { state: 'signedIn', orgs, context };
    } catch {
      return { state: 'anonymous' };
    }
  }, []);

  /** Apply what the server said. Separated so the effect below never sets
   *  state synchronously — it only subscribes to a result that arrives later. */
  const reload = useCallback(async () => {
    setSession(await refresh());
  }, [refresh]);

  /*
   * Boot: resolve branding and the session together.
   *
   * Branding comes from the hostname the *console* is served on, not the API's.
   * They are different origins, so the server cannot infer it (D-035), and a
   * branding failure must never block sign-in — an unreachable lookup falls
   * back to the shipped accent and carries on.
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

    refresh()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch(() => {
        if (!cancelled) setSession({ state: 'anonymous' });
      });

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  if (session.state === 'loading') return <BootSkeleton />;

  if (session.state === 'anonymous') {
    return <LoginScreen branding={branding} onAuthenticated={reload} />;
  }

  return (
    <Workspace
      orgs={session.orgs}
      context={session.context}
      onSwitched={reload}
      onSignedOut={() => {
        clearBrand();
        applyBrand(branding);
        setSession({ state: 'anonymous' });
      }}
    />
  );
}

function BootSkeleton() {
  return (
    <div className="min-h-dvh bg-background" aria-busy="true" aria-label={t('common.loading')}>
      <div className="flex h-14 items-center justify-between border-b border-border px-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-8" />
      </div>
      <div className="mx-auto max-w-3xl space-y-4 px-6 py-10">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

function Workspace({
  orgs,
  context,
  onSwitched,
  onSignedOut,
}: {
  readonly orgs: readonly AvailableOrg[];
  readonly context: RequestContext | null;
  readonly onSwitched: () => Promise<void>;
  readonly onSignedOut: () => void;
}) {
  const [dark, setDark] = useState(isDark);

  function toggleTheme() {
    const next = !dark;
    applyTheme(next ? 'dark' : 'light');
    setDark(next);
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex h-14 items-center justify-between gap-4 border-b border-border px-6">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">{t('workspace.title')}</span>
          <span className="text-xs text-muted-foreground">{t('auth.subtitle')}</span>
        </div>

        <div className="flex items-center gap-2">
          <OrgSwitcher
            orgs={orgs}
            activeOrgId={context?.orgId ?? null}
            onSwitched={() => onSwitched()}
          />

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={dark ? t('theme.toLight') : t('theme.toDark')}
            className="inline-flex size-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>

          <Button
            variant="ghost"
            aria-label={t('auth.signOut')}
            onClick={() => {
              void endpoints.signOut().finally(onSignedOut);
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-lg font-semibold tracking-tight">
          {context === null ? t('org.chooseOne') : t('org.current')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('workspace.placeholder')}</p>

        {context === null ? null : (
          <dl className="mt-8 divide-y divide-border rounded-lg border border-border">
            <Row label={t('workspace.organisation')}>
              {orgs.find((org) => org.orgId === context.orgId)?.displayName ?? context.orgId}
            </Row>
            <Row label={t('workspace.roles')}>{context.roles.join(', ')}</Row>
            <Row label={t('workspace.branchScope')}>
              {context.branchIds.length === 0
                ? t('workspace.wholeOrg')
                : context.branchIds.join(', ')}
            </Row>
            <Row label={t('workspace.superAdmin')}>
              {context.isSuperAdmin ? t('workspace.yes') : t('workspace.no')}
            </Row>
          </dl>
        )}
      </main>
    </div>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-(--row-height) items-center justify-between gap-4 px-4 py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}
