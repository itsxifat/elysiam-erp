import { Link } from '@tanstack/react-router';
import { Fragment, type ComponentProps, type ReactNode } from 'react';

import { useAbility, useSession } from '../../auth/session.js';
import { useAnalyticsT } from './messages.js';

/** An analytics path, widened once until the routes are in the router's type. */
export type AnalyticsPath = ComponentProps<typeof Link>['to'];
export const analyticsPath = (path: string): AnalyticsPath => path;

/**
 * The analytics screens as tabs, each shown only to whoever can open it (D-325, D-023):
 * the dashboard to `read Dashboard`, the leaderboard to `read Leaderboard`, and all brands
 * to the platform super admin.
 */
export function AnalyticsNav() {
  const t = useAnalyticsT();
  const ability = useAbility();
  const session = useSession();

  const tab =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: `${tab} bg-muted font-medium text-foreground` };

  const tabs = [
    {
      path: '/analytics',
      label: t('analytics.nav.dashboard'),
      show: ability.can('read', 'Dashboard'),
      exact: true,
    },
    {
      path: '/analytics/leaderboard',
      label: t('analytics.nav.leaderboard'),
      show: ability.can('read', 'Leaderboard'),
      exact: false,
    },
    {
      path: '/analytics/group',
      label: t('analytics.nav.group'),
      show: session.context?.isSuperAdmin === true,
      exact: false,
    },
  ];

  return (
    <nav aria-label={t('analytics.title')} className="flex flex-wrap gap-1">
      {tabs
        .filter((entry) => entry.show)
        .map((entry) => (
          <Link
            key={entry.path}
            to={analyticsPath(entry.path)}
            className={tab}
            activeProps={active}
            activeOptions={{ exact: entry.exact }}
          >
            {entry.label}
          </Link>
        ))}
    </nav>
  );
}

export function AnalyticsHeader({
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
        {actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </header>
      <AnalyticsNav />
    </div>
  );
}

/** A titled block with a hairline border, the frame every table on these screens sits in. */
export function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-card">
      <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">{title}</h2>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

/** One figure with its label: the dashboard's tiles. */
export function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly hint?: string;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * A translated sentence with `{name}` placeholders filled by nodes — a `<Money>` where the
 * value is an amount, so money in a sentence is formatted like money everywhere else.
 */
export function Template({
  text,
  values,
}: {
  readonly text: string;
  readonly values: Readonly<Record<string, ReactNode>>;
}) {
  const parts = text.split(/(\{[a-zA-Z]+\})/);
  return (
    <>
      {parts.map((part, index) => {
        const name = /^\{([a-zA-Z]+)\}$/.exec(part)?.[1];
        const value = name === undefined ? undefined : values[name];
        return <Fragment key={index}>{value ?? part}</Fragment>;
      })}
    </>
  );
}

export const CELL = 'h-row px-4 text-left';
export const NUMERIC = 'h-row px-4 text-right tabular-nums';
export const HEAD = 'h-row px-4 text-left text-xs font-medium text-muted-foreground';
export const HEAD_NUMERIC = 'h-row px-4 text-right text-xs font-medium text-muted-foreground';
export const INPUT =
  'h-8 rounded-md border border-border bg-background px-2 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring';
export const BUTTON =
  'inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50';
