import { lineAmountOf } from '@elysium/domain/inbox';
import { formatMoneyText } from '@elysium/i18n';
import {
  Button,
  Checkbox,
  Input,
  Label,
  Money,
  Select,
  StatusBadge,
  buttonVariants,
  cn,
  poishaToTaka,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckCircle2, ClipboardCopy, MessageSquareText, ShoppingCart, Trash2 } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

import '../../alive/alive.css';
import { ApiError } from '../../api.js';
import { useLocale } from '../../i18n/locale.js';
import { recordAdvance } from '../orders/advances-api.js';
import { checkPromo, createOrder, getOrder, listAreas } from '../orders/api.js';
import { ordersPath } from '../orders/paths.js';
import { addNote, INBOX_KEY, type ConversationItem } from './api.js';
import { fillComposer } from './composer-bridge.js';
import { districtsOf, thanasOf } from './logic.js';
import { useOwnerGuard } from './owner-guard.js';
import {
  ADVANCE_METHODS,
  advanceRefReads,
  emptyDraft,
  lineName,
  newPlaceKey,
  orderBody,
  placeCheck,
  placedSummary,
  promoBasket,
  removeLine,
  setLinePrice,
  setLineQty,
  summaryText,
  takaInput,
  typeCustomer,
  typedPhone,
  ORDER_CHANNEL_FOR,
  type AdvanceMethod,
  type MissingField,
  type PlacedOrder,
  type PromoState,
  type SellDraft,
} from './sell-logic.js';
import { useSellT } from './sell-messages.js';

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const messageOf = (cause: unknown) =>
  cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause);

export interface DraftOrderProps {
  readonly draft: SellDraft;
  readonly update: (change: (draft: SellDraft) => SellDraft) => void;
  readonly conversation: ConversationItem;
  readonly me: string | null;
  /** The product picker, shown under the items. */
  readonly picker: ReactNode;
}

/**
 * The draft order in the panel (M44b, D-773 to D-776): items with their size, colour, quantity
 * and price (each editable where it stands), the delivery name, phone and address, the delivery
 * charge (the zone's unless typed), a discount and a promo code as the order desk takes them, an
 * advance the customer says they paid, and the totals, moving on every key press. Place order
 * sends it through the order desk's own route (`POST /v1/orders`: its checks, its prices, its
 * discount ceiling), records the advance as a claim for accounts, and offers the summary to send.
 * Ctrl+Enter places it from anywhere in the draft.
 */
