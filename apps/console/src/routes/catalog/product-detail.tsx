import {
  Button,
  ConfirmDialog,
  DateTime,
  Dialog,
  Money,
  PermissionGate,
  Select,
  StatusBadge,
  cn,
  controlClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  ImagePlus,
  Pencil,
  Printer,
  Trash2,
} from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import '../../i18n/catalog-pricing.js';
import { DEFAULT_PAGE_SIZE } from '../../lib/table-search.js';
import { listLocations, listMovements, listStock, type StockRow } from '../stock/api.js';
import {
  attachImage,
  detachImage,
  getProduct,
  listAttributes,
  listCategories,
  reorderImages,
  updateProduct,
  type CatalogAttribute,
  type CatalogProduct,
  type CatalogSku,
} from './api.js';
import { BuyingPrices } from './buying-prices.js';
import { Field, Thumb } from './parts.js';
import { duplicateProduct, productPriceHistory, setImageColour, skuCosts } from './pricing-api.js';
import { SizesAndColours } from './sizes-colours.js';
import { PhotoTooLargeError, uploadPhoto } from './photo-picker.js';
import {
  AdjustStockDialog,
  ReceiveStockDialog,
  ReorderDialog,
  TransferStockDialog,
  type VariantInfo,
} from './stock-actions.js';
import { StickerDialog, type StickerItem } from './stickers.js';
import { parseGrams, total } from './variant-grid.js';
import { VariantTable, variantLabel } from './variant-table.js';
import { WebsiteCard } from './website-card.js';

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
 * `takaToPoisha`.
 *
 * M39b (D-636 to D-646): the regular price beside each price; for a role that may read cost,
 * each variant's average cost, last buying price and margin (worked out on this page from what
 * the supply module sends that role, never sent as a margin) and its standard buying price; a
 * bulk price editor with a preview; one price history for every variant; sizes and colours
 * added with their prices or stopped in every colour; photos tied to a colour; a variant's own
 * barcode and weight; and Duplicate. Cost reaches this page only from `/v1/supply/sku-costs`,
 * which answers `read:cost` roles alone (invariant 5); the catalog's own answers carry none.
 */

const route = getRouteApi('/catalog/$productId');

type Dialogs =
  'receive' | 'adjust' | 'transfer' | 'reorder' | 'edit' | 'archive' | 'duplicate' | null;

/** The label a sticker row and a dialog line read as: `Linen Panjabi · M / White`. */
function stickerLabel(product: CatalogProduct, sku: CatalogSku): string {
  const variant = variantLabel(sku);
  return variant === '' ? product.name : `${product.name} · ${variant}`;
}

