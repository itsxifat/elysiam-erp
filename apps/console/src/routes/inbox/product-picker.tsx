import { Money, Spinner, cn } from '@elysium/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { useLocale } from '../../i18n/locale.js';
import { ProductThumb } from './product-thumb.js';
import { pickProducts, SELL_KEY, type PickerProduct, type PickerVariant } from './sell-api.js';
import { matchesWant, type Want } from './sell-logic.js';
import { useSellT } from './sell-messages.js';

/** About the pause between two keys of someone typing fast: the search waits that long. */
const DEBOUNCE_MS = 120;

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** A number key, ASCII or Bangla, as 1 to 9; anything else null. */
function qtyKey(key: string): number | null {
  const index = BANGLA_DIGITS.indexOf(key);
  const digit = index >= 0 ? index : /^[0-9]$/.test(key) ? Number(key) : -1;
  return digit >= 1 && digit <= 9 ? digit : null;
}

/** Where the cursor starts on a product: the SKU named exactly, the size asked for, in stock. */
function defaultChip(product: PickerProduct, want: Want | null): number {
  const variants = product.variants;
  const matched = variants.findIndex((variant) => variant.skuId === product.matchedSkuId);
  if (matched >= 0) return matched;
  const asked = variants.findIndex((variant) => matchesWant(variant, want));
  if (asked >= 0) return asked;
  const inStock = variants.findIndex((variant) => variant.available > 0);
  return inStock >= 0 ? inStock : 0;
}

