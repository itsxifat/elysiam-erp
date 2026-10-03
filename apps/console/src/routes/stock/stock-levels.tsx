import {
  Button,
  Checkbox,
  DataTable,
  FilterChips,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Money,
  PermissionGate,
  SearchInput,
  Select,
  StatusBadge,
  buttonVariants,
  dataTableColumns,
  type ActiveFilter,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { MoreHorizontal, PackagePlus } from 'lucide-react';
import { useMemo } from 'react';

import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { formatSort, mergeSearch, parseSort } from '../../lib/table-search.js';
import { listCategories } from '../catalog/api.js';
import { listLocations, listStock, stockValuation, type StockRow } from './api.js';
import { StockHeader } from './stock-nav.js';
import { useStockT } from './messages.js';

/**
 * Stock levels (M07 Build list: "available quantity for all roles; cost and stock
 * value only for cost roles").
 *
 * The cost columns are built **from the caller's ability**, not from whether the field
 * happens to be present. Two reasons, and the second is the one that matters:
 *
 * * `serializeFor` already removes `wacPoisha` and `stockValuePoisha` for a role
 *   without `read Cost`, so rendering them unconditionally would put empty cells in
 *   front of a sales agent — a column that exists and is always blank reads as broken
 *   data rather than as withheld data;
 * * deciding from the ability means the screen and the server agree about *why* the
 *   number is absent. If the two ever disagree, the server wins and the column is
 *   blank, which is the safe direction.
 *
 * Availability is `on hand − reserved`, and it is the column with the badge: a full
 * shelf that is entirely promised to confirmed orders is not stock anybody can sell,
 * and showing only "on hand" is how an order desk oversells.
 *
 * Filters live in the URL (M05's `tableSearchSchema`), so "low stock at the Gulshan
 * showroom" is a link somebody can paste into a chat.
 */

const route = getRouteApi('/stock');

export function StockLevelsPage() {
  const ability = useAbility();
  const t = useT();
  const st = useStockT();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const mayRead = ability.can('read', 'Stock');
  const mayReadCost = ability.can('read', 'Cost');
  const lowOnly = search.status === 'low';

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const transit = useMemo(
    () =>
      new Set(
        (locations.data?.items ?? [])
          .filter((location) => location.kind === 'in_transit')
          .map((location) => location.id),
      ),
    [locations.data],
  );

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: listCategories,
    enabled: mayRead && ability.can('read', 'Catalog'),
    staleTime: 5 * 60_000,
  });

  const rows = useQuery({
    queryKey: [
      'stock',
      'levels',
      search.q,
      search.type,
      search.category,
      lowOnly,
      search.page,
      search.pageSize,
    ],
    queryFn: () =>
      listStock({
        q: search.q,
        locationId: search.type,
        categoryId: search.category,
        low: lowOnly,
        page: search.page,
        pageSize: search.pageSize,
      }),
    enabled: mayRead,
  });

  const valuation = useQuery({
    queryKey: ['stock', 'valuation', search.type ?? null],
    queryFn: () => stockValuation(search.type),
    // Only asked for when the caller may have it. A 403 in the network tab of a
    // sales agent's browser is not a security problem, but it is a support call.
    enabled: mayReadCost,
    staleTime: 60_000,
  });

  const columns = useMemo<readonly DataTableColumn<StockRow>[]>(() => {
    const column = dataTableColumns<StockRow>();
    const base = [
      // The product first, linked to its page — where receiving, adjusting and
      // transferring it are one click each (plan `catalog-stock-ux`, D-420).
      column.accessor('productName', {
        header: st('stock.colProduct'),
        cell: (cell) => (
          <Link
            to="/catalog/$productId"
            params={{ productId: cell.row.original.productId }}
            className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('variantLabel', {
        header: t('cs.col.variant'),
        cell: (cell) => cell.getValue() || '—',
      }),
      column.accessor('skuCode', {
        header: st('stock.colSku'),
        meta: { sortable: true },
        cell: (cell) => (
          <span className="font-mono text-xs text-muted-foreground">{cell.getValue()}</span>
        ),
      }),
      column.accessor('locationCode', {
        header: st('stock.colLocation'),
        cell: (cell) => cell.row.original.locationName,
      }),
      column.accessor('onHand', { header: st('stock.colOnHand'), meta: { numeric: true } }),
      column.accessor('reserved', { header: st('stock.colReserved'), meta: { numeric: true } }),
      column.accessor('available', {
        header: st('stock.colAvailable'),
        meta: { numeric: true },
        cell: (cell) => {
          const row = cell.row.original;
          const low = row.reorderLevel > 0 && row.available <= row.reorderLevel;
          return (
            <span className="inline-flex items-center gap-2 tabular-nums">
              {cell.getValue()}
              {row.available === 0 && !transit.has(row.locationId) ? (
                <StatusBadge tone="danger">{t('cs.hub.out')}</StatusBadge>
              ) : low ? (
                <StatusBadge tone="warning">{st('stock.lowOnly')}</StatusBadge>
              ) : null}
            </span>
          );
        },
      }),
      column.accessor('reorderLevel', {
        header: st('stock.colReorder'),
        meta: { numeric: true },
        cell: (cell) => (cell.getValue() === 0 ? '—' : cell.getValue()),
      }),
    ];

    if (!mayReadCost) return column.columns(base);

    return column.columns([
      ...base,
      column.accessor('wacPoisha', {
        header: st('stock.colWac'),
        meta: { numeric: true },
        cell: (cell) => {
          const value = cell.getValue();
          // Still guarded. The ability says the server should have sent it; if it
          // did not, an em dash is the honest rendering rather than `৳NaN`.
          return value === undefined ? '—' : <Money poisha={value} />;
        },
      }),
      column.accessor('stockValuePoisha', {
        header: st('stock.colValue'),
        meta: { numeric: true },
        cell: (cell) => {
          const value = cell.getValue();
          return value === undefined ? '—' : <Money poisha={value} />;
        },
      }),
    ]);
  }, [mayReadCost, st, t, transit]);

  const mayTransfer = ability.can('request', 'StockAdjustment');
  const locationOptions = [
    { value: '', label: st('stock.allLocations') },
    ...(locations.data?.items ?? []).map((location) => ({
      value: location.id,
      label: `${location.code} · ${location.name}`,
    })),
  ];
  const categoryOptions = [
    { value: '', label: t('cs.stock.allCategories') },
    ...(categories.data?.items ?? []).map((category) => ({
      value: category.id,
      // Nested categories indent with no-break spaces, which the list keeps.
      label: `${'\u00a0\u00a0'.repeat(category.depth)}${category.name}`,
    })),
  ];
  const labelOf = (options: readonly { value: string; label: string }[], value: string) =>
    (options.find((option) => option.value === value)?.label ?? value).trim();

  // The filters that are narrowing the list, as chips with a remove each (D-452).
  const active: ActiveFilter[] = [
    ...(search.type === undefined
      ? []
      : [
          {
            key: 'location',
            label: st('stock.colLocation'),
            value: labelOf(locationOptions, search.type),
            onRemove: () =>
              void navigate({ search: mergeSearch(search, { type: undefined, page: 1 }) }),
          },
        ]),
    ...(search.category === undefined
      ? []
      : [
          {
            key: 'category',
            label: t('catalog.colCategory'),
            value: labelOf(categoryOptions, search.category),
            onRemove: () =>
              void navigate({
                search: { ...mergeSearch(search, { page: 1 }), category: undefined },
              }),
          },
        ]),
  ];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('stock.deniedTitle'), detail: st('stock.deniedDetail') }}
    >
      <div className="space-y-6">
        <StockHeader
          title={st('stock.title')}
          description={t('cs.stock.help')}
          actions={
            // Receiving is the common one, so it is the primary; the rest sit in a menu
            // (and in the tabs below), so the header carries one obvious action (D-445).
            <>
              <PermissionGate allowed={ability.can('create', 'Supply')}>
                <Link to="/supply/entries" className={buttonVariants({ variant: 'primary' })}>
                  <PackagePlus aria-hidden="true" />
                  {t('cs.receive.action')}
                </Link>
              </PermissionGate>
              <PermissionGate allowed={mayTransfer}>
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="outline" size="icon" aria-label={t('common.more')}>
                      <MoreHorizontal aria-hidden="true" />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem asChild>
                      <Link to="/stock/transfers">{t('cs.transfer.action')}</Link>
                    </MenuItem>
                    <MenuItem asChild>
                      <Link to="/stock/adjustments">{t('cs.adjust.action')}</Link>
                    </MenuItem>
                    <MenuItem asChild>
                      <Link to="/stock/counts">{t('cs.stock.count')}</Link>
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </PermissionGate>
            </>
          }
        />

        <PermissionGate allowed={mayReadCost}>
          <dl
            aria-label={st('stock.valuation')}
            className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-2 sm:divide-x sm:divide-border"
          >
            <div className="px-5 py-4">
              <dt className="text-xs text-muted-foreground">{st('stock.valuationUnits')}</dt>
              <dd className="mt-1 text-xl font-medium tabular-nums">
                {valuation.data?.units ?? '—'}
              </dd>
            </div>
            <div className="px-5 py-4">
              <dt className="text-xs text-muted-foreground">{st('stock.valuationTotal')}</dt>
              <dd className="mt-1 text-xl font-medium">
                {valuation.data === undefined ? (
                  '—'
                ) : (
                  <Money poisha={valuation.data.stockValuePoisha} align="start" compact />
                )}
              </dd>
            </div>
          </dl>
        </PermissionGate>

        <DataTable
          columns={columns}
          data={(rows.data?.items ?? []).filter(
            // An empty in-transit row is bookkeeping, not stock anybody can look for.
            (row) => row.onHand > 0 || !transit.has(row.locationId),
          )}
          getRowId={(row) => `${row.skuId}:${row.locationId}`}
          page={{
            page: search.page,
            pageSize: search.pageSize,
            // Offset pagination with no count query: `total` is honestly unknown, and
            // "there is another page" is "this one came back full". A fabricated
            // total is worse than none (the kit says so on `TablePage.total`).
            total: null,
            hasNext: (rows.data?.items.length ?? 0) === search.pageSize,
          }}
          onPageChange={(page) => void navigate({ search: mergeSearch(search, { page }) })}
          sort={parseSort(search.sort)}
          onSortChange={(sort) =>
            void navigate({ search: mergeSearch(search, { sort: formatSort(sort) }) })
          }
          loading={rows.isPending}
          error={rows.error}
          onRetry={() => void rows.refetch()}
          caption={st('stock.levels')}
          // Reserved and the reorder level are one click away under Columns, so the table
          // fits a laptop (D-458); Available already nets out what is reserved.
          initialColumnVisibility={{ reserved: false, reorderLevel: false }}
          labels={{
            columns: st('stock.columns'),
            previous: st('stock.previous'),
            next: st('stock.next'),
            emptyTitle: st('stock.emptyTitle'),
            emptyDetail: st('stock.emptyDetail'),
            errorTitle: st('stock.errorTitle'),
            errorDetail: st('stock.errorDetail'),
            retry: st('stock.retry'),
            pageStatus: `${t('table.page')} ${String(search.page)}`,
            sortAscending: st('stock.sortAscending'),
            sortDescending: st('stock.sortDescending'),
          }}
          toolbar={
            <div className="flex w-full flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="stock-search">
                  {st('stock.search')}
                </label>
                <SearchInput
                  id="stock-search"
                  defaultValue={search.q ?? ''}
                  placeholder={st('stock.search')}
                  onChange={(event) => {
                    const value = event.target.value.trim();
                    void navigate({
                      search: mergeSearch(search, {
                        q: value === '' ? undefined : value,
                        page: 1,
                      }),
                    });
                  }}
                />

                <Select
                  variant="filter"
                  aria-label={st('stock.allLocations')}
                  value={search.type ?? ''}
                  options={locationOptions}
                  onValueChange={(value) =>
                    void navigate({
                      search: mergeSearch(search, { type: value || undefined, page: 1 }),
                    })
                  }
                />

                <Select
                  variant="filter"
                  aria-label={t('cs.stock.allCategories')}
                  value={search.category ?? ''}
                  options={categoryOptions}
                  onValueChange={(value) =>
                    void navigate({
                      search: {
                        ...mergeSearch(search, { page: 1 }),
                        category: value === '' ? undefined : value,
                      },
                    })
                  }
                />

                <label className="inline-flex h-control items-center gap-2 px-1 text-sm">
                  <Checkbox
                    checked={lowOnly}
                    onCheckedChange={(checked) =>
                      void navigate({
                        search: mergeSearch(search, {
                          status: checked === true ? 'low' : undefined,
                          page: 1,
                        }),
                      })
                    }
                  />
                  {st('stock.lowOnly')}
                </label>
              </div>

              <FilterChips
                filters={active}
                removeLabel={t('common.removeFilter')}
                clearAllLabel={t('common.clearFilters')}
                onClearAll={() =>
                  void navigate({
                    search: {
                      ...mergeSearch(search, { type: undefined, page: 1 }),
                      category: undefined,
                    },
                  })
                }
              />
            </div>
          }
        />
      </div>
    </PermissionGate>
  );
}
