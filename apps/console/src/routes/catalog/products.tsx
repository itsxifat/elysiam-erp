import {
  Button,
  Checkbox,
  ConfirmDialog,
  DataTable,
  Dialog,
  FilterChips,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Money,
  PageHeader,
  PermissionGate,
  SearchInput,
  Select,
  StatusBadge,
  buttonVariants,
  cn,
  controlClassName,
  dataTableColumns,
  type ActiveFilter,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import {
  Archive,
  ArchiveRestore,
  Copy,
  Eye,
  EyeOff,
  FileUp,
  ImageOff,
  MoreHorizontal,
  Plus,
  Printer,
  Settings2,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { deleteProduct, productUsage } from '../../api/manage.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/catalog-pricing.js';
import { formatSort, keysetPage, mergeSearch, parseSort } from '../../lib/table-search.js';
import { DeleteOrArchive } from '../../ui/delete-or-archive.js';
import { listSizeCharts } from '../website/api.js';
import {
  getProduct,
  imageUrl,
  listCategories,
  listProducts,
  type CatalogProductListItem,
} from './api.js';
import { useCatalogT } from './messages.js';
import {
  bulkProducts,
  bulkProductsWeb,
  duplicateProduct,
  productStockTotals,
} from './pricing-api.js';
import { StickerDialog, type StickerItem } from './stickers.js';
import { variantLabel } from './variant-table.js';

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
 *
 * M39b (D-642): a photo, the stock on hand (for a role that may read stock), whether the
 * website shows it and the price range on every row; a menu per row (open, duplicate, show or
 * hide on the website, archive or restore); and, for rows ticked on this page, the same
 * changes in bulk plus "move to category", "set size chart" and "print stickers". The
 * selection is the page's own and is never taken from the address, so a shared link cannot
 * arrive with forty products chosen. Delete (M39a's routes, D-623) opens the shared
 * Delete-or-archive dialog: a product nothing uses is deleted, anything else archived.
 * "Delete unused" on ticked rows deletes each one nothing uses, one request each (the server
 * asks what uses it inside every delete), and keeps the rest, saying how many.
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
  const mayUpdate = ability.can('update', 'Catalog');
  const mayWeb = ability.can('update', 'Storefront');
  const mayStock = ability.can('read', 'Stock');
  const mayDelete = ability.can('delete', 'Catalog');
  const queryClient = useQueryClient();
  const navigate2 = useNavigate();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [duplicating, setDuplicating] = useState<CatalogProductListItem | null>(null);
  const [managing, setManaging] = useState<CatalogProductListItem | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [stickers, setStickers] = useState<readonly StickerItem[] | null>(null);

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
    queryKey: [
      'catalog',
      'products',
      search.q,
      search.type,
      search.status,
      search.pageSize,
      cursor ?? null,
    ],
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

  const rows = query.data?.items ?? [];
  const pageIds = rows.map((row) => row.id);
  const chosen = pageIds.filter((id) => selected.has(id));
  const allChosen = pageIds.length > 0 && chosen.length === pageIds.length;
  const stock = useQuery({
    queryKey: ['stock', 'product-totals', pageIds.join(',')],
    queryFn: () => productStockTotals(pageIds),
    enabled: mayStock && pageIds.length > 0,
  });
  const stockOf = new Map((stock.data?.items ?? []).map((item) => [item.productId, item]));
  const charts = useQuery({
    queryKey: ['website', 'size-charts'],
    queryFn: listSizeCharts,
    enabled: mayWeb,
    staleTime: 60_000,
  });

  const done = (text: string) => {
    setMessage({ text, error: false });
    setSelected(new Set());
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };
  const failed = (error: unknown) =>
    setMessage({
      text: error instanceof ApiError ? error.message : t('cp.saveFailed'),
      error: true,
    });
  const change = useMutation({
    mutationFn: (input: Parameters<typeof bulkProducts>[0]) => bulkProducts(input),
    onSuccess: () => done(t('cp.list.done')),
    onError: failed,
  });
  const web = useMutation({
    mutationFn: (input: Parameters<typeof bulkProductsWeb>[0]) => bulkProductsWeb(input),
    onSuccess: () => done(t('cp.list.done')),
    onError: failed,
  });
  const printStickers = useMutation({
    mutationFn: async (ids: readonly string[]) => {
      const items: StickerItem[] = [];
      for (const id of ids) {
        const product = await getProduct(id);
        for (const sku of product.skus.filter((entry) => entry.status === 'active')) {
          const variant = variantLabel(sku);
          items.push({
            skuId: sku.id,
            label: variant === '' ? product.name : `${product.name} · ${variant}`,
            skuCode: sku.skuCode,
            count: 1,
          });
        }
      }
      return items;
    },
    onSuccess: setStickers,
    onError: failed,
  });
  /**
   * Delete every ticked product nothing uses (plan item 8). One request each, in turn: a
   * product in use is refused by the server (`*_IN_USE`) and kept; anything else stops the
   * run and says why, with what was already deleted counted.
   */
  const deleteUnused = async () => {
    let deleted = 0;
    let kept = 0;
    for (const id of chosen) {
      try {
        await deleteProduct(id);
        deleted += 1;
      } catch (error) {
        if (error instanceof ApiError && error.code?.endsWith('_IN_USE') === true) {
          kept += 1;
          continue;
        }
        void queryClient.invalidateQueries({ queryKey: ['catalog'] });
        failed(error);
        return;
      }
    }
    done(
      t('cp.list.deleteUnusedDone')
        .replace('{deleted}', String(deleted))
        .replace('{kept}', String(kept)),
    );
  };
  const toggle = (id: string) =>
    setSelected((current) => {
      const nextSet = new Set(current);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });

  const columns = useMemo<readonly DataTableColumn<CatalogProductListItem>[]>(() => {
    const column = dataTableColumns<CatalogProductListItem>();
    return column.columns([
      column.display({
        id: 'select',
        header: () => (
          <Checkbox
            aria-label={t('cp.list.selectPage')}
            checked={allChosen ? true : chosen.length > 0 ? 'indeterminate' : false}
            onCheckedChange={() =>
              setSelected(allChosen ? new Set() : new Set([...selected, ...pageIds]))
            }
          />
        ),
        cell: (cell) => (
          <Checkbox
            aria-label={`${t('cp.selectRow')} ${cell.row.original.name}`}
            checked={selected.has(cell.row.original.id)}
            onCheckedChange={() => toggle(cell.row.original.id)}
          />
        ),
      }),
      column.accessor('imageFileId', {
        header: t('cp.list.photo'),
        cell: (cell) => <ListThumb fileId={cell.getValue()} alt={cell.row.original.name} />,
      }),
      column.accessor('name', {
        header: ct('catalog.colProduct'),
        meta: { sortable: true },
        cell: (cell) => (
          <Link
            to="/catalog/$productId"
            params={{ productId: cell.row.original.id }}
            className="font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('categoryName', {
        header: ct('catalog.colCategory'),
        cell: (cell) => <span className="text-muted-foreground">{cell.getValue() ?? '—'}</span>,
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
      column.accessor('webVisible', {
        header: t('cp.list.website'),
        cell: (cell) => (
          <StatusBadge tone={cell.getValue() ? 'success' : 'neutral'}>
            {cell.getValue() ? t('cp.list.shown') : t('cp.list.hidden')}
          </StatusBadge>
        ),
      }),
      column.accessor('skuCount', {
        header: ct('catalog.colSkus'),
        meta: { numeric: true },
      }),
      ...(mayStock
        ? [
            column.display({
              id: 'stock',
              header: t('cp.list.stock'),
              meta: { numeric: true },
              cell: (cell) => {
                const totals = stockOf.get(cell.row.original.id);
                const onHand = totals?.onHand ?? 0;
                return (
                  <span className={cn('tabular-nums', onHand === 0 ? 'text-destructive' : '')}>
                    {stock.isPending ? '…' : onHand}
                  </span>
                );
              },
            }),
          ]
        : []),
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
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">{t('cs.col.actions')}</span>,
        cell: (cell) => {
          const row = cell.row.original;
          return (
            <Menu>
              <MenuTrigger
                aria-label={`${t('cp.list.actions')} ${row.name}`}
                className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
              >
                <MoreHorizontal aria-hidden="true" />
              </MenuTrigger>
              <MenuContent>
                <MenuItem asChild>
                  <Link to="/catalog/$productId" params={{ productId: row.id }}>
                    <SquarePen aria-hidden="true" />
                    {t('cp.list.edit')}
                  </Link>
                </MenuItem>
                {mayWrite ? (
                  <MenuItem onSelect={() => setDuplicating(row)}>
                    <Copy aria-hidden="true" />
                    {t('cp.dup.action')}
                  </MenuItem>
                ) : null}
                {mayWeb ? (
                  <MenuItem
                    onSelect={() =>
                      web.mutate({ productIds: [row.id], webVisible: !row.webVisible })
                    }
                  >
                    {row.webVisible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    {row.webVisible ? t('cp.list.hide') : t('cp.list.show')}
                  </MenuItem>
                ) : null}
                {mayUpdate ? (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      destructive={row.status !== 'archived'}
                      onSelect={() =>
                        change.mutate({
                          productIds: [row.id],
                          status: row.status === 'archived' ? 'active' : 'archived',
                        })
                      }
                    >
                      {row.status === 'archived' ? (
                        <ArchiveRestore aria-hidden="true" />
                      ) : (
                        <Archive aria-hidden="true" />
                      )}
                      {row.status === 'archived' ? t('cp.list.restore') : t('cp.list.archive')}
                    </MenuItem>
                  </>
                ) : null}
                {mayDelete ? (
                  <MenuItem destructive onSelect={() => setManaging(row)}>
                    <Trash2 aria-hidden="true" />
                    {t('cp.delete')}
                  </MenuItem>
                ) : null}
              </MenuContent>
            </Menu>
          );
        },
      }),
    ]);
    // The selection and the stock change the cells; the rest is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ct,
    t,
    selected,
    allChosen,
    rows,
    stock.data,
    mayStock,
    mayWeb,
    mayUpdate,
    mayWrite,
    mayDelete,
  ]);

  const categoryOptions = [
    { value: '', label: ct('catalog.allCategories') },
    ...(categories.data?.items ?? []).map((category) => ({
      value: category.id,
      // A sub-category sits under its parent, indented as the list nests.
      label: `${'\u00a0'.repeat(category.depth * 2)}${category.name}`,
    })),
  ];
  const statusOptions = [
    { value: '', label: ct('catalog.allStatuses') },
    { value: 'draft', label: ct('catalog.status.draft') },
    { value: 'active', label: ct('catalog.status.active') },
    { value: 'archived', label: ct('catalog.status.archived') },
  ];
  const labelOf = (options: readonly { value: string; label: string }[], value: string) =>
    (options.find((option) => option.value === value)?.label ?? value).trim();
  const active: ActiveFilter[] = [
    ...(search.type === undefined
      ? []
      : [
          {
            key: 'category',
            label: ct('catalog.colCategory'),
            value: labelOf(categoryOptions, search.type),
            onRemove: () => void navigate({ search: mergeSearch(search, { type: undefined }) }),
          },
        ]),
    ...(search.status === undefined
      ? []
      : [
          {
            key: 'status',
            label: ct('catalog.colStatus'),
            value: labelOf(statusOptions, search.status),
            onRemove: () => void navigate({ search: mergeSearch(search, { status: undefined }) }),
          },
        ]),
  ];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: ct('catalog.deniedTitle'), detail: ct('catalog.deniedDetail') }}
    >
      <div className="space-y-6">
        <PageHeader
          title={ct('catalog.title')}
          description={ct('catalog.products')}
          actions={
            <>
              {/* The catalog's setup and its importer live one click from the list
                  (plan `catalog-stock-ux`): before, neither was linked from anywhere. Quiet,
                  so New product stays the one obvious action. */}
              <Link to="/catalog/structure" className={buttonVariants({ variant: 'ghost' })}>
                <Settings2 aria-hidden="true" />
                {t('cs.setup.link')}
              </Link>
              <PermissionGate allowed={mayWrite}>
                <Link to="/catalog/import" className={buttonVariants({ variant: 'ghost' })}>
                  <FileUp aria-hidden="true" />
                  {t('cs.import.link')}
                </Link>
                {/* A Link styled as a button rather than a Button wrapping a Link: the
                    kit's Button renders a real <button>, and nesting an anchor inside one
                    is invalid HTML that keyboard and screen-reader users hit first. */}
                <Link to="/catalog/new" className={buttonVariants({ variant: 'primary' })}>
                  <Plus aria-hidden="true" />
                  {ct('catalog.newProduct')}
                </Link>
              </PermissionGate>
            </>
          }
        />

        {chosen.length === 0 ? null : (
          <div
            role="region"
            aria-label={t('cp.selected')}
            className="flex flex-wrap items-center gap-2 rounded-lg bg-selected px-3 py-2 motion-safe:animate-in"
          >
            <span className="me-2 text-sm font-medium tabular-nums">
              {`${String(chosen.length)} ${t('cp.selected')}`}
            </span>
            {mayWeb ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={web.isPending}
                  onClick={() => web.mutate({ productIds: chosen, webVisible: true })}
                >
                  <Eye aria-hidden="true" />
                  {t('cp.list.show')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={web.isPending}
                  onClick={() => web.mutate({ productIds: chosen, webVisible: false })}
                >
                  <EyeOff aria-hidden="true" />
                  {t('cp.list.hide')}
                </Button>
                <Select
                  variant="filter"
                  size="sm"
                  aria-label={t('cp.list.setChart')}
                  value=""
                  placeholder={t('cp.list.setChart')}
                  onValueChange={(value) =>
                    web.mutate({
                      productIds: chosen,
                      sizeChartId: value === 'none' ? null : value,
                    })
                  }
                  options={[
                    { value: 'none', label: t('cp.list.noChart') },
                    ...(charts.data?.items ?? []).map((chart) => ({
                      value: chart.id,
                      label: chart.name,
                    })),
                  ]}
                />
              </>
            ) : null}
            {mayUpdate ? (
              <>
                <Select
                  variant="filter"
                  size="sm"
                  aria-label={t('cp.list.moveTo')}
                  value=""
                  placeholder={t('cp.list.moveTo')}
                  onValueChange={(value) =>
                    change.mutate({
                      productIds: chosen,
                      categoryId: value === 'none' ? null : value,
                    })
                  }
                  options={[
                    { value: 'none', label: ct('catalog.allCategories') },
                    ...(categories.data?.items ?? [])
                      .filter((category) => category.isActive)
                      .map((category) => ({
                        value: category.id,
                        label: `${'\u00a0'.repeat(category.depth * 2)}${category.name}`,
                      })),
                  ]}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={change.isPending}
                  onClick={() => change.mutate({ productIds: chosen, status: 'archived' })}
                >
                  <Archive aria-hidden="true" />
                  {t('cp.list.archive')}
                </Button>
              </>
            ) : null}
            {mayDelete ? (
              <Button size="sm" variant="outline" onClick={() => setConfirmingDelete(true)}>
                <Trash2 aria-hidden="true" />
                {t('cp.list.deleteUnused')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={printStickers.isPending}
              onClick={() => printStickers.mutate(chosen)}
            >
              <Printer aria-hidden="true" />
              {t('cp.list.stickers')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              {t('cp.clearSelection')}
            </Button>
          </div>
        )}
        {message === null ? null : (
          <p
            role={message.error ? 'alert' : 'status'}
            className={cn('text-sm', message.error ? 'text-destructive' : 'text-muted-foreground')}
          >
            {message.text}
          </p>
        )}

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
            <div className="flex w-full flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="catalog-search">
                  {ct('catalog.search')}
                </label>
                <SearchInput
                  id="catalog-search"
                  defaultValue={search.q ?? ''}
                  placeholder={ct('catalog.search')}
                  aria-describedby="catalog-search-hint"
                  onChange={(event) => {
                    const value = event.target.value.trim();
                    // Below the floor the param is cleared rather than sent, so the
                    // table shows everything instead of erroring.
                    void navigate({
                      search: mergeSearch(search, { q: value.length >= 3 ? value : undefined }),
                    });
                  }}
                />
                <Select
                  variant="filter"
                  aria-label={ct('catalog.allCategories')}
                  value={search.type ?? ''}
                  options={categoryOptions}
                  onValueChange={(value) =>
                    void navigate({ search: mergeSearch(search, { type: value || undefined }) })
                  }
                />
                <Select
                  variant="filter"
                  aria-label={ct('catalog.allStatuses')}
                  value={search.status ?? ''}
                  options={statusOptions}
                  onValueChange={(value) =>
                    void navigate({ search: mergeSearch(search, { status: value || undefined }) })
                  }
                />
                <span id="catalog-search-hint" className="text-xs text-muted-foreground">
                  {ct('catalog.searchHint')}
                </span>
              </div>
              <FilterChips
                filters={active}
                removeLabel={t('common.removeFilter')}
                clearAllLabel={t('common.clearFilters')}
                onClearAll={() =>
                  void navigate({
                    search: mergeSearch(search, { type: undefined, status: undefined }),
                  })
                }
              />
            </div>
          }
        />
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title={t('cp.list.deleteUnusedTitle').replace('{n}', String(chosen.length))}
          description={t('cp.list.deleteUnusedHelp')}
          confirmLabel={t('cp.list.deleteUnused')}
          cancelLabel={t('cp.cancel')}
          closeLabel={t('cp.close')}
          destructive
          onConfirm={deleteUnused}
        />
        {managing === null ? null : (
          <DeleteOrArchive
            key={managing.id}
            open
            onClose={() => setManaging(null)}
            queryKey={['catalog', 'product-usage', managing.id]}
            loadUsage={() => productUsage(managing.id)}
            onDelete={() => deleteProduct(managing.id)}
            onArchive={
              mayUpdate
                ? () => bulkProducts({ productIds: [managing.id], status: 'archived' })
                : undefined
            }
            onRestore={
              mayUpdate
                ? () => bulkProducts({ productIds: [managing.id], status: 'active' })
                : undefined
            }
            onDone={() => done(t('cp.list.done'))}
          />
        )}
        {duplicating === null ? null : (
          <DuplicateFromList
            product={duplicating}
            onClose={() => setDuplicating(null)}
            onMade={(id) => {
              setDuplicating(null);
              void queryClient.invalidateQueries({ queryKey: ['catalog'] });
              void navigate2({ to: '/catalog/$productId', params: { productId: id } });
            }}
          />
        )}
        <StickerDialog
          open={stickers !== null}
          onOpenChange={(open) => {
            if (!open) setStickers(null);
          }}
          items={stickers ?? []}
        />
      </div>
    </PermissionGate>
  );
}

/** A row's photo: the first one, small, through a short-lived address. */
function ListThumb({ fileId, alt }: { readonly fileId: string | null; readonly alt: string }) {
  const url = useQuery({
    queryKey: ['files', 'url', fileId],
    queryFn: () => imageUrl(fileId ?? ''),
    enabled: fileId !== null,
    staleTime: 4 * 60_000,
  });
  return (
    <div className="flex size-10 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
      {url.data === undefined ? (
        <ImageOff aria-hidden className="size-4 text-muted-foreground" />
      ) : (
        <img src={url.data.url} alt={alt} className="size-full object-cover" loading="lazy" />
      )}
    </div>
  );
}

/** Duplicate from the list (D-641): the name, then the copy opens. */
function DuplicateFromList({
  product,
  onClose,
  onMade,
}: {
  readonly product: CatalogProductListItem;
  readonly onClose: () => void;
  readonly onMade: (id: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState(`${product.name} ${t('cp.dup.copySuffix')}`.slice(0, 200));
  const make = useMutation({
    mutationFn: () => duplicateProduct(product.id, { name: name.trim() }),
    onSuccess: (copy) => onMade(copy.id),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('cp.dup.title')}
      description={t('cp.dup.help')}
      closeLabel={t('cp.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cp.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || make.isPending} onClick={() => make.mutate()}>
            {t('cp.dup.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        <label htmlFor="duplicate-name" className="text-sm font-medium">
          {t('cp.dup.name')}
        </label>
        <input
          id="duplicate-name"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          className={cn(controlClassName, 'w-full')}
        />
        {make.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {make.error instanceof ApiError ? make.error.message : t('cp.saveFailed')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
