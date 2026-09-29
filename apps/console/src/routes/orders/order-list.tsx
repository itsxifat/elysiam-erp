import {
  Button,
  DataTable,
  DateTime,
  Money,
  PermissionGate,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCheck, FileText, Plus, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  bulkConfirm,
  documentsUrl,
  listAgents,
  listAreas,
  listOrders,
  ORDER_CHANNELS,
  ORDER_STATUSES,
  type OrderChannel,
  type OrderRow,
  type OrderStatus,
} from './api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { LiveIndicator, OrdersNav, OrderStatusBadge, useOrderEvents } from './parts.js';
import { ordersPath, useSchemaSearch } from './paths.js';
import { mergeOrderSearch, orderListSearchSchema } from './search.js';

/**
 * Every order the caller may see, filtered (M11 Build list: status, channel, date, agent,
 * zone), with bulk confirm and bulk print.
 *
 * The filters are in the URL (M05), so "yesterday's unconfirmed WhatsApp orders" is a link.
 * The list is §6-scoped by the server — a sales agent's "every agent" is their own orders
 * and the unassigned queue, because that is what the query returns to them, not because
 * this screen hides anything.
 *
 * Selection is per page and lives in component state: it is a gesture, not a view, and a
 * shared link that arrived with forty orders pre-selected would be a trap.
 */

const SELECT =
  'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function OrderListPage() {
  const ability = useAbility();
  const t = useOrdersT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Order')}
      explain={{ title: t('orders.deniedTitle'), detail: t('orders.deniedDetail') }}
    >
      <OrderList />
    </PermissionGate>
  );
}