export function DraftOrder({ draft, update, conversation, me, picker }: DraftOrderProps) {
  const t = useSellT();
  const { locale } = useLocale();
  const ids = useId();
  const queryClient = useQueryClient();
  const { guard, dialog } = useOwnerGuard(conversation, me);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  const areas = useQuery({
    queryKey: ['orders', 'areas'],
    queryFn: listAreas,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const allAreas = areas.data?.areas ?? [];
  const districts = districtsOf(allAreas);
  const thanas = thanasOf(allAreas, draft.customer.districtId);
  const area = allAreas.find((entry) => entry.thanaId === draft.customer.thanaId) ?? null;
  const zone = areas.data?.zones.find((entry) => entry.id === area?.zoneId) ?? null;

  // The promo code's live check, as the desk makes it: a preview; the order prices it again.
  const code = useDebounced(draft.promoCode.trim(), 400);
  const deliveryPoisha =
    draft.deliveryTaka === null ? (zone?.chargePoisha ?? '0') : takaInput(draft.deliveryTaka);
  const discountPoisha = takaInput(draft.discountTaka);
  const basket = useMemo(() => promoBasket(draft), [draft]);
  const promoOn =
    code.length >= 3 &&
    draft.lines.length > 0 &&
    deliveryPoisha !== null &&
    discountPoisha !== null;
  const promo = useQuery({
    queryKey: [
      'orders',
      'promo',
      code,
      basket,
      deliveryPoisha,
      discountPoisha,
      ORDER_CHANNEL_FOR[conversation.channel],
    ],
    queryFn: () =>
      checkPromo({
        code,
        lines: basket,
        ...(discountPoisha !== null && discountPoisha !== '0'
          ? { orderDiscountPoisha: discountPoisha }
          : {}),
        deliveryChargePoisha: deliveryPoisha ?? '0',
        channel: ORDER_CHANNEL_FOR[conversation.channel],
      }),
    enabled: promoOn,
    retry: false,
    staleTime: 10_000,
  });
  const promoState: PromoState =
    draft.promoCode.trim() === ''
      ? { kind: 'none' }
      : !promoOn || draft.promoCode.trim() !== code || promo.isPending
        ? { kind: 'checking' }
        : promo.isError
          ? promo.error instanceof ApiError && promo.error.status === 404
            ? { kind: 'not_found' }
            : { kind: 'failed' }
          : promo.data.ok
            ? {
                kind: 'ok',
                discountPoisha: promo.data.discountPoisha,
                deliveryDiscountPoisha: promo.data.deliveryDiscountPoisha,
              }
            : { kind: 'refused', reason: promo.data.reason };

  const check = placeCheck(draft, zone?.chargePoisha ?? null, promoState);
  const totals = check.totals;

  const refresh = () => {
    const keys = [
      [...INBOX_KEY, 'panel', conversation.id],
      [...INBOX_KEY, 'thread', conversation.id],
      [...INBOX_KEY, 'list'],
    ];
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
    // The worker moves the contact to Customer when it hears the order; ask again shortly.
    window.setTimeout(() => {
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    }, 2_500);
  };

  const place = useMutation({
    mutationFn: async (acknowledged: boolean): Promise<PlacedOrder> => {
      const body = orderBody(draft, check, {
        channel: conversation.channel,
        me,
        promoApplies: promoState.kind === 'ok',
      });
      if (body === null || totals === null) {
        throw new Error(t('inbox.sell.missing', { fields: '' }));
      }
      // The draft's own key: a retry after a lost answer is this order again, not a second.
      const created = await createOrder(body, { 'Idempotency-Key': draft.placeKey });

      // A dated note in the chat's panel. On someone else's conversation it carries the
      // acknowledgement the person just gave, so the owner is told and the audit names them
      // (D-737, D-774). A note that fails does not undo the order.
      await addNote(
        conversation.id,
        t('inbox.sell.note', { orderNo: created.orderNo }),
        acknowledged,
      ).catch(() => undefined);

      let advanceError: string | null = null;
      if (draft.advance !== null && check.advancePoisha !== null && check.advancePoisha !== '0') {
        try {
          await recordAdvance(created.id, {
            method: draft.advance.method,
            transactionRef: draft.advance.transactionRef.trim(),
            amountPoisha: check.advancePoisha,
          });
        } catch (cause) {
          advanceError = messageOf(cause);
        }
      }

      // What the summary states: the draft's figures, or the saved order's when its total is
      // not the draft's (the ledger audit's W2), so the customer reads what the rider asks.
      const total = BigInt(created.codAmountPoisha);
      let lines = draft.lines.map((line, index) => ({
        item: lineName(line),
        qty: line.qty,
        totalPoisha: (totals.lineTotals[index] ?? 0n).toString(),
      }));
      let discount: bigint = totals.discountPoisha;
      let delivery: bigint = totals.deliveryPoisha;
      const repriced = total !== totals.totalPoisha;
      if (repriced) {
        try {
          const saved = await getOrder(created.id);
          const names = new Map(draft.lines.map((line) => [line.skuId, lineName(line)]));
          lines = saved.lines.map((line) => ({
            item: names.get(line.skuId) ?? line.productName,
            qty: line.qty,
            totalPoisha: (
              BigInt(lineAmountOf(line.unitPricePoisha, line.qty) ?? '0') -
              BigInt(line.discountPoisha)
            ).toString(),
          }));
          discount = BigInt(saved.amounts.discountPoisha);
          delivery = BigInt(saved.amounts.deliveryChargePoisha);
        } catch {
          // The order's total still leads the summary; its lines stay the draft's.
        }
      }
      const wanted: bigint = totals.advancePoisha;
      const build = (withAdvance: boolean) => {
        const advance = !withAdvance ? 0n : wanted > total ? total : wanted;
        return summaryText(
          (key, values) => t(key, values),
          (amount) => formatMoneyText(amount),
          {
            orderNo: created.orderNo,
            name: draft.customer.name,
            lines,
            totals: {
              discountPoisha: discount,
              deliveryPoisha: delivery,
              totalPoisha: total,
              advancePoisha: advance,
              toCollectPoisha: total - advance,
            },
            address: [
              draft.customer.addressLine.trim(),
              draft.customer.area.trim(),
              area?.thanaEn ?? '',
              area?.districtEn ?? '',
            ]
              .filter((part) => part !== '')
              .join(', '),
            phone: typedPhone(draft.customer.phone) ?? draft.customer.phone,
          },
        );
      };
      return {
        orderId: created.id,
        orderNo: created.orderNo,
        summary: build(true),
        summaryWithoutAdvance: build(false),
        advanceError,
        repriced,
      };
    },
    onSuccess: (placed) => {
      setError(null);
      update((current) => ({ ...current, placed }));
      refresh();
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.code === 'IDEMPOTENCY_CONFLICT') {
        // This key already placed an order with other contents: say so, and let a deliberate
        // second press place a new one.
        setError(t('inbox.sell.alreadyPlaced'));
        update((current) => ({ ...current, placeKey: newPlaceKey() }));
        return;
      }
      setError(t('inbox.sell.failed', { reason: messageOf(cause) }));
    },
  });

  const submit = () => {
    setAttempted(true);
    if (!check.ready || place.isPending || draft.placed !== null) return;
    setError(null);
    // On a conversation someone else has, ask first, as every write from the panel does.
    void guard(async (acknowledged) => {
      await place.mutateAsync(acknowledged);
    }).catch(() => undefined);
  };

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  if (draft.placed !== null) {
    return (
      <>
        <Placed
          draft={draft}
          conversationId={conversation.id}
          onRetryAdvance={async () => {
            const placed = draft.placed;
            if (placed === null || draft.advance === null || check.advancePoisha === null) return;
            try {
              await recordAdvance(placed.orderId, {
                method: draft.advance.method,
                transactionRef: draft.advance.transactionRef.trim(),
                amountPoisha: check.advancePoisha,
              });
              update((current) =>
                current.placed === null
                  ? current
                  : { ...current, placed: { ...current.placed, advanceError: null } },
              );
            } catch (cause) {
              const reason = messageOf(cause);
              update((current) =>
                current.placed === null
                  ? current
                  : { ...current, placed: { ...current.placed, advanceError: reason } },
              );
            }
          }}
          onNew={() =>
            update((current) => ({
              ...emptyDraft(current.conversationId),
              hintsSeenAt: current.hintsSeenAt,
            }))
          }
          notice={notice}
          setNotice={setNotice}
        />
        {dialog}
      </>
    );
  }

  const missingWords = check.missing.map((field: MissingField) => t(`inbox.sell.field.${field}`));
  const showMissing = attempted || draft.lines.length > 0;

  return (
    <div className="space-y-3" onKeyDown={onKey}>
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground uppercase">
          {t('inbox.sell.draft.title')}
        </h3>
        {draft.lines.length === 0 && draft.typed.length === 0 ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              update((current) => ({
                ...emptyDraft(current.conversationId),
                hintsSeenAt: current.hintsSeenAt,
              }))
            }
          >
            {t('inbox.sell.draft.clear')}
          </Button>
        )}
      </div>

      {draft.lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inbox.sell.draft.empty')}</p>
      ) : (
        <ul className="space-y-2" aria-label={t('inbox.sell.draft.items')}>
          {draft.lines.map((line, index) => {
            const name = lineName(line);
            return (
              <li
                key={line.skuId}
                className="alive-in space-y-1.5 rounded-md border border-border p-2"
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{line.productName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[line.label, line.code].filter((part) => part !== '').join(' · ')}
                    </p>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t('inbox.sell.draft.remove', { name })}
                    onClick={() => update((current) => removeLine(current, line.skuId))}
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={999}
                    value={line.qty}
                    aria-label={t('inbox.sell.draft.qty', { name })}
                    onChange={(event) => {
                      const qty = Number(event.target.value);
                      if (event.target.value !== '' && Number.isFinite(qty)) {
                        update((current) => setLineQty(current, line.skuId, qty));
                      }
                    }}
                    className="h-8 w-16 rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  />
                  <span aria-hidden className="text-xs text-muted-foreground">
                    ×
                  </span>
                  <PriceInput
                    pricePoisha={line.unitPricePoisha}
                    label={t('inbox.sell.draft.unitPrice', { name })}
                    onPrice={(poisha) =>
                      update((current) => setLinePrice(current, line.skuId, poisha))
                    }
                  />
                  <span className="ml-auto text-sm font-medium">
                    <Money poisha={(totals?.lineTotals[index] ?? 0n).toString()} locale={locale} />
                  </span>
                </div>
                {line.available !== null && line.available < line.qty ? (
                  <StatusBadge tone="warning">
                    {t('inbox.sell.draft.stockShort', { n: String(Math.max(line.available, 0)) })}
                  </StatusBadge>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {picker}

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground uppercase">
          {t('inbox.sell.draft.customer')}
        </legend>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-name`}>{t('inbox.sell.draft.name')}</Label>
            <Input
              id={`${ids}-name`}
              value={draft.customer.name}
              maxLength={200}
              autoComplete="off"
              onChange={(event) =>
                update((current) => typeCustomer(current, 'name', event.target.value))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-phone`}>{t('inbox.sell.draft.phone')}</Label>
            <Input
              id={`${ids}-phone`}
              value={draft.customer.phone}
              inputMode="tel"
              maxLength={20}
              autoComplete="off"
              aria-invalid={
                draft.customer.phone !== '' && typedPhone(draft.customer.phone) === null
              }
              aria-describedby={`${ids}-phone-hint`}
              onChange={(event) =>
                update((current) => typeCustomer(current, 'phone', event.target.value))
              }
            />
          </div>
        </div>
        {draft.customer.phone !== '' && typedPhone(draft.customer.phone) === null ? (
          <p id={`${ids}-phone-hint`} className="text-xs text-destructive-text">
            {t('inbox.sell.draft.phoneInvalid')}
          </p>
        ) : (
          <span id={`${ids}-phone-hint`} hidden />
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-district`}>{t('inbox.sell.draft.district')}</Label>
            <Select
              id={`${ids}-district`}
              size="sm"
              value={draft.customer.districtId === null ? '' : String(draft.customer.districtId)}
              placeholder={t('inbox.sell.draft.choose')}
              disabled={areas.isPending}
              onValueChange={(value) =>
                update((current) =>
                  typeCustomer(
                    typeCustomer(current, 'districtId', value === '' ? null : Number(value)),
                    'thanaId',
                    null,
                  ),
                )
              }
              options={districts.map((entry) => ({ value: String(entry.id), label: entry.name }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-thana`}>{t('inbox.sell.draft.thana')}</Label>
            <Select
              id={`${ids}-thana`}
              size="sm"
              value={draft.customer.thanaId === null ? '' : String(draft.customer.thanaId)}
              placeholder={t('inbox.sell.draft.choose')}
              disabled={draft.customer.districtId === null}
              onValueChange={(value) =>
                update((current) =>
                  typeCustomer(current, 'thanaId', value === '' ? null : Number(value)),
                )
              }
              options={thanas.map((entry) => ({ value: String(entry.id), label: entry.name }))}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-line`}>{t('inbox.sell.draft.addressLine')}</Label>
          <Input
            id={`${ids}-line`}
            value={draft.customer.addressLine}
            maxLength={500}
            autoComplete="off"
            onChange={(event) =>
              update((current) => typeCustomer(current, 'addressLine', event.target.value))
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-area`}>{t('inbox.sell.draft.area')}</Label>
          <Input
            id={`${ids}-area`}
            value={draft.customer.area}
            maxLength={160}
            autoComplete="off"
            onChange={(event) =>
              update((current) => typeCustomer(current, 'area', event.target.value))
            }
          />
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground uppercase">
          {t('inbox.sell.draft.charges')}
        </legend>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-delivery`}>{t('inbox.sell.draft.delivery')}</Label>
            <Input
              id={`${ids}-delivery`}
              inputMode="decimal"
              value={draft.deliveryTaka ?? (zone === null ? '' : poishaToTaka(zone.chargePoisha))}
              aria-describedby={`${ids}-delivery-hint`}
              onChange={(event) =>
                update((current) => ({ ...current, deliveryTaka: event.target.value }))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-discount`}>{t('inbox.sell.draft.discount')}</Label>
            <Input
              id={`${ids}-discount`}
              inputMode="decimal"
              value={draft.discountTaka}
              placeholder="0"
              onChange={(event) =>
                update((current) => ({ ...current, discountTaka: event.target.value }))
              }
            />
          </div>
        </div>
        <p id={`${ids}-delivery-hint`} className="text-xs text-muted-foreground">
          {zone === null
            ? t('inbox.sell.draft.deliveryNoZone')
            : t('inbox.sell.draft.deliveryZone', { zone: zone.nameEn })}
        </p>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-promo`}>{t('inbox.sell.draft.promo')}</Label>
          <Input
            id={`${ids}-promo`}
            value={draft.promoCode}
            maxLength={40}
            autoComplete="off"
            aria-describedby={`${ids}-promo-state`}
            onChange={(event) =>
              update((current) => ({ ...current, promoCode: event.target.value }))
            }
          />
          <p
            id={`${ids}-promo-state`}
            className={cn(
              'text-xs',
              promoState.kind === 'ok'
                ? 'text-foreground'
                : promoState.kind === 'none' || promoState.kind === 'checking'
                  ? 'text-muted-foreground'
                  : 'text-destructive-text',
            )}
          >
            {promoState.kind === 'none'
              ? ''
              : promoState.kind === 'checking'
                ? t('inbox.sell.draft.promoChecking')
                : promoState.kind === 'ok'
                  ? t('inbox.sell.draft.promoOk')
                  : promoState.kind === 'not_found'
                    ? t('inbox.sell.draft.promoNotFound')
                    : promoState.kind === 'refused'
                      ? t('inbox.sell.draft.promoRefused', { reason: promoState.reason })
                      : t('inbox.sell.draft.promoFailed')}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.advance !== null}
            onCheckedChange={(checked) =>
              update((current) => ({
                ...current,
                advance:
                  checked === true
                    ? (current.advance ?? { method: 'bkash', transactionRef: '', amountTaka: '' })
                    : null,
              }))
            }
          />
          {t('inbox.sell.draft.advance')}
        </label>
        {draft.advance === null ? null : (
          <div className="space-y-2 rounded-md border border-border p-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label htmlFor={`${ids}-method`}>{t('inbox.sell.draft.advanceMethod')}</Label>
                <Select
                  id={`${ids}-method`}
                  size="sm"
                  value={draft.advance.method}
                  onValueChange={(value) =>
                    update((current) =>
                      current.advance === null
                        ? current
                        : {
                            ...current,
                            advance: { ...current.advance, method: value as AdvanceMethod },
                          },
                    )
                  }
                  options={ADVANCE_METHODS.map((method) => ({
                    value: method,
                    label: t(`inbox.sell.method.${method}`),
                  }))}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${ids}-advance`}>{t('inbox.sell.draft.advanceAmount')}</Label>
                <Input
                  id={`${ids}-advance`}
                  inputMode="decimal"
                  value={draft.advance.amountTaka}
                  onChange={(event) =>
                    update((current) =>
                      current.advance === null
                        ? current
                        : {
                            ...current,
                            advance: { ...current.advance, amountTaka: event.target.value },
                          },
                    )
                  }
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${ids}-ref`}>{t('inbox.sell.draft.advanceRef')}</Label>
              <Input
                id={`${ids}-ref`}
                value={draft.advance.transactionRef}
                maxLength={30}
                autoComplete="off"
                aria-invalid={
                  draft.advance.transactionRef.trim() !== '' &&
                  !advanceRefReads(draft.advance.transactionRef)
                }
                aria-describedby={`${ids}-ref-hint`}
                onChange={(event) =>
                  update((current) =>
                    current.advance === null
                      ? current
                      : {
                          ...current,
                          advance: { ...current.advance, transactionRef: event.target.value },
                        },
                  )
                }
              />
            </div>
            <p
              id={`${ids}-ref-hint`}
              className={cn(
                'text-xs',
                draft.advance.transactionRef.trim() !== '' &&
                  !advanceRefReads(draft.advance.transactionRef)
                  ? 'text-destructive-text'
                  : 'text-muted-foreground',
              )}
            >
              {draft.advance.transactionRef.trim() !== '' &&
              !advanceRefReads(draft.advance.transactionRef)
                ? t('inbox.sell.draft.advanceRefInvalid')
                : t('inbox.sell.draft.advanceHint')}
            </p>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor={`${ids}-notes`}>{t('inbox.sell.draft.notes')}</Label>
          <Input
            id={`${ids}-notes`}
            value={draft.notes}
            maxLength={2000}
            autoComplete="off"
            onChange={(event) => update((current) => ({ ...current, notes: event.target.value }))}
          />
        </div>
      </fieldset>

      {totals === null ? null : (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-border pt-2 text-sm">
          <dt className="text-muted-foreground">{t('inbox.sell.totals.items')}</dt>
          <dd className="text-right">
            <Money poisha={totals.itemsPoisha.toString()} locale={locale} />
          </dd>
          {totals.discountPoisha > 0n ? (
            <>
              <dt className="text-muted-foreground">{t('inbox.sell.totals.discount')}</dt>
              <dd className="text-right">
                <Money poisha={(0n - totals.discountPoisha).toString()} locale={locale} />
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t('inbox.sell.totals.delivery')}</dt>
          <dd className="text-right">
            <Money poisha={totals.deliveryPoisha.toString()} locale={locale} />
          </dd>
          <dt className="font-medium">{t('inbox.sell.totals.total')}</dt>
          <dd className="text-right font-semibold">
            <Money poisha={totals.totalPoisha.toString()} locale={locale} />
          </dd>
          {totals.advancePoisha > 0n ? (
            <>
              <dt className="text-muted-foreground">{t('inbox.sell.totals.advance')}</dt>
              <dd className="text-right">
                <Money poisha={(0n - totals.advancePoisha).toString()} locale={locale} />
              </dd>
              <dt className="font-medium">{t('inbox.sell.totals.toCollect')}</dt>
              <dd className="text-right font-semibold">
                <Money poisha={totals.toCollectPoisha.toString()} locale={locale} />
              </dd>
            </>
          ) : null}
        </dl>
      )}

      {check.problems.length === 0 ? null : (
        <ul className="space-y-0.5 text-xs text-destructive-text" role="alert">
          {check.problems.map((problem) => (
            <li key={problem}>{t(`inbox.sell.problem.${problem}`)}</li>
          ))}
        </ul>
      )}
      {showMissing && check.missing.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('inbox.sell.missing', { fields: missingWords.join(', ') })}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      )}
      <Button
        className="w-full"
        onClick={submit}
        disabled={place.isPending}
        aria-disabled={!check.ready}
        aria-keyshortcuts="Control+Enter"
      >
        <ShoppingCart aria-hidden className="size-4" />
        {place.isPending ? t('inbox.sell.placing') : t('inbox.sell.place')}
      </Button>
      {dialog}
    </div>
  );
}

/**
 * A price typed in taka. Kept as text while it is typed (`10.` must stay `10.`), and passed on as
 * poisha whenever it reads as an amount.
 */
function PriceInput({
  pricePoisha,
  label,
  onPrice,
}: {
  readonly pricePoisha: string;
  readonly label: string;
  readonly onPrice: (poisha: string) => void;
}) {
  const [text, setText] = useState(() => poishaToTaka(pricePoisha));
  return (
    <input
      inputMode="decimal"
      value={text}
      aria-label={label}
      onChange={(event) => {
        setText(event.target.value);
        const poisha = takaInput(event.target.value);
        if (poisha !== null && event.target.value.trim() !== '') onPrice(poisha);
      }}
      onBlur={() => setText(poishaToTaka(pricePoisha))}
      className="h-8 w-24 rounded-md border border-input bg-background px-2 text-sm tabular-nums focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    />
  );
}

function Placed({
  draft,
  conversationId,
  onRetryAdvance,
  onNew,
  notice,
  setNotice,
}: {
  readonly draft: SellDraft;
  readonly conversationId: string;
  readonly onRetryAdvance: () => Promise<void>;
  readonly onNew: () => void;
  readonly notice: string | null;
  readonly setNotice: (notice: string | null) => void;
}) {
  const t = useSellT();
  const placed = draft.placed;
  const [retrying, setRetrying] = useState(false);
  if (placed === null) return null;

  const send = async () => {
    const text = placedSummary(placed);
    if (fillComposer(conversationId, text)) {
      setNotice(t('inbox.sell.summaryFilled'));
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNotice(t('inbox.sell.summaryCopied'));
    } catch {
      setNotice(text);
    }
  };

  return (
    <div className="alive-in space-y-3 rounded-lg border border-border p-3" role="status">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <CheckCircle2 aria-hidden className="size-4 text-success" />
        {t('inbox.sell.placed', { orderNo: placed.orderNo })}
      </p>
      <p className="text-xs text-muted-foreground">{t('inbox.sell.placedDetail')}</p>
      {placed.repriced ? (
        <p role="alert" className="text-xs text-warning-subtle-foreground">
          {t('inbox.sell.repriced')}
        </p>
      ) : null}
      {placed.advanceError === null ? null : (
        <div className="space-y-1">
          <p role="alert" className="text-xs text-destructive-text">
            {t('inbox.sell.advanceFailed', { reason: placed.advanceError })}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void onRetryAdvance().finally(() => setRetrying(false));
            }}
          >
            {t('inbox.sell.retryAdvance')}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void send()}>
          <MessageSquareText aria-hidden className="size-4" />
          {t('inbox.sell.sendSummary')}
        </Button>
        <Link
          to={ordersPath(`/orders/${placed.orderId}`)}
          className={buttonVariants({ size: 'sm', variant: 'outline' })}
        >
          {t('inbox.sell.openOrder')}
        </Link>
      </div>
      {notice === null ? null : (
        <p className="flex items-start gap-1.5 text-xs break-words whitespace-pre-wrap text-muted-foreground">
          <ClipboardCopy aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {notice}
        </p>
      )}
      <Button size="sm" variant="ghost" onClick={onNew}>
        {t('inbox.sell.newDraft')}
      </Button>
    </div>
  );
}
