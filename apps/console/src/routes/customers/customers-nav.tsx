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

  const tab =
    'rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const active = { className: `${tab} bg-muted font-medium text-foreground` };

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
    <nav aria-label={t('customers.title')} className="flex flex-wrap gap-1">
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
    </nav>
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
      <CustomersNav />
    </div>
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

export const control =
  'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
