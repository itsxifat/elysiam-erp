import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Money,
  PermissionGate,
  SearchInput,
  Skeleton,
  poishaToTaka,
  takaToPoisha,
} from '@elysium/ui';
import { formatMoneyText } from '@elysium/i18n';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Minus, Plus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/order-edit.js';
import { useScanHandler } from '../../lib/scanner.js';
import { setParcelStatus } from '../courier/api.js';
import { ProductThumb } from '../inbox/product-thumb.js';
import { deliverPartially, getOrder, startReturn, type OrderDetail } from './api.js';
import { pickProducts, productsOfSkus, quoteReturn } from './edit-api.js';
import { OffersPanel } from './offers-panel.js';
import { BackLink, Total, useSettled } from './order-edit.js';
import { differenceNote, returnOne, startingTerms } from './order-edit-logic.js';
import { OrderStatusBadge } from './parts.js';
import { liveParcelOf, useOrderParcels } from './parcel-panel.js';
import { ordersPath } from './paths.js';

/** How a status set from this page reads on the parcel's history, as on the order page. */
const MANUAL_RAW_STATUS = 'Set from the order detail';

/**
 * Return items (M50, D-924): `/orders/$orderId/return`.
 *
 * The owner's words: "after sent to courier customer can return the whole parcel or can take one
 * and or multiple and return one and multiple. so we need another return tab also. after
 * returning any item … there will be another side panel to apply discount … also make sure we
 * can update the delivery fee".
 *
 * A person marks what the buyer gives back, line by line or by scanning the pieces; the offers
 * panel re-prices what they keep (the server's `repriceReturn`) with the delivery charge typed,
 * and the page says what the rider collects. Saving records it the way the order page always
 * has, so the books are unchanged in kind:
 *
 * - **Some kept**: a partial delivery of the kept pieces with that amount, on the parcel when
 *   there is one (so the courier's figure and its statement agree) or on the order. Where it
 *   differs from the order's own terms the journal books the difference to Sales discounts, with
 *   the offers and charge written in its reason (§7).
 * - **Nothing kept**: the parcel starts its way back; the warehouse receives and checks it on
 *   Returns, as before.
 */
export function OrderReturnPage() {
  const ability = useAbility();
  const t = useT();
  const params = useParams({ strict: false }) as unknown as { orderId?: string };
  const orderId = params.orderId ?? '';
  const order = useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => getOrder(orderId),
    enabled: orderId !== '',
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  return (
    <PermissionGate
      allowed={ability.can('update', 'Order')}
      explain={{ title: t('orders.deniedTitle'), detail: t('orders.deniedDetail') }}
    >
      <div className="space-y-5" data-scan-capture="">
        <BackLink orderId={orderId} />
        {order.isPending ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : order.isError ? (
          <ErrorState
            title={t('orders.errorTitle')}
            detail={t('orders.errorDetail')}
            action={
              <Button variant="outline" size="sm" onClick={() => void order.refetch()}>
                {t('orders.retry')}
              </Button>
            }
          />
        ) : order.data.status === 'shipped' ? (
          <Returner order={order.data} />
        ) : (
          <EmptyState title={t('oe.return.locked')} detail={t('oe.return.lockedDetail')} />
        )}
      </div>
    </PermissionGate>
  );
}

