import { Button, Money, SearchInput, Skeleton, StatusBadge, buttonVariants, cn } from '@elysium/ui';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScanLine } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/order-edit.js';
import { useScanHandler } from '../../lib/scanner.js';
import { ProductThumb } from '../inbox/product-thumb.js';
import { pickProducts, type PickerProduct, type PickerVariant } from './edit-api.js';

/**
 * The order editor's product picker (M50, D-923).
 *
 * The owner's words: "the product selection tab must advance show image and all details and it
 * shows all product not just top 20 only and search also available for product it must work
 * with product name sku barcode any thing". So:
 *
 * - **Every product.** Nothing typed lists the whole catalogue, newest first; a search lists
 *   every match. Pages of 24 load as the list scrolls to its end (and from a button, for the
 *   keyboard), until the server says there are no more.
 * - **Everything a person needs to choose.** The photo, the name, every size and colour on sale
 *   with its own price (the "was" price struck through), its SKU and the units in hand.
 * - **Any word.** The server finds a product by name in any word order, by SKU or parent SKU,
 *   by barcode and by website slug.
 * - **Scans.** While the picker is open a scan fills its search wherever focus is (the screen
 *   around it takes every scan, `data-scan-capture`); the size the barcode names is marked and
 *   Enter adds it.
 */
export function OrderProductPicker({
  onAdd,
  locationId,
  onOrder,
  autoFocus = false,
  takeScans = true,
}: {
  readonly onAdd: (product: PickerProduct, variant: PickerVariant) => void;
  readonly locationId?: string | null;
  /** SKUs already on the order, marked in the list. */
  readonly onOrder?: ReadonlySet<string>;
  readonly autoFocus?: boolean;
  /** Take the page's scans while open. Off when a screen around it handles them itself. */
  readonly takeScans?: boolean;
}) {
  const t = useT();
  const { locale } = useLocale();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const q = useSettled(text.trim(), 250);

  const pages = useInfiniteQuery({
    queryKey: ['orders', 'picker', q, locationId ?? null],
    queryFn: ({ pageParam }) => pickProducts(q, pageParam, locationId),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset ?? undefined,
    staleTime: 30_000,
  });
  const products = pages.data?.pages.flatMap((page) => page.items) ?? [];
  const matched =
    q === text.trim() ? products.find((product) => product.matchedSkuId !== null) : undefined;
  const matchedVariant = matched?.variants.find(
    (variant) => variant.skuId === matched.matchedSkuId,
  );

  useScanHandler((code) => {
    setText(code);
    inputRef.current?.focus();
  }, takeScans);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  // The next page when the end of the list comes into view.
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    const node = end.current;
    if (node === null || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (matched !== undefined && matchedVariant !== undefined) {
      onAdd(matched, matchedVariant);
      setText('');
      return;
    }
    // One product with one size on sale: Enter adds it too.
    const only = products.length === 1 ? products[0] : undefined;
    const variant = only?.variants.length === 1 ? only.variants[0] : undefined;
    if (only !== undefined && variant !== undefined) {
      onAdd(only, variant);
      setText('');
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor={`${ids}-q`} className="text-sm font-medium">
          {t('oe.picker.label')}
        </label>
        <SearchInput
          ref={inputRef}
          id={`${ids}-q`}
          className="sm:w-full"
          value={text}
          placeholder={t('oe.picker.placeholder')}
          autoComplete="off"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKey}
          onClear={() => setText('')}
          clearLabel={t('oe.picker.close')}
        />
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            {q === '' ? t('oe.picker.all') : t('oe.picker.results').replace('{q}', q)}
            {products.length === 0
              ? null
              : ` · ${t('oe.picker.count').replace('{n}', String(products.length))}`}
          </span>
          {matchedVariant === undefined ? null : <span>{t('oe.picker.enterHint')}</span>}
        </p>
      </div>

      {pages.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">{t('oe.picker.loading')}</span>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : pages.isError ? (
        <div className="space-y-2 text-sm">
          <p className="text-destructive">{t('oe.picker.error')}</p>
          <Button variant="outline" size="sm" onClick={() => void pages.refetch()}>
            {t('oe.picker.retry')}
          </Button>
        </div>
      ) : products.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('oe.picker.empty')}</p>
      ) : (
        <ul
          className="max-h-[32rem] space-y-2 overflow-y-auto pr-1"
          aria-label={t('oe.picker.label')}
        >
          {products.map((product) => (
            <ProductCard
              key={product.id}
              product={product}
              locale={locale}
              onOrder={onOrder}
              onAdd={(variant) => {
                onAdd(product, variant);
                if (product.matchedSkuId !== null) setText('');
              }}
            />
          ))}
          <li className="list-none">
            <div ref={end} />
            {hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                disabled={isFetchingNextPage}
                onClick={() => void fetchNextPage()}
              >
                {isFetchingNextPage ? t('oe.picker.loading') : t('oe.picker.loadMore')}
              </Button>
            ) : (
              <p className="py-2 text-center text-xs text-muted-foreground">{t('oe.picker.end')}</p>
            )}
          </li>
        </ul>
      )}
    </div>
  );
}

