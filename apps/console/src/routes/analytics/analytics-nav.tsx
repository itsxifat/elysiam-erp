import {
  PageHeader,
  TabList,
  cn,
  controlClassName,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
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

  const tab = tabClassName;
  const active = { className: tabActiveClassName };

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
    <TabList label={t('analytics.title')}>
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
    </TabList>
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
    <PageHeader
      title={title}
      description={caption}
      {...(actions === undefined ? {} : { actions })}
      tabs={<AnalyticsNav />}
    />
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
      <h2 className="px-4 pt-4 pb-3 text-base font-semibold tracking-tight">{title}</h2>
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
    <div className="space-y-1.5 rounded-lg border border-border bg-card p-5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-2xl font-medium tabular-nums">{value}</p>
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

export const CELL = 'h-row border-t border-border px-4 text-left whitespace-nowrap';
export const NUMERIC =
  'h-row border-t border-border px-4 text-right tabular-nums whitespace-nowrap';
export const HEAD =
  'h-9 px-4 text-left text-xs font-medium whitespace-nowrap text-muted-foreground';
export const HEAD_NUMERIC =
  'h-9 px-4 text-right text-xs font-medium whitespace-nowrap text-muted-foreground';
/** The kit's control chrome at the small height, for the date pickers in a header. */
export const INPUT = cn(controlClassName, 'h-control-sm px-2.5 tabular-nums');
export const BUTTON =
  'inline-flex h-control-sm items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-sm font-medium text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50 [&_svg]:text-muted-foreground';
