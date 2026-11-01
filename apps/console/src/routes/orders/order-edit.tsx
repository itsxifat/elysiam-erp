import {
  Button,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Money,
  PermissionGate,
  Skeleton,
  poishaToTaka,
  takaToPoisha,
} from '@elysium/ui';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ArrowLeft, Minus, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/order-edit.js';
import '../../i18n/workflow.js';
import { useStaffNames } from '../../staff-names.js';
import { getOrder, type OrderDetail } from './api.js';
import { productsOfSkus, quoteEdit, replaceOrder, saveEdit } from './edit-api.js';
import { OffersPanel } from './offers-panel.js';
import {
  addRow,
  editLines,
  rowTotal,
  setRowQty,
  startingTerms,
  type EditRow,
} from './order-edit-logic.js';
import { OrderProductPicker } from './order-product-picker.js';
import { OwnerGuardProvider, useOwnerGuard } from './owner-guard.js';
import { OrderStatusBadge } from './parts.js';
import { ordersPath } from './paths.js';
import { ProductImage } from '../../ui/product-image.js';

const EDITABLE = new Set(['pending', 'confirmed', 'on_hold']);

/**
 * Edit an order (M50, D-921, D-922): `/orders/$orderId/edit`.
 *
 * The owner's words: "we need order edit option in the erp if any order comes we may edit the
 * order anytime, but if the order is packed once but not sent to courier it has to be cancelled
 * then create another one". So:
 *
 * - **Before packing** (pending, confirmed, on hold) the order is edited in place: items added,
 *   removed and changed, the delivery charge and the person's discount, with the offers side
 *   panel re-priced as they go. Saving re-reserves the stock and gives back and takes again the
 *   offers' uses, in one transaction.
 * - **Packed**, the same screen says so and its save cancels the order and creates the new one,
 *   confirmed, back in packing, in one transaction (`replace`).
 * - **With the courier or after**, the screen points at Return items.
 *
 * The totals are the server's (`POST /offers`), never worked out here. The screen takes every
 * scan (`data-scan-capture`): a barcode fills the product search wherever focus is.
 */
export function OrderEditPage() {
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
        ) : EDITABLE.has(order.data.status) || order.data.status === 'packed' ? (
          <Guarded order={order.data} />
        ) : (
          <EmptyState title={t('oe.edit.locked')} detail={t('oe.edit.lockedDetail')} />
        )}
      </div>
    </PermissionGate>
  );
}

export function BackLink({ orderId }: { readonly orderId: string }) {
  const t = useT();
  return (
    <Link
      to={ordersPath(`/orders/${orderId}`)}
      className="-mb-2 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t('oe.edit.back')}
    </Link>
  );
}

/** The owner's "go ahead?" (M41) around the save, as on the order page. */
export function OwnerGuarded({
  order,
  children,
}: {
  readonly order: OrderDetail;
  readonly children: React.ReactNode;
}) {
  const t = useT();
  const staff = useStaffNames([order.assignedTo]);
  const ownerName = order.assignedTo === null ? '' : (staff(order.assignedTo) ?? t('wf.someone'));
  return (
    <OwnerGuardProvider order={order} ownerName={ownerName}>
      {children}
    </OwnerGuardProvider>
  );
}

function Guarded({ order }: { readonly order: OrderDetail }) {
  return (
    <OwnerGuarded order={order}>
      <Editor order={order} />
    </OwnerGuarded>
  );
}

