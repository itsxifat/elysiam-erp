import {
  Button,
  DataTable,
  DateTime,
  FileUpload,
  Money,
  PermissionGate,
  StatusBadge,
  dataTableColumns,
  takaToPoisha,
  type DataTableColumn,
  type UploadTicket,
  type UploadedFile,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { api } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import {
  addVariants,
  attachImage,
  detachImage,
  getProduct,
  labelSheetPdf,
  listAttributes,
  priceHistory,
  reorderImages,
  setPrices,
  type CatalogSku,
} from './api.js';
import { useCatalogT } from './messages.js';

/**
 * One product: its variant matrix, its prices, its images and its labels
 * (M06 Build list).
 *
 * ## The matrix panel adds; it never replaces
 *
 * The control is labelled "Add variants" and its help text says what it does,
 * because the mental model matters here more than the widget does. An operator who
 * believes this screen *sets* the matrix will untick XXL to discontinue it and
 * expect the SKUs to go — and check 1 exists because those SKUs have stock,
 * movements, order lines and printed labels behind them. So the endpoint only ever
 * adds, and when the selection no longer covers an existing variant the screen says
 * so plainly and leaves it alone.
 *
 * ## Prices
 *
 * Every price on this screen is an integer-poisha string (§23) rendered through
 * `<Money>` and edited in **taka** through `takaToPoisha`, which is integer
 * arithmetic — the alternative is `parseFloat(taka) * 100`, which the
 * `elysium/no-float-money` lint rule bans outright (D-090).
 *
 * The bulk edit is one request for every SKU shown, because the endpoint applies
 * all of them in one transaction or none (M06 check 4's sibling property). A
 * per-row save button would look friendlier and would leave half a product
 * repriced when the tab was closed.
 *
 * There is no cost column anywhere on this screen, and no field in the API types
 * that could become one (invariant 5).
 */

const route = getRouteApi('/catalog/$productId');

export function CatalogProductPage() {
  const ability = useAbility();
  const t = useT();
  const ct = useCatalogT();
  const { productId } = route.useParams();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Catalog');
  const mayWrite = ability.can('update', 'Catalog');

  const product = useQuery({
    queryKey: ['catalog', 'product', productId],
    queryFn: () => getProduct(productId),
    enabled: mayRead,
  });

  const attributes = useQuery({
    queryKey: ['catalog', 'attributes'],
    queryFn: listAttributes,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['catalog', 'product', productId] });

  const columns = useMemo<readonly DataTableColumn<CatalogSku>[]>(() => {
    const column = dataTableColumns<CatalogSku>();
    return column.columns([
      column.accessor('skuCode', {
        header: ct('catalog.colCode'),
        meta: { sortable: true },
        cell: (cell) => <span className="font-mono text-xs">{cell.getValue()}</span>,
      }),
      column.display({
        id: 'variant',
        header: ct('catalog.colVariant'),
        cell: (cell) =>
          cell.row.original.attributes.map((pair) => pair.valueLabel).join(' / ') || '—',
      }),
      column.accessor('pricePoisha', {
        header: ct('catalog.colPrice'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} />,
      }),
      column.accessor('barcode', {
        header: ct('catalog.colBarcode'),
        cell: (cell) => <span className="font-mono text-xs">{cell.getValue() ?? '—'}</span>,
      }),
      column.accessor('status', {
        header: ct('catalog.colStatus'),
        cell: (cell) => (
          <StatusBadge tone={cell.getValue() === 'active' ? 'success' : 'neutral'}>
            {ct(`catalog.status.${cell.getValue()}`)}
          </StatusBadge>
        ),
      }),
    ]);
  }, [ct]);

  const skus = product.data?.skus ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: ct('catalog.deniedTitle'), detail: ct('catalog.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">
            {product.data?.name ?? ct('catalog.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {product.data === undefined
              ? ''
              : `${ct('catalog.code')} ${String(product.data.sequence).padStart(4, '0')}`}
          </p>
        </header>

        <section aria-labelledby="variants-heading" className="space-y-3">
          <h2 id="variants-heading" className="text-sm font-semibold">
            {ct('catalog.variantMatrix')}
          </h2>
          <DataTable
            columns={columns}
            data={skus}
            getRowId={(row) => row.id}
            page={{
              page: 1,
              pageSize: Math.max(skus.length, 1),
              total: skus.length,
              hasNext: false,
            }}
            onPageChange={() => undefined}
            sort={null}
            onSortChange={() => undefined}
            loading={product.isPending}
            error={product.error}
            onRetry={() => void product.refetch()}
            caption={ct('catalog.variants')}
            labels={{
              columns: ct('catalog.columns'),
              previous: ct('catalog.previous'),
              next: ct('catalog.next'),
              emptyTitle: ct('catalog.emptyTitle'),
              emptyDetail: ct('catalog.addVariantsHelp'),
              errorTitle: ct('catalog.errorTitle'),
              errorDetail: ct('catalog.errorDetail'),
              retry: ct('catalog.retry'),
              pageStatus: `${t('table.page')} 1`,
              sortAscending: ct('catalog.sortAscending'),
              sortDescending: ct('catalog.sortDescending'),
            }}
          />
        </section>

        <PermissionGate allowed={mayWrite}>
          <AddVariants
            productId={productId}
            axes={attributes.data?.items ?? []}
            onDone={invalidate}
          />
          <BulkPrice skus={skus} onDone={invalidate} />
          <Images productId={productId} images={product.data?.images ?? []} onDone={invalidate} />
          <Labels skus={skus} />
        </PermissionGate>

        <PriceHistory skus={skus} />
      </div>
    </PermissionGate>
  );
}

/** Extend the matrix. See the note at the top of the file about why it only adds. */
function AddVariants({
  productId,
  axes,
  onDone,
}: {
  readonly productId: string;
  readonly axes: readonly {
    id: string;
    name: string;
    isVariant: boolean;
    values: readonly { id: string; label: string }[];
  }[];
  readonly onDone: () => void;
}) {
  const ct = useCatalogT();
  const [selected, setSelected] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
  const [result, setResult] = useState<{ created: number; orphaned: number } | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      addVariants(productId, {
        axes: [...selected]
          .filter(([, values]) => values.length > 0)
          .map(([attributeId, valueIds]) => ({ attributeId, valueIds })),
      }),
    onSuccess: (data) => {
      setResult({ created: data.created.length, orphaned: data.orphaned.length });
      onDone();
    },
  });

  const toggle = (attributeId: string, valueId: string) => {
    setSelected((current) => {
      const next = new Map(current);
      const values = current.get(attributeId) ?? [];
      next.set(
        attributeId,
        values.includes(valueId) ? values.filter((id) => id !== valueId) : [...values, valueId],
      );
      return next;
    });
  };

  const chosen = [...selected.values()].filter((values) => values.length > 0);

  return (
    <section
      aria-labelledby="add-variants-heading"
      className="space-y-3 rounded-md border border-border p-4"
    >
      <h2 id="add-variants-heading" className="text-sm font-semibold">
        {ct('catalog.addVariants')}
      </h2>
      <p className="text-sm text-muted-foreground">{ct('catalog.addVariantsHelp')}</p>

      {axes
        .filter((axis) => axis.isVariant)
        .map((axis) => (
          <fieldset key={axis.id} className="space-y-1">
            <legend className="text-xs font-medium text-muted-foreground">{axis.name}</legend>
            <div className="flex flex-wrap gap-3">
              {axis.values.map((value) => (
                <label key={value.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                    checked={(selected.get(axis.id) ?? []).includes(value.id)}
                    onChange={() => toggle(axis.id, value.id)}
                  />
                  {value.label}
                </label>
              ))}
            </div>
          </fieldset>
        ))}

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={chosen.length === 0 || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {ct('catalog.addVariants')}
        </Button>
        {result !== null && (
          <p className="text-sm text-muted-foreground">
            {result.created === 0
              ? ct('catalog.variantsNoneAdded')
              : `${String(result.created)} ${ct('catalog.variantsAdded')}`}
          </p>
        )}
      </div>

      {/* Orphans are stated, never acted on. */}
      {result !== null && result.orphaned > 0 && (
        <p className="text-sm text-warning-subtle-foreground">{ct('catalog.variantsOrphaned')}</p>
      )}
    </section>
  );
}

/** One price for every SKU shown, applied all at once or not at all. */
function BulkPrice({
  skus,
  onDone,
}: {
  readonly skus: readonly CatalogSku[];
  readonly onDone: () => void;
}) {
  const ct = useCatalogT();
  const [taka, setTaka] = useState('');
  const [reason, setReason] = useState('');

  /*
   * `takaToPoisha` is integer arithmetic and returns null for anything that is not
   * taka with up to two decimals. `parseFloat(taka) * 100` is 1998.9999999999998
   * for 19.99, and the `elysium/no-float-money` rule bans it outright (D-090).
   */
  const pricePoisha = takaToPoisha(taka);

  const mutation = useMutation({
    mutationFn: () =>
      setPrices({
        prices: skus.map((sku) => ({ skuId: sku.id, pricePoisha: pricePoisha ?? '' })),
        reason: reason === '' ? undefined : reason,
      }),
    onSuccess: () => {
      setTaka('');
      onDone();
    },
  });

  return (
    <section
      aria-labelledby="bulk-price-heading"
      className="space-y-3 rounded-md border border-border p-4"
    >
      <h2 id="bulk-price-heading" className="text-sm font-semibold">
        {ct('catalog.bulkPrice')}
      </h2>
      <p className="text-sm text-muted-foreground">{ct('catalog.bulkPriceHelp')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium">
          {ct('catalog.productPrice')}
          <input
            inputMode="decimal"
            value={taka}
            onChange={(event) => setTaka(event.target.value)}
            className="h-8 w-32 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium">
          {ct('catalog.priceReason')}
          <input
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            className="h-8 w-64 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <Button
          size="sm"
          disabled={pricePoisha === null || skus.length === 0 || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {ct('catalog.save')}
        </Button>
      </div>
    </section>
  );
}

/** Product images: upload through §22's presigned PUT, then order them. */
function Images({
  productId,
  images,
  onDone,
}: {
  readonly productId: string;
  readonly images: readonly { id: string; fileId: string; altText: string | null }[];
  readonly onDone: () => void;
}) {
  const ct = useCatalogT();

  const attach = useMutation({
    mutationFn: (fileId: string) => attachImage(productId, { fileId }),
    onSuccess: onDone,
  });
  const reorder = useMutation({
    mutationFn: (ids: readonly string[]) => reorderImages(productId, ids),
    onSuccess: onDone,
  });
  const detach = useMutation({
    mutationFn: (imageId: string) => detachImage(productId, imageId),
    onSuccess: onDone,
  });

  const move = (index: number, delta: number) => {
    const ids = images.map((image) => image.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const swapped = [...ids];
    const held = swapped[index] ?? '';
    swapped[index] = swapped[target] ?? '';
    swapped[target] = held;
    // The whole order, every time: the endpoint refuses a partial list rather
    // than renumbering some images and leaving the rest where they were.
    reorder.mutate(swapped);
  };

  return (
    <section
      aria-labelledby="images-heading"
      className="space-y-3 rounded-md border border-border p-4"
    >
      <h2 id="images-heading" className="text-sm font-semibold">
        {ct('catalog.images')}
      </h2>
      <p className="text-sm text-muted-foreground">{ct('catalog.imagesHelp')}</p>

      <ol className="space-y-1.5">
        {images.map((image, index) => (
          <li key={image.id} className="flex items-center gap-2 text-sm">
            <span className="w-5 text-right text-muted-foreground tabular-nums">{index + 1}</span>
            <span className="font-mono text-xs">{image.fileId.slice(0, 8)}</span>
            <span className="flex-1 truncate text-muted-foreground">{image.altText ?? ''}</span>
            {/* Buttons rather than drag-and-drop as the only path: a keyboard user
                cannot drag, and `.claude/rules/frontend.md` puts a visible focus
                ring and keyboard reach on every interactive element. */}
            <Button
              size="sm"
              variant="ghost"
              aria-label={ct('catalog.imageMoveUp')}
              disabled={index === 0 || reorder.isPending}
              onClick={() => move(index, -1)}
            >
              {'↑'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={ct('catalog.imageMoveDown')}
              disabled={index === images.length - 1 || reorder.isPending}
              onClick={() => move(index, 1)}
            >
              {'↓'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={ct('catalog.imageRemove')}
              disabled={detach.isPending}
              onClick={() => detach.mutate(image.id)}
            >
              <Trash2 aria-hidden className="size-4" />
            </Button>
          </li>
        ))}
      </ol>

      <FileUpload
        accept="image/webp,image/jpeg,image/png"
        createTicket={(input) =>
          api.post<UploadTicket>('/v1/files', {
            ...input,
            // `public` and `product-image`: the catalog's attach endpoint accepts
            // nothing else, and the files module refuses a public upload for any
            // purpose that may not be public.
            visibility: 'public',
            purpose: 'product-image',
          })
        }
        finalize={(fileId) => api.post<UploadedFile>(`/v1/files/${fileId}/finalize`)}
        onUploaded={(file) => attach.mutate(file.id)}
        labels={{
          choose: ct('catalog.images'),
          uploading: ct('catalog.importRows'),
          uploaded: ct('catalog.images'),
          remove: ct('catalog.imageRemove'),
          failed: ct('catalog.errorDetail'),
          tooLarge: ct('catalog.errorDetail'),
        }}
      />
    </section>
  );
}

/** The barcode label sheet. */
function Labels({ skus }: { readonly skus: readonly CatalogSku[] }) {
  const ct = useCatalogT();
  const [copies, setCopies] = useState(1);
  const [showPrice, setShowPrice] = useState(false);

  const download = useMutation({
    mutationFn: () =>
      labelSheetPdf(
        skus.map((sku) => ({ skuId: sku.id, copies })),
        showPrice,
      ),
    onSuccess: (blob) => {
      // An object URL opened in a new tab, revoked once the browser has it. The
      // alternative — a GET endpoint the browser navigates to — would put the SKU
      // list in a query string and lose the CSRF header with it.
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  });

  return (
    <section
      aria-labelledby="labels-heading"
      className="space-y-3 rounded-md border border-border p-4"
    >
      <h2 id="labels-heading" className="text-sm font-semibold">
        {ct('catalog.labels')}
      </h2>
      <p className="text-sm text-muted-foreground">{ct('catalog.labelsHelp')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs font-medium">
          {ct('catalog.labelsCopies')}
          <input
            type="number"
            min={1}
            max={200}
            value={copies}
            onChange={(event) => setCopies(Math.max(1, Number(event.target.value)))}
            className="h-8 w-20 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={showPrice}
            onChange={(event) => setShowPrice(event.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
          {ct('catalog.labelsShowPrice')}
        </label>
        <Button
          size="sm"
          disabled={skus.length === 0 || download.isPending}
          onClick={() => download.mutate()}
        >
          {ct('catalog.labelsDownload')}
        </Button>
      </div>
    </section>
  );
}

/** The price history of whichever SKU is chosen. */
function PriceHistory({ skus }: { readonly skus: readonly CatalogSku[] }) {
  const ct = useCatalogT();
  const [skuId, setSkuId] = useState<string>('');
  const chosen = skuId === '' ? skus[0]?.id : skuId;

  const history = useQuery({
    queryKey: ['catalog', 'price-history', chosen],
    queryFn: () => priceHistory(chosen ?? ''),
    enabled: chosen !== undefined,
  });

  return (
    <section aria-labelledby="history-heading" className="space-y-3">
      <h2 id="history-heading" className="text-sm font-semibold">
        {ct('catalog.priceHistory')}
      </h2>
      <select
        aria-label={ct('catalog.colCode')}
        value={chosen ?? ''}
        onChange={(event) => setSkuId(event.target.value)}
        className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {skus.map((sku) => (
          <option key={sku.id} value={sku.id}>
            {sku.skuCode}
          </option>
        ))}
      </select>

      {(history.data?.items ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{ct('catalog.priceNoHistory')}</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">{ct('catalog.priceHistory')}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1.5">
                {ct('catalog.priceWhen')}
              </th>
              <th scope="col" className="py-1.5 text-right">
                {ct('catalog.priceFrom')}
              </th>
              <th scope="col" className="py-1.5 text-right">
                {ct('catalog.priceTo')}
              </th>
              <th scope="col" className="py-1.5">
                {ct('catalog.priceReason')}
              </th>
            </tr>
          </thead>
          <tbody>
            {(history.data?.items ?? []).map((row, index) => (
              <tr key={`${row.changedAt}-${String(index)}`} className="border-b border-border/60">
                <td className="py-1.5">
                  <DateTime value={row.changedAt} />
                </td>
                <td className="py-1.5 text-right">
                  {row.fromPricePoisha === null ? '—' : <Money poisha={row.fromPricePoisha} />}
                </td>
                <td className="py-1.5 text-right">
                  <Money poisha={row.toPricePoisha} />
                </td>
                <td className="py-1.5 text-muted-foreground">{row.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
