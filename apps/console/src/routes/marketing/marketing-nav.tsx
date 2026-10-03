import {
  PageHeader,
  TabList,
  cn,
  controlClassName,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import type { ComponentProps, ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useMarketingT } from './messages.js';

/** A marketing path, widened once until the routes are in the router's type (see `courierPath`). */
export type MarketingPath = ComponentProps<typeof Link>['to'];
export const marketingPath = (path: string): MarketingPath => path;

/**
 * The marketing screens as tabs, each shown only to a role that can open it (D-260).
 *
 * Spend is `CampaignSpend`, which accounts also holds ("spend entry", §6); everything else
 * is `Campaign`. So an accountant sees one tab, Spend, and nothing that answers 403.
 */
export function MarketingNav() {
  const t = useMarketingT();
  const ability = useAbility();
  const campaign = ability.can('read', 'Campaign');

  const tab = tabClassName;
  const active = { className: tabActiveClassName };

  const tabs = [
    { path: '/marketing', label: t('marketing.nav.dashboard'), show: campaign, exact: true },
    {
      path: '/marketing/campaigns',
      label: t('marketing.nav.campaigns'),
      show: campaign,
      exact: false,
    },
    {
      path: '/marketing/spend',
      label: t('marketing.nav.spend'),
      show: ability.can('read', 'CampaignSpend'),
      exact: false,
    },
    { path: '/marketing/leads', label: t('marketing.nav.leads'), show: campaign, exact: false },
    {
      path: '/marketing/segments',
      label: t('marketing.nav.segments'),
      show: campaign,
      exact: false,
    },
    { path: '/marketing/meta', label: t('marketing.nav.meta'), show: campaign, exact: false },
  ];

  return (
    <TabList label={t('marketing.title')}>
      {tabs
        .filter((entry) => entry.show)
        .map((entry) => (
          <Link
            key={entry.path}
            to={marketingPath(entry.path)}
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

export function MarketingHeader({
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
      tabs={<MarketingNav />}
    />
  );
}

/** The table labels every list in this section shares. */
export function useMarketingTableLabels(emptyTitle: string, emptyDetail: string) {
  const t = useMarketingT();
  return {
    columns: t('marketing.columns'),
    previous: t('marketing.previous'),
    next: t('marketing.next'),
    emptyTitle,
    emptyDetail,
    errorTitle: t('marketing.errorTitle'),
    errorDetail: t('marketing.errorDetail'),
    retry: t('marketing.retry'),
    pageStatus: `${t('marketing.page')} 1`,
    sortAscending: t('marketing.sortAscending'),
    sortDescending: t('marketing.sortDescending'),
  };
}

/** A from–to pair of Dhaka dates, the shape every period on these screens takes. */
export function PeriodPicker({
  from,
  to,
  onChange,
  idPrefix,
}: {
  readonly from: string;
  readonly to: string;
  readonly onChange: (next: { from: string; to: string }) => void;
  readonly idPrefix: string;
}) {
  const t = useMarketingT();
  const input = cn(controlClassName, 'w-auto tabular-nums');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={`${idPrefix}-from`} className="text-xs font-medium text-muted-foreground">
        {t('marketing.period.from')}
      </label>
      <input
        id={`${idPrefix}-from`}
        type="date"
        className={input}
        value={from}
        max={to}
        onChange={(event) => {
          if (event.target.value !== '') onChange({ from: event.target.value, to });
        }}
      />
      <label htmlFor={`${idPrefix}-to`} className="text-xs font-medium text-muted-foreground">
        {t('marketing.period.to')}
      </label>
      <input
        id={`${idPrefix}-to`}
        type="date"
        className={input}
        value={to}
        min={from}
        onChange={(event) => {
          if (event.target.value !== '') onChange({ from, to: event.target.value });
        }}
      />
    </div>
  );
}
