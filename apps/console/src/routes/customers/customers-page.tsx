import {
  DataTable,
  DateTime,
  Money,
  Monogram,
  PermissionGate,
  SearchInput,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';

import { useAbility } from '../../auth/session.js';
import { useSchemaSearch } from '../orders/paths.js';
import { listCustomers, type Customer } from './api.js';
import { CustomersHeader, customersPath, useTableLabels } from './customers-nav.js';
import { useCustomersT } from './messages.js';
import { CUSTOMER_PAGE_SIZE, customerSearchSchema, type CustomerSearch } from './routes.js';

/**
 * Every buyer the caller can reach, searchable by name or number (M16).
 *
 * `read Customer`, with the server's §6 scope: a sales agent sees the buyers of their own
 * orders and anybody nobody has ordered for yet. The list has no total because the
 * endpoint does not count — a "next" is offered while a page comes back full.
 */
export function CustomersPage() {
  const ability = useAbility();
  const t = useCustomersT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Customer')}
      explain={{ title: t('customers.deniedTitle'), detail: t('customers.deniedDetail') }}
    >
      <Customers />
    </PermissionGate>
  );
}

function Customers() {
  const t = useCustomersT();
  const [search, setSearch] = useSchemaSearch(customerSearchSchema);

  const customers = useQuery({
    queryKey: ['customers', 'list', search],
    queryFn: () =>
      listCustomers(search.q, CUSTOMER_PAGE_SIZE, (search.page - 1) * CUSTOMER_PAGE_SIZE),
  });

  function update(patch: Partial<CustomerSearch>) {
    const next: Record<string, unknown> = { ...search, ...patch, page: patch.page ?? 1 };
    if (next.q === undefined || next.q === '') delete next.q;
    setSearch(customerSearchSchema.parse(next));
  }

  const columns = useMemo<readonly DataTableColumn<Customer>[]>(() => {
    const column = dataTableColumns<Customer>();
    return column.columns([
      column.accessor('name', {
        header: t('customers.col.name'),
        cell: (cell) => (
          <Link
            to={customersPath(`/customers/${cell.row.original.id}`)}
            className="inline-flex items-center gap-2.5 font-medium underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Monogram name={cell.getValue()} size="sm" className="rounded-full" />
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('phone', {
        header: t('customers.col.phone'),
        cell: (cell) => (
          <span className="text-muted-foreground tabular-nums">{cell.getValue()}</span>
        ),
      }),
      column.accessor((row) => row.stats.orders, {
        id: 'orders',
        header: t('customers.col.orders'),
        meta: { numeric: true },
      }),
      column.accessor((row) => row.stats.delivered, {
        id: 'delivered',
        header: t('customers.col.delivered'),
        meta: { numeric: true },
      }),
      column.accessor((row) => row.stats.ltvPoisha, {
        id: 'ltv',
        header: t('customers.col.ltv'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} />,
      }),
      column.accessor((row) => row.stats.lastOrderAt, {
        id: 'last',
        header: t('customers.col.lastOrder'),
        cell: (cell) => {
          const value = cell.getValue();
          return value === null ? (
            '—'
          ) : (
            <DateTime value={value} dateOnly className="text-muted-foreground" />
          );
        },
      }),
    ]);
  }, [t]);

  const items = customers.data?.items ?? [];
  const labels = useTableLabels(t('customers.emptyTitle'), t('customers.emptyDetail'), search.page);

  return (
    <div className="space-y-6">
      <CustomersHeader title={t('customers.title')} caption={t('customers.subtitle')} />
      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        page={{
          page: search.page,
          pageSize: CUSTOMER_PAGE_SIZE,
          total: null,
          hasNext: items.length === CUSTOMER_PAGE_SIZE,
        }}
        onPageChange={(page) => update({ page })}
        sort={null}
        onSortChange={() => undefined}
        loading={customers.isPending}
        error={customers.error}
        onRetry={() => void customers.refetch()}
        caption={t('customers.title')}
        labels={labels}
        toolbar={
          <SearchInput
            aria-label={t('customers.search')}
            placeholder={t('customers.search')}
            defaultValue={search.q ?? ''}
            onChange={(event) => {
              const value = event.target.value.trim();
              // The server needs two characters; one would only flash an error.
              if (value.length === 1) return;
              update({ q: value === '' ? undefined : value });
            }}
          />
        }
      />
    </div>
  );
}
