import {
  DataTable,
  DateTime,
  PermissionGate,
  Select,
  controlClassName,
  dataTableColumns,
  type DataTableColumn,
  PageHeader,
  buttonVariants,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useMemo } from 'react';

import { useAbility } from '../../auth/session.js';
import {
  buyersExportUrl,
  listBuyers,
  ORDER_CHANNELS,
  type Buyer,
  type BuyerFilters,
  type OrderChannel,
} from './api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { OrdersNav } from './parts.js';
import { ordersPath, useSchemaSearch } from './paths.js';
import { BUYER_PAGE_SIZE, buyerSearchSchema, type BuyerSearch } from './search.js';
import { DateRangePicker } from '../../ui/date-picker.js';

/**
 * The buyer list and its export (M11 Build list; acceptance check 2).
 *
 * `export BuyerExport`, org_admin's and marketing's: a list of phone numbers of everybody
 * who bought something is the most reusable personal data this system holds, so the page
 * and the file are one grant. The count above the table is the server's count for the same
 * filters the file will contain — check 2 is that those two agree with the database, and
 * the screen shows the figure so a person can see it too.
 *
 * The export is a link, not a script download: the browser saves the file the server names,
 * with the cookie it already has, and the server logs who took which list.
 */
const INPUT = controlClassName;

export function BuyerListPage() {
  const ability = useAbility();
  const t = useOrdersT();
  return (
    <PermissionGate
      allowed={ability.can('export', 'BuyerExport')}
      explain={{ title: t('orders.buyers.deniedTitle'), detail: t('orders.buyers.deniedDetail') }}
    >
      <Buyers />
    </PermissionGate>
  );
}

function filtersOf(search: BuyerSearch): BuyerFilters {
  return {
    product: search.product,
    sku: search.sku?.toUpperCase(),
    size: search.size?.toUpperCase(),
    channel: search.channel,
    from: search.from,
    to: search.to,
  };
}

function Buyers() {
  const t = useOrdersT();
  const [search, setSearch] = useSchemaSearch(buyerSearchSchema);
  const filters = filtersOf(search);

  const buyers = useQuery({
    queryKey: ['orders', 'buyers', search],
    queryFn: () => listBuyers(filters, BUYER_PAGE_SIZE, (search.page - 1) * BUYER_PAGE_SIZE),
  });

  function update(patch: Partial<BuyerSearch>) {
    const next: Record<string, unknown> = { ...search, ...patch, page: patch.page ?? 1 };
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || value === '') delete next[key];
    }
    setSearch(buyerSearchSchema.parse(next));
  }

  const columns = useMemo<readonly DataTableColumn<Buyer>[]>(() => {
    const column = dataTableColumns<Buyer>();
    return column.columns([
      column.accessor('name', {
        header: t('orders.buyers.col.name'),
        cell: (cell) => (
          <Link
            to={ordersPath(`/customers/${cell.row.original.customerId}`)}
            className="font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('phone', {
        header: t('orders.buyers.col.phone'),
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.accessor((row) => [row.thana, row.district].filter(Boolean).join(', '), {
        id: 'area',
        header: t('orders.buyers.col.area'),
      }),
      column.accessor('orders', { header: t('orders.buyers.col.orders'), meta: { numeric: true } }),
      column.accessor('units', { header: t('orders.buyers.col.units'), meta: { numeric: true } }),
      column.accessor('lastOrderAt', {
        header: t('orders.buyers.col.last'),
        cell: (cell) => <DateTime value={cell.getValue()} dateOnly />,
      }),
    ]);
  }, [t]);

  const total = buyers.data?.total ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('orders.buyers.title')}
        description={t('orders.buyers.subtitle')}
        tabs={<OrdersNav />}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="text-sm text-muted-foreground tabular-nums"
              role="status"
              data-testid="buyer-count"
            >
              {total === null ? '—' : `${String(total)} ${t('orders.buyers.count')}`}
            </span>
            <a
              href={buyersExportUrl(filters, 'csv')}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Download aria-hidden="true" />
              {t('orders.buyers.exportCsv')}
            </a>
            <a
              href={buyersExportUrl(filters, 'xlsx')}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Download aria-hidden="true" />
              {t('orders.buyers.exportXlsx')}
            </a>
          </div>
        }
      />

      <DataTable
        columns={columns}
        data={buyers.data?.items ?? []}
        getRowId={(row) => row.customerId}
        page={{
          page: search.page,
          pageSize: BUYER_PAGE_SIZE,
          total,
          hasNext: total !== null && search.page * BUYER_PAGE_SIZE < total,
        }}
        onPageChange={(page) => update({ page })}
        sort={null}
        onSortChange={() => undefined}
        loading={buyers.isPending}
        error={buyers.error}
        onRetry={() => void buyers.refetch()}
        caption={t('orders.buyers.title')}
        labels={{
          columns: t('orders.columns'),
          previous: t('orders.previous'),
          next: t('orders.next'),
          emptyTitle: t('orders.buyers.emptyTitle'),
          emptyDetail: t('orders.buyers.emptyDetail'),
          errorTitle: t('orders.errorTitle'),
          errorDetail: t('orders.errorDetail'),
          retry: t('orders.retry'),
          pageStatus: `${t('orders.page')} ${String(search.page)}`,
          sortAscending: t('orders.sortAscending'),
          sortDescending: t('orders.sortDescending'),
        }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['product', 'orders.buyers.product', 'w-44'],
                ['sku', 'orders.buyers.sku', 'w-44'],
                ['size', 'orders.buyers.size', 'w-20'],
              ] as const
            ).map(([name, label, width]) => (
              <input
                key={name}
                type="search"
                aria-label={t(label as OrdersMessageKey)}
                placeholder={t(label as OrdersMessageKey)}
                defaultValue={search[name] ?? ''}
                className={`${INPUT} ${width}`}
                onChange={(event) => update({ [name]: event.target.value.trim() || undefined })}
              />
            ))}
            <Select
              variant="filter"
              aria-label={t('orders.col.channel')}
              value={search.channel ?? ''}
              onValueChange={(value) =>
                update({ channel: (value || undefined) as OrderChannel | undefined })
              }
              options={[
                { value: '', label: t('orders.filter.allChannels') },
                ...ORDER_CHANNELS.map((channel) => ({
                  value: channel,
                  label: t(`orders.channel.${channel}` as OrdersMessageKey),
                })),
              ]}
            />
            <DateRangePicker
              aria-label={`${t('orders.filter.from')} – ${t('orders.filter.to')}`}
              value={{ from: search.from ?? '', to: search.to ?? '' }}
              clearable
              onValueChange={(range) =>
                update({ from: range.from || undefined, to: range.to || undefined })
              }
            />
          </div>
        }
      />
    </div>
  );
}
