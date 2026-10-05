import { ean13Modules, isValidEan13 } from '@elysium/domain/barcode';
import { Button, Checkbox, Dialog, Select, cn, controlClassName } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy, Download, ExternalLink, Printer } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '../../api.js';
import { useSession } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import { stickersPdf } from './api.js';
import {
  STICKER_MEDIUM_IDS,
  parseCopies,
  positionsOn,
  readStickerPrefs,
  stickerPrints,
  writeStickerPrefs,
  type StickerMediumChoice,
} from './stickers-plan.js';

/**
 * Print barcode stickers (M38a, D-604): one per piece, on a thermal roll or an A4 sheet.
 *
 * Opened from the end of the new-product form, after a stock receipt or a stock-in-hand
 * entry (one sticker per piece received), from the product page (any variants, any counts)
 * and from the Stock list (the rows ticked). The person picks the stock they print on, a
 * start position for a half-used A4 sheet, and whether the price is on the tag; the stock
 * and the price choice are remembered for them on this device.
 *
 * A print of more than a thousand stickers comes as several PDFs, one button each.
 */

export interface StickerItem {
  readonly skuId: string;
  /** `Linen Panjabi · M / White`. */
  readonly label: string;
  readonly skuCode: string;
  /** How many to print to begin with: one per piece, usually. */
  readonly count: number;
}

const MEDIUM_KEYS = {
  'thermal-38x25': 'st.stickers.medium.thermal-38x25',
  'thermal-40x30': 'st.stickers.medium.thermal-40x30',
  'thermal-50x25': 'st.stickers.medium.thermal-50x25',
  'a4-3x8': 'st.stickers.medium.a4-3x8',
  'a4-4x10': 'st.stickers.medium.a4-4x10',
} as const;

