import type { WebGender } from '@elysium/contracts';
import {
  Button,
  Checkbox,
  Money,
  PageHeader,
  PermissionGate,
  Select,
  cn,
  controlClassName,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CheckCircle2, Printer } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import { DEFAULT_PAGE_SIZE } from '../../lib/table-search.js';
import {
  draftStockInHand,
  listLocations,
  openingStockWindow,
  postStockInHand,
} from '../stock/api.js';
import { createDraft, createEntry, listSupplierOptions } from '../supply/api.js';
import { listSizeCharts, saveProductWebFields } from '../website/api.js';
import {
  attachImage,
  createProduct,
  listAttributes,
  listCategories,
  type CatalogProduct,
} from './api.js';
import { ChipGroup, Field } from './parts.js';
import { PhotoPicker, PhotoTooLargeError, uploadPhoto, type PendingPhoto } from './photo-picker.js';
import { slugify } from './slug.js';
import { StickerDialog, type StickerItem } from './stickers.js';
import {
  isReplayConflict,
  parseQty,
  positiveCost,
  requestKey,
  variantRows,
  type VariantRow,
} from './variant-grid.js';
import '../../i18n/website.js';

/**
 * New product, in one form (plan `catalog-stock-ux` D-421, D-426; M38a D-601, D-602).
 *
 * Everything the old website's product form had, and more, on one page:
 *
 * - **the product**: name, category, selling price, status (Active by default, D-426),
 *   description;
 * - **sizes and colours** as chips, which draw the variant grid: a price per variant, and the
 *   pieces of each variant the brand has;
 * - **photos**: several at once, dragged into order, the first one the cover, each
 *   optionally cropped to the shop's 3 : 4 shape;
 * - **the website's details** (M33): shown on the website, featured, new arrival, shelf,
 *   tags, size chart, material, care, the words a search engine shows; folded away until
 *   wanted, and only for someone who manages the website;
 * - **the stock**: either **already in hand** (while the brand's opening stock window is
 *   open, D-602: at a cost per piece, posted against opening balance equity) or **received
 *   from a supplier** (a supply receipt, D-421).
 *
 * One button creates the product with every SKU (codes and barcodes made by the server),
 * attaches the photos in order, saves the website's details and posts the stock; a step
 * that fails is retried alone, never twice (the stock keeps its key, D-432). Then it offers
 * exactly one sticker per piece (D-604).
 *
 * Every price is typed in taka and converted by `takaToPoisha`, integer arithmetic.
 */

type StockMode = 'in-hand' | 'supplier';

interface Saved {
  readonly product: CatalogProduct;
  readonly stickers: readonly StickerItem[];
  readonly pieces: number;
}

export function CatalogNewProductPage() {
  // "Add another product" starts a fresh form: a new key, so every piece of state resets.
  const [round, setRound] = useState(0);
  return <NewProductForm key={round} onAnother={() => setRound((current) => current + 1)} />;
}

