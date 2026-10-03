import {
  Button,
  ConfirmDialog,
  DateTime,
  Dialog,
  Money,
  PermissionGate,
  StatusBadge,
  takaToPoisha,
  poishaToTaka,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { DEFAULT_PAGE_SIZE } from '../../lib/table-search.js';
import { listLocations, listMovements, listStock, type StockRow } from '../stock/api.js';
import {
  addVariants,
  attachImage,
  detachImage,
  getProduct,
  labelSheetPdf,
  listAttributes,
  listCategories,
  priceHistory,
  reorderImages,
  setPrices,
  updateProduct,
  updateSku,
  type CatalogAttribute,
  type CatalogProduct,
  type CatalogSku,
} from './api.js';
import { ChipGroup, Field, PhotoUploader, Thumb } from './parts.js';
import {
  AdjustStockDialog,
  ReceiveStockDialog,
  ReorderDialog,
  TransferStockDialog,
  type VariantInfo,
} from './stock-actions.js';
import { total } from './variant-grid.js';

/**
 * One product, and everything done to it (plan `catalog-stock-ux`, D-420).
 *
 * The product page is the hub: its variants with their stock at every location, their
 * prices and photos, and the actions on them — **Receive stock** first, because it is
 * what a product page is opened for most, then adjust, transfer, edit, labels and
 * archive. Each action is a dialog that sends one request through the route that owns
 * it; nothing here writes stock or cost itself (invariants 3 and 5).
 *
 * The variant list only ever adds (M06 check 1): "Add sizes or colours" extends the
 * matrix, and a variant that is no longer wanted is archived, which keeps its stock,
 * history and printed labels joined to it.
 *
 * Prices are integer-poisha strings, shown through `<Money>` and edited in taka through
 * `takaToPoisha`. There is no cost on this page: cost lives in supply, inventory and the
 * ledger (invariant 5), and the stock grid shows quantities only.
 */

const route = getRouteApi('/catalog/$productId');

type Dialogs = 'receive' | 'adjust' | 'transfer' | 'reorder' | 'edit' | 'archive' | null;

export function CatalogProductPage() {
  const ability = useAbility();
  const t = useT();
  const { productId } = route.useParams();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Catalog');
  const mayWrite = ability.can('update', 'Catalog');
  const mayStock = ability.can('read', 'Stock');
  const mayReceive = ability.can('create', 'Supply');
  const mayAdjust = ability.can('request', 'StockAdjustment');

  const [open, setOpen] = useState<Dialogs>(null);

  const product = useQuery({
    queryKey: ['catalog', 'product', productId],
    queryFn: () => getProduct(productId),
    enabled: mayRead,
  });
  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: listCategories,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });
  const stock = useQuery({
    queryKey: ['stock', 'product', productId],
    queryFn: () => listStock({ productId, page: 1, pageSize: 200 }),
    enabled: mayStock,
  });
  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: mayStock,
    staleTime: 5 * 60_000,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  const data = product.data;
  const skus = data?.skus ?? [];
  const variants: VariantInfo[] = skus.map((sku) => ({
    id: sku.id,
    skuCode: sku.skuCode,
    label: labelOf(sku),
    status: sku.status,
  }));
  const rows = stock.data?.items ?? [];
  const category = categories.data?.items.find((entry) => entry.id === data?.categoryId);
  const available = total(rows.map((row) => row.available));
  const onHand = total(rows.map((row) => row.onHand));

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('catalog.deniedTitle'), detail: t('catalog.deniedDetail') }}
    >
      <div className="space-y-6">
        <nav aria-label={t('cs.breadcrumb')} className="text-xs text-muted-foreground">
          <Link
            to="/catalog"
            search={{ page: 1, pageSize: DEFAULT_PAGE_SIZE }}
            className="underline-offset-4 hover:underline"
          >
            {t('catalog.title')}
          </Link>
        </nav>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold tracking-tight">
                {data?.name ?? t('catalog.title')}
              </h1>
              {data === undefined ? null : (
                <StatusBadge
                  tone={
                    data.status === 'active'
                      ? 'success'
                      : data.status === 'archived'
                        ? 'neutral'
                        : 'info'
                  }
                >
                  {t(`catalog.status.${data.status}`)}
                </StatusBadge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {data === undefined
                ? ''
                : [
                    `${t('catalog.code')} ${String(data.sequence).padStart(4, '0')}`,
                    category?.name ?? t('cs.noCategory'),
                  ].join(' · ')}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <PermissionGate allowed={mayReceive && data?.status !== 'archived'}>
              <Button onClick={() => setOpen('receive')}>{t('cs.receive.action')}</Button>
            </PermissionGate>
            <PermissionGate allowed={mayAdjust}>
              <Button variant="outline" onClick={() => setOpen('adjust')}>
                {t('cs.adjust.action')}
              </Button>
              <Button variant="outline" onClick={() => setOpen('transfer')}>
                {t('cs.transfer.action')}
              </Button>
            </PermissionGate>
            <PermissionGate allowed={mayWrite}>
              <Button variant="outline" onClick={() => setOpen('edit')}>
                {t('cs.edit')}
              </Button>
              <Button variant="ghost" onClick={() => setOpen('archive')}>
                {data?.status === 'archived' ? t('cs.reactivate') : t('cs.archive')}
              </Button>
            </PermissionGate>
          </div>
        </header>

        {product.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {product.error instanceof ApiError ? product.error.message : t('cs.loadFailed')}
          </p>
        ) : null}

        <PermissionGate allowed={mayStock}>
          <section
            aria-label={t('cs.hub.summary')}
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
          >
            <Tile label={t('cs.hub.available')} value={String(available)} />
            <Tile label={t('cs.hub.onHand')} value={String(onHand)} />
            <Tile label={t('cs.hub.variants')} value={String(skus.length)} />
            <Tile label={t('cs.hub.price')} value={<PriceRange skus={skus} />} />
          </section>
        </PermissionGate>

        <VariantGrid
          product={data}
          rows={rows}
          locations={(locations.data?.items ?? []).filter(
            (location) =>
              location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
          )}
          showStock={mayStock}
          mayWrite={mayWrite}
          onReorder={() => setOpen('reorder')}
          onDone={refresh}
        />

        <PermissionGate allowed={mayWrite}>
          <AddVariants productId={productId} product={data} onDone={refresh} />
          <Photos productId={productId} images={data?.images ?? []} onDone={refresh} />
        </PermissionGate>

        <PermissionGate allowed={mayStock}>
          <StockHistory productId={productId} variants={variants} />
        </PermissionGate>

        <PriceHistory variants={variants} />

        <PermissionGate allowed={mayRead}>
          <Labels skus={skus} />
        </PermissionGate>

        <ReceiveStockDialog
          open={open === 'receive'}
          onOpenChange={(next) => setOpen(next ? 'receive' : null)}
          variants={variants}
          onDone={refresh}
        />
        <AdjustStockDialog
          open={open === 'adjust'}
          onOpenChange={(next) => setOpen(next ? 'adjust' : null)}
          variants={variants}
          stock={rows}
          onDone={refresh}
        />
        <ReorderDialog
          open={open === 'reorder'}
          onOpenChange={(next) => setOpen(next ? 'reorder' : null)}
          variants={variants}
          stock={rows}
          onDone={refresh}
        />
        <TransferStockDialog
          open={open === 'transfer'}
          onOpenChange={(next) => setOpen(next ? 'transfer' : null)}
          variants={variants}
          stock={rows}
          onDone={refresh}
        />
        {data === undefined ? null : (
          <>
            <EditProductDialog
              // Remounted on every open, so it starts from the product as it is now.
              key={open === 'edit' ? 'edit-open' : 'edit-closed'}
              open={open === 'edit'}
              onOpenChange={(next) => setOpen(next ? 'edit' : null)}
              product={data}
              onDone={refresh}
            />
            <ConfirmDialog
              open={open === 'archive'}
              onOpenChange={(next) => setOpen(next ? 'archive' : null)}
              title={data.status === 'archived' ? t('cs.reactivateTitle') : t('cs.archiveTitle')}
              description={
                data.status === 'archived' ? t('cs.reactivateHelp') : t('cs.archiveHelp')
              }
              confirmLabel={data.status === 'archived' ? t('cs.reactivate') : t('cs.archive')}
              cancelLabel={t('cs.cancel')}
              closeLabel={t('cs.close')}
              destructive={data.status !== 'archived'}
              onConfirm={async () => {
                await updateProduct(data.id, {
                  status: data.status === 'archived' ? 'active' : 'archived',
                });
                refresh();
              }}
            />
          </>
        )}
      </div>
    </PermissionGate>
  );
}