export function StickerDialog({
  open,
  onOpenChange,
  items,
  title,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly items: readonly StickerItem[];
  readonly title?: string;
}) {
  const t = useT();
  const id = useId();
  const userId = useSession().context?.userId ?? '';
  const [prefs] = useState(() => readStickerPrefs(userId));
  const [medium, setMedium] = useState<StickerMediumChoice>(prefs.medium);
  const [showPrice, setShowPrice] = useState(prefs.showPrice);
  const [startAt, setStartAt] = useState('1');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [ready, setReady] = useState<{ url: string; part: number }[]>([]);

  // Every PDF made while the dialog is open, let go when it closes or the page leaves.
  const made = useRef<string[]>([]);
  const release = () => {
    for (const url of made.current) URL.revokeObjectURL(url);
    made.current = [];
  };
  useEffect(() => release, []);

  // Start from the counts the caller offered each time the dialog opens, and only then: a
  // page re-rendering behind an open dialog must not wipe what the person typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setCounts(Object.fromEntries(items.map((item) => [item.skuId, String(item.count)])));
      setReady([]);
    }
    if (!open && wasOpen.current) release();
    wasOpen.current = open;
  }, [open, items]);

  const positions = positionsOn(medium);
  const start = positions === 0 ? 1 : Number(startAt);
  const startProblem =
    positions > 0 && (!/^\d{1,2}$/.test(startAt) || start < 1 || start > positions);
  const lines = items.map((item) => ({
    skuId: item.skuId,
    copies: parseCopies(counts[item.skuId] ?? '') ?? 0,
  }));
  const countProblem = items.some((item) => parseCopies(counts[item.skuId] ?? '') === null);
  const total = lines.reduce((sum, line) => sum + line.copies, 0);
  const prints = stickerPrints(lines);

  const remember = (next: { medium?: StickerMediumChoice; showPrice?: boolean }) =>
    writeStickerPrefs(userId, {
      medium: next.medium ?? medium,
      showPrice: next.showPrice ?? showPrice,
    });

  const print = useMutation({
    mutationFn: async (part: number) => {
      const chosen = prints[part] ?? [];
      const blob = await stickersPdf({
        items: chosen,
        showPrice,
        medium,
        // Only the first PDF starts part-way into a sheet; the rest start on a fresh one.
        startAt: part === 0 ? start : 1,
      });
      const url = URL.createObjectURL(blob);
      made.current.push(url);
      return { url, part };
    },
    onSuccess: (result) => {
      setReady((current) => [...current.filter((entry) => entry.part !== result.part), result]);
      // A new tab, where the browser's print dialog is one click away. A blocked pop-up
      // still leaves the Open and Download links below.
      window.open(result.url, '_blank', 'noopener');
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? t('st.stickers.title')}
      description={t('st.stickers.help')}
      closeLabel={t('st.close')}
      className="w-[min(46rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('st.close')}
          </Button>
          {prints.length <= 1 ? (
            <Button
              data-testid="stickers-print"
              disabled={total === 0 || countProblem || startProblem || print.isPending}
              onClick={() => print.mutate(0)}
            >
              <Printer aria-hidden="true" />
              {`${t('st.stickers.print')} (${String(total)})`}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-medium`} className="text-sm font-medium">
              {t('st.stickers.medium')}
            </label>
            <Select
              id={`${id}-medium`}
              value={medium}
              onValueChange={(value) => {
                const next = value as StickerMediumChoice;
                setMedium(next);
                remember({ medium: next });
              }}
              options={STICKER_MEDIUM_IDS.map((value) => ({
                value,
                label: t(MEDIUM_KEYS[value]),
              }))}
            />
          </div>
          {positions > 0 ? (
            <div className="space-y-1.5">
              <label htmlFor={`${id}-start`} className="text-sm font-medium">
                {t('st.stickers.startAt')}
              </label>
              <input
                id={`${id}-start`}
                inputMode="numeric"
                value={startAt}
                aria-invalid={startProblem}
                aria-describedby={`${id}-start-hint`}
                onChange={(event) => setStartAt(event.target.value)}
                className={cn(controlClassName, 'w-24 text-right tabular-nums')}
              />
              <p id={`${id}-start-hint`} className="text-xs text-muted-foreground">
                {`${t('st.stickers.startAtHint')} ${String(positions)}`}
              </p>
            </div>
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={showPrice}
            onCheckedChange={(next) => {
              const value = next === true;
              setShowPrice(value);
              remember({ showPrice: value });
            }}
          />
          {t('st.stickers.showPrice')}
        </label>

        <div className="max-h-72 overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('st.stickers.caption')}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th scope="col" className="h-9 px-3 font-medium">
                  {t('st.col.item')}
                </th>
                <th scope="col" className="h-9 w-28 px-3 text-right font-medium">
                  {t('st.stickers.count')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const text = counts[item.skuId] ?? '';
                return (
                  <tr key={item.skuId} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-1.5">
                      <span className="font-medium">{item.label}</span>
                      <span className="ms-2 text-xs text-muted-foreground tabular-nums">
                        {item.skuCode}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <label className="sr-only" htmlFor={`${id}-count-${item.skuId}`}>
                        {`${t('st.stickers.count')} ${item.label}`}
                      </label>
                      <input
                        id={`${id}-count-${item.skuId}`}
                        inputMode="numeric"
                        value={text}
                        aria-invalid={parseCopies(text) === null}
                        onChange={(event) =>
                          setCounts((current) => ({ ...current, [item.skuId]: event.target.value }))
                        }
                        className={cn(
                          controlClassName,
                          'h-control-sm w-20 text-right tabular-nums aria-[invalid=true]:border-destructive',
                        )}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="text-sm tabular-nums">{`${t('st.stickers.total')} ${String(total)}`}</p>

        {prints.length > 1 ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t('st.stickers.parts')}</p>
            <div className="flex flex-wrap gap-2">
              {prints.map((part, index) => {
                const count = part.reduce((sum, line) => sum + line.copies, 0);
                return (
                  <Button
                    key={String(index)}
                    variant="outline"
                    disabled={countProblem || startProblem || print.isPending}
                    onClick={() => print.mutate(index)}
                  >
                    <Printer aria-hidden="true" />
                    {`${t('st.stickers.part')} ${String(index + 1)} (${String(count)})`}
                  </Button>
                );
              })}
            </div>
          </div>
        ) : null}

        {ready.length > 0 ? (
          <div role="status" className="space-y-1 text-sm">
            <p>{t('st.stickers.ready')}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {[...ready]
                .sort((a, b) => a.part - b.part)
                .map((entry) => (
                  <li key={entry.url} className="flex items-center gap-3">
                    <a
                      href={entry.url}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex items-center gap-1 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <ExternalLink aria-hidden="true" className="size-3.5" />
                      {prints.length > 1
                        ? `${t('st.stickers.open')} ${String(entry.part + 1)}`
                        : t('st.stickers.open')}
                    </a>
                    <a
                      href={entry.url}
                      download={`stickers-${medium}-${String(entry.part + 1)}.pdf`}
                      className="inline-flex items-center gap-1 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <Download aria-hidden="true" className="size-3.5" />
                      {t('st.stickers.download')}
                    </a>
                  </li>
                ))}
            </ul>
          </div>
        ) : null}
        {print.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {print.error instanceof ApiError ? print.error.message : t('st.stickers.failed')}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * An EAN-13 drawn small, for the product page (D-606): the same modules the sticker prints,
 * as whole-module rects. A supplier's non-EAN code shows as text only.
 */
export function EanBars({
  code,
  className,
}: {
  readonly code: string;
  readonly className?: string;
}) {
  if (!isValidEan13(code)) return null;
  const modules = ean13Modules(code);
  const rects: { x: number; w: number }[] = [];
  for (let index = 0; index < modules.length;) {
    if (modules[index] !== '1') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < modules.length && modules[end] === '1') end += 1;
    rects.push({ x: index, w: end - index });
    index = end;
  }
  return (
    <svg
      viewBox="0 0 95 20"
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={cn('h-5 w-24 fill-current text-foreground', className)}
    >
      {rects.map((rect) => (
        <rect key={rect.x} x={rect.x} y={0} width={rect.w} height={20} />
      ))}
    </svg>
  );
}

/** Copy a barcode's digits, saying so for a moment. */
export function CopyCode({ code }: { readonly code: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? t('st.barcode.copied') : `${t('st.barcode.copy')} ${code}`}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(code)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}