export function CatalogProductPage() {
  const ability = useAbility();
  const t = useT();
  const { productId } = route.useParams();
  // The variant a scan opened this page at (M38a, D-605), marked in the grid.
  const { variant: scannedVariant } = route.useSearch();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Catalog');
  const mayWrite = ability.can('update', 'Catalog');
  const mayStock = ability.can('read', 'Stock');
  const mayReceive = ability.can('create', 'Supply');
  const mayAdjust = ability.can('request', 'StockAdjustment');
  // Cost on this page only for a role the server would send it to (invariant 5, D-636).
  const mayCost = ability.can('read', 'Cost');
  const mayStandard = mayCost && ability.can('update', 'Supply');
  const mayCreate = ability.can('create', 'Catalog');

  const [open, setOpen] = useState<Dialogs>(null);
  // Stickers to print: from the Stickers button, a variant's own button, or a receipt.
  const [stickers, setStickers] = useState<readonly StickerItem[] | null>(null);

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
    // Every row, not the first 200: a product may have 500 variants at several
    // locations, and a missing row would read as zero stock (ledger audit M1).
    queryFn: async () => {
      const items: StockRow[] = [];
      for (let page = 1; page <= 50; page += 1) {
        const batch = await listStock({ productId, page, pageSize: 200 });
        items.push(...batch.items);
        if (batch.items.length < 200) break;
      }
      // A row inserted between two page requests shifts the offsets; keep one of each.
      const seen = new Set<string>();
      return {
        items: items.filter((row) => {
          const id = `${row.skuId}:${row.locationId}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        }),
      };
    },
    enabled: mayStock,
  });
  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: mayStock,
    staleTime: 5 * 60_000,
  });
  const attributes = useQuery({
    queryKey: ['catalog', 'attributes'],
    queryFn: listAttributes,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });
  const skuIds = (product.data?.skus ?? []).map((sku) => sku.id);
  const costs = useQuery({
    queryKey: ['supply', 'sku-costs', productId, skuIds.join(',')],
    queryFn: () => skuCosts(skuIds),
    enabled: mayCost && skuIds.length > 0,
  });
  const costMap =
    mayCost && costs.data !== undefined
      ? new Map(costs.data.items.map((item) => [item.skuId, item]))
      : undefined;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['supply', 'sku-costs'] });
  };

  const data = product.data;
  const skus = data?.skus ?? [];
  const kinds = new Map((attributes.data?.items ?? []).map((entry) => [entry.id, entry.kind]));
  const variants: VariantInfo[] = skus.map((sku) => ({
    id: sku.id,
    skuCode: sku.skuCode,
    barcode: sku.barcode,
    label: variantLabel(sku, kinds),
    status: sku.status,
  }));
  /** One sticker per piece on hand, or one when there is none yet. */
  const onHandOf = (skuId: string) =>
    total(rows.filter((row) => row.skuId === skuId).map((row) => row.onHand));
  const stickerItems = (pick: (sku: CatalogSku) => number): StickerItem[] =>
    data === undefined
      ? []
      : skus
          .filter((sku) => sku.status === 'active')
          .map((sku) => ({
            skuId: sku.id,
            label: stickerLabel(data, sku),
            skuCode: sku.skuCode,
            count: pick(sku),
          }))
          .filter((item) => item.count > 0);
  const rows = stock.data?.items ?? [];
  const category = categories.data?.items.find((entry) => entry.id === data?.categoryId);
  const available = total(rows.map((row) => row.available));
  const onHand = total(rows.map((row) => row.onHand));
  // The stock's value at average cost, for a role that may read cost (the field is stripped
  // for anyone else, so it is absent and the tile is not shown).
  const stockValue = rows.reduce(
    (sum, row) => (row.stockValuePoisha === undefined ? sum : sum + BigInt(row.stockValuePoisha)),
    0n,
  );

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('catalog.deniedTitle'), detail: t('catalog.deniedDetail') }}
    >
      <div className="space-y-6">
        <nav aria-label={t('cs.breadcrumb')} className="-mb-3 text-sm text-muted-foreground">
          <Link
            to="/catalog"
            search={{ page: 1, pageSize: DEFAULT_PAGE_SIZE }}
            className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('catalog.title')}
          </Link>
        </nav>

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-3">
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
              <Button variant="ghost" onClick={() => setOpen('edit')}>
                <Pencil aria-hidden="true" />
                {t('cs.edit')}
              </Button>
            </PermissionGate>
            <PermissionGate allowed={mayCreate && data !== undefined}>
              <Button
                variant="ghost"
                data-testid="duplicate-product"
                onClick={() => setOpen('duplicate')}
              >
                <Copy aria-hidden="true" />
                {t('cp.dup.action')}
              </Button>
            </PermissionGate>
            <PermissionGate allowed={mayWrite}>
              <Button variant="ghost" onClick={() => setOpen('archive')}>
                {data?.status === 'archived' ? t('cs.reactivate') : t('cs.archive')}
              </Button>
              {/*
               * M39a's Delete (D-623) goes here: its `DeleteOrArchive` dialog asks the server what
               * uses the product and offers Delete or Archive. Wired at integration.
               */}
            </PermissionGate>
          </div>
        </header>

        {product.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {product.error instanceof ApiError ? product.error.message : t('cs.loadFailed')}
          </p>
        ) : null}

        {/*
         * The price is catalog data every reader may see (M39b fix); the stock tiles need
         * `read Stock`, the stock value `read:cost`.
         */}
        <section
          aria-label={t('cs.hub.summary')}
          className="grid overflow-hidden rounded-lg border border-border bg-card sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-border"
        >
          {mayStock ? (
            <>
              <Tile label={t('cs.hub.available')} value={String(available)} />
              <Tile label={t('cs.hub.onHand')} value={String(onHand)} />
              <Tile label={t('cs.hub.variants')} value={String(skus.length)} />
            </>
          ) : null}
          <Tile label={t('cs.hub.price')} value={<PriceRange skus={skus} />} />
          {mayCost && mayStock ? (
            <Tile label={t('cp.hub.stockValue')} value={<Money poisha={stockValue.toString()} />} />
          ) : null}
        </section>

        <VariantTable
          product={data}
          attributes={attributes.data?.items ?? []}
          costs={costMap}
          rows={rows}
          locations={(locations.data?.items ?? []).filter(
            (location) =>
              location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
          )}
          showStock={mayStock}
          mayWrite={mayWrite}
          highlighted={scannedVariant}
          onReorder={() => setOpen('reorder')}
          onPrint={(sku) =>
            setStickers(
              stickerItems((entry) => (entry.id === sku.id ? Math.max(1, onHandOf(sku.id)) : 0)),
            )
          }
          onDone={refresh}
        />

        {data !== undefined && mayStandard && costMap !== undefined ? (
          <BuyingPrices
            product={data}
            attributes={attributes.data?.items ?? []}
            costs={costMap}
            onDone={refresh}
          />
        ) : null}

        <PermissionGate allowed={mayWrite}>
          <SizesAndColours
            // Starts again from the product as saved, after every change.
            key={skus.map((sku) => `${sku.id}:${sku.status}`).join(',')}
            product={data}
            attributes={attributes.data?.items ?? []}
            stock={rows}
            onDone={refresh}
          />
          <Photos
            productId={productId}
            images={data?.images ?? []}
            colours={colourValuesOf(skus, attributes.data?.items ?? [])}
            onDone={refresh}
          />
        </PermissionGate>

        {data === undefined ? null : (
          <PermissionGate allowed={ability.can('read', 'Storefront')}>
            <WebsiteCard
              // Starts again from the product as saved, after every save or rename.
              key={`${data.slug}:${JSON.stringify(data.web)}`}
              product={data}
              onDone={refresh}
            />
          </PermissionGate>
        )}

        <PermissionGate allowed={mayStock}>
          <StockHistory productId={productId} variants={variants} />
        </PermissionGate>

        <PriceHistory productId={productId} />

        <PermissionGate allowed={mayRead}>
          <section
            aria-labelledby="stickers-heading"
            className="space-y-3 rounded-lg border border-border bg-card p-5"
          >
            <h2 id="stickers-heading" className="text-base font-semibold tracking-tight">
              {t('st.stickers.sectionTitle')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('st.stickers.sectionHelp')}</p>
            <Button
              variant="outline"
              data-testid="product-stickers"
              disabled={skus.every((sku) => sku.status !== 'active')}
              onClick={() => setStickers(stickerItems((sku) => Math.max(1, onHandOf(sku.id))))}
            >
              <Printer aria-hidden="true" />
              {t('st.stickers.choose')}
            </Button>
          </section>
        </PermissionGate>

        <StickerDialog
          open={stickers !== null}
          onOpenChange={(next) => {
            if (!next) setStickers(null);
          }}
          items={stickers ?? []}
        />

        <ReceiveStockDialog
          open={open === 'receive'}
          onOpenChange={(next) => setOpen(next ? 'receive' : null)}
          variants={variants}
          onDone={refresh}
          onReceived={(lines) => {
            // One sticker per piece just received (D-604).
            setOpen(null);
            setStickers(
              stickerItems((sku) => lines.find((line) => line.skuId === sku.id)?.qty ?? 0),
            );
          }}
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
            <DuplicateDialog
              key={open === 'duplicate' ? 'duplicate-open' : 'duplicate-closed'}
              open={open === 'duplicate'}
              onOpenChange={(next) => setOpen(next ? 'duplicate' : null)}
              product={data}
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

function Tile({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="px-5 py-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-medium tabular-nums">{value}</p>
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

/** The product's colour values, for tying a photo to a colour (D-643). */
function colourValuesOf(
  skus: readonly CatalogSku[],
  attributes: readonly CatalogAttribute[],
): { id: string; label: string }[] {
  const colourAxes = new Set(
    attributes.filter((attribute) => attribute.kind === 'colour').map((attribute) => attribute.id),
  );
  const seen = new Map<string, string>();
  for (const sku of skus) {
    for (const pair of sku.attributes) {
      if (colourAxes.has(pair.attributeId)) seen.set(pair.valueId, pair.valueLabel);
    }
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

/** A copy of the product under a new name (D-641); opens the copy when it is made. */
function DuplicateDialog({
  open,
  onOpenChange,
  product,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly product: CatalogProduct;
}) {
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState(`${product.name} ${t('cp.dup.copySuffix')}`.slice(0, 200));
  const make = useMutation({
    mutationFn: () => duplicateProduct(product.id, { name: name.trim() }),
    onSuccess: (copy) => {
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      onOpenChange(false);
      void navigate({ to: '/catalog/$productId', params: { productId: copy.id } });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('cp.dup.title')}
      description={t('cp.dup.help')}
      closeLabel={t('cp.close')}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cp.cancel')}
          </Button>
          <Button
            data-testid="duplicate-submit"
            disabled={name.trim() === '' || make.isPending}
            onClick={() => make.mutate()}
          >
            {t('cp.dup.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('cp.dup.name')}>
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className={cn(controlClassName, 'w-full')}
          />
        </Field>
        {make.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {make.error instanceof ApiError ? make.error.message : t('cp.saveFailed')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- photos ---------------------------------------------------------------------

function Photos({
  productId,
  images,
  colours,
  onDone,
}: {
  readonly productId: string;
  readonly images: readonly {
    id: string;
    fileId: string;
    altText: string | null;
    colourValueId: string | null;
  }[];
  /** The product's colours: a photo may show one of them (D-643). */
  readonly colours: readonly { id: string; label: string }[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const colour = useMutation({
    mutationFn: (input: { imageId: string; colourValueId: string | null }) =>
      setImageColour(productId, input.imageId, input.colourValueId),
    onSuccess: onDone,
  });
  const attach = useMutation({
    mutationFn: async (fileIds: readonly string[]) => {
      for (const fileId of fileIds) await attachImage(productId, { fileId });
    },
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
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 id="photos-heading" className="text-base font-semibold tracking-tight">
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
              {colours.length > 0 ? (
                <Select
                  variant="filter"
                  size="sm"
                  aria-label={`${t('cp.photo.colour')} ${String(index + 1)}`}
                  value={image.colourValueId ?? ''}
                  disabled={colour.isPending}
                  onValueChange={(next) =>
                    colour.mutate({ imageId: image.id, colourValueId: next === '' ? null : next })
                  }
                  options={[
                    { value: '', label: t('cp.photo.anyColour') },
                    ...colours.map((value) => ({ value: value.id, label: value.label })),
                  ]}
                />
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <AddPhotos onAdd={(fileIds) => attach.mutateAsync(fileIds)} />
    </section>
  );
}

/**
 * Add several photos at once (M38a, D-601): each is uploaded and attached in the order
 * chosen, after the ones already there.
 */
function AddPhotos({
  onAdd,
}: {
  readonly onAdd: (fileIds: readonly string[]) => Promise<unknown>;
}) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const add = async (files: readonly File[]) => {
    setFailed(null);
    try {
      const ids: string[] = [];
      for (const [index, file] of files.entries()) {
        setProgress(`${t('st.new.uploading')} ${String(index + 1)} / ${String(files.length)}`);
        ids.push((await uploadPhoto(file)).id);
      }
      await onAdd(ids);
    } catch (error) {
      setFailed(
        error instanceof PhotoTooLargeError ? t('cs.photos.tooLarge') : t('cs.photos.failed'),
      );
    } finally {
      setProgress(null);
    }
  };
  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept="image/webp,image/jpeg,image/png"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length > 0) void add(files);
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={progress !== null}
        onClick={() => input.current?.click()}
      >
        <ImagePlus aria-hidden="true" />
        {t('st.photos.add')}
      </Button>
      {progress === null ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {progress}
        </p>
      )}
      {failed === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {failed}
        </p>
      )}
    </div>
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
  const [slug, setSlug] = useState(product.slug);
  const [categoryId, setCategoryId] = useState(product.categoryId ?? '');
  const [description, setDescription] = useState(product.description ?? '');
  const [status, setStatus] = useState(product.status);
  const [weight, setWeight] = useState(
    product.weightGrams === null ? '' : String(product.weightGrams),
  );
  const grams = parseGrams(weight);
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
        // The web address only when it changed: the old one keeps leading here (M33).
        ...(slug.trim() === product.slug || slug.trim() === '' ? {} : { slug: slug.trim() }),
        categoryId: categoryId === '' ? null : categoryId,
        description: description.trim() === '' ? null : description.trim(),
        status,
        // Grams per piece for couriers (D-645); blank clears it.
        weightGrams: grams === undefined ? null : grams,
      }),
    onSuccess: () => {
      onDone();
      onOpenChange(false);
    },
  });

  const control = cn(controlClassName, 'w-full');

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
          <Button
            disabled={name.trim() === '' || grams === null || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('cs.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('catalog.productName')}>
          <input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className={control}
          />
        </Field>
        <Field label={t('st.edit.slug')} hint={t('st.edit.slugHint')}>
          <input
            value={slug}
            maxLength={120}
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
            className={cn(control, 'font-mono')}
          />
        </Field>
        <Field label={t('catalog.productCategory')}>
          <Select
            value={categoryId}
            onValueChange={setCategoryId}
            options={[
              { value: '', label: t('cs.noCategory') },
              ...(categories.data?.items ?? []).map((category) => ({
                value: category.id,
                // A sub-category sits under its parent, indented as the list nests.
                label: `${'\u00a0'.repeat(category.depth * 2)}${category.name}`,
              })),
            ]}
          />
        </Field>
        <Field label={t('catalog.productStatus')}>
          <Select
            value={status}
            onValueChange={(value) => setStatus(value as CatalogProduct['status'])}
            options={[
              { value: 'active', label: t('cs.status.activeHelp') },
              { value: 'draft', label: t('cs.status.draftHelp') },
              { value: 'archived', label: t('catalog.status.archived') },
            ]}
          />
        </Field>
        <Field label={t('cs.description')}>
          <textarea
            value={description}
            maxLength={20000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            className={cn(controlClassName, 'h-auto w-full py-2')}
          />
        </Field>
        <Field
          label={t('cp.new.weight')}
          hint={grams === null ? t('cp.new.weightInvalid') : t('cp.new.weightHint')}
        >
          <input
            inputMode="numeric"
            value={weight}
            aria-invalid={grams === null}
            onChange={(event) => setWeight(event.target.value)}
            className={cn(control, 'text-right tabular-nums')}
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
      <h2 id="history-heading" className="text-base font-semibold tracking-tight">
        {t('cs.hub.history')}
      </h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-border px-5 py-4 text-sm text-muted-foreground">
          {history.isPending ? t('cs.loading') : t('cs.hub.noHistory')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('cs.hub.history')}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th
                  scope="col"
                  className="h-10 px-4 text-xs font-medium whitespace-nowrap text-muted-foreground"
                >
                  {t('cs.col.when')}
                </th>
                <th
                  scope="col"
                  className="h-10 px-4 text-xs font-medium whitespace-nowrap text-muted-foreground"
                >
                  {t('cs.col.what')}
                </th>
                <th
                  scope="col"
                  className="h-10 px-4 text-xs font-medium whitespace-nowrap text-muted-foreground"
                >
                  {t('cs.col.variant')}
                </th>
                <th
                  scope="col"
                  className="h-10 px-4 text-xs font-medium whitespace-nowrap text-muted-foreground"
                >
                  {t('cs.location')}
                </th>
                <th
                  scope="col"
                  className="h-10 px-4 text-right text-xs font-medium whitespace-nowrap text-muted-foreground"
                >
                  {t('cs.col.qty')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border last:border-b-0 hover:bg-accent/60"
                >
                  <td className="h-row px-4 whitespace-nowrap text-muted-foreground">
                    <DateTime value={row.createdAt} />
                  </td>
                  <td className="h-row px-4">
                    {row.kind in KINDS ? t(KINDS[row.kind as keyof typeof KINDS]) : row.kind}
                  </td>
                  <td className="h-row px-4">{label(row.skuId, row.skuCode)}</td>
                  <td className="h-row px-4">{row.locationName}</td>
                  <td className="h-row px-4 text-right tabular-nums">
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

/** One price history for every variant of the product, newest first (D-636). */
function PriceHistory({ productId }: { readonly productId: string }) {
  const t = useT();
  const history = useQuery({
    queryKey: ['catalog', 'price-history', productId],
    queryFn: () => productPriceHistory(productId),
  });
  const items = history.data?.items ?? [];
  const th = 'h-10 px-4 text-xs font-medium whitespace-nowrap text-muted-foreground';
  const change = (from: string | null, to: string | null) =>
    from === to ? (
      <span className="text-muted-foreground">—</span>
    ) : (
      <span className="inline-flex items-center gap-1 tabular-nums">
        {from === null ? '—' : <Money poisha={from} />}
        <span aria-hidden="true">→</span>
        {to === null ? '—' : <Money poisha={to} />}
      </span>
    );

  return (
    <section aria-labelledby="price-history-heading" className="space-y-3">
      <h2 id="price-history-heading" className="text-base font-semibold tracking-tight">
        {t('cp.history.title')}
      </h2>
      {items.length === 0 ? (
        <p className="rounded-lg border border-border px-5 py-4 text-sm text-muted-foreground">
          {history.isPending ? t('cs.loading') : t('cp.history.none')}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('cp.history.title')}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th scope="col" className={th}>
                  {t('catalog.priceWhen')}
                </th>
                <th scope="col" className={th}>
                  {t('cs.col.variant')}
                </th>
                <th scope="col" className={cn(th, 'text-right')}>
                  {t('cp.history.price')}
                </th>
                <th scope="col" className={cn(th, 'text-right')}>
                  {t('cp.history.regular')}
                </th>
                <th scope="col" className={th}>
                  {t('catalog.priceReason')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row, index) => (
                <tr
                  key={`${row.skuId}-${row.changedAt}-${String(index)}`}
                  className="border-b border-border last:border-b-0 hover:bg-accent/60"
                >
                  <td className="h-row px-4 whitespace-nowrap text-muted-foreground">
                    <DateTime value={row.changedAt} />
                  </td>
                  <td className="h-row px-4 whitespace-nowrap">
                    {row.variantLabel === '' ? row.skuCode : row.variantLabel}
                  </td>
                  <td className="h-row px-4 text-right whitespace-nowrap">
                    {row.fromPricePoisha === null ? (
                      <Money poisha={row.toPricePoisha} />
                    ) : (
                      change(row.fromPricePoisha, row.toPricePoisha)
                    )}
                  </td>
                  <td className="h-row px-4 text-right whitespace-nowrap">
                    {change(row.compareAtFromPoisha, row.compareAtToPoisha)}
                  </td>
                  <td className="h-row px-4 text-muted-foreground">{row.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