function Returner({ order }: { readonly order: OrderDetail }) {
  const t = useT();
  const { locale } = useLocale();
  const ids = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const parcels = useOrderParcels(order.id);
  const parcel = liveParcelOf(parcels.data?.items ?? []);

  const start = useMemo(() => startingTerms(order), [order]);
  const [returned, setReturned] = useState<Record<string, number>>({});
  const [fee, setFee] = useState(() => poishaToTaka(start.baseDeliveryPoisha.toString()));
  const [selected, setSelected] = useState<string[]>(start.offerIds);
  const [find, setFind] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const products = useQuery({
    queryKey: ['orders', 'picker', 'skus', order.lines.map((line) => line.skuId).join(',')],
    queryFn: () =>
      productsOfSkus(
        order.lines.map((line) => line.skuId),
        order.locationId,
      ),
    staleTime: 60_000,
  });
  const lookOf = (skuId: string) => {
    const product = products.data?.items.find((entry) =>
      entry.variants.some((variant) => variant.skuId === skuId),
    );
    return {
      imageFileId: product?.imageFileId ?? null,
      label: product?.variants.find((variant) => variant.skuId === skuId)?.label ?? '',
    };
  };

  const sentOf = (line: OrderDetail['lines'][number]) =>
    line.qty - line.deliveredQty - line.returnedQty;
  const keep = order.lines.map((line) => ({
    skuId: line.skuId,
    qty: sentOf(line) - (returned[line.skuId] ?? 0),
  }));
  const feePoisha = takaToPoisha(fee.trim() === '' ? '0' : fee);
  const feeOk = feePoisha !== null && !feePoisha.startsWith('-');
  const body = feeOk ? { keep, deliveryChargePoisha: feePoisha, discountIds: selected } : null;
  const settled = useSettled(body === null ? null : JSON.stringify(body), 300);
  const quote = useQuery({
    queryKey: ['orders', 'return-quote', order.id, settled],
    queryFn: () => quoteReturn(order.id, JSON.parse(settled ?? '{}') as NonNullable<typeof body>),
    enabled: settled !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });

  /** One more piece of the SKU a scan or a typed SKU names, if it is on this order. */
  async function returnByCode(raw: string) {
    const code = raw.trim();
    if (code === '') return;
    let skuId = order.lines.find(
      (line) => line.skuCode.toUpperCase() === code.toUpperCase(),
    )?.skuId;
    if (skuId === undefined) {
      try {
        const page = await pickProducts(code, 0, order.locationId);
        skuId =
          page.items.find((product) => product.matchedSkuId !== null)?.matchedSkuId ?? undefined;
      } catch {
        skuId = undefined;
      }
    }
    const line = order.lines.find((entry) => entry.skuId === skuId);
    if (line === undefined) {
      setNotice(t('oe.return.notOnOrder'));
      return;
    }
    if ((returned[line.skuId] ?? 0) >= sentOf(line)) {
      setNotice(t('oe.return.allBack'));
      return;
    }
    setReturned((current) => returnOne(current, line.skuId, sentOf(line), 1));
    setNotice(`${line.productName} ${lookOf(line.skuId).label}`.trim());
    setFind('');
  }
  useScanHandler((code) => void returnByCode(code));

  const whole = quote.data?.wholeReturn === true;
  const save = useMutation({
    mutationFn: async () => {
      const data = quote.data;
      if (data === undefined) throw new Error(t('orders.errorDetail'));
      const reason = note.trim().length >= 3 ? note.trim() : MANUAL_RAW_STATUS;
      if (data.wholeReturn) {
        if (parcel !== null) {
          return setParcelStatus(parcel.id, {
            status: 'return_in_transit',
            rawStatus: MANUAL_RAW_STATUS,
            reason,
          });
        }
        return startReturn(order.id, note.trim().length >= 3 ? note.trim() : undefined);
      }
      const lines = keep.map((entry) => ({ skuId: entry.skuId, deliveredQty: entry.qty }));
      const differs = data.collectPoisha !== data.expectedPoisha;
      const differenceReason = differs
        ? differenceNote(
            t('oe.return.differenceNote'),
            data.applied.map((entry) => entry.title),
            t('oe.return.noOffers'),
            formatMoneyText(data.deliveryChargePoisha),
            note,
          )
        : undefined;
      if (parcel !== null) {
        return setParcelStatus(parcel.id, {
          status: 'partial_delivered',
          rawStatus: MANUAL_RAW_STATUS,
          reason: differenceReason ?? reason,
          collectedPoisha: data.collectPoisha,
          ...(differenceReason === undefined ? {} : { differenceReason }),
          deliveredLines: lines,
        });
      }
      return deliverPartially(order.id, {
        collectedPoisha: data.collectPoisha,
        lines,
        ...(differenceReason === undefined ? {} : { differenceReason }),
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['courier'] });
      await navigate({ to: ordersPath(`/orders/${order.id}`) });
    },
    onError: (error) => setProblem(error instanceof ApiError ? error.message : t('oe.edit.failed')),
  });

  const visible = order.lines.filter((line) => {
    const term = find.trim().toLowerCase();
    return (
      term === '' ||
      line.productName.toLowerCase().includes(term) ||
      line.skuCode.toLowerCase().includes(term)
    );
  });

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-3 text-lg font-semibold tracking-tight">
          {t('oe.return.title').replace('{no}', order.orderNo)}
          <OrderStatusBadge status={order.status} />
        </h1>
        <p className="text-sm text-muted-foreground">{t('oe.return.caption')}</p>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="space-y-4 rounded-lg border border-border bg-card p-5">
          <div className="space-y-1.5">
            <Label htmlFor={`${ids}-find`}>{t('oe.return.find')}</Label>
            <SearchInput
              id={`${ids}-find`}
              className="sm:w-full"
              value={find}
              autoComplete="off"
              onChange={(event) => setFind(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void returnByCode(find);
                }
              }}
              onClear={() => setFind('')}
              clearLabel={t('oe.picker.close')}
              aria-describedby={`${ids}-find-hint`}
            />
            <p id={`${ids}-find-hint`} className="text-xs text-muted-foreground">
              {t('oe.return.findHint')}
            </p>
            {notice === null ? null : (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setReturned(
                  Object.fromEntries(order.lines.map((line) => [line.skuId, sentOf(line)])),
                )
              }
            >
              {t('oe.return.all')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setReturned({})}>
              {t('oe.return.none')}
            </Button>
          </div>
          <table className="w-full text-sm">
            <caption className="sr-only">{t('oe.edit.items')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">{t('oe.edit.item')}</th>
                <th className="pb-2 text-right font-medium">{t('oe.return.sent')}</th>
                <th className="pb-2 text-right font-medium">{t('oe.return.returned')}</th>
                <th className="pb-2 text-right font-medium">{t('oe.return.kept')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((line) => {
                const look = lookOf(line.skuId);
                const sent = sentOf(line);
                const back = returned[line.skuId] ?? 0;
                const item = `${line.productName} ${look.label}`.trim();
                return (
                  <tr key={line.id} className="border-b border-border last:border-b-0">
                    <td className="py-2.5">
                      <span className="flex items-center gap-3">
                        <ProductThumb fileId={look.imageFileId} alt="" size="sm" />
                        <span className="min-w-0">
                          <span className="block font-medium">{line.productName}</span>
                          <span className="block text-xs text-muted-foreground tabular-nums">
                            {[look.label, line.skuCode].filter((part) => part !== '').join(' · ')}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            <Money poisha={line.unitPricePoisha} locale={locale} />
                          </span>
                        </span>
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{sent}</td>
                    <td className="text-right">
                      <span className="inline-flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('oe.return.decrease').replace('{item}', item)}
                          disabled={back <= 0}
                          onClick={() =>
                            setReturned((current) => returnOne(current, line.skuId, sent, -1))
                          }
                        >
                          <Minus aria-hidden="true" />
                        </Button>
                        <span className="w-8 text-center tabular-nums">{back}</span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('oe.return.increase').replace('{item}', item)}
                          disabled={back >= sent}
                          onClick={() =>
                            setReturned((current) => returnOne(current, line.skuId, sent, 1))
                          }
                        >
                          <Plus aria-hidden="true" />
                        </Button>
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{sent - back}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <aside className="space-y-4">
          {whole ? null : (
            <OffersPanel
              offers={quote.data?.offers}
              applied={quote.data?.applied ?? []}
              selected={selected}
              onChange={setSelected}
              updating={quote.isFetching}
              failed={quote.isError}
            />
          )}
          <section className="space-y-4 rounded-lg border border-border bg-card p-5">
            {whole ? (
              <div className="space-y-1">
                <h2 className="text-base font-semibold tracking-tight">{t('oe.return.whole')}</h2>
                <p className="text-sm text-muted-foreground">{t('oe.return.wholeDetail')}</p>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${ids}-fee`}>{t('oe.edit.delivery')}</Label>
                  <Input
                    id={`${ids}-fee`}
                    inputMode="decimal"
                    className="tabular-nums"
                    value={fee}
                    onChange={(event) => setFee(event.target.value)}
                  />
                </div>
                <dl
                  className="space-y-1.5 border-t border-border pt-3 text-sm"
                  aria-busy={quote.isFetching}
                >
                  <Total label={t('oe.total.kept')} poisha={quote.data?.keptNetPoisha} />
                  <Total
                    label={t('oe.total.offers')}
                    poisha={quote.data?.offerDiscountPoisha}
                    minus
                  />
                  {quote.data === undefined || quote.data.typedDiscountPoisha === '0' ? null : (
                    <Total
                      label={t('oe.total.discount')}
                      poisha={quote.data.typedDiscountPoisha}
                      minus
                    />
                  )}
                  <Total label={t('oe.total.delivery')} poisha={quote.data?.deliveryChargePoisha} />
                  {quote.data === undefined || quote.data.advanceAppliedPoisha === '0' ? null : (
                    <Total
                      label={t('oe.total.advance')}
                      poisha={quote.data.advanceAppliedPoisha}
                      minus
                    />
                  )}
                  <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
                    <dt className="font-medium">{t('oe.total.collect')}</dt>
                    <dd className="text-xl font-semibold">
                      {quote.data === undefined ? (
                        '—'
                      ) : (
                        <Money poisha={quote.data.collectPoisha} locale={locale} />
                      )}
                    </dd>
                  </div>
                </dl>
                {quote.data === undefined ||
                quote.data.collectPoisha === quote.data.expectedPoisha ? null : (
                  <p className="text-xs text-muted-foreground">
                    {t('oe.return.expected').replace(
                      '{amount}',
                      formatMoneyText(quote.data.expectedPoisha),
                    )}
                  </p>
                )}
              </>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-note`}>{t('oe.return.note')}</Label>
              <Input
                id={`${ids}-note`}
                value={note}
                aria-describedby={`${ids}-note-hint`}
                onChange={(event) => setNote(event.target.value)}
              />
              <p id={`${ids}-note-hint`} className="text-xs text-muted-foreground">
                {t('oe.return.noteHint')}
              </p>
            </div>
            {quote.isError && quote.error instanceof ApiError ? (
              <p role="alert" className="text-sm text-destructive">
                {quote.error.message}
              </p>
            ) : null}
            {problem === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            <Button
              className="w-full"
              disabled={save.isPending || quote.data === undefined || quote.isFetching}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t('oe.edit.saving')
                : whole
                  ? t('oe.return.submitWhole')
                  : t('oe.return.submitPartial')}
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}
