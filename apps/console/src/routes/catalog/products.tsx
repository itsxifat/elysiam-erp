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
import { useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { formatSort, keysetPage, mergeSearch, parseSort } from '../../lib/table-search.js';
import { listCategories, listProducts, type CatalogProductListItem } from './api.js';
import { useCatalogT } from './messages.js';

/**
 * The product list (M06 Build list: "product list with pg_trgm search and filters").
 *
 * Three things it is careful about, and each one is a bug it would otherwise have:
 *
 * **The search fragment has a floor of three characters, and the screen says so.**
 * `pg_trgm` produces no trigrams from a two-character word, so a shorter fragment
 * cannot use the GIN index and the query becomes the sequential scan check 2 is
 * about. The server refuses it; this screen therefore does not send it, and shows
 * the hint rather than letting a keystroke produce a 400 that reads as a broken
 * search box.
 *
 * **Filters live in the URL** (M05's `tableSearchSchema`), so a merchandiser can
 * paste "active shirts" into a chat and the other person sees the same rows.
 *
 * **Prices are never parsed.** `fromPricePoisha` is an integer-poisha string and
 * goes straight into `<Money>`. And there is no cost column, because there is no
 * cost field to put in one (invariant 5).
 */

const route = getRouteApi('/catalog');

export function CatalogProductsPage() {
  const ability = useAbility();
  const t = useT();
  const ct = useCatalogT();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const mayRead = ability.can('read', 'Catalog');
  const mayWrite = ability.can('create', 'Catalog');

  // Keyset pagination cannot compute "page 4"; it needs the last row of page 3.
  // So the walk is remembered as the operator pages forward, exactly as the
  // approvals inbox does, and the pager offers Previous/Next rather than page
  // numbers — which is the honest shape for a cursor endpoint.
  const [cursors, setCursors] = useState<ReadonlyMap<number, string>>(new Map());
  const cursor = cursors.get(search.page);

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: listCategories,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const query = useQuery({
    queryKey: ['catalog', 'products', search.q, search.status, search.pageSize, cursor ?? null],
    queryFn: () =>
      listProducts({
        q: search.q,
        categoryId: search.type,
        status: search.status,
        limit: search.pageSize,
        cursor,
      }),
    enabled: mayRead && (search.page === 1 || cursor !== undefined),
  });

  const next = query.data?.nextCursor;
  if (next != null && cursors.get(search.page + 1) !== next) {
    setCursors((current) => new Map(current).set(search.page + 1, next));
  }

  const columns = useMemo<readonly DataTableColumn<CatalogProductListItem>[]>(() => {
    const column = dataTableColumns<CatalogProductListItem>();
    return column.columns([
      column.accessor('name', {
        header: ct('catalog.colProduct'),
        meta: { sortable: true },
        cell: (cell) => (
          <Link
            to="/catalog/$productId"
            params={{ productId: cell.row.original.id }}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('categoryName', {
        header: ct('catalog.colCategory'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
      column.accessor('status', {
        header: ct('catalog.colStatus'),
        cell: (cell) => {
          const status = cell.getValue();
          return (
            <StatusBadge
              tone={status === 'active' ? 'success' : status === 'archived' ? 'neutral' : 'info'}
            >
              {ct(`catalog.status.${status}`)}
            </StatusBadge>
          );
        },
      }),
      column.accessor('skuCount', {
        header: ct('catalog.colSkus'),
        meta: { numeric: true },
      }),
      column.accessor('fromPricePoisha', {
        header: ct('catalog.colPrice'),
        meta: { numeric: true },
        cell: (cell) => {
          const row = cell.row.original;
          if (row.fromPricePoisha === null) return '—';
          // A range when the variants are priced differently, one figure when they
          // are not. "From ৳1490" on a product whose every SKU costs ৳1490 reads as
          // if something is being hidden.
          return row.toPricePoisha !== null && row.toPricePoisha !== row.fromPricePoisha ? (
            <span className="tabular-nums">
              <Money poisha={row.fromPricePoisha} />
              {'–'}
              <Money poisha={row.toPricePoisha} symbol={false} />
            </span>
          ) : (
            <Money poisha={row.fromPricePoisha} />
          );
        },
      }),
    ]);
  }, [ct]);

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: ct('catalog.deniedTitle'), detail: ct('catalog.deniedDetail') }}
    >
      <div className="space-y-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{ct('catalog.title')}</h1>
            <p className="text-sm text-muted-foreground">{ct('catalog.products')}</p>
          </div>
          <PermissionGate allowed={mayWrite}>
            {/* A Link styled as a button rather than a Button wrapping a Link: the
                kit's Button renders a real <button>, and nesting an anchor inside one
                is invalid HTML that keyboard and screen-reader users hit first. */}
            <Link to="/catalog/new" className={buttonVariants({ size: 'sm' })}>
              {ct('catalog.newProduct')}
            </Link>
          </PermissionGate>
        </header>

        <DataTable
          columns={columns}
          data={query.data?.items ?? []}
          getRowId={(row) => row.id}
          page={keysetPage(search, query.data?.nextCursor != null)}
          onPageChange={(page) => void navigate({ search: mergeSearch(search, { page }) })}
          sort={parseSort(search.sort)}
          onSortChange={(sort) =>
            void navigate({ search: mergeSearch(search, { sort: formatSort(sort) }) })
          }
          loading={query.isPending}
          error={query.error}
          onRetry={() => void query.refetch()}
          caption={ct('catalog.products')}
          labels={{
            columns: ct('catalog.columns'),
            previous: ct('catalog.previous'),
            next: ct('catalog.next'),
            emptyTitle: ct('catalog.emptyTitle'),
            // Only a role that can create products is told to create one.
            emptyDetail: ct(mayWrite ? 'catalog.emptyDetail' : 'catalog.emptyDetailReadOnly'),
            errorTitle: ct('catalog.errorTitle'),
            errorDetail: ct('catalog.errorDetail'),
            retry: ct('catalog.retry'),
            pageStatus: `${t('table.page')} ${String(search.page)}`,
            sortAscending: ct('catalog.sortAscending'),
            sortDescending: ct('catalog.sortDescending'),
          }}
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="catalog-search">
                {ct('catalog.search')}
              </label>
              <input
                id="catalog-search"
                type="search"
                defaultValue={search.q ?? ''}
                placeholder={ct('catalog.search')}
                aria-describedby="catalog-search-hint"
                className="h-8 w-56 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => {
                  const value = event.target.value.trim();
                  // Below the floor the param is cleared rather than sent, so the
                  // table shows everything instead of erroring.
                  void navigate({
                    search: mergeSearch(search, { q: value.length >= 3 ? value : undefined }),
                  });
                }}
              />
              <span id="catalog-search-hint" className="text-xs text-muted-foreground">
                {ct('catalog.searchHint')}
              </span>

              <select
                aria-label={ct('catalog.allCategories')}
                value={search.type ?? ''}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) =>
                  void navigate({
                    search: mergeSearch(search, { type: event.target.value || undefined }),
                  })
                }
              >
                <option value="">{ct('catalog.allCategories')}</option>
                {(categories.data?.items ?? []).map((category) => (
                  <option key={category.id} value={category.id}>
                    {' '.repeat(category.depth * 2)}
                    {category.name}
                  </option>
                ))}
              </select>

              <select
                aria-label={ct('catalog.allStatuses')}
                value={search.status ?? ''}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) =>
                  void navigate({
                    search: mergeSearch(search, { status: event.target.value || undefined }),
                  })
                }
              >
                <option value="">{ct('catalog.allStatuses')}</option>
                <option value="draft">{ct('catalog.status.draft')}</option>
                <option value="active">{ct('catalog.status.active')}</option>
                <option value="archived">{ct('catalog.status.archived')}</option>
              </select>
            </div>
          }
        />
      </div>
    </PermissionGate>
  );
}