function ProductCard({
  product,
  locale,
  onOrder,
  onAdd,
}: {
  readonly product: PickerProduct;
  readonly locale: Parameters<typeof Money>[0]['locale'];
  readonly onOrder: ReadonlySet<string> | undefined;
  readonly onAdd: (variant: PickerVariant) => void;
}) {
  const t = useT();
  const prices = product.variants.map((variant) => BigInt(variant.pricePoisha));
  const low = prices.length === 0 ? null : prices.reduce((a, b) => (b < a ? b : a));
  const high = prices.length === 0 ? null : prices.reduce((a, b) => (b > a ? b : a));
  const stock = product.variants.reduce((total, variant) => total + variant.available, 0);
  return (
    <li className="flex gap-3 rounded-md border border-border p-3">
      <ProductThumb fileId={product.imageFileId} alt={product.name} />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-medium">{product.name}</p>
          <p className="text-sm">
            {low === null ? null : low === high ? (
              <Money poisha={low.toString()} locale={locale} />
            ) : (
              <span className="text-muted-foreground">
                {t('oe.picker.from').replace('{price}', '')}
                <Money poisha={low.toString()} locale={locale} />
              </span>
            )}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {stock > 0
            ? t('oe.picker.inStock').replace('{n}', String(stock))
            : t('oe.picker.outOfStock')}
        </p>
        {product.variants.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('oe.picker.noVariants')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {product.variants.map((variant) => {
              const scanned = variant.skuId === product.matchedSkuId;
              const label = variant.label === '' ? variant.code : variant.label;
              return (
                <button
                  key={variant.skuId}
                  type="button"
                  aria-label={t('oe.picker.add').replace('{variant}', `${product.name} ${label}`)}
                  className={cn(
                    buttonVariants({ variant: scanned ? 'primary' : 'outline', size: 'sm' }),
                    'h-auto flex-col items-start py-1.5 text-left',
                  )}
                  onClick={() => onAdd(variant)}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {scanned ? <ScanLine aria-hidden="true" className="size-3.5" /> : null}
                    {label}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs font-normal">
                    <Money poisha={variant.pricePoisha} locale={locale} />
                    {variant.compareAtPoisha === null ? null : (
                      <s className="opacity-70">
                        <Money poisha={variant.compareAtPoisha} locale={locale} />
                      </s>
                    )}
                    <span className="tabular-nums">{variant.code}</span>
                    <span>
                      {variant.available > 0
                        ? t('oe.picker.inStock').replace('{n}', String(variant.available))
                        : t('oe.picker.outOfStock')}
                    </span>
                  </span>
                  {onOrder?.has(variant.skuId) === true ? (
                    <StatusBadge tone="info">{t('oe.picker.onOrder')}</StatusBadge>
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

/** The value once it has stopped changing for `ms`: one request per pause, not per key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
