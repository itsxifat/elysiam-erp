import {
  Button,
  EmptyState,
  ErrorState,
  PermissionGate,
  Skeleton,
  PageHeader,
  controlClassName,
  cn,
} from '@elysium/ui';
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

export const control = `${controlClassName} w-full disabled:opacity-50`;

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
  // Settings reads like a settings screen (D-454): its sections down the left, the one
  // being edited beside them at a form's measure, rather than a strip of tabs.
  const itemClass = cn(
    'flex h-8 items-center rounded-md px-2.5 text-sm text-muted-foreground',
    'motion-safe:duration-fast hover:bg-accent hover:text-foreground motion-safe:transition-colors',
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    'aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-selected-foreground',
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} />
      <div className="grid gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
        {tabs.length === 0 ? null : (
          <nav aria-label={t('settings.title')} className="md:sticky md:top-20 md:self-start">
            <ul className="flex gap-1 overflow-x-auto md:flex-col">
              {tabs.map((entry) => (
                <li key={entry.path} className="shrink-0">
                  <Link to={settingsPath(entry.path)} className={itemClass}>
                    {t(entry.labelKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="max-w-form min-w-0 space-y-5">
          <PermissionGate
            allowed={allowed}
            explain={{ title: t('settings.deniedTitle'), detail: t('settings.deniedDetail') }}
          >
            {children}
          </PermissionGate>
        </div>
      </div>
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
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} />
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
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only">{t('settings.loading')}</span>
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

export const tableClass = 'w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3';
export const headClass = 'border-b border-border text-left text-xs text-muted-foreground';
export const rowClass = 'h-row border-b border-border last:border-b-0 hover:bg-accent/40';