function OrderList() {
  const t = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const live = useOrderEvents();
  const [search, setSearch] = useSchemaSearch(orderListSearchSchema);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const agentFilter = search.agent;
  const queue = agentFilter === 'unassigned' || agentFilter === 'mine' ? agentFilter : undefined;

  const orders = useQuery({
    queryKey: ['orders', 'list', search],
    queryFn: () =>
      listOrders({
        status: search.status,
        channel: search.channel,
        queue,
        assignedTo: queue === undefined ? agentFilter : undefined,
        zoneId: search.zone,
        q: search.q,
        from: search.from,
        to: search.to,
        limit: search.pageSize,
        offset: (search.page - 1) * search.pageSize,
      }),
  });

  const agents = useQuery({
    queryKey: ['orders', 'agents'],
    queryFn: listAgents,
    staleTime: 5 * 60_000,
  });
  const areas = useQuery({
    queryKey: ['orders', 'areas'],
    queryFn: listAreas,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const agentName = useMemo(
    () => new Map((agents.data?.items ?? []).map((agent) => [agent.userId, agent.name])),
    [agents.data],
  );
  const zoneName = useMemo(
    () =>
      new Map(
        (areas.data?.zones ?? []).map((zone) => [
          zone.id,
          locale === 'bn' ? zone.nameBn : zone.nameEn,
        ]),
      ),
    [areas.data, locale],
  );

  const rows = orders.data?.items ?? [];
  const pageIds = rows.map((row) => row.id);
  const chosen = pageIds.filter((id) => selected.has(id));
  const allChosen = pageIds.length > 0 && chosen.length === pageIds.length;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const confirmMany = useMutation({
    mutationFn: () => bulkConfirm(chosen),
    onSuccess: (result) => {
      const failed = result.results.length - result.confirmed;
      setBulkMessage(
        `${String(result.confirmed)} ${t('orders.bulk.confirmedCount')}` +
          (failed > 0 ? ` · ${String(failed)} ${t('orders.bulk.failedCount')}` : ''),
      );
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => setBulkMessage(error instanceof Error ? error.message : String(error)),
  });

  const columns = useMemo<readonly DataTableColumn<OrderRow>[]>(() => {
    const column = dataTableColumns<OrderRow>();
    return column.columns([
      column.display({
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            aria-label={t('orders.bulk.selectAll')}
            checked={allChosen}
            onChange={() => setSelected(allChosen ? new Set() : new Set([...selected, ...pageIds]))}
            className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
          />
        ),
        cell: (cell) => (
          <input
            type="checkbox"
            aria-label={`${t('orders.bulk.selectRow')} ${cell.row.original.orderNo}`}
            checked={selected.has(cell.row.original.id)}
            onChange={() => toggle(cell.row.original.id)}
            className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
          />
        ),
      }),
      column.accessor('orderNo', {
        header: t('orders.col.orderNo'),
        cell: (cell) => (
          <Link
            to={ordersPath(`/orders/${cell.row.original.id}`)}
            className="font-medium tabular-nums underline-offset-4 hover:underline"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor((row) => row.customer.name, {
        id: 'customer',
        header: t('orders.col.customer'),
      }),
      column.accessor((row) => row.shipTo.phone, {
        id: 'phone',
        header: t('orders.col.phone'),
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.accessor('status', {
        header: t('orders.col.status'),
        cell: (cell) => <OrderStatusBadge status={cell.getValue()} />,
      }),
      column.accessor('channel', {
        header: t('orders.col.channel'),
        cell: (cell) => t(`orders.channel.${cell.getValue()}` as OrdersMessageKey),
      }),
      column.accessor((row) => row.deliveryZoneId, {
        id: 'zone',
        header: t('orders.col.zone'),
        cell: (cell) => {
          const id = cell.getValue();
          return id === null ? '—' : (zoneName.get(id) ?? '—');
        },
      }),
      column.accessor((row) => row.assignedTo, {
        id: 'agent',
        header: t('orders.col.agent'),
        cell: (cell) => {
          const id = cell.getValue();
          return id === null ? (
            <span className="text-muted-foreground">{t('orders.detail.unassigned')}</span>
          ) : (
            (agentName.get(id) ?? id)
          );
        },
      }),
      column.accessor((row) => row.amounts.codAmountPoisha, {
        id: 'cod',
        header: t('orders.col.cod'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor((row) => row.timestamps.createdAt, {
        id: 'created',
        header: t('orders.col.created'),
        cell: (cell) => <DateTime value={cell.getValue()} />,
      }),
    ]);
    // `selected` and `allChosen` change the checkbox cells; the rest is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, selected, allChosen, agentName, zoneName, rows]);

  const mayConfirm = ability.can('update', 'Order');

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t('orders.list.title')}</h1>
          <LiveIndicator status={live} />
        </div>
        {ability.can('create', 'Order') ? (
          <Link
            to={ordersPath('/orders/new')}
            className="inline-flex h-control items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <Plus aria-hidden="true" className="size-4" />
            {t('orders.desk.title')}
          </Link>
        ) : null}
      </header>

      <OrdersNav />

      {chosen.length === 0 ? null : (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
          role="region"
          aria-label={t('orders.bulk.selected')}
        >
          <span className="text-sm tabular-nums">
            {chosen.length} {t('orders.bulk.selected')}
          </span>
          {mayConfirm ? (
            <Button size="sm" disabled={confirmMany.isPending} onClick={() => confirmMany.mutate()}>
              <CheckCheck aria-hidden="true" />
              {t('orders.bulk.confirm')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(documentsUrl(chosen, 'invoice'), '_blank')}
          >
            <FileText aria-hidden="true" />
            {t('orders.bulk.printInvoices')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(documentsUrl(chosen, 'label'), '_blank')}
          >
            <Tag aria-hidden="true" />
            {t('orders.bulk.printLabels')}
          </Button>
        </div>
      )}
      {bulkMessage === null ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {bulkMessage}
        </p>
      )}

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.id}
        page={{
          page: search.page,
          pageSize: search.pageSize,
          total: null,
          hasNext: orders.data?.hasNext ?? false,
        }}
        onPageChange={(page) => setSearch(mergeOrderSearch(search, { page }))}
        sort={null}
        onSortChange={() => undefined}
        loading={orders.isPending}
        error={orders.error}
        onRetry={() => void orders.refetch()}
        caption={t('orders.list.caption')}
        labels={{
          columns: t('orders.columns'),
          previous: t('orders.previous'),
          next: t('orders.next'),
          emptyTitle: t('orders.emptyTitle'),
          emptyDetail: t('orders.emptyDetail'),
          errorTitle: t('orders.errorTitle'),
          errorDetail: t('orders.errorDetail'),
          retry: t('orders.retry'),
          pageStatus: `${t('orders.page')} ${String(search.page)}`,
          sortAscending: t('orders.sortAscending'),
          sortDescending: t('orders.sortDescending'),
        }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="orders-search">
              {t('orders.filter.search')}
            </label>
            <input
              id="orders-search"
              type="search"
              defaultValue={search.q ?? ''}
              placeholder={t('orders.filter.search')}
              className="h-8 w-56 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => {
                const value = event.target.value.trim();
                setSearch(mergeOrderSearch(search, { q: value.length >= 2 ? value : undefined }));
              }}
            />
            <select
              aria-label={t('orders.col.status')}
              value={search.status ?? ''}
              className={SELECT}
              onChange={(event) =>
                setSearch(
                  mergeOrderSearch(search, {
                    status: (event.target.value || undefined) as OrderStatus | undefined,
                  }),
                )
              }
            >
              <option value="">{t('orders.filter.allStatuses')}</option>
              {ORDER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`orders.status.${status}` as OrdersMessageKey)}
                </option>
              ))}
            </select>
            <select
              aria-label={t('orders.col.channel')}
              value={search.channel ?? ''}
              className={SELECT}
              onChange={(event) =>
                setSearch(
                  mergeOrderSearch(search, {
                    channel: (event.target.value || undefined) as OrderChannel | undefined,
                  }),
                )
              }
            >
              <option value="">{t('orders.filter.allChannels')}</option>
              {ORDER_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {t(`orders.channel.${channel}` as OrdersMessageKey)}
                </option>
              ))}
            </select>
            <select
              aria-label={t('orders.col.agent')}
              value={search.agent ?? ''}
              className={SELECT}
              onChange={(event) =>
                setSearch(mergeOrderSearch(search, { agent: event.target.value || undefined }))
              }
            >
              <option value="">{t('orders.filter.allAgents')}</option>
              <option value="mine">{t('orders.filter.mine')}</option>
              <option value="unassigned">{t('orders.filter.unassigned')}</option>
              {(agents.data?.items ?? []).map((agent) => (
                <option key={agent.userId} value={agent.userId}>
                  {agent.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t('orders.col.zone')}
              value={search.zone ?? ''}
              className={SELECT}
              onChange={(event) =>
                setSearch(mergeOrderSearch(search, { zone: event.target.value || undefined }))
              }
            >
              <option value="">{t('orders.filter.allZones')}</option>
              {(areas.data?.zones ?? []).map((zone) => (
                <option key={zone.id} value={zone.id}>
                  {locale === 'bn' ? zone.nameBn : zone.nameEn}
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {t('orders.filter.from')}
              <input
                type="date"
                value={search.from ?? ''}
                className={SELECT}
                onChange={(event) =>
                  setSearch(mergeOrderSearch(search, { from: event.target.value || undefined }))
                }
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {t('orders.filter.to')}
              <input
                type="date"
                value={search.to ?? ''}
                className={SELECT}
                onChange={(event) =>
                  setSearch(mergeOrderSearch(search, { to: event.target.value || undefined }))
                }
              />
            </label>
          </div>
        }
      />
    </div>
  );
}
