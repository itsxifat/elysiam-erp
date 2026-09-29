import {
  DataTable,
  DateTime,
  PermissionGate,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
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
import { useSchemaSearch } from './paths.js';
import { BUYER_PAGE_SIZE, buyerSearchSchema, type BuyerSearch } from './search.js';

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
const INPUT =
  'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

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
      column.accessor('name', { header: t('orders.buyers.col.name') }),
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
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t('orders.buyers.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('orders.buyers.subtitle')}</p>
        </div>
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
            className="inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Download aria-hidden="true" className="size-4" />
            {t('orders.buyers.exportCsv')}
          </a>
          <a
            href={buyersExportUrl(filters, 'xlsx')}
            className="inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Download aria-hidden="true" className="size-4" />
            {t('orders.buyers.exportXlsx')}
          </a>
        </div>
      </header>

      <OrdersNav />

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
            <select
              aria-label={t('orders.col.channel')}
              value={search.channel ?? ''}
              className={INPUT}
              onChange={(event) =>
                update({ channel: (event.target.value || undefined) as OrderChannel | undefined })
              }
            >
              <option value="">{t('orders.filter.allChannels')}</option>
              {ORDER_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {t(`orders.channel.${channel}` as OrdersMessageKey)}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {t('orders.filter.from')}
              <input
                type="date"
                value={search.from ?? ''}
                className={INPUT}
                onChange={(event) => update({ from: event.target.value || undefined })}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {t('orders.filter.to')}
              <input
                type="date"
                value={search.to ?? ''}
                className={INPUT}
                onChange={(event) => update({ to: event.target.value || undefined })}
              />
            </label>
          </div>
        }
      />
    </div>
  );
}