export interface ProductPickerProps {
  /** The customer's interests, shown before anything is typed. */
  readonly recentIds: readonly string[];
  /** What the card asked for: its size is pointed out and its quantity used. */
  readonly preset: Want | null;
  /** Text to search for, pushed in by the card ("Choose the product"); `n` re-applies it. */
  readonly pushed: { readonly q: string; readonly n: number } | null;
  readonly onPick: (product: PickerProduct, variant: PickerVariant, qty: number | null) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

/**
 * The instant product picker (M44b, D-772): name, SKU, parent SKU or barcode, searched as the
 * agent types (~120 ms after the last key); each product with its photo, price and a chip per size
 * showing the units in hand (greyed at none). Driven by the keyboard: Down from the box into the
 * results, Up and Down for the product, Left and Right for the size, 1 to 9 for the quantity,
 * Enter to add, Esc back to the box. A click on a chip adds it too.
 */
export function ProductPicker({ recentIds, preset, pushed, onPick, inputRef }: ProductPickerProps) {
  const t = useSellT();
  const { locale } = useLocale();
  const ids = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [active, setActive] = useState<{ product: number; chip: number }>({ product: 0, chip: 0 });
  const [qty, setQty] = useState<number | null>(null);

  // The card's "Choose the product" puts its words in the box (the card focuses it).
  const [seenPush, setSeenPush] = useState(pushed?.n ?? 0);
  if (pushed !== null && pushed.n !== seenPush) {
    setSeenPush(pushed.n);
    setText(pushed.q);
  }

  const term = useDebounced(text.trim(), DEBOUNCE_MS);
  const searching = term.length >= 2;
  const search = useQuery({
    queryKey: [...SELL_KEY, 'pick', term],
    queryFn: () => pickProducts({ q: term }),
    enabled: searching,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const recentKey = useMemo(() => [...recentIds].slice(0, 12), [recentIds]);
  const recent = useQuery({
    queryKey: [...SELL_KEY, 'ids', recentKey],
    queryFn: () => pickProducts({ ids: recentKey }),
    enabled: !searching && recentKey.length > 0,
    staleTime: 15_000,
  });
  const items: readonly PickerProduct[] = useMemo(
    () => (searching ? (search.data?.items ?? []) : (recent.data?.items ?? [])),
    [searching, search.data, recent.data],
  );

  // A new answer (or a new request from the card) starts the cursor on the first product's
  // best chip: adjusted while rendering, as React suggests for state that follows other state.
  const [seenAnswer, setSeenAnswer] = useState({ items, preset });
  if (seenAnswer.items !== items || seenAnswer.preset !== preset) {
    setSeenAnswer({ items, preset });
    const first = items[0];
    setActive({ product: 0, chip: first === undefined ? 0 : defaultChip(first, preset) });
  }

  const chipId = (product: number, chip: number) => `${ids}-p${String(product)}-c${String(chip)}`;
  const pick = (productIndex: number, chipIndex: number) => {
    const product = items[productIndex];
    const variant = product?.variants[chipIndex];
    if (product === undefined || variant === undefined) return;
    onPick(product, variant, qty ?? preset?.qty ?? null);
    setQty(null);
  };
  const moveProduct = (step: number) => {
    const next = Math.min(Math.max(active.product + step, 0), Math.max(items.length - 1, 0));
    const product = items[next];
    setActive({ product: next, chip: product === undefined ? 0 : defaultChip(product, preset) });
  };
  const moveChip = (step: number) => {
    const count = items[active.product]?.variants.length ?? 0;
    setActive((current) => ({
      ...current,
      chip: Math.min(Math.max(current.chip + step, 0), Math.max(count - 1, 0)),
    }));
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && items.length > 0) {
      event.preventDefault();
      listRef.current?.focus();
    } else if (event.key === 'Enter' && items.length > 0) {
      // A scanned barcode or a whole SKU code: Enter takes the size it named at once.
      event.preventDefault();
      pick(active.product, active.chip);
    } else if (event.key === 'Escape' && text !== '') {
      event.preventDefault();
      setText('');
    }
  };

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const number = qtyKey(event.key);
    if (number !== null && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      setQty(number);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveProduct(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (active.product === 0) inputRef.current?.focus();
        else moveProduct(-1);
        return;
      case 'ArrowRight':
        event.preventDefault();
        moveChip(1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        moveChip(-1);
        return;
      case 'Enter':
      case ' ':
        event.preventDefault();
        pick(active.product, active.chip);
        return;
      case 'Escape':
      case 'Backspace':
        event.preventDefault();
        inputRef.current?.focus();
        return;
      default:
        // Typing again goes back to the box with the key typed.
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault();
          setText((current) => current + event.key);
          inputRef.current?.focus();
        }
    }
  };

  const loading = searching
    ? search.isFetching && search.data === undefined
    : recent.isPending && recentKey.length > 0;
  const activeChip = items.length === 0 ? undefined : chipId(active.product, active.chip);

  return (
    <div className="space-y-2">
      <label htmlFor={`${ids}-q`} className="text-xs font-medium text-muted-foreground uppercase">
        {t('inbox.sell.picker.label')}
      </label>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          ref={inputRef}
          id={`${ids}-q`}
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onInputKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('inbox.sell.picker.placeholder')}
          aria-describedby={`${ids}-keys`}
          aria-controls={`${ids}-list`}
          className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-8 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
        {search.isFetching && searching ? (
          <span className="absolute top-1/2 right-2.5 -translate-y-1/2">
            <Spinner className="size-3.5" label={t('inbox.sell.picker.searching')} />
          </span>
        ) : text === '' ? null : (
          <button
            type="button"
            onClick={() => {
              setText('');
              inputRef.current?.focus();
            }}
            aria-label={t('inbox.sell.picker.close')}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <p id={`${ids}-keys`} className="text-xs text-muted-foreground">
        {t('inbox.sell.picker.keys')}
      </p>
      {preset === null ||
      (preset.size === null && preset.qty === null && preset.colour === null) ? null : (
        <p className="text-xs text-muted-foreground">
          {t('inbox.sell.picker.preset', {
            what: [
              preset.size === null ? null : t('inbox.sell.card.size', { size: preset.size }),
              preset.colour,
              preset.qty === null ? null : t('inbox.sell.card.qty', { qty: String(preset.qty) }),
            ]
              .filter((part): part is string => part !== null)
              .join(' · '),
          })}
        </p>
      )}
      {qty === null ? null : (
        <p role="status" className="text-xs font-medium">
          {t('inbox.sell.picker.qtyNext', { qty: String(qty) })}
        </p>
      )}

      <h4 className="text-xs text-muted-foreground">
        {searching ? t('inbox.sell.picker.results') : t('inbox.sell.picker.recent')}
      </h4>
      {loading ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          {t('inbox.sell.picker.searching')}
        </p>
      ) : searching && search.isError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {t('inbox.sell.picker.failed')}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {searching ? t('inbox.sell.picker.none', { q: term }) : t('inbox.sell.picker.noRecent')}
        </p>
      ) : (
        <div
          ref={listRef}
          id={`${ids}-list`}
          role="listbox"
          tabIndex={0}
          aria-label={searching ? t('inbox.sell.picker.results') : t('inbox.sell.picker.recent')}
          aria-activedescendant={activeChip}
          onKeyDown={onListKey}
          className={cn(
            'space-y-1 rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            search.isFetching && searching && 'opacity-80',
          )}
        >
          {items.map((product, productIndex) => (
            <div
              key={product.id}
              role="group"
              aria-label={product.name}
              className={cn(
                'flex gap-2 rounded-md border border-transparent p-1.5',
                productIndex === active.product && 'border-border bg-accent/60',
              )}
            >
              <ProductThumb fileId={product.imageFileId} alt="" size="sm" />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-baseline gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{product.name}</p>
                  {product.minPricePoisha === null ? null : (
                    <span className="shrink-0 text-xs">
                      <Money poisha={product.minPricePoisha} locale={locale} />
                      {product.maxPricePoisha === null ||
                      product.maxPricePoisha === product.minPricePoisha ? null : (
                        <>
                          {'–'}
                          <Money poisha={product.maxPricePoisha} locale={locale} />
                        </>
                      )}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {product.variants.map((variant, chipIndex) => {
                    const isActive = productIndex === active.product && chipIndex === active.chip;
                    const out = variant.available <= 0;
                    const name =
                      variant.label === '' ? t('inbox.sell.picker.oneSize') : variant.label;
                    return (
                      <div
                        key={variant.skuId}
                        id={chipId(productIndex, chipIndex)}
                        role="option"
                        aria-selected={isActive}
                        aria-label={t('inbox.sell.picker.chip', {
                          size: name,
                          stock: out
                            ? t('inbox.sell.picker.outOfStock')
                            : t('inbox.sell.picker.inStock', { n: String(variant.available) }),
                        })}
                        onClick={() => pick(productIndex, chipIndex)}
                        className={cn(
                          'inline-flex cursor-pointer items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs select-none',
                          'motion-safe:duration-fast motion-safe:transition-colors',
                          out
                            ? 'border-border text-muted-foreground opacity-60'
                            : 'border-border hover:bg-accent',
                          matchesWant(variant, preset) && 'border-primary',
                          isActive && 'bg-selected text-selected-foreground ring-2 ring-ring',
                        )}
                      >
                        <span className="font-medium">{name}</span>
                        <span className="tabular-nums">{String(variant.available)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
