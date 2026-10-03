import {
  Button,
  DataTable,
  DateTime,
  FilterChips,
  Input,
  Money,
  PageHeader,
  PermissionGate,
  SearchInput,
  Select,
  buttonVariants,
  dataTableColumns,
  type ActiveFilter,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  CheckCheck,
  FileText,
  PackageCheck,
  Plus,
  SlidersHorizontal,
  Tag,
  Truck,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import {
  bulkConfirm,
  bulkTransition,
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
 * zone), with bulk confirm, bulk pack and hand-over (D-393) and bulk print.
 *
 * The filters are in the URL (M05), so "yesterday's unconfirmed WhatsApp orders" is a link.
 * The list is §6-scoped by the server — a sales agent's "every agent" is their own orders
 * and the unassigned queue, because that is what the query returns to them, not because
 * this screen hides anything.
 *
 * Selection is per page and lives in component state: it is a gesture, not a view, and a
 * shared link that arrived with forty orders pre-selected would be a trap.
 */

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
  const common = useT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const live = useOrderEvents();
  const [search, setSearch] = useSchemaSearch(orderListSearchSchema);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);
  // Agent, zone and dates are a second row, shown on request or while one is set: most
  // visits filter by status and nothing else (D-452).
  const advancedSet =
    search.agent !== undefined ||
    search.zone !== undefined ||
    search.from !== undefined ||
    search.to !== undefined;
  const [moreFilters, setMoreFilters] = useState(advancedSet);

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

  // Pack and hand to the courier in bulk (D-393): the warehouse's half of bulk confirm.
  const moveMany = useMutation({
    mutationFn: (trigger: 'pack' | 'ship') => bulkTransition(chosen, trigger),
    onSuccess: (result) => {
      const failed = result.results.length - result.moved;
      setBulkMessage(
        `${String(result.moved)} ${t('orders.bulk.movedCount')}` +
          (failed > 0 ? ` · ${String(failed)} ${t('orders.bulk.notMoved')}` : ''),
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
            className="size-4 accent-primary"
          />
        ),
        cell: (cell) => (
          <input
            type="checkbox"
            aria-label={`${t('orders.bulk.selectRow')} ${cell.row.original.orderNo}`}
            checked={selected.has(cell.row.original.id)}
            onChange={() => toggle(cell.row.original.id)}
            className="size-4 accent-primary"
          />
        ),
      }),
      column.accessor('orderNo', {
        header: t('orders.col.orderNo'),
        cell: (cell) => (
          <Link
            to={ordersPath(`/orders/${cell.row.original.id}`)}
            className="font-medium text-foreground tabular-nums underline-offset-4 hover:text-primary hover:underline"
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
        cell: (cell) => (
          <span className="text-muted-foreground">
            <DateTime value={cell.getValue()} />
          </span>
        ),
      }),
    ]);
    // `selected` and `allChosen` change the checkbox cells; the rest is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, selected, allChosen, agentName, zoneName, rows]);

  const mayConfirm = ability.can('update', 'Order');

  const statusOptions = [
    { value: '', label: t('orders.filter.allStatuses') },
    ...ORDER_STATUSES.map((status) => ({
      value: status,
      label: t(`orders.status.${status}` as OrdersMessageKey),
    })),
  ];
  const channelOptions = [
    { value: '', label: t('orders.filter.allChannels') },
    ...ORDER_CHANNELS.map((channel) => ({
      value: channel,
      label: t(`orders.channel.${channel}` as OrdersMessageKey),
    })),
  ];
  const agentOptions = [
    { value: '', label: t('orders.filter.allAgents') },
    { value: 'mine', label: t('orders.filter.mine') },
    { value: 'unassigned', label: t('orders.filter.unassigned') },
    ...(agents.data?.items ?? []).map((agent) => ({ value: agent.userId, label: agent.name })),
  ];
  const zoneOptions = [
    { value: '', label: t('orders.filter.allZones') },
    ...(areas.data?.zones ?? []).map((zone) => ({
      value: zone.id,
      label: locale === 'bn' ? zone.nameBn : zone.nameEn,
    })),
  ];
  const labelOf = (options: readonly { value: string; label: string }[], value: string) =>
    options.find((option) => option.value === value)?.label ?? value;

  // The filters that are on, as chips: what is narrowing the list, readable at a glance.
  const active: ActiveFilter[] = [
    ...(search.status === undefined
      ? []
      : [
          {
            key: 'status',
            label: t('orders.col.status'),
            value: labelOf(statusOptions, search.status),
            onRemove: () => setSearch(mergeOrderSearch(search, { status: undefined })),
          },
        ]),
    ...(search.channel === undefined
      ? []
      : [
          {
            key: 'channel',
            label: t('orders.col.channel'),
            value: labelOf(channelOptions, search.channel),
            onRemove: () => setSearch(mergeOrderSearch(search, { channel: undefined })),
          },
        ]),
    ...(search.agent === undefined
      ? []
      : [
          {
            key: 'agent',
            label: t('orders.col.agent'),
            value: labelOf(agentOptions, search.agent),
            onRemove: () => setSearch(mergeOrderSearch(search, { agent: undefined })),
          },
        ]),
    ...(search.zone === undefined
      ? []
      : [
          {
            key: 'zone',
            label: t('orders.col.zone'),
            value: labelOf(zoneOptions, search.zone),
            onRemove: () => setSearch(mergeOrderSearch(search, { zone: undefined })),
          },
        ]),
    ...(search.from === undefined
      ? []
      : [
          {
            key: 'from',
            label: t('orders.filter.from'),
            value: search.from,
            onRemove: () => setSearch(mergeOrderSearch(search, { from: undefined })),
          },
        ]),
    ...(search.to === undefined
      ? []
      : [
          {
            key: 'to',
            label: t('orders.filter.to'),
            value: search.to,
            onRemove: () => setSearch(mergeOrderSearch(search, { to: undefined })),
          },
        ]),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('orders.list.title')}
        meta={<LiveIndicator status={live} />}
        actions={
          ability.can('create', 'Order') ? (
            <Link to={ordersPath('/orders/new')} className={buttonVariants({ variant: 'primary' })}>
              <Plus aria-hidden="true" />
              {t('orders.desk.title')}
            </Link>
          ) : undefined
        }
        tabs={<OrdersNav />}
      />

      {chosen.length === 0 ? null : (
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg bg-selected px-3 py-2 motion-safe:animate-in"
          role="region"
          aria-label={t('orders.bulk.selected')}
        >
          <span className="mr-2 text-sm font-medium tabular-nums">
            {chosen.length} {t('orders.bulk.selected')}
          </span>
          {mayConfirm ? (
            <Button size="sm" disabled={confirmMany.isPending} onClick={() => confirmMany.mutate()}>
              <CheckCheck aria-hidden="true" />
              {t('orders.bulk.confirm')}
            </Button>
          ) : null}
          {mayConfirm ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={moveMany.isPending}
                onClick={() => moveMany.mutate('pack')}
              >
                <PackageCheck aria-hidden="true" />
                {t('orders.bulk.pack')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={moveMany.isPending}
                onClick={() => moveMany.mutate('ship')}
              >
                <Truck aria-hidden="true" />
                {t('orders.bulk.ship')}
              </Button>
            </>
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
          <div className="flex w-full flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="orders-search">
                {t('orders.filter.search')}
              </label>
              <SearchInput
                id="orders-search"
                defaultValue={search.q ?? ''}
                placeholder={t('orders.filter.search')}
                onChange={(event) => {
                  const value = event.target.value.trim();
                  setSearch(mergeOrderSearch(search, { q: value.length >= 2 ? value : undefined }));
                }}
              />
              <Select
                variant="filter"
                aria-label={t('orders.col.status')}
                value={search.status ?? ''}
                options={statusOptions}
                onValueChange={(value) =>
                  setSearch(
                    mergeOrderSearch(search, {
                      status: (value || undefined) as OrderStatus | undefined,
                    }),
                  )
                }
              />
              <Select
                variant="filter"
                aria-label={t('orders.col.channel')}
                value={search.channel ?? ''}
                options={channelOptions}
                onValueChange={(value) =>
                  setSearch(
                    mergeOrderSearch(search, {
                      channel: (value || undefined) as OrderChannel | undefined,
                    }),
                  )
                }
              />
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={moreFilters}
                aria-controls="orders-more-filters"
                onClick={() => setMoreFilters((value) => !value)}
                className="text-muted-foreground"
              >
                <SlidersHorizontal aria-hidden="true" />
                {moreFilters ? common('common.fewerFilters') : common('common.moreFilters')}
              </Button>
            </div>

            {moreFilters ? (
              <div
                id="orders-more-filters"
                className="flex flex-wrap items-center gap-2 motion-safe:animate-in"
              >
                <Select
                  variant="filter"
                  aria-label={t('orders.col.agent')}
                  value={search.agent ?? ''}
                  options={agentOptions}
                  onValueChange={(value) =>
                    setSearch(mergeOrderSearch(search, { agent: value || undefined }))
                  }
                />
                <Select
                  variant="filter"
                  aria-label={t('orders.col.zone')}
                  value={search.zone ?? ''}
                  options={zoneOptions}
                  onValueChange={(value) =>
                    setSearch(mergeOrderSearch(search, { zone: value || undefined }))
                  }
                />
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  {t('orders.filter.from')}
                  <Input
                    type="date"
                    value={search.from ?? ''}
                    className="w-40"
                    onChange={(event) =>
                      setSearch(mergeOrderSearch(search, { from: event.target.value || undefined }))
                    }
                  />
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                  {t('orders.filter.to')}
                  <Input
                    type="date"
                    value={search.to ?? ''}
                    className="w-40"
                    onChange={(event) =>
                      setSearch(mergeOrderSearch(search, { to: event.target.value || undefined }))
                    }
                  />
                </label>
              </div>
            ) : null}

            <FilterChips
              filters={active}
              removeLabel={common('common.removeFilter')}
              clearAllLabel={common('common.clearFilters')}
              onClearAll={() =>
                setSearch(
                  mergeOrderSearch(search, {
                    status: undefined,
                    channel: undefined,
                    agent: undefined,
                    zone: undefined,
                    from: undefined,
                    to: undefined,
                  }),
                )
              }
            />
          </div>
        }
      />
    </div>
  );
}