function Editor({ order }: { readonly order: OrderDetail }) {
  const t = useT();
  const { locale } = useLocale();
  const ids = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { guard } = useOwnerGuard();
  const replacing = order.status === 'packed';

  const start = useMemo(() => startingTerms(order), [order]);
  const [rows, setRows] = useState<EditRow[]>(() =>
    order.lines.map((line) => ({
      skuId: line.skuId,
      skuCode: line.skuCode,
      name: line.productName,
      variantLabel: '',
      imageFileId: null,
      qty: line.qty,
      unitPricePoisha: line.unitPricePoisha,
      lineDiscountPoisha: line.discountPoisha,
      originalQty: line.qty,
      available: null,
    })),
  );
  const [fee, setFee] = useState(() => poishaToTaka(start.baseDeliveryPoisha.toString()));
  const [discount, setDiscount] = useState(() =>
    start.typedDiscountPoisha === 0n ? '' : poishaToTaka(start.typedDiscountPoisha.toString()),
  );
  const [selected, setSelected] = useState<string[]>(start.offerIds);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The photos and size names of the lines the order already had.
  const known = useQuery({
    queryKey: ['orders', 'picker', 'skus', order.lines.map((line) => line.skuId).join(',')],
    queryFn: () =>
      productsOfSkus(
        order.lines.map((line) => line.skuId),
        order.locationId,
      ),
    enabled: order.lines.length > 0,
    staleTime: 60_000,
  });
  /** A line's photo and size name: its own (added here), else what the catalogue says. */
  const lookOf = (row: EditRow) => {
    if (row.imageFileId !== null || row.variantLabel !== '') return row;
    const product = known.data?.items.find((entry) =>
      entry.variants.some((variant) => variant.skuId === row.skuId),
    );
    const variant = product?.variants.find((entry) => entry.skuId === row.skuId);
    return {
      imageFileId: product?.imageFileId ?? null,
      variantLabel: variant?.label ?? '',
    };
  };

  const feePoisha = takaToPoisha(fee.trim() === '' ? '0' : fee);
  const discountPoisha = takaToPoisha(discount.trim() === '' ? '0' : discount);
  const amountsOk =
    feePoisha !== null &&
    discountPoisha !== null &&
    !feePoisha.startsWith('-') &&
    !discountPoisha.startsWith('-');
  const lines = editLines(rows);
  const body =
    amountsOk && lines.length > 0
      ? {
          lines,
          discountPoisha: discountPoisha,
          deliveryChargePoisha: feePoisha,
          discountIds: selected,
        }
      : null;
  const settledBody = useSettled(body === null ? null : JSON.stringify(body), 300);

  const quote = useQuery({
    queryKey: ['orders', 'edit-quote', order.id, settledBody],
    queryFn: () => quoteEdit(order.id, JSON.parse(settledBody ?? '{}') as NonNullable<typeof body>),
    enabled: settledBody !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });

  const save = useMutation({
    mutationFn: async (ack: boolean) => {
      if (body === null) throw new Error(t('oe.edit.needLine'));
      if (replacing) {
        return replaceOrder(order.id, { ...body, reason: reason.trim() }, ack);
      }
      return saveEdit(order.id, body, ack);
    },
    onSuccess: async (result) => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['courier'] });
      const next = replacing && 'orderNo' in result ? result.id : order.id;
      await navigate({ to: ordersPath(`/orders/${next}`) });
    },
    onError: (error) => setProblem(error instanceof ApiError ? error.message : t('oe.edit.failed')),
  });

  function submit() {
    setNotice(null);
    if (rows.length === 0) return setProblem(t('oe.edit.needLine'));
    if (!amountsOk) return setProblem(t('oe.edit.badAmount'));
    if (replacing && reason.trim().length < 3) return setProblem(t('oe.edit.needReason'));
    setProblem(null);
    guard((ack) => save.mutate(ack));
  }

  const onOrder = useMemo(() => new Set(rows.map((row) => row.skuId)), [rows]);
  const totals = quote.data?.totals;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-3 text-lg font-semibold tracking-tight">
          {(replacing ? t('oe.edit.replaceTitle') : t('oe.edit.title')).replace(
            '{no}',
            order.orderNo,
          )}
          <OrderStatusBadge status={order.status} />
        </h1>
        <p className="text-sm text-muted-foreground">{t('oe.edit.caption')}</p>
      </header>
      {replacing ? (
        <p role="note" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {t('oe.edit.packedNotice')}
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-base font-semibold tracking-tight">{t('oe.edit.items')}</h2>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('oe.edit.noLines')}</p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">{t('oe.edit.items')}</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-medium">{t('oe.edit.item')}</th>
                    <th className="pb-2 text-right font-medium">{t('oe.edit.price')}</th>
                    <th className="pb-2 text-right font-medium">{t('oe.edit.qty')}</th>
                    <th className="pb-2 text-right font-medium">{t('oe.edit.total')}</th>
                    <th className="pb-2">
                      <span className="sr-only">{t('oe.edit.remove').replace('{item}', '')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const look = lookOf(row);
                    const item = `${row.name} ${look.variantLabel}`.trim();
                    return (
                      <tr key={row.skuId} className="border-b border-border last:border-b-0">
                        <td className="py-2.5">
                          <span className="flex items-center gap-3">
                            <ProductImage skuId={row.skuId} alt={item} />
                            <span className="min-w-0">
                              <span className="block font-medium">{row.name}</span>
                              <span className="block text-xs text-muted-foreground tabular-nums">
                                {[look.variantLabel, row.skuCode]
                                  .filter((part) => part !== '')
                                  .join(' · ')}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="text-right">
                          <Money poisha={row.unitPricePoisha} locale={locale} />
                        </td>
                        <td className="text-right">
                          <span className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('oe.edit.decrease').replace('{item}', item)}
                              disabled={row.qty <= 1}
                              onClick={() =>
                                setRows((current) => setRowQty(current, row.skuId, row.qty - 1))
                              }
                            >
                              <Minus aria-hidden="true" />
                            </Button>
                            <Input
                              aria-label={`${t('oe.edit.qty')} ${item}`}
                              inputMode="numeric"
                              className="w-14 text-right tabular-nums"
                              value={String(row.qty)}
                              onChange={(event) => {
                                const next = Number.parseInt(event.target.value, 10);
                                if (Number.isFinite(next)) {
                                  setRows((current) => setRowQty(current, row.skuId, next));
                                }
                              }}
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('oe.edit.increase').replace('{item}', item)}
                              onClick={() =>
                                setRows((current) => setRowQty(current, row.skuId, row.qty + 1))
                              }
                            >
                              <Plus aria-hidden="true" />
                            </Button>
                          </span>
                        </td>
                        <td className="text-right">
                          <Money poisha={rowTotal(row).toString()} locale={locale} />
                        </td>
                        <td className="text-right">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('oe.edit.remove').replace('{item}', item)}
                            onClick={() =>
                              setRows((current) =>
                                current.filter((entry) => entry.skuId !== row.skuId),
                              )
                            }
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-base font-semibold tracking-tight">
              {t('oe.edit.addProducts')}
            </h2>
            {notice === null ? null : (
              <p role="status" className="mb-2 text-sm text-muted-foreground">
                {notice}
              </p>
            )}
            <OrderProductPicker
              locationId={order.locationId}
              onOrder={onOrder}
              onAdd={(product, variant) => {
                setRows((current) =>
                  addRow(current, {
                    skuId: variant.skuId,
                    skuCode: variant.code,
                    name: product.name,
                    variantLabel: variant.label,
                    imageFileId: product.imageFileId,
                    qty: 1,
                    unitPricePoisha: variant.pricePoisha,
                    lineDiscountPoisha: '0',
                    originalQty: null,
                    available: variant.available,
                  }),
                );
                setNotice(
                  t('oe.edit.added').replace('{item}', `${product.name} ${variant.label}`.trim()),
                );
              }}
            />
          </section>
        </div>

        <aside className="space-y-4">
          <OffersPanel
            offers={quote.data?.offers}
            applied={quote.data?.applied ?? []}
            selected={selected}
            onChange={setSelected}
            updating={quote.isFetching}
            failed={quote.isError}
          />

          <section className="space-y-4 rounded-lg border border-border bg-card p-5">
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
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-discount`}>{t('oe.edit.discount')}</Label>
              <Input
                id={`${ids}-discount`}
                inputMode="decimal"
                className="tabular-nums"
                value={discount}
                aria-describedby={`${ids}-discount-hint`}
                onChange={(event) => setDiscount(event.target.value)}
              />
              <p id={`${ids}-discount-hint`} className="text-xs text-muted-foreground">
                {t('oe.edit.discountHint')}
              </p>
            </div>
            {replacing ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-reason`}>{t('oe.edit.reason')}</Label>
                <Input
                  id={`${ids}-reason`}
                  value={reason}
                  aria-describedby={`${ids}-reason-hint`}
                  onChange={(event) => setReason(event.target.value)}
                />
                <p id={`${ids}-reason-hint`} className="text-xs text-muted-foreground">
                  {t('oe.edit.reasonHint')}
                </p>
              </div>
            ) : null}

            <dl
              className="space-y-1.5 border-t border-border pt-3 text-sm"
              aria-busy={quote.isFetching}
            >
              <Total label={t('oe.total.items')} poisha={totals?.itemsPoisha} />
              <Total label={t('oe.total.offers')} poisha={quote.data?.offerDiscountPoisha} minus />
              <Total label={t('oe.total.discount')} poisha={discountPoisha ?? undefined} minus />
              <Total label={t('oe.total.delivery')} poisha={totals?.deliveryChargePoisha} />
              {totals === undefined || totals.advancePaidPoisha === '0' ? null : (
                <Total label={t('oe.total.advance')} poisha={totals.advancePaidPoisha} minus />
              )}
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
                <dt className="font-medium">{t('oe.total.cod')}</dt>
                <dd className="text-xl font-semibold">
                  {totals === undefined ? (
                    '—'
                  ) : (
                    <Money poisha={totals.codAmountPoisha} locale={locale} />
                  )}
                </dd>
              </div>
            </dl>

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
            <Button className="w-full" disabled={save.isPending} onClick={submit}>
              {save.isPending
                ? t('oe.edit.saving')
                : replacing
                  ? t('oe.edit.replace')
                  : t('oe.edit.save')}
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function Total({
  label,
  poisha,
  minus = false,
}: {
  readonly label: string;
  readonly poisha: string | undefined;
  readonly minus?: boolean;
}) {
  const { locale } = useLocale();
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {poisha === undefined ? (
          '—'
        ) : (
          <>
            {minus && poisha !== '0' ? '−' : ''}
            <Money poisha={poisha} locale={locale} />
          </>
        )}
      </dd>
    </div>
  );
}

/** The value once it has stopped changing for `ms`. */
export function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
