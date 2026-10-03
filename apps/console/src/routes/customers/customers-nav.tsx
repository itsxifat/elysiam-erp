import {
  PageHeader,
  TabList,
  controlClassName,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import type { ComponentProps, ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useCustomersT } from './messages.js';

/** A customers path, widened once until the routes are in the router's type (see `courierPath`). */
export type CustomersPath = ComponentProps<typeof Link>['to'];
export const customersPath = (path: string): CustomersPath => path;

/**
 * The buyer screens as tabs, each shown only to a role that can open it.
 *
 * The lapsed list is `export BuyerExport` (D-208), not `read Customer`: a sales agent who
 * can look up a buyer should not be shown a tab that is a list of everybody's numbers.
 */
export function CustomersNav() {
  const t = useCustomersT();
  const ability = useAbility();

  const tab = tabClassName;
  const active = { className: tabActiveClassName };

  const tabs = [
    {
      path: '/customers',
      label: t('customers.nav.all'),
      show: ability.can('read', 'Customer'),
      exact: true,
    },
    {
      path: '/customers/lapsed',
      label: t('customers.nav.lapsed'),
      show: ability.can('export', 'BuyerExport'),
      exact: false,
    },
  ];

  return (
    <TabList label={t('customers.title')}>
      {tabs
        .filter((entry) => entry.show)
        .map((entry) => (
          <Link
            key={entry.path}
            to={customersPath(entry.path)}
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

export function CustomersHeader({
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
      tabs={<CustomersNav />}
    />
  );
}

/** The table labels every list in this section shares. */
export function useTableLabels(emptyTitle: string, emptyDetail: string, page: number) {
  const t = useCustomersT();
  return {
    columns: t('customers.columns'),
    previous: t('customers.previous'),
    next: t('customers.next'),
    emptyTitle,
    emptyDetail,
    errorTitle: t('customers.errorTitle'),
    errorDetail: t('customers.errorDetail'),
    retry: t('customers.retry'),
    pageStatus: `${t('customers.page')} ${String(page)}`,
    sortAscending: t('customers.sortAscending'),
    sortDescending: t('customers.sortDescending'),
  };
}

export const control = `${controlClassName} disabled:opacity-50`;