function NewProductForm({ onAnother }: { readonly onAnother: () => void }) {
  const ability = useAbility();
  const t = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mayWrite = ability.can('create', 'Catalog');
  const mayReceive = ability.can('create', 'Supply');
  const mayPrice = ability.can('read', 'Cost');
  const mayWeb = ability.can('update', 'Storefront');

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [taka, setTaka] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('active');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [rowPrice, setRowPrice] = useState<Record<string, string>>({});
  const [rowQty, setRowQty] = useState<Record<string, string>>({});
  const [rowCost, setRowCost] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<StockMode>('in-hand');
  const [locationId, setLocationId] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [costTaka, setCostTaka] = useState('');
  const [photos, setPhotos] = useState<PendingPhoto[]>([]);
  const [web, setWeb] = useState<WebDraft>(EMPTY_WEB);
  const [created, setCreated] = useState<CatalogProduct | null>(null);
  const [steps, setSteps] = useState<{ web: boolean; stock: boolean }>({
    web: false,
    stock: false,
  });
  const [saved, setSaved] = useState<Saved | null>(null);
  const [printing, setPrinting] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  // The stock's key, kept across retries (ledger audit H1, D-432).
  const [key] = useState(() => requestKey());

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: listCategories,
    enabled: mayWrite,
    staleTime: 5 * 60_000,
  });
  const attributes = useQuery({
    queryKey: ['catalog', 'attributes'],
    queryFn: listAttributes,
    enabled: mayWrite,
    staleTime: 5 * 60_000,
  });
  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: mayWrite && mayReceive,
    staleTime: 5 * 60_000,
  });
  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', 'options'],
    queryFn: listSupplierOptions,
    enabled: mayWrite && mayReceive && mode === 'supplier',
    staleTime: 5 * 60_000,
  });
  const openingWindow = useQuery({
    queryKey: ['stock', 'opening-window'],
    queryFn: openingStockWindow,
    enabled: mayWrite && mayReceive,
    staleTime: 60_000,
  });
  const charts = useQuery({
    queryKey: ['website', 'size-charts'],
    queryFn: listSizeCharts,
    enabled: mayWrite && mayWeb,
    staleTime: 60_000,
  });

  // Stock in hand is offered while the brand's window is open; otherwise a supplier.
  const windowOpen = openingWindow.data?.open === true;
  const stockMode: StockMode = windowOpen ? mode : 'supplier';

  // Size before colour before the rest: the order the codes read in (`…-XL-RED`).
  const ordered = (attributes.data?.items ?? [])
    .filter((attribute) => attribute.isVariant && attribute.values.length > 0)
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.position - b.position);
  const choice = ordered.map((axis) => ({
    attributeId: axis.id,
    values: axis.values
      .filter((value) => (chosen[axis.id] ?? []).includes(value.id))
      .map((value) => ({ id: value.id, label: value.label })),
  }));
  const rows = variantRows(choice);

  const pricePoisha = takaToPoisha(taka);
  // A stray 0 would put every piece in at nothing and drag the average down (audit L6).
  const costPoisha = positiveCost(takaToPoisha(costTaka));
  const costOf = (row: VariantRow): string | null => {
    const own = (rowCost[row.key] ?? '').trim();
    return own === '' ? costPoisha : positiveCost(takaToPoisha(own));
  };
  const receivable = (locations.data?.items ?? []).filter(
    (location) =>
      location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
  );
  const chosenLocation =
    locationId !== '' ? locationId : (receivable.find((l) => l.kind === 'warehouse')?.id ?? '');

  const priceProblem = rows.some(
    (row) =>
      (rowPrice[row.key] ?? '').trim() !== '' && takaToPoisha(rowPrice[row.key] ?? '') === null,
  );
  const qtyProblem = rows.some(
    (row) => (rowQty[row.key] ?? '').trim() !== '' && parseQty(rowQty[row.key] ?? '') === null,
  );
  const stockLines = rows.flatMap((row) => {
    const qty = parseQty(rowQty[row.key] ?? '');
    return qty === null ? [] : [{ row, qty }];
  });
  const wantsStock = mayReceive && stockLines.length > 0;
  const costMissing =
    mayPrice &&
    stockLines.some((entry) => (stockMode === 'in-hand' ? costOf(entry.row) : costPoisha) === null);
  const stockReady =
    !wantsStock ||
    (chosenLocation !== '' &&
      (stockMode === 'in-hand' || supplierId !== '') &&
      (!mayPrice || !costMissing));
  const units = stockLines.reduce((sum, entry) => sum + entry.qty, 0);
  const stockValue = mayPrice
    ? stockLines.reduce((sum, entry) => {
        const cost = stockMode === 'in-hand' ? costOf(entry.row) : costPoisha;
        return cost === null ? sum : sum + BigInt(cost) * BigInt(entry.qty);
      }, 0n)
    : 0n;

  const ready =
    name.trim() !== '' && pricePoisha !== null && !priceProblem && !qtyProblem && stockReady;

  const save = useMutation({
    mutationFn: async (): Promise<Saved> => {
      setProgress(t('st.new.creating'));
      const product =
        created ??
        (await createProduct({
          name: name.trim(),
          slug: slugify(name),
          categoryId: categoryId === '' ? undefined : categoryId,
          description: description.trim() === '' ? undefined : description.trim(),
          pricePoisha: pricePoisha ?? '',
          status,
          axes: choice
            .filter((axis) => axis.values.length > 0)
            .map((axis) => ({
              attributeId: axis.attributeId,
              valueIds: axis.values.map((value) => value.id),
            })),
          variantPrices: rows.flatMap((row) => {
            // A plain product's one row has no values to name; its price is the product's.
            if (row.valueIds.length === 0) return [];
            const own = takaToPoisha(rowPrice[row.key] ?? '');
            return own === null || own === pricePoisha
              ? []
              : [{ valueIds: row.valueIds, pricePoisha: own }];
          }),
        }));
      // Kept, so a retry after a failed later step does not create it twice.
      setCreated(product);

      // Photos in their order, the first the cover; each leaves the list once attached, so a
      // retry uploads only what is left.
      let remaining = photos;
      for (const [index, photo] of photos.entries()) {
        setProgress(`${t('st.new.uploading')} ${String(index + 1)} / ${String(photos.length)}`);
        const file = await uploadPhoto(photo.file);
        await attachImage(product.id, { fileId: file.id });
        URL.revokeObjectURL(photo.url);
        remaining = remaining.filter((entry) => entry.key !== photo.key);
        setPhotos(remaining);
      }

      if (mayWeb && !steps.web && webChanged(web)) {
        setProgress(t('st.new.savingWeb'));
        await saveProductWebFields(product.id, webInput(web));
        setSteps((current) => ({ ...current, web: true }));
      }

      const lines = stockLines.map((entry) => {
        const skuId = skuFor(product, entry.row);
        // Refused rather than dropped: the grid is locked once the product exists.
        if (skuId === undefined) throw new Error(t('cs.new.rowMissing'));
        return { skuId, qty: entry.qty, row: entry.row };
      });
      if (wantsStock && !steps.stock) {
        setProgress(t('st.new.savingStock'));
        if (stockMode === 'in-hand') {
          if (mayPrice) {
            await postStockInHand({
              entryId: key.current(),
              locationId: chosenLocation,
              memo: t('st.new.inHandMemo'),
              lines: lines.map((line) => ({
                skuId: line.skuId,
                qty: line.qty,
                unitCostPoisha: costOf(line.row) ?? '0',
              })),
            });
          } else {
            await draftStockInHand({
              entryId: key.current(),
              locationId: chosenLocation,
              memo: t('st.new.inHandMemo'),
              lines: lines.map((line) => ({ skuId: line.skuId, qty: line.qty })),
            });
          }
        } else if (mayPrice) {
          await createEntry({
            supplyId: key.current(),
            supplierId,
            locationId: chosenLocation,
            memo: t('cs.new.openingMemo'),
            lines: lines.map((line) => ({
              skuId: line.skuId,
              qty: line.qty,
              unitCostPoisha: costPoisha ?? '0',
            })),
          });
        } else {
          await createDraft({
            draftId: key.current(),
            supplierId,
            locationId: chosenLocation,
            lines: lines.map((line) => ({ skuId: line.skuId, qty: line.qty })),
          });
        }
        key.settle();
        setSteps((current) => ({ ...current, stock: true }));
      }

      // One sticker per piece entered; with no stock entered, one per variant to start.
      const pieces = lines.reduce((sum, line) => sum + line.qty, 0);
      const stickers = product.skus
        .filter((sku) => sku.status === 'active')
        .map((sku) => {
          const label = sku.attributes.map((pair) => pair.valueLabel).join(' / ');
          const qty = lines.find((line) => line.skuId === sku.id)?.qty ?? 0;
          return {
            skuId: sku.id,
            label: label === '' ? product.name : `${product.name} · ${label}`,
            skuCode: sku.skuCode,
            count: pieces > 0 ? qty : 1,
          };
        })
        .filter((item) => item.count > 0);
      return { product, stickers, pieces };
    },
    // Told an earlier save went through with other stock: the next press is a new entry.
    onError: (error) => {
      setProgress(null);
      if (isReplayConflict(error)) key.settle();
    },
    onSuccess: (result) => {
      setProgress(null);
      setSaved(result);
      void queryClient.invalidateQueries({ queryKey: ['catalog'] });
      void queryClient.invalidateQueries({ queryKey: ['stock'] });
    },
  });

  const control = cn(controlClassName, 'w-full');
  const cell = cn(controlClassName, 'text-right tabular-nums');
  const sectionClass = 'space-y-4 rounded-lg border border-border bg-card p-5';
  const headingClass = 'text-base font-semibold tracking-tight';
  const showCostColumn = mayReceive && mayPrice && stockMode === 'in-hand';

  if (saved !== null) {
    return (
      <div className="max-w-form space-y-6">
        <PageHeader title={t('st.new.doneTitle')} description={saved.product.name} />
        <section
          aria-labelledby="done-heading"
          className="space-y-4 rounded-lg border border-border bg-card p-5"
        >
          <h2 id="done-heading" className="flex items-center gap-2 text-base font-semibold">
            <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
            {t('st.new.done')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {saved.pieces > 0
              ? `${t('st.new.donePieces')} ${String(saved.pieces)}`
              : t('st.new.doneNoStock')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button data-testid="print-new-stickers" onClick={() => setPrinting(true)}>
              <Printer aria-hidden="true" />
              {`${t('st.new.printStickers')} (${String(
                saved.stickers.reduce((sum, item) => sum + item.count, 0),
              )})`}
            </Button>
            <Link
              to="/catalog/$productId"
              params={{ productId: saved.product.id }}
              className="inline-flex h-control items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('cs.new.openCreated')}
            </Link>
            <Button variant="ghost" onClick={onAnother}>
              {t('st.new.another')}
            </Button>
          </div>
        </section>
        <StickerDialog
          open={printing}
          onOpenChange={setPrinting}
          items={saved.stickers}
          title={t('st.new.printStickers')}
        />
      </div>
    );
  }

  return (
    <PermissionGate
      allowed={mayWrite}
      explain={{ title: t('catalog.deniedTitle'), detail: t('catalog.deniedDetail') }}
    >
      <div className="max-w-form space-y-6">
        <PageHeader title={t('catalog.newProduct')} description={t('cs.new.help')} />

        <section aria-labelledby="basics-heading" className={sectionClass}>
          <h2 id="basics-heading" className={headingClass}>
            {t('cs.new.basics')}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('catalog.productName')} className="sm:col-span-2">
              <input
                value={name}
                maxLength={200}
                disabled={created !== null}
                onChange={(event) => setName(event.target.value)}
                className={control}
              />
            </Field>
            <Field label={t('catalog.productCategory')}>
              <Select
                value={categoryId}
                onValueChange={setCategoryId}
                disabled={created !== null}
                options={[
                  { value: '', label: t('cs.noCategory') },
                  ...(categories.data?.items ?? [])
                    .filter((category) => category.isActive)
                    .map((category) => ({
                      value: category.id,
                      // A sub-category sits under its parent, indented as the list nests.
                      label: `${' '.repeat(category.depth * 2)}${category.name}`,
                    })),
                ]}
              />
            </Field>
            <Field label={t('cs.sellingPrice')}>
              <input
                inputMode="decimal"
                value={taka}
                disabled={created !== null}
                onChange={(event) => setTaka(event.target.value)}
                aria-invalid={taka.trim() !== '' && pricePoisha === null}
                className={cn(cell, 'w-full')}
              />
            </Field>
            <Field label={t('catalog.productStatus')}>
              <Select
                value={status}
                disabled={created !== null}
                onValueChange={(value) => setStatus(value as 'draft' | 'active')}
                options={[
                  { value: 'active', label: t('cs.status.activeHelp') },
                  { value: 'draft', label: t('cs.status.draftHelp') },
                ]}
              />
            </Field>
            <Field label={t('cs.description')} className="sm:col-span-2">
              <textarea
                value={description}
                maxLength={20000}
                rows={3}
                disabled={created !== null}
                onChange={(event) => setDescription(event.target.value)}
                className={cn(controlClassName, 'h-auto w-full py-2')}
              />
            </Field>
          </div>
        </section>

        <section aria-labelledby="photos-heading" className={sectionClass}>
          <h2 id="photos-heading" className={headingClass}>
            {t('cs.photos.title')}
          </h2>
          <PhotoPicker photos={photos} onChange={setPhotos} disabled={save.isPending} />
        </section>

        <section aria-labelledby="variants-heading" className={sectionClass}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="variants-heading" className={headingClass}>
              {t('cs.new.sizesColours')}
            </h2>
            <Link
              to="/catalog/structure"
              className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('cs.manageLists')}
            </Link>
          </div>
          {ordered.length === 0 && attributes.isSuccess ? (
            <p className="text-sm text-muted-foreground">{t('cs.new.noLists')}</p>
          ) : null}
          {ordered.map((axis) => (
            <ChipGroup
              key={axis.id}
              legend={axis.name}
              values={axis.values}
              chosen={chosen[axis.id] ?? []}
              // Locked once the product exists: its variants are made (audit L7).
              disabled={created !== null}
              onToggle={(valueId) =>
                setChosen((current) => {
                  const list = current[axis.id] ?? [];
                  return {
                    ...current,
                    [axis.id]: list.includes(valueId)
                      ? list.filter((id) => id !== valueId)
                      : [...list, valueId],
                  };
                })
              }
            />
          ))}

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('cs.new.grid')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                  <th scope="col" className="h-10 px-4 font-medium">
                    {t('cs.col.variant')}
                  </th>
                  <th scope="col" className="h-10 w-32 px-3 text-right font-medium">
                    {t('cs.col.price')}
                  </th>
                  {mayReceive ? (
                    <th scope="col" className="h-10 w-28 px-3 text-right font-medium">
                      {t('st.col.pieces')}
                    </th>
                  ) : null}
                  {showCostColumn ? (
                    <th scope="col" className="h-10 w-32 px-3 text-right font-medium">
                      {t('st.col.costPerPiece')}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.key} className="border-b border-border last:border-b-0">
                    <td className="px-4 py-2 font-medium">
                      {row.label === '' ? t('cs.new.oneVariant') : row.label}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {row.valueIds.length === 0 ? (
                        // A plain product: its price is the selling price above.
                        <span className="text-muted-foreground tabular-nums">{taka || '—'}</span>
                      ) : (
                        <>
                          <label className="sr-only" htmlFor={`price-${String(index)}`}>
                            {`${t('cs.col.price')} ${row.label}`}
                          </label>
                          <input
                            id={`price-${String(index)}`}
                            inputMode="decimal"
                            value={rowPrice[row.key] ?? ''}
                            placeholder={taka}
                            disabled={created !== null}
                            onChange={(event) =>
                              setRowPrice((current) => ({
                                ...current,
                                [row.key]: event.target.value,
                              }))
                            }
                            className={cn(cell, 'w-28')}
                          />
                        </>
                      )}
                    </td>
                    {mayReceive ? (
                      <td className="px-3 py-2 text-right">
                        <label className="sr-only" htmlFor={`qty-${String(index)}`}>
                          {`${t('st.col.pieces')} ${row.label}`}
                        </label>
                        <input
                          id={`qty-${String(index)}`}
                          inputMode="numeric"
                          value={rowQty[row.key] ?? ''}
                          placeholder="0"
                          disabled={created !== null}
                          onChange={(event) =>
                            setRowQty((current) => ({ ...current, [row.key]: event.target.value }))
                          }
                          className={cn(cell, 'w-24')}
                        />
                      </td>
                    ) : null}
                    {showCostColumn ? (
                      <td className="px-3 py-2 text-right">
                        <label className="sr-only" htmlFor={`cost-${String(index)}`}>
                          {`${t('st.col.costPerPiece')} ${row.label}`}
                        </label>
                        <input
                          id={`cost-${String(index)}`}
                          inputMode="decimal"
                          value={rowCost[row.key] ?? ''}
                          placeholder={costTaka}
                          disabled={created !== null}
                          aria-invalid={
                            (rowCost[row.key] ?? '').trim() !== '' && costOf(row) === null
                          }
                          onChange={(event) =>
                            setRowCost((current) => ({ ...current, [row.key]: event.target.value }))
                          }
                          className={cn(cell, 'w-28')}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t('st.new.gridHelp')}</p>
        </section>

        {wantsStock ? (
          <section aria-labelledby="stock-heading" className={sectionClass}>
            <h2 id="stock-heading" className={headingClass}>
              {t('st.new.stock')}
            </h2>
            {windowOpen ? (
              <fieldset className="space-y-2">
                <legend className="mb-1.5 text-sm font-medium">{t('st.new.stockFrom')}</legend>
                <div className="flex flex-wrap gap-4">
                  {(['in-hand', 'supplier'] as const).map((value) => (
                    <label key={value} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="stock-mode"
                        value={value}
                        checked={stockMode === value}
                        disabled={created !== null}
                        onChange={() => setMode(value)}
                        className="size-4 accent-primary"
                      />
                      {t(value === 'in-hand' ? 'st.new.inHand' : 'st.new.fromSupplier')}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : openingWindow.isSuccess ? (
              <p className="text-sm text-muted-foreground">{t('st.new.windowClosed')}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {stockMode === 'in-hand'
                ? t(mayPrice ? 'st.new.inHandHelp' : 'st.new.inHandHelpDraft')
                : t(mayPrice ? 'cs.new.openingHelp' : 'cs.receive.helpDraft')}
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('cs.location')}>
                <Select
                  value={chosenLocation}
                  onValueChange={setLocationId}
                  disabled={created !== null}
                  options={receivable.map((location) => ({
                    value: location.id,
                    label: location.name,
                  }))}
                />
              </Field>
              {stockMode === 'supplier' ? (
                <Field label={t('cs.supplier')}>
                  <Select
                    value={supplierId}
                    onValueChange={setSupplierId}
                    disabled={created !== null}
                    placeholder={t('cs.chooseSupplier')}
                    options={(suppliers.data?.items ?? []).map((supplier) => ({
                      value: supplier.id,
                      label: `${supplier.name} (${supplier.code})`,
                    }))}
                  />
                </Field>
              ) : null}
              {mayPrice ? (
                <Field
                  label={t('cs.costPerPiece')}
                  hint={stockMode === 'in-hand' ? t('st.new.costHint') : undefined}
                >
                  <input
                    inputMode="decimal"
                    value={costTaka}
                    disabled={created !== null}
                    onChange={(event) => setCostTaka(event.target.value)}
                    className={cn(cell, 'w-full')}
                  />
                </Field>
              ) : null}
            </div>
            {stockMode === 'supplier' &&
            (suppliers.data?.items ?? []).length === 0 &&
            suppliers.isSuccess ? (
              <p className="text-sm text-muted-foreground">{t('cs.noSuppliers')}</p>
            ) : null}
            {mayPrice && costMissing ? (
              <p className="text-sm text-destructive">{t('st.new.costMissing')}</p>
            ) : null}
            {mayPrice && !costMissing ? (
              <p className="text-sm text-muted-foreground tabular-nums">
                {`${String(units)} ${t('cs.units')} · `}
                <Money poisha={stockValue.toString()} />
              </p>
            ) : null}
          </section>
        ) : null}

        {mayWeb ? (
          <details className="group rounded-lg border border-border bg-card">
            <summary className="cursor-pointer list-none rounded-lg p-5 text-base font-semibold tracking-tight focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
              {t('st.new.website')}
              <span className="ms-2 text-sm font-normal text-muted-foreground">
                {t('st.new.websiteHint')}
              </span>
            </summary>
            <div className="space-y-4 px-5 pb-5">
              <WebDetails
                value={web}
                onChange={setWeb}
                disabled={created !== null && steps.web}
                charts={(charts.data?.items ?? []).map((chart) => ({
                  id: chart.id,
                  name: chart.name,
                }))}
              />
            </div>
          </details>
        ) : null}

        {progress !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {progress}
          </p>
        ) : null}
        {save.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof PhotoTooLargeError
              ? t('cs.photos.tooLarge')
              : save.error instanceof ApiError
                ? save.error.message
                : t('cs.saveFailed')}
            {created !== null ? ` ${t('cs.new.createdButStock')}` : ''}
          </p>
        ) : null}

        {/* The long form's actions stay in reach at the foot of the screen (D-447). */}
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-background py-3">
          <Button
            data-testid="create-product"
            disabled={!ready || save.isPending}
            onClick={() => save.mutate()}
          >
            {created !== null ? t('cs.new.retry') : t('cs.new.create')}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void navigate({ to: '/catalog', search: { page: 1, pageSize: DEFAULT_PAGE_SIZE } })
            }
          >
            {t('cs.cancel')}
          </Button>
          {created !== null ? (
            <Link
              to="/catalog/$productId"
              params={{ productId: created.id }}
              className="rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('cs.new.openCreated')}
            </Link>
          ) : null}
        </div>
      </div>
    </PermissionGate>
  );
}

function rank(kind: string): number {
  return kind === 'size' ? 0 : kind === 'colour' ? 1 : 2;
}

/** The created SKU carrying exactly this row's values. */
function skuFor(product: CatalogProduct, row: VariantRow): string | undefined {
  return product.skus.find(
    (sku) =>
      sku.attributes.length === row.valueIds.length &&
      row.valueIds.every((id) => sku.attributes.some((pair) => pair.valueId === id)),
  )?.id;
}

// --- the website's details (M33) -----------------------------------------------------------

interface WebDraft {
  readonly webVisible: boolean;
  readonly featured: boolean;
  readonly newArrival: boolean;
  readonly gender: string;
  readonly tags: string;
  readonly sizeChartId: string;
  readonly material: string;
  readonly care: string;
  readonly seoTitle: string;
  readonly seoDescription: string;
}

const EMPTY_WEB: WebDraft = {
  webVisible: false,
  featured: false,
  newArrival: false,
  gender: '',
  tags: '',
  sizeChartId: '',
  material: '',
  care: '',
  seoTitle: '',
  seoDescription: '',
};

function webChanged(value: WebDraft): boolean {
  return JSON.stringify(value) !== JSON.stringify(EMPTY_WEB);
}

function webInput(value: WebDraft) {
  const text = (raw: string) => (raw.trim() === '' ? null : raw.trim());
  return {
    webVisible: value.webVisible,
    featured: value.featured,
    newArrival: value.newArrival,
    gender: value.gender === '' ? null : (value.gender as WebGender),
    tags: value.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
    sizeChartId: value.sizeChartId === '' ? null : value.sizeChartId,
    material: text(value.material),
    careInstructions: text(value.care),
    seoTitle: text(value.seoTitle),
    seoDescription: text(value.seoDescription),
  };
}

function WebDetails({
  value,
  onChange,
  disabled,
  charts,
}: {
  readonly value: WebDraft;
  readonly onChange: (next: WebDraft) => void;
  readonly disabled: boolean;
  readonly charts: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useT();
  const set = <K extends keyof WebDraft>(key: K, next: WebDraft[K]) =>
    onChange({ ...value, [key]: next });
  const control = cn(controlClassName, 'w-full');
  const tick = (key: 'webVisible' | 'featured' | 'newArrival', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={value[key]}
        disabled={disabled}
        onCheckedChange={(next) => set(key, next === true)}
      />
      {label}
    </label>
  );
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {tick('webVisible', t('web.card.visible'))}
        {tick('featured', t('web.card.featured'))}
        {tick('newArrival', t('web.card.newArrival'))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('web.card.gender')}>
          <Select
            value={value.gender}
            onValueChange={(next) => set('gender', next)}
            options={[
              { value: '', label: t('web.card.genderAny') },
              { value: 'men', label: t('web.gender.men') },
              { value: 'women', label: t('web.gender.women') },
              { value: 'kids', label: t('web.gender.kids') },
              { value: 'unisex', label: t('web.gender.unisex') },
            ]}
          />
        </Field>
        <Field label={t('web.card.sizeChart')}>
          <Select
            value={value.sizeChartId}
            onValueChange={(next) => set('sizeChartId', next)}
            options={[
              { value: '', label: t('web.card.noSizeChart') },
              ...charts.map((chart) => ({ value: chart.id, label: chart.name })),
            ]}
          />
        </Field>
      </div>
      <Field label={t('web.card.tags')} hint={t('web.card.tagsHelp')}>
        <input
          value={value.tags}
          maxLength={1200}
          onChange={(event) => set('tags', event.target.value)}
          className={control}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('web.card.material')}>
          <input
            value={value.material}
            maxLength={200}
            onChange={(event) => set('material', event.target.value)}
            className={control}
          />
        </Field>
        <Field label={t('web.card.seoTitle')}>
          <input
            value={value.seoTitle}
            maxLength={120}
            onChange={(event) => set('seoTitle', event.target.value)}
            className={control}
          />
        </Field>
      </div>
      <Field label={t('web.card.seoDescription')}>
        <textarea
          value={value.seoDescription}
          maxLength={320}
          rows={2}
          onChange={(event) => set('seoDescription', event.target.value)}
          className={cn(controlClassName, 'h-auto w-full py-2')}
        />
      </Field>
      <Field label={t('web.card.care')}>
        <textarea
          value={value.care}
          maxLength={2000}
          rows={3}
          onChange={(event) => set('care', event.target.value)}
          className={cn(controlClassName, 'h-auto w-full py-2')}
        />
      </Field>
    </fieldset>
  );
}
