import {
  PageHeader,
  TabList,
  cn,
  controlClassName,
  tabActiveClassName,
  tabClassName,
  type TablePage,
} from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import type { ComponentProps, ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useCampaignsT } from './messages.js';

/** A campaigns path, widened once until the routes are in the router's type (see `courierPath`). */
export type CampaignsPath = ComponentProps<typeof Link>['to'];
export const campaignsPath = (path: string): CampaignsPath => path;

/**
 * The campaign screens as tabs, each shown only to a role that can open it.
 *
 * Promo codes are the `LandingPage` subject (D-203); templates, opt-outs and the delivery
 * log are `Campaign` (D-205). Today the same roles hold both, but the tabs ask the routes'
 * own questions so a later split does not show anybody a tab that answers 403.
 */
export function CampaignsNav() {
  const t = useCampaignsT();
  const ability = useAbility();

  const tab = tabClassName;
  const active = { className: tabActiveClassName };

  const tabs = [
    {
      path: '/campaigns',
      label: t('campaigns.nav.codes'),
      show: ability.can('read', 'LandingPage'),
      exact: true,
    },
    {
      path: '/campaigns/templates',
      label: t('campaigns.nav.templates'),
      show: ability.can('read', 'Campaign'),
      exact: false,
    },
    {
      path: '/campaigns/opt-outs',
      label: t('campaigns.nav.optOuts'),
      show: ability.can('read', 'Campaign'),
      exact: false,
    },
    {
      path: '/campaigns/log',
      label: t('campaigns.nav.log'),
      show: ability.can('read', 'Campaign'),
      exact: false,
    },
  ];

  return (
    <TabList label={t('campaigns.title')}>
      {tabs
        .filter((entry) => entry.show)
        .map((entry) => (
          <Link
            key={entry.path}
            to={campaignsPath(entry.path)}
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

export function CampaignsHeader({
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
      tabs={<CampaignsNav />}
    />
  );
}

/** The table labels every list in this section shares. */
export function useCampaignTableLabels(emptyTitle: string, emptyDetail: string) {
  const t = useCampaignsT();
  return {
    columns: t('campaigns.columns'),
    previous: t('campaigns.previous'),
    next: t('campaigns.next'),
    emptyTitle,
    emptyDetail,
    errorTitle: t('campaigns.errorTitle'),
    errorDetail: t('campaigns.errorDetail'),
    retry: t('campaigns.retry'),
    pageStatus: `${t('campaigns.page')} 1`,
    sortAscending: t('campaigns.sortAscending'),
    sortDescending: t('campaigns.sortDescending'),
  };
}

/**
 * The one page these lists have. Each endpoint returns its newest few hundred rows and no
 * cursor, so there is nothing to page through; the table still wants to say how many.
 */
export function singlePage(count: number): TablePage {
  return { page: 1, pageSize: Math.max(count, 1), total: count, hasNext: false };
}

/** One labelled control, the shape the other sections' forms use. */
export function Field({
  label,
  id,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {hint === undefined || error !== undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

export const control = cn(controlClassName, 'w-full aria-[invalid=true]:border-destructive');
