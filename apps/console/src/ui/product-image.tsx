import { Dialog, cn } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { useState, type MouseEvent } from 'react';

import { api } from '../api.js';
import { useT } from '../i18n/locale.js';

/**
 * A product's photo wherever a product is listed, and its large view on a click (D-929).
 *
 * The owner: "in every product picker or browser when a product list comes there must be a
 * feature for clicking the image to see it in expand view … anywhere we need product details
 * there must be the product image with it and click to expand view". So one component, named by
 * what the screen already has: a SKU (an order line, a stock row: its colour's photo, else the
 * product's first), a product (its first photo) or a photo's file. The website's own public
 * sizes are used, the thumb in the list and the full one in the view, and every lookup a screen
 * makes in the same moment goes to the server as one request (`GET /v1/storefront/product-images`).
 */

type Kind = 'sku' | 'product' | 'file';

interface Photo {
  readonly thumb: string;
  readonly full: string;
}

interface ImagesResponse {
  readonly items: readonly {
    readonly kind: Kind;
    readonly id: string;
    readonly thumb: string;
    readonly full: string;
  }[];
}

const BATCH_LIMIT = 100;
const waiting = new Map<string, ((photo: Photo | null) => void)[]>();
let scheduled = false;

/** One lookup, answered with the others asked in the same moment. Null: no photo. */
function lookUp(kind: Kind, id: string): Promise<Photo | null> {
  return new Promise((resolve) => {
    const key = `${kind}:${id}`;
    const list = waiting.get(key);
    if (list === undefined) waiting.set(key, [resolve]);
    else list.push(resolve);
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => void flush(), 10);
    }
  });
}

async function flush(): Promise<void> {
  scheduled = false;
  const batch = new Map(waiting);
  waiting.clear();
  const ids: Record<Kind, string[]> = { sku: [], product: [], file: [] };
  for (const key of batch.keys()) {
    const [kind, id] = key.split(':') as [Kind, string];
    ids[kind].push(id);
  }
  const rounds = Math.ceil(
    Math.max(ids.sku.length, ids.product.length, ids.file.length) / BATCH_LIMIT,
  );
  const found = new Map<string, Photo>();
  for (let round = 0; round < rounds; round += 1) {
    const part = (list: string[]) => list.slice(round * BATCH_LIMIT, (round + 1) * BATCH_LIMIT);
    const query = new URLSearchParams();
    if (part(ids.sku).length > 0) query.set('skuIds', part(ids.sku).join(','));
    if (part(ids.product).length > 0) query.set('productIds', part(ids.product).join(','));
    if (part(ids.file).length > 0) query.set('fileIds', part(ids.file).join(','));
    try {
      const answer = await api.get<ImagesResponse>(
        `/v1/storefront/product-images?${query.toString()}`,
      );
      for (const item of answer.items) {
        found.set(`${item.kind}:${item.id}`, { thumb: item.thumb, full: item.full });
      }
    } catch {
      // No photo is shown rather than an error: the line still reads without it.
    }
  }
  for (const [key, resolvers] of batch) {
    for (const resolve of resolvers) resolve(found.get(key) ?? null);
  }
}

const SIZES = {
  xs: 'size-8',
  sm: 'size-10',
  md: 'size-14',
  lg: 'size-24',
} as const;

export function ProductImage({
  skuId,
  productId,
  fileId,
  alt,
  size = 'sm',
  className,
}: {
  readonly skuId?: string | null | undefined;
  readonly productId?: string | null | undefined;
  readonly fileId?: string | null | undefined;
  /** The product's name: the photo's text, and the large view's title. */
  readonly alt: string;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [kind, id]: [Kind, string | null] =
    skuId != null
      ? ['sku', skuId]
      : productId != null
        ? ['product', productId]
        : ['file', fileId ?? null];
  const photo = useQuery({
    queryKey: ['product-image', kind, id],
    queryFn: () => lookUp(kind, id ?? ''),
    enabled: id !== null,
    // The website's URLs do not expire; a product's photos change rarely.
    staleTime: 10 * 60_000,
  });
  const box = cn(
    'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted',
    SIZES[size],
    className,
  );

  if (photo.data == null) {
    return (
      <div className={box} title={photo.isPending && id !== null ? undefined : t('common.noPhoto')}>
        {photo.isPending && id !== null ? null : (
          <ImageOff aria-hidden className="size-4 text-muted-foreground" />
        )}
      </div>
    );
  }
  const show = (event: MouseEvent) => {
    // A row that opens its order or adds its product keeps its own click.
    event.stopPropagation();
    event.preventDefault();
    setOpen(true);
  };
  return (
    <>
      <button
        type="button"
        className={cn(
          box,
          'hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        )}
        aria-label={`${t('common.viewPhoto')}: ${alt}`}
        title={t('common.viewPhoto')}
        // A picker's option adds its product on mouse-down: the photo's press is the photo's.
        onMouseDown={(event) => event.stopPropagation()}
        onClick={show}
      >
        <img src={photo.data.thumb} alt={alt} loading="lazy" className="size-full object-cover" />
      </button>
      {open ? (
        // The dialog is portalled, but React still bubbles its clicks and keys to the row around
        // this photo: stopped here, so closing the view never opens the order or adds the product.
        <span
          role="presentation"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog
            open
            onOpenChange={setOpen}
            title={alt}
            closeLabel={t('common.close')}
            className="w-[min(44rem,calc(100vw-2rem))]"
          >
            <img
              src={photo.data.full}
              alt={alt}
              className="mx-auto max-h-[70vh] w-full rounded-md object-contain"
            />
          </Dialog>
        </span>
      ) : null}
    </>
  );
}
