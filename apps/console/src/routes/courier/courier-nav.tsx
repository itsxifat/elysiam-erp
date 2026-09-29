import { Link } from '@tanstack/react-router';
import type { ComponentProps, ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useCourierT } from './messages.js';

/**
 * A courier path, as the router will know it.
 *
 * TanStack derives `to`'s type from the live route tree, so until the integrator wires
 * `courierRoutes()` into `router.tsx` these paths are not in that union and every `<Link>` to
 * them is a type error in files this milestone owns. One named widening, in one place — the
 * same arrangement M19's `hrPath` uses — which the integrator can delete with the commit that
 * registers the routes. An unregistered path 404s the first time anybody clicks it, so it
 * cannot hide a wrong path for long.
 */
export type CourierPath = ComponentProps<typeof Link>['to'];

export const courierPath = (path: string): CourierPath => path;

/** Route params, read loosely until the routes are in the router's type (see above). */
export function paramOf(params: unknown, name: string): string {
  const value = (params as Record<string, unknown> | null)?.[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The courier screens, as tabs, each shown only to a role that can open it.
 *
 * Filtered by ability rather than left to answer 403: a warehouse hand who can see parcels
 * should not be shown a Performance tab that is a finance report, and the permission-denied
 * state is not navigation. The abilities are the routes' own: parcels, the stuck queue and
 * returns are `read Order`; performance is `read LedgerReport`; settlements are
 * `read CourierSettlement`.
 */
export function CourierNav() {
  const t = useCourierT();
  const ability = useAbility();

  const tab =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: `${tab} bg-muted font-medium text-foreground` };

  const tabs: { path: string; label: string; show: boolean; exact?: boolean }[] = [
    {
      path: '/courier',
      label: t('courier.nav.parcels'),
      show: ability.can('read', 'Order'),
      exact: true,
    },
    { path: '/courier/stuck', label: t('courier.nav.stuck'), show: ability.can('read', 'Order') },
    {
      path: '/courier/performance',
      label: t('courier.nav.performance'),
      show: ability.can('read', 'LedgerReport'),
    },
    {
      path: '/courier/settlements',
      label: t('courier.nav.settlements'),
      show: ability.can('read', 'CourierSettlement'),
    },
    {
      path: '/courier/returns',
      label: t('courier.nav.returns'),
      show: ability.can('read', 'Order'),
    },
  ];

  return (
    <nav aria-label={t('courier.title')} className="flex flex-wrap gap-1">
      {tabs
        .filter((entry) => entry.show)
        .map((entry) => (
          <Link
            key={entry.path}
            to={courierPath(entry.path)}
            className={tab}
            activeProps={active}
            activeOptions={{ exact: entry.exact === true }}
          >
            {entry.label}
          </Link>
        ))}
    </nav>
  );
}

/** A page header with the section's tabs under it. */
export function CourierHeader({
  title,
  caption,
  actions,
}: {
  readonly title: string;
  readonly caption: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">{caption}</p>
        </div>
        {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      <CourierNav />
    </div>
  );
}

/** One labelled control, the shape the other sections' forms use. */
export function Field({
  label,
  id,
  hint,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The input class the courier forms share, so density matches the rest of the console. */
export const control =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