function labelOf(sku: CatalogSku): string {
  const rank = (code: string, name: string) => {
    const text = `${code} ${name}`.toLowerCase();
    return text.includes('size') ? 0 : text.includes('colo') ? 1 : 2;
  };
  return [...sku.attributes]
    .sort((a, b) => rank(a.code, a.name) - rank(b.code, b.name))
    .map((pair) => pair.valueLabel)
    .join(' / ');
}

function Tile({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function PriceRange({ skus }: { readonly skus: readonly CatalogSku[] }) {
  const prices = skus
    .filter((sku) => sku.status === 'active')
    .map((sku) => BigInt(sku.pricePoisha));
  if (prices.length === 0) return <>{'—'}</>;
  const low = prices.reduce((a, b) => (b < a ? b : a));
  const high = prices.reduce((a, b) => (b > a ? b : a));
  return low === high ? (
    <Money poisha={low.toString()} />
  ) : (
    <span>
      <Money poisha={low.toString()} />
      {'–'}
      <Money poisha={high.toString()} symbol={false} />
    </span>
  );
}

// --- the variant grid ------------------------------------------------------------

function VariantGrid({
  product,
  rows,
  locations,
  showStock,
  mayWrite,
  onReorder,
  onDone,
}: {
  readonly onReorder: () => void;
  readonly product: CatalogProduct | undefined;
  readonly rows: readonly StockRow[];
  readonly locations: readonly { id: string; name: string; code: string; kind: string }[];
  readonly showStock: boolean;
  readonly mayWrite: boolean;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [prices, setPricesState] = useState<Record<string, string>>({});
  const [archiving, setArchiving] = useState<CatalogSku | null>(null);
  const skus = product?.skus ?? [];

  // Every active warehouse, then every showroom, then anywhere else this product has
  // stock right now (in transit, damaged). An empty in-transit column is noise.
  const columns = [
    ...locations.filter((location) => location.kind === 'warehouse'),
    ...locations.filter((location) => location.kind !== 'warehouse'),
    ...rows
      .filter((row) => row.onHand > 0)
      .filter((row) => !locations.some((location) => location.id === row.locationId))
      .filter(
        (row, index, all) =>
          all.findIndex((other) => other.locationId === row.locationId) === index,
      )
      .map((row) => ({ id: row.locationId, name: row.locationName, code: row.locationCode })),
  ];
  const cell = (skuId: string, locationId: string) =>
    rows.find((row) => row.skuId === skuId && row.locationId === locationId);

  const changed = skus.flatMap((sku) => {
    const text = prices[sku.id];
    if (text === undefined || text.trim() === '') return [];
    const value = takaToPoisha(text);
    return value === null || value === sku.pricePoisha
      ? []
      : [{ skuId: sku.id, pricePoisha: value }];
  });
  const invalid = skus.some((sku) => {
    const text = prices[sku.id];
    return text !== undefined && text.trim() !== '' && takaToPoisha(text) === null;
  });

  const save = useMutation({
    mutationFn: () => setPrices({ prices: changed, reason: t('cs.hub.priceReason') }),
    onSuccess: () => {
      setEditing(false);
      setPricesState({});
      onDone();
    },
  });

  const archive = useMutation({
    mutationFn: (sku: CatalogSku) =>
      updateSku(sku.id, sku.status === 'active' ? 'archived' : 'active'),
    onSuccess: onDone,
  });

  return (
    <section aria-labelledby="variants-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="variants-heading" className="text-sm font-semibold">
          {t('cs.hub.variantsStock')}
        </h2>
        <PermissionGate allowed={mayWrite && skus.length > 0}>
          {editing ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setPricesState({});
                }}
              >
                {t('cs.cancel')}
              </Button>
              <Button
                size="sm"
                disabled={changed.length === 0 || invalid || save.isPending}
                onClick={() => save.mutate()}
              >
                {t('cs.hub.savePrices')}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {showStock ? (
                <Button size="sm" variant="ghost" onClick={onReorder}>
                  {t('cs.reorder.action')}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                {t('cs.hub.editPrices')}
              </Button>
            </div>
          )}
        </PermissionGate>
      </div>

      {skus.length === 0 && product !== undefined ? (
        <p className="text-sm text-muted-foreground">{t('cs.hub.noVariants')}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('cs.hub.variantsStock')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2">
                  {t('cs.col.variant')}
                </th>
                <th scope="col" className="px-3 py-2">
                  {t('catalog.colCode')}
                </th>
                <th scope="col" className="px-3 py-2 text-right">
                  {t('cs.col.price')}
                </th>
                {showStock
                  ? columns.map((location) => (
                      <th key={location.id} scope="col" className="px-3 py-2 text-right">
                        {location.name}
                      </th>
                    ))
                  : null}
                {showStock ? (
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('cs.col.available')}
                  </th>
                ) : null}
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">{t('cs.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {skus.map((sku) => {
                const mine = rows.filter((row) => row.skuId === sku.id);
                const free = total(mine.map((row) => row.available));
                const low = mine.some(
                  (row) => row.reorderLevel > 0 && row.available <= row.reorderLevel,
                );
                return (
                  <tr key={sku.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">
                      <span className="font-medium">{labelOf(sku) || t('cs.new.oneVariant')}</span>
                      {sku.status === 'archived' ? (
                        <span className="ms-2">
                          <StatusBadge tone="neutral">{t('catalog.status.archived')}</StatusBadge>
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{sku.skuCode}</td>
                    <td className="px-3 py-2 text-right">
                      {editing ? (
                        <>
                          <label className="sr-only" htmlFor={`price-${sku.id}`}>
                            {`${t('cs.col.price')} ${sku.skuCode}`}
                          </label>
                          <input
                            id={`price-${sku.id}`}
                            inputMode="decimal"
                            value={prices[sku.id] ?? poishaToTaka(sku.pricePoisha)}
                            onChange={(event) =>
                              setPricesState((current) => ({
                                ...current,
                                [sku.id]: event.target.value,
                              }))
                            }
                            className="h-8 w-28 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        </>
                      ) : (
                        <Money poisha={sku.pricePoisha} />
                      )}
                    </td>
                    {showStock
                      ? columns.map((location) => {
                          const level = cell(sku.id, location.id);
                          return (
                            <td key={location.id} className="px-3 py-2 text-right tabular-nums">
                              {level === undefined ? (
                                <span className="text-muted-foreground">0</span>
                              ) : (
                                <span title={`${t('cs.hub.onHand')} ${String(level.onHand)}`}>
                                  {level.available}
                                  {level.reserved > 0 ? (
                                    <span className="ms-1 text-xs text-muted-foreground">
                                      {`(+${String(level.reserved)} ${t('cs.hub.held')})`}
                                    </span>
                                  ) : null}
                                </span>
                              )}
                            </td>
                          );
                        })
                      : null}
                    {showStock ? (
                      <td className="px-3 py-2 text-right">
                        <span className="inline-flex items-center gap-2 tabular-nums">
                          {free}
                          {sku.status === 'active' && free === 0 ? (
                            <StatusBadge tone="danger">{t('cs.hub.out')}</StatusBadge>
                          ) : low ? (
                            <StatusBadge tone="warning">{t('cs.hub.low')}</StatusBadge>
                          ) : null}
                        </span>
                      </td>
                    ) : null}
                    <td className="px-3 py-2 text-right">
                      <PermissionGate allowed={mayWrite}>
                        <Button size="sm" variant="ghost" onClick={() => setArchiving(sku)}>
                          {sku.status === 'active' ? t('cs.archive') : t('cs.restore')}
                        </Button>
                      </PermissionGate>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {save.error !== null || archive.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {(save.error ?? archive.error) instanceof ApiError
            ? (save.error ?? archive.error)?.message
            : t('cs.saveFailed')}
        </p>
      ) : null}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(next) => {
          if (!next) setArchiving(null);
        }}
        title={archiving?.status === 'active' ? t('cs.hub.archiveSku') : t('cs.hub.restoreSku')}
        description={
          archiving?.status === 'active' ? t('cs.hub.archiveSkuHelp') : t('cs.hub.restoreSkuHelp')
        }
        confirmLabel={archiving?.status === 'active' ? t('cs.archive') : t('cs.restore')}
        cancelLabel={t('cs.cancel')}
        closeLabel={t('cs.close')}
        onConfirm={async () => {
          if (archiving !== null) await archive.mutateAsync(archiving);
        }}
      />
    </section>
  );
}

// --- add sizes or colours ----------------------------------------------------------

function AddVariants({
  productId,
  product,
  onDone,
}: {
  readonly productId: string;
  readonly product: CatalogProduct | undefined;
  readonly onDone: () => void;
}) {
  const t = useT();
  const attributes = useQuery({
    queryKey: ['catalog', 'attributes'],
    queryFn: listAttributes,
    staleTime: 5 * 60_000,
  });
  const [chosen, setChosen] = useState<Record<string, string[]> | null>(null);
  const [result, setResult] = useState<number | null>(null);

  // Start from what the product already has, so adding XXL is one click.
  const existing = (axis: CatalogAttribute) => [
    ...new Set(
      (product?.skus ?? []).flatMap((sku) =>
        sku.attributes.filter((pair) => pair.attributeId === axis.id).map((pair) => pair.valueId),
      ),
    ),
  ];
  const axes = (attributes.data?.items ?? []).filter(
    (axis) => axis.isVariant && axis.values.length > 0,
  );
  const current = (axis: CatalogAttribute) => chosen?.[axis.id] ?? existing(axis);

  const mutation = useMutation({
    mutationFn: () =>
      addVariants(productId, {
        axes: axes
          .map((axis) => ({ attributeId: axis.id, valueIds: current(axis) }))
          .filter((axis) => axis.valueIds.length > 0),
      }),
    onSuccess: (data) => {
      setResult(data.created.length);
      setChosen(null);
      onDone();
    },
  });

  return (
    <section
      aria-labelledby="add-variants-heading"
      className="space-y-3 rounded-md border border-border p-4"
    >
      <h2 id="add-variants-heading" className="text-sm font-semibold">
        {t('cs.hub.addVariants')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('cs.hub.addVariantsHelp')}</p>
      {axes.map((axis) => (
        <ChipGroup
          key={axis.id}
          legend={axis.name}
          values={axis.values}
          chosen={current(axis)}
          onToggle={(valueId) => {
            const list = current(axis);
            // An existing value cannot be taken off here; archive its variants instead.
            if (list.includes(valueId) && existing(axis).includes(valueId)) return;
            setChosen((state) => ({
              ...(state ?? {}),
              [axis.id]: list.includes(valueId)
                ? list.filter((id) => id !== valueId)
                : [...list, valueId],
            }));
          }}
        />
      ))}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={chosen === null || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {t('cs.hub.addVariantsSubmit')}
        </Button>
        {result !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {result === 0
              ? t('catalog.variantsNoneAdded')
              : `${String(result)} ${t('catalog.variantsAdded')}`}
          </p>
        ) : null}
      </div>
      {mutation.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error instanceof ApiError ? mutation.error.message : t('cs.saveFailed')}
        </p>
      ) : null}
    </section>
  );
}

// --- photos ---------------------------------------------------------------------

function Photos({
  productId,
  images,
  onDone,
}: {
  readonly productId: string;
  readonly images: readonly { id: string; fileId: string; altText: string | null }[];
  readonly onDone: () => void;
}) {
  const t = useT();
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
    reorder.mutate(swapped);
  };

  return (
    <section
      aria-labelledby="photos-heading"
      className="space-y-3 rounded-md border border-border p-4"
    >
      <h2 id="photos-heading" className="text-sm font-semibold">
        {t('cs.photos.title')}
      </h2>
      {images.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('cs.photos.none')}</p>
      ) : (
        <ol className="flex flex-wrap gap-3">
          {images.map((image, index) => (
            <li key={image.id} className="space-y-1">
              <Thumb fileId={image.fileId} alt={image.altText ?? t('cs.photos.alt')} />
              <div className="flex justify-center gap-0.5">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('catalog.imageMoveUp')}
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp aria-hidden className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('catalog.imageMoveDown')}
                  disabled={index === images.length - 1 || reorder.isPending}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown aria-hidden className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t('catalog.imageRemove')}
                  disabled={detach.isPending}
                  onClick={() => detach.mutate(image.id)}
                >
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <PhotoUploader onUploaded={(file) => attach.mutate(file.id)} />
    </section>
  );
}

// --- edit -----------------------------------------------------------------------

function EditProductDialog({
  open,
  onOpenChange,
  product,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly product: CatalogProduct;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(product.name);
  const [categoryId, setCategoryId] = useState(product.categoryId ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [status, setStatus] = useState(product.status);
  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: listCategories,
    enabled: open,
    staleTime: 5 * 60_000,
  });

  const save = useMutation({
    mutationFn: () =>
      updateProduct(product.id, {
        name: name.trim(),
        categoryId: categoryId === '' ? null : categoryId,
        description: description.trim() === '' ? null : description.trim(),
        status,
      }),
    onSuccess: () => {
      onDone();
      onOpenChange(false);
    },
  });

  const control =
    'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('cs.editTitle')}
      description={t('cs.editHelp')}
      closeLabel={t('cs.close')}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {t('cs.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('catalog.productName')}>
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className={control}
          />
        </Field>
        <Field label={t('catalog.productCategory')}>
          <select
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            className={control}
          >
            <option value="">{t('cs.noCategory')}</option>
            {(categories.data?.items ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {'  '.repeat(category.depth)}
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('catalog.productStatus')}>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as CatalogProduct['status'])}
            className={control}
          >
            <option value="active">{t('cs.status.activeHelp')}</option>
            <option value="draft">{t('cs.status.draftHelp')}</option>
            <option value="archived">{t('catalog.status.archived')}</option>
          </select>
        </Field>
        <Field label={t('cs.description')}>
          <textarea
            value={description}
            maxLength={4000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Field>
        {save.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : t('cs.saveFailed')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- history --------------------------------------------------------------------

const KINDS = {
  opening_balance: 'cs.kind.opening_balance',
  supply_receipt: 'cs.kind.supply_receipt',
  supplier_return: 'cs.kind.supplier_return',
  dispatch: 'cs.kind.dispatch',
  customer_return: 'cs.kind.customer_return',
  pos_sale: 'cs.kind.pos_sale',
  pos_return: 'cs.kind.pos_return',
  transfer_out: 'cs.kind.transfer_out',
  transfer_in: 'cs.kind.transfer_in',
  adjustment_gain: 'cs.kind.adjustment_gain',
  adjustment_loss: 'cs.kind.adjustment_loss',
  count_correction: 'cs.kind.count_correction',
} as const;

function StockHistory({
  productId,
  variants,
}: {
  readonly productId: string;
  readonly variants: readonly VariantInfo[];
}) {
  const t = useT();
  const history = useQuery({
    queryKey: ['stock', 'movements', productId],
    queryFn: () => listMovements({ productId, pageSize: 50 }),
  });
  // A transfer's two legs through in-transit are bookkeeping; the person wants "out of
  // the warehouse" and "into the showroom".
  const items = (history.data?.items ?? []).filter((row) => row.locationKind !== 'in_transit');
  const label = (skuId: string, code: string) => {
    const found = variants.find((variant) => variant.id === skuId)?.label ?? '';
    return found === '' ? code : found;
  };

  return (
    <section aria-labelledby="history-heading" className="space-y-3">
      <h2 id="history-heading" className="text-sm font-semibold">
        {t('cs.hub.history')}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {history.isPending ? t('cs.loading') : t('cs.hub.noHistory')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('cs.hub.history')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5">
                  {t('cs.col.when')}
                </th>
                <th scope="col" className="py-1.5">
                  {t('cs.col.what')}
                </th>
                <th scope="col" className="py-1.5">
                  {t('cs.col.variant')}
                </th>
                <th scope="col" className="py-1.5">
                  {t('cs.location')}
                </th>
                <th scope="col" className="py-1.5 text-right">
                  {t('cs.col.qty')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="border-b border-border/60">
                  <td className="py-1.5">
                    <DateTime value={row.createdAt} />
                  </td>
                  <td className="py-1.5">
                    {row.kind in KINDS ? t(KINDS[row.kind as keyof typeof KINDS]) : row.kind}
                  </td>
                  <td className="py-1.5">{label(row.skuId, row.skuCode)}</td>
                  <td className="py-1.5">{row.locationName}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {row.qtyDelta > 0 ? `+${String(row.qtyDelta)}` : String(row.qtyDelta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PriceHistory({ variants }: { readonly variants: readonly VariantInfo[] }) {
  const t = useT();
  const [skuId, setSkuId] = useState('');
  const chosen = skuId === '' ? variants[0]?.id : skuId;

  const history = useQuery({
    queryKey: ['catalog', 'price-history', chosen],
    queryFn: () => priceHistory(chosen ?? ''),
    enabled: chosen !== undefined,
  });

  return (
    <section aria-labelledby="price-history-heading" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="price-history-heading" className="text-sm font-semibold">
          {t('catalog.priceHistory')}
        </h2>
        <select
          aria-label={t('cs.col.variant')}
          value={chosen ?? ''}
          onChange={(event) => setSkuId(event.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.label === '' ? variant.skuCode : `${variant.label} · ${variant.skuCode}`}
            </option>
          ))}
        </select>
      </div>

      {(history.data?.items ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('catalog.priceNoHistory')}</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('catalog.priceHistory')}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="px-2 py-1.5">
                {t('catalog.priceWhen')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-right">
                {t('catalog.priceFrom')}
              </th>
              <th scope="col" className="px-2 py-1.5 text-right">
                {t('catalog.priceTo')}
              </th>
              <th scope="col" className="px-2 py-1.5">
                {t('catalog.priceReason')}
              </th>
            </tr>
          </thead>
          <tbody>
            {(history.data?.items ?? []).map((row, index) => (
              <tr key={`${row.changedAt}-${String(index)}`} className="border-b border-border/60">
                <td className="px-2 py-1.5">
                  <DateTime value={row.changedAt} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  {row.fromPricePoisha === null ? '—' : <Money poisha={row.fromPricePoisha} />}
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Money poisha={row.toPricePoisha} />
                </td>
                <td className="px-2 py-1.5 text-muted-foreground">{row.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The barcode label sheet, one or more labels per variant. */
function Labels({ skus }: { readonly skus: readonly CatalogSku[] }) {
  const t = useT();
  const [copies, setCopies] = useState(1);
  const [showPrice, setShowPrice] = useState(true);

  const download = useMutation({
    mutationFn: () =>
      labelSheetPdf(
        skus.filter((sku) => sku.status === 'active').map((sku) => ({ skuId: sku.id, copies })),
        showPrice,
      ),
    onSuccess: (blob) => {
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
        {t('catalog.labels')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('catalog.labelsHelp')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('catalog.labelsCopies')}>
          <input
            type="number"
            min={1}
            max={200}
            value={copies}
            onChange={(event) => setCopies(Math.min(200, Math.max(1, Number(event.target.value))))}
            className="h-8 w-20 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </Field>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={showPrice}
            onChange={(event) => setShowPrice(event.target.checked)}
            className="size-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
          {t('catalog.labelsShowPrice')}
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={skus.length === 0 || download.isPending}
          onClick={() => download.mutate()}
        >
          {t('catalog.labelsDownload')}
        </Button>
      </div>
      {download.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {t('cs.labelsFailed')}
        </p>
      ) : null}
    </section>
  );
}
