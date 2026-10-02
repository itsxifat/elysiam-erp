import { Button, EmptyState, ErrorState, PermissionGate, Skeleton } from '@elysium/ui';
import { Link, Navigate } from '@tanstack/react-router';
import type { ComponentProps, ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useSettingsT } from './messages.js';
import { visibleTabs, type SettingsTab } from './tabs.js';

/**
 * The settings section's frame: a title, the tabs this caller may open, and the tab.
 *
 * A tab the caller's role does not hold is not shown, rather than shown and refused — the
 * permission-denied state is for a screen somebody reached on purpose (a pasted link), and
 * `SettingsPage` gives it when they do.
 */

/** A settings path, widened like every section's (see `orders/paths.ts`). */
export type SettingsPath = ComponentProps<typeof Link>['to'];
export const settingsPath = (path: string): SettingsPath => path;

export const control =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function SettingsPage({
  tab,
  children,
}: {
  readonly tab: SettingsTab['path'];
  readonly children: ReactNode;
}) {
  const t = useSettingsT();
  const ability = useAbility();
  const tabs = visibleTabs(ability);
  const allowed = tabs.some((entry) => entry.path === tab);
  const tabClass =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold tracking-tight">{t('settings.title')}</h1>
      {tabs.length === 0 ? null : (
        <nav aria-label={t('settings.title')} className="flex flex-wrap gap-1">
          {tabs.map((entry) => (
            <Link
              key={entry.path}
              to={settingsPath(entry.path)}
              className={tabClass}
              activeProps={{ className: `${tabClass} bg-muted font-medium text-foreground` }}
            >
              {t(entry.labelKey)}
            </Link>
          ))}
        </nav>
      )}
      <PermissionGate
        allowed={allowed}
        explain={{ title: t('settings.deniedTitle'), detail: t('settings.deniedDetail') }}
      >
        {children}
      </PermissionGate>
    </div>
  );
}

/** `/settings` itself: the first tab this caller may open, or the denied state. */
export function SettingsIndexPage() {
  const t = useSettingsT();
  const ability = useAbility();
  const [first] = visibleTabs(ability);
  if (first !== undefined) return <Navigate to={settingsPath(first.path)} replace />;
  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold tracking-tight">{t('settings.title')}</h1>
      <PermissionGate
        allowed={false}
        explain={{ title: t('settings.deniedTitle'), detail: t('settings.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    </div>
  );
}

/** Loading, failed or loaded, the same way on every tab. */
export function Loadable<T>({
  query,
  children,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly data: T | undefined;
    readonly refetch: () => unknown;
  };
  readonly children: (data: T) => ReactNode;
}) {
  const t = useSettingsT();
  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t('settings.loading')}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <ErrorState
        title={t('settings.errorTitle')}
        detail={query.error instanceof ApiError ? query.error.message : t('settings.errorDetail')}
        action={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t('settings.retry')}
          </Button>
        }
      />
    );
  }
  return <>{children(query.data)}</>;
}

export function Empty() {
  const t = useSettingsT();
  return <EmptyState title={t('settings.empty')} />;
}

/** A labelled control, with the label tied to it by id. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The error a save came back with, in words. */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export const tableClass = 'w-full text-sm';
export const headClass = 'border-b border-border text-left text-xs text-muted-foreground';
export const rowClass = 'h-row border-b border-border last:border-b-0';
