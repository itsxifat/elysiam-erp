import {
  DataTable,
  Money,
  PermissionGate,
  StatusBadge,
  buttonVariants,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { useMemo } from 'react';

import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { formatSort, mergeSearch, parseSort } from '../../lib/table-search.js';
import { listCategories } from '../catalog/api.js';
import { listLocations, listStock, stockValuation, type StockRow } from './api.js';
import { StockNav } from './stock-nav.js';
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

  const transit = new Set(
    (locations.data?.items ?? [])
      .filter((location) => location.kind === 'in_transit')
      .map((location) => location.id),
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
            className="font-medium text-foreground underline-offset-4 hover:underline"
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
        cell: (cell) => <span className="font-mono text-xs">{cell.getValue()}</span>,
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
  }, [mayReadCost, st, t]);

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('stock.deniedTitle'), detail: st('stock.deniedDetail') }}
    >
      <div className="space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{st('stock.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('cs.stock.help')}</p>
          </div>
          {/* Quick actions: receiving is the common one, so it is the primary. */}
          <div className="flex flex-wrap items-center gap-2">
            <PermissionGate allowed={ability.can('create', 'Supply')}>
              <Link to="/supply/entries" className={buttonVariants({ size: 'sm' })}>
                {t('cs.receive.action')}
              </Link>
            </PermissionGate>
            <PermissionGate allowed={ability.can('request', 'StockAdjustment')}>
              <Link
                to="/stock/transfers"
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
              >
                {t('cs.transfer.action')}
              </Link>
              <Link
                to="/stock/adjustments"
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
              >
                {t('cs.adjust.action')}
              </Link>
              <Link to="/stock/counts" className={buttonVariants({ size: 'sm', variant: 'ghost' })}>
                {t('cs.stock.count')}
              </Link>
            </PermissionGate>
          </div>
        </header>

        <StockNav />

        <PermissionGate allowed={mayReadCost}>
          <section
            aria-label={st('stock.valuation')}
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2"
          >
            <div>
              <p className="text-xs text-muted-foreground">{st('stock.valuationUnits')}</p>
              <p className="text-base font-semibold tabular-nums">{valuation.data?.units ?? '—'}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{st('stock.valuationTotal')}</p>
              <p className="text-base font-semibold">
                {valuation.data === undefined ? (
                  '—'
                ) : (
                  <Money poisha={valuation.data.stockValuePoisha} />
                )}
              </p>
            </div>
          </section>
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
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="stock-search">
                {st('stock.search')}
              </label>
              <input
                id="stock-search"
                type="search"
                defaultValue={search.q ?? ''}
                placeholder={st('stock.search')}
                className="h-8 w-56 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => {
                  const value = event.target.value.trim();
                  void navigate({
                    search: mergeSearch(search, { q: value === '' ? undefined : value, page: 1 }),
                  });
                }}
              />

              <select
                aria-label={st('stock.allLocations')}
                value={search.type ?? ''}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) =>
                  void navigate({
                    search: mergeSearch(search, {
                      type: event.target.value || undefined,
                      page: 1,
                    }),
                  })
                }
              >
                <option value="">{st('stock.allLocations')}</option>
                {(locations.data?.items ?? []).map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.code} · {location.name}
                  </option>
                ))}
              </select>

              <select
                aria-label={t('cs.stock.allCategories')}
                value={search.category ?? ''}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) =>
                  void navigate({
                    search: {
                      ...mergeSearch(search, { page: 1 }),
                      category: event.target.value === '' ? undefined : event.target.value,
                    },
                  })
                }
              >
                <option value="">{t('cs.stock.allCategories')}</option>
                {(categories.data?.items ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {'  '.repeat(category.depth)}
                    {category.name}
                  </option>
                ))}
              </select>

              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={lowOnly}
                  className="size-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) =>
                    void navigate({
                      search: mergeSearch(search, {
                        status: event.target.checked ? 'low' : undefined,
                        page: 1,
                      }),
                    })
                  }
                />
                {st('stock.lowOnly')}
              </label>
            </div>
          }
        />
      </div>
    </PermissionGate>
  );
}
