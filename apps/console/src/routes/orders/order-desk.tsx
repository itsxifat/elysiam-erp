import {
  Button,
  buttonVariants,
  Input,
  Label,
  Money,
  PermissionGate,
  StatusBadge,
  cn,
  poishaToTaka,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, CheckCircle2, Keyboard, Trash2 } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { ApiError } from '../../api.js';
import { useAbility, useSession } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  availability,
  checkPromo,
  confirmOrder,
  createOrder,
  DESK_CHANNELS,
  findDuplicates,
  fraudCheck,
  listAreas,
  lookupCustomer,
  searchSkus,
  type Area,
  type OrderChannel,
} from './api.js';
import {
  addLine,
  deskPhone,
  filterAreas,
  previewWithPromo,
  promoLines,
  toAsciiDigits,
  type DeskLine,
} from './desk-logic.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import {
  FraudBadgeView,
  OrdersNav,
  OrderStatusBadge,
  ShortcutsHelp,
  type Shortcut,
} from './parts.js';
import { ordersPath } from './paths.js';

/**
 * The order desk (M11 Build list; acceptance check 1).
 *
 * An agent takes an order off a Facebook or WhatsApp chat in under thirty seconds, so the
 * screen is built for the keyboard first and the mouse second, and every design choice here
 * is about keystrokes:
 *
 * * **One form, in reading order.** Phone, name, area, address, items — Tab walks it; nothing
 *   needs the mouse, and the two pickers (area, SKU) are comboboxes that take arrow keys and
 *   Enter without leaving the field.
 * * **The phone is typed first because it answers the most.** As soon as it is a whole
 *   number the buyer, their saved address, their recent orders and M13's trust badge load in
 *   parallel; a returning buyer's name and address are filled in while the agent is still
 *   reading the chat, and never over something they already typed.
 * * **The area list is local.** Every thana and the zone that covers it arrive once, and the
 *   autocomplete filters in memory: a round trip per keystroke would be the slowest thing
 *   on the screen. The delivery charge follows the zone, as `create` will.
 * * **Ctrl+Enter saves and confirms** in one keystroke; Ctrl+S saves as pending. `?` lists
 *   every shortcut.
 *
 * The totals on the right are a preview in `bigint` (`previewTotals`). The saved order's
 * figures come from the server's `computeOrderTotals` and replace them.
 */

/** Where the typed promo code stands, as the field shows it. */
type PromoState =
  | { readonly kind: 'none' }
  | { readonly kind: 'checking' }
  | {
      readonly kind: 'ok';
      readonly discountPoisha: string;
      readonly deliveryDiscountPoisha: string;
    }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'failed' };

/** The domain's reasons, each with words; an unknown one falls back to "cannot apply". */
const PROMO_REASONS: Readonly<Record<string, OrdersMessageKey>> = {
  inactive: 'orders.desk.promoReason.inactive',
  not_yet_valid: 'orders.desk.promoReason.not_yet_valid',
  expired: 'orders.desk.promoReason.expired',
  personal_code: 'orders.desk.promoReason.personal_code',
  wrong_channel: 'orders.desk.promoReason.wrong_channel',
  limit_reached: 'orders.desk.promoReason.limit_reached',
  customer_limit_reached: 'orders.desk.promoReason.customer_limit_reached',
  min_order_not_met: 'orders.desk.promoReason.min_order_not_met',
  out_of_scope: 'orders.desk.promoReason.out_of_scope',
  nothing_to_discount: 'orders.desk.promoReason.nothing_to_discount',
};

interface Outcome {
  readonly kind: 'confirmed' | 'saved' | 'saved_not_confirmed' | 'failed';
  readonly orderId?: string;
  readonly orderNo?: string;
  readonly message?: string;
}

function messageOf(error: unknown): string {
  return error instanceof ApiError || error instanceof Error ? error.message : String(error);
}

/** Debounced value, so a SKU search waits for the agent to pause rather than firing per key. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function OrderDeskPage() {
  const ability = useAbility();
  const t = useOrdersT();
  const mayCreate = ability.can('create', 'Order');

  return (
    <PermissionGate
      allowed={mayCreate}
      explain={{ title: t('orders.deniedTitle'), detail: t('orders.deniedDetail') }}
    >
      <Desk />
    </PermissionGate>
  );
}

function Desk() {
  const t = useOrdersT();
  const { locale } = useLocale();
  const session = useSession();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayConfirm = ability.can('update', 'Order');
  const ids = useId();

  // --- the form -------------------------------------------------------------------
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [areaQuery, setAreaQuery] = useState('');
  const [area, setArea] = useState<Area | null>(null);
  const [areaOpen, setAreaOpen] = useState(false);
  const [areaActive, setAreaActive] = useState(0);
  const [addressLine, setAddressLine] = useState('');
  const [areaDetail, setAreaDetail] = useState('');
  const [skuQuery, setSkuQuery] = useState('');
  const [skuActive, setSkuActive] = useState(0);
  const [lines, setLines] = useState<DeskLine[]>([]);
  const [channel, setChannel] = useState<OrderChannel>('facebook');
  const [discountTaka, setDiscountTaka] = useState('');
  /**
   * The promo code as typed, and the same word once typing has paused. The live check
   * keys on the settled word, so it asks the server once per pause rather than once per
   * keystroke.
   */
  const [promoCode, setPromoCode] = useState('');
  const [settledPromo, setSettledPromo] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledPromo(promoCode.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [promoCode]);
  const [deliveryTaka, setDeliveryTaka] = useState('');
  const [deliveryTouched, setDeliveryTouched] = useState(false);
  const [notes, setNotes] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempted, setAttempted] = useState(false);

  const phoneRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLInputElement>(null);
  const skuRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);

  const normalized = deskPhone(phone);

  // --- what the phone answers --------------------------------------------------------
  const areas = useQuery({
    queryKey: ['orders', 'areas'],
    queryFn: listAreas,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const lookup = useQuery({
    queryKey: ['orders', 'lookup', normalized],
    queryFn: () => lookupCustomer(normalized ?? ''),
    enabled: normalized !== null,
    staleTime: 60_000,
  });

  const fraud = useQuery({
    queryKey: ['orders', 'fraud', normalized],
    queryFn: () => fraudCheck(normalized ?? ''),
    enabled: normalized !== null && ability.can('read', 'FraudSignal'),
    retry: false,
    staleTime: 60_000,
  });

  const customer = lookup.data?.customer ?? null;

  /*
   * A returning buyer fills the form — but only the fields the agent has not typed in.
   *
   * Run from the phone field's change handler rather than from an effect watching the
   * lookup: the lookup and the prefill are one event ("this number became whole"), and an
   * effect that copied query data into form state would re-run on every render that touched
   * either. Every write is a functional update that keeps a value the agent already typed —
   * overwriting a name they just corrected, because the lookup came back a moment later, is
   * the kind of helpfulness that makes people stop trusting a form.
   */
  const latestPhone = useRef<string | null>(null);
  function prefillFor(whole: string) {
    latestPhone.current = whole;
    void Promise.all([
      queryClient.fetchQuery({
        queryKey: ['orders', 'lookup', whole],
        queryFn: () => lookupCustomer(whole),
        staleTime: 60_000,
      }),
      queryClient.ensureQueryData({ queryKey: ['orders', 'areas'], queryFn: listAreas }),
    ])
      .then(([found, reference]) => {
        const buyer = found.customer;
        // The agent typed on while this was in flight: a different number, a different buyer.
        if (buyer === null || latestPhone.current !== whole) return;
        setName((current) => (current === '' ? buyer.name : current));
        const preferred = buyer.addresses.find((entry) => entry.isDefault) ?? buyer.addresses[0];
        if (preferred === undefined) return;
        const matched = reference.areas.find((entry) => entry.thanaId === preferred.thanaId);
        if (matched !== undefined) {
          setArea((current) => current ?? matched);
          setAreaQuery((current) => (current === '' ? areaLabel(matched, locale) : current));
        }
        setAddressLine((current) => (current === '' ? preferred.addressLine : current));
        setAreaDetail((current) => (current === '' ? (preferred.area ?? '') : current));
      })
      // A failed lookup leaves a blank form, which is what a new buyer gets anyway; the
      // query below renders the error state for the buyer panel.
      .catch(() => undefined);
  }

  // --- the area combobox -------------------------------------------------------------
  const areaMatches = useMemo(
    () =>
      area !== null && areaQuery === areaLabel(area, locale)
        ? []
        : filterAreas(areas.data?.areas ?? [], areaQuery),
    [areas.data, areaQuery, area, locale],
  );
  const zone = useMemo(
    () => areas.data?.zones.find((entry) => entry.id === area?.zoneId) ?? null,
    [areas.data, area],
  );

  // The zone's charge, until the agent types their own: derived, not copied into state, so
  // picking another area moves it without an effect chasing the zone.
  const deliveryShown = deliveryTouched
    ? deliveryTaka
    : zone === null
      ? ''
      : poishaToTaka(zone.chargePoisha);

  function pickArea(chosen: Area) {
    setArea(chosen);
    setAreaQuery(areaLabel(chosen, locale));
    setAreaOpen(false);
  }

  function onAreaKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setAreaOpen(true);
      setAreaActive((index) => Math.min(index + 1, Math.max(areaMatches.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setAreaActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && areaOpen && areaMatches.length > 0) {
      event.preventDefault();
      const chosen = areaMatches[areaActive] ?? areaMatches[0];
      if (chosen !== undefined) pickArea(chosen);
    } else if (event.key === 'Escape') {
      setAreaOpen(false);
    }
  }

  // --- the SKU combobox ---------------------------------------------------------------
  const skuTerm = useDebounced(skuQuery.trim().toUpperCase(), 150);
  const skus = useQuery({
    queryKey: ['orders', 'sku-search', skuTerm],
    queryFn: () => searchSkus(skuTerm),
    enabled: skuTerm.length >= 3,
    staleTime: 30_000,
  });
  const hits = useMemo(
    () =>
      skuQuery.trim().length >= 3
        ? (skus.data?.items ?? []).filter((hit) => hit.status === 'active')
        : [],
    [skus.data, skuQuery],
  );
  const hitIds = useMemo(() => hits.map((hit) => hit.skuId), [hits]);
  const lineIds = useMemo(() => lines.map((line) => line.skuId), [lines]);
  const stockIds = useMemo(() => [...new Set([...hitIds, ...lineIds])].sort(), [hitIds, lineIds]);

  // Live availability for what is on screen: the hits being chosen from and the lines taken.
  const stock = useQuery({
    queryKey: ['orders', 'availability', stockIds],
    queryFn: () => availability(stockIds),
    enabled: stockIds.length > 0 && ability.can('read', 'Stock'),
    staleTime: 5_000,
  });
  const availableOf = (skuId: string): number | null =>
    stock.data?.items.find((item) => item.skuId === skuId)?.availableQty ?? null;

  function addHit(index: number) {
    const hit = hits[index] ?? hits[0];
    if (hit === undefined) return;
    setLines((current) =>
      addLine(current, {
        skuId: hit.skuId,
        skuCode: hit.skuCode,
        name: hit.name,
        qty: 1,
        unitPricePoisha: String(hit.pricePoisha),
        availableQty: availableOf(hit.skuId),
      }),
    );
    setSkuQuery('');
    setSkuActive(0);
  }

  function onSkuKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSkuActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSkuActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && hits.length > 0) {
      event.preventDefault();
      addHit(skuActive);
    } else if (event.key === 'Escape') {
      setSkuQuery('');
    }
  }

  // --- duplicates, totals ---------------------------------------------------------------
  const duplicates = useQuery({
    queryKey: ['orders', 'duplicates', normalized, lineIds],
    queryFn: () => findDuplicates(normalized ?? '', lineIds),
    enabled: normalized !== null && lineIds.length > 0,
    staleTime: 15_000,
  });

  const discountPoisha = discountTaka.trim() === '' ? '0' : takaToPoisha(discountTaka);
  const deliveryPoisha = deliveryShown.trim() === '' ? '0' : takaToPoisha(deliveryShown);

  /*
   * The code's live check (M16 check 5). A preview only: the order's own transaction
   * prices the word again from the lines the server priced and redeems it there (D-204),
   * so nothing the desk computes here is ever sent as an amount — only the word is.
   */
  const promoBasket = promoLines(lines);
  const promoActive =
    settledPromo.length >= 3 &&
    lines.length > 0 &&
    deliveryPoisha !== null &&
    discountPoisha !== null;
  const promo = useQuery({
    queryKey: [
      'orders',
      'promo',
      settledPromo,
      promoBasket,
      deliveryPoisha,
      discountPoisha,
      channel,
      customer?.id ?? null,
    ],
    queryFn: () =>
      checkPromo({
        code: settledPromo,
        lines: promoBasket,
        // The server prices the code on what is left after the agent's own discount, the
        // same way the order's transaction will (W3), so the preview and the save agree.
        ...(discountPoisha !== null && discountPoisha !== '0'
          ? { orderDiscountPoisha: discountPoisha }
          : {}),
        deliveryChargePoisha: deliveryPoisha ?? '0',
        channel,
        ...(customer === null ? {} : { customerId: customer.id }),
      }),
    enabled: promoActive,
    retry: false,
    staleTime: 10_000,
  });
  const promoState: PromoState =
    promoCode.trim() === ''
      ? { kind: 'none' }
      : !promoActive || promoCode.trim() !== settledPromo || promo.isPending
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

  const totals = previewWithPromo({
    lines,
    discountPoisha,
    deliveryPoisha,
    promo: promoState.kind === 'ok' ? promoState : null,
  });
  const moneyInvalid = discountPoisha === null || deliveryPoisha === null || totals.invalid;

  const ready =
    normalized !== null &&
    name.trim() !== '' &&
    area !== null &&
    addressLine.trim().length >= 3 &&
    lines.length > 0 &&
    !moneyInvalid &&
    // A code that does not apply would make the server refuse the whole order, so the
    // desk holds the save until the agent removes it or fixes the basket.
    (promoState.kind === 'none' || promoState.kind === 'ok');

  // --- saving ------------------------------------------------------------------------------
  const save = useMutation({
    mutationFn: async (confirm: boolean): Promise<Outcome> => {
      if (area === null || normalized === null) throw new Error(t('orders.desk.missing'));
      const created = await createOrder({
        channel,
        customer: { phone: normalized, name: name.trim() },
        shipTo: {
          name: name.trim(),
          districtId: area.districtId,
          thanaId: area.thanaId,
          ...(areaDetail.trim() === '' ? {} : { area: areaDetail.trim() }),
          addressLine: addressLine.trim(),
        },
        lines: lines.map((line) => ({ skuId: line.skuId, qty: line.qty })),
        ...(deliveryTouched && deliveryPoisha !== null
          ? { deliveryChargePoisha: deliveryPoisha }
          : {}),
        ...(discountPoisha !== null && discountPoisha !== '0' ? { discountPoisha } : {}),
        ...(promoState.kind === 'ok' ? { promoCode: settledPromo } : {}),
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
        // The agent who takes the order owns it: it is theirs to confirm, pack-check and
        // chase, and leaving it unassigned would drop it into every colleague's queue.
        ...(session.context === null ? {} : { assignedTo: session.context.userId }),
      });
      if (!confirm) return { kind: 'saved', orderId: created.id, orderNo: created.orderNo };
      try {
        await confirmOrder(created.id);
        return { kind: 'confirmed', orderId: created.id, orderNo: created.orderNo };
      } catch (error) {
        // Saved but not confirmed — a blocked buyer, a size that just sold out. The order
        // exists and is pending, which the agent must be told in so many words.
        return {
          kind: 'saved_not_confirmed',
          orderId: created.id,
          orderNo: created.orderNo,
          message: messageOf(error),
        };
      }
    },
    onSuccess: (result) => {
      setOutcome(result);
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => setOutcome({ kind: 'failed', message: messageOf(error) }),
  });

  function submit(confirm: boolean) {
    setAttempted(true);
    if (save.isPending || outcome !== null) return;
    if (!ready) return;
    save.mutate(confirm && mayConfirm);
  }

  function reset() {
    setPhone('');
    setName('');
    setAreaQuery('');
    setArea(null);
    setAddressLine('');
    setAreaDetail('');
    setSkuQuery('');
    setLines([]);
    setDiscountTaka('');
    setDeliveryTaka('');
    setDeliveryTouched(false);
    setNotes('');
    setOutcome(null);
    setAttempted(false);
    save.reset();
    phoneRef.current?.focus();
  }

  // --- the keyboard ---------------------------------------------------------------------
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      const mod = event.ctrlKey || event.metaKey;
      const target = event.target as HTMLElement | null;
      const typing =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT');

      if (mod && event.key === 'Enter') {
        event.preventDefault();
        submitRef.current(true);
      } else if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault();
        submitRef.current(false);
      } else if ((mod && event.key === '/') || (!typing && event.key === '?')) {
        event.preventDefault();
        setHelpOpen(true);
      } else if (event.altKey && !mod) {
        const target = { p: phoneRef, a: areaRef, k: skuRef, n: notesRef }[event.key.toLowerCase()];
        if (target !== undefined) {
          event.preventDefault();
          target.current?.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // After a save, focus the one next action, so Enter takes the next order.
  useEffect(() => {
    if (outcome !== null && outcome.kind !== 'failed') nextRef.current?.focus();
  }, [outcome]);

  const shortcuts: Shortcut[] = [
    { keys: ['Ctrl', 'Enter'], label: t('orders.keys.confirm') },
    { keys: ['Ctrl', 'S'], label: t('orders.keys.save') },
    { keys: ['Alt', 'P'], label: t('orders.keys.phone') },
    { keys: ['Alt', 'A'], label: t('orders.keys.area') },
    { keys: ['Alt', 'K'], label: t('orders.keys.sku') },
    { keys: ['Alt', 'N'], label: t('orders.keys.notes') },
    { keys: ['↑', '↓', 'Enter'], label: t('orders.keys.pick') },
    { keys: ['↑', '↓'], label: t('orders.keys.qty') },
    { keys: ['?'], label: t('orders.keys.help') },
    { keys: ['Esc'], label: t('orders.keys.escape') },
  ];

  const phoneError = attempted && normalized === null;
  const duplicateItems = duplicates.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{t('orders.desk.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('orders.desk.subtitle')}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setHelpOpen(true)}>
          <Keyboard aria-hidden="true" />
          {t('orders.keys.open')}
        </Button>
      </header>

      <OrdersNav />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <form
          className="space-y-5"
          aria-label={t('orders.desk.title')}
          onSubmit={(event) => {
            event.preventDefault();
            submit(true);
          }}
        >
          {/* The buyer ---------------------------------------------------------------- */}
          <section className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-phone`} required>
                {t('orders.desk.phone')}
              </Label>
              <Input
                id={`${ids}-phone`}
                ref={phoneRef}
                // The desk opens on the phone because the phone answers the most.
                autoFocus
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={phone}
                onChange={(event) => {
                  const typed = toAsciiDigits(event.target.value);
                  setPhone(typed);
                  const whole = deskPhone(typed);
                  if (whole !== null && whole !== normalized) prefillFor(whole);
                }}
                aria-invalid={phoneError}
                aria-describedby={`${ids}-phone-hint`}
                className="tabular-nums"
              />
              <p id={`${ids}-phone-hint`} className="text-xs text-muted-foreground">
                {phoneError || (phone.length >= 11 && normalized === null)
                  ? t('orders.desk.phoneInvalid')
                  : t('orders.desk.phoneHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-name`} required>
                {t('orders.desk.name')}
              </Label>
              <Input
                id={`${ids}-name`}
                value={name}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                }}
                aria-invalid={attempted && name.trim() === ''}
              />
              {normalized === null ? null : (
                <p className="text-xs text-muted-foreground">
                  {lookup.isPending
                    ? t('orders.loading')
                    : customer === null
                      ? t('orders.desk.newBuyer')
                      : t('orders.desk.returningBuyer')}
                </p>
              )}
            </div>
          </section>

          {/* Where it goes ----------------------------------------------------------- */}
          <section className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
            <div className="relative space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${ids}-area`} required>
                {t('orders.desk.area')}
              </Label>
              <Input
                id={`${ids}-area`}
                ref={areaRef}
                role="combobox"
                aria-expanded={areaOpen && areaMatches.length > 0}
                aria-controls={`${ids}-area-list`}
                aria-autocomplete="list"
                aria-activedescendant={
                  areaOpen && areaMatches.length > 0
                    ? `${ids}-area-${String(areaActive)}`
                    : undefined
                }
                aria-describedby={`${ids}-area-hint`}
                aria-invalid={attempted && area === null}
                autoComplete="off"
                value={areaQuery}
                onChange={(event) => {
                  setAreaQuery(event.target.value);
                  setArea(null);
                  setAreaOpen(true);
                  setAreaActive(0);
                }}
                onKeyDown={onAreaKey}
                onBlur={() => setAreaOpen(false)}
                onFocus={() => setAreaOpen(true)}
              />
              <p id={`${ids}-area-hint`} className="text-xs text-muted-foreground">
                {area === null
                  ? t('orders.desk.areaHint')
                  : zone === null
                    ? t('orders.desk.noZone')
                    : `${t('orders.desk.zone')}: ${locale === 'bn' ? zone.nameBn : zone.nameEn}`}
              </p>
              {areaOpen && areaQuery.trim() !== '' && area === null ? (
                <ul
                  id={`${ids}-area-list`}
                  role="listbox"
                  className="absolute top-full right-0 left-0 z-20 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-popover"
                >
                  {areaMatches.length === 0 ? (
                    <li className="px-2 py-1.5 text-muted-foreground">
                      {t('orders.desk.areaNone')}
                    </li>
                  ) : (
                    areaMatches.map((match, index) => (
                      <li
                        key={match.thanaId}
                        id={`${ids}-area-${String(index)}`}
                        role="option"
                        aria-selected={index === areaActive}
                        className={cn(
                          'flex cursor-pointer justify-between gap-3 rounded-sm px-2 py-1.5',
                          index === areaActive ? 'bg-accent text-accent-foreground' : '',
                        )}
                        // mousedown, not click: the input's blur would close the list first.
                        onMouseDown={(event) => {
                          event.preventDefault();
                          pickArea(match);
                        }}
                      >
                        <span>{areaLabel(match, locale)}</span>
                      </li>
                    ))
                  )}
                </ul>
              ) : null}
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${ids}-address`} required>
                {t('orders.desk.addressLine')}
              </Label>
              <Input
                id={`${ids}-address`}
                value={addressLine}
                autoComplete="off"
                onChange={(event) => {
                  setAddressLine(event.target.value);
                }}
                aria-invalid={attempted && addressLine.trim().length < 3}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${ids}-area-detail`}>{t('orders.desk.areaText')}</Label>
              <Input
                id={`${ids}-area-detail`}
                value={areaDetail}
                autoComplete="off"
                onChange={(event) => setAreaDetail(event.target.value)}
              />
            </div>
            {customer !== null && customer.addresses.length > 1 ? (
              <div className="space-y-1 sm:col-span-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('orders.desk.savedAddresses')}
                </p>
                <ul className="flex flex-wrap gap-1.5">
                  {customer.addresses.map((saved) => (
                    <li key={saved.id}>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`${t('orders.desk.useAddress')}: ${saved.addressLine}`}
                        onClick={() => {
                          const found = areas.data?.areas.find(
                            (entry) => entry.thanaId === saved.thanaId,
                          );
                          if (found !== undefined) pickArea(found);
                          setAddressLine(saved.addressLine);
                          setAreaDetail(saved.area ?? '');
                        }}
                      >
                        {saved.addressLine}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          {/* What they want ---------------------------------------------------------- */}
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <div className="relative space-y-1.5">
              <Label htmlFor={`${ids}-sku`}>{t('orders.desk.skuSearch')}</Label>
              <Input
                id={`${ids}-sku`}
                ref={skuRef}
                role="combobox"
                aria-expanded={hits.length > 0}
                aria-controls={`${ids}-sku-list`}
                aria-autocomplete="list"
                aria-activedescendant={
                  hits.length > 0 ? `${ids}-sku-${String(skuActive)}` : undefined
                }
                aria-describedby={`${ids}-sku-hint`}
                autoComplete="off"
                value={skuQuery}
                onChange={(event) => {
                  setSkuQuery(event.target.value);
                  setSkuActive(0);
                }}
                onKeyDown={onSkuKey}
              />
              <p id={`${ids}-sku-hint`} className="text-xs text-muted-foreground">
                {t('orders.desk.skuHint')}
              </p>
              {skuQuery.trim().length >= 3 ? (
                <ul
                  id={`${ids}-sku-list`}
                  role="listbox"
                  className="absolute top-[4.25rem] right-0 left-0 z-20 max-h-80 overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-popover"
                >
                  {hits.length === 0 ? (
                    <li className="px-2 py-1.5 text-muted-foreground">
                      {skus.isFetching ? t('orders.loading') : t('orders.desk.skuNone')}
                    </li>
                  ) : (
                    hits.map((hit, index) => {
                      const available = availableOf(hit.skuId);
                      return (
                        <li
                          key={hit.skuId}
                          id={`${ids}-sku-${String(index)}`}
                          role="option"
                          aria-selected={index === skuActive}
                          className={cn(
                            'flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5',
                            index === skuActive ? 'bg-accent text-accent-foreground' : '',
                          )}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            addHit(index);
                          }}
                        >
                          <span className="min-w-0">
                            <span className="block font-medium tabular-nums">{hit.skuCode}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {hit.name}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <Money poisha={String(hit.pricePoisha)} locale={locale} />
                            {available === null ? null : available > 0 ? (
                              <StatusBadge tone="success">
                                {available} {t('orders.desk.available')}
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="danger">{t('orders.desk.outOfStock')}</StatusBadge>
                            )}
                          </span>
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : null}
            </div>

            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground" aria-invalid={attempted}>
                {t('orders.desk.noItems')}
              </p>
            ) : (
              <table className="w-full text-sm">
                <caption className="sr-only">{t('orders.desk.items')}</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 font-medium">{t('orders.desk.items')}</th>
                    <th className="w-20 py-1.5 text-right font-medium">{t('orders.desk.qty')}</th>
                    <th className="py-1.5 text-right font-medium">{t('orders.desk.unitPrice')}</th>
                    <th className="py-1.5 text-right font-medium">{t('orders.desk.lineTotal')}</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    const available = availableOf(line.skuId) ?? line.availableQty;
                    return (
                      <tr key={line.skuId} className="h-row border-b border-border">
                        <td className="py-1.5">
                          <span className="block font-medium tabular-nums">{line.skuCode}</span>
                          <span className="block text-xs text-muted-foreground">
                            {line.name}
                            {available !== null && available < line.qty ? (
                              <>
                                {' · '}
                                <span className="text-destructive">
                                  {t('orders.desk.outOfStock')}
                                </span>
                              </>
                            ) : null}
                          </span>
                        </td>
                        <td className="py-1.5 text-right">
                          <Input
                            type="number"
                            min={1}
                            max={999}
                            aria-label={`${t('orders.desk.qty')} ${line.skuCode}`}
                            className="h-control-sm w-16 text-right tabular-nums"
                            value={line.qty}
                            onChange={(event) => {
                              const qty = Math.max(
                                1,
                                Math.min(999, Number(event.target.value) || 1),
                              );
                              setLines((current) =>
                                current.map((entry) =>
                                  entry.skuId === line.skuId ? { ...entry, qty } : entry,
                                ),
                              );
                            }}
                          />
                        </td>
                        <td className="py-1.5 text-right">
                          <Money poisha={line.unitPricePoisha} locale={locale} />
                        </td>
                        <td className="py-1.5 text-right">
                          <Money
                            poisha={(BigInt(line.unitPricePoisha) * BigInt(line.qty)).toString()}
                            locale={locale}
                          />
                        </td>
                        <td className="py-1.5 text-right">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${t('orders.desk.remove')} ${line.skuCode}`}
                            onClick={() =>
                              setLines((current) =>
                                current.filter((entry) => entry.skuId !== line.skuId),
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

          {/* How it came and anything else ---------------------------------------------- */}
          <section className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-channel`}>{t('orders.desk.channel')}</Label>
              <select
                id={`${ids}-channel`}
                value={channel}
                onChange={(event) => setChannel(event.target.value as OrderChannel)}
                className="h-control w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {DESK_CHANNELS.map((option) => (
                  <option key={option} value={option}>
                    {t(`orders.channel.${option}` as OrdersMessageKey)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-discount`}>{t('orders.desk.discount')}</Label>
              <Input
                id={`${ids}-discount`}
                inputMode="decimal"
                value={discountTaka}
                onChange={(event) => setDiscountTaka(event.target.value)}
                aria-invalid={discountPoisha === null || totals.invalid}
                className="text-right tabular-nums"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor={`${ids}-promo`}>{t('orders.desk.promoCode')}</Label>
              <div className="flex items-start gap-2">
                <Input
                  id={`${ids}-promo`}
                  value={promoCode}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setPromoCode(event.target.value.toUpperCase())}
                  aria-describedby={`${ids}-promo-status`}
                  aria-invalid={
                    promoState.kind === 'refused' ||
                    promoState.kind === 'not_found' ||
                    promoState.kind === 'failed'
                  }
                  className="max-w-xs font-mono uppercase"
                />
                {promoCode === '' ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('orders.desk.promoRemove')}
                    onClick={() => setPromoCode('')}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                )}
              </div>
              <p
                id={`${ids}-promo-status`}
                role="status"
                className={
                  promoState.kind === 'ok'
                    ? 'flex items-center gap-1.5 text-xs text-success'
                    : promoState.kind === 'none' || promoState.kind === 'checking'
                      ? 'text-xs text-muted-foreground'
                      : 'text-xs text-destructive'
                }
              >
                {promoState.kind === 'none' ? t('orders.desk.promoHint') : null}
                {promoState.kind === 'checking' ? t('orders.desk.promoChecking') : null}
                {promoState.kind === 'ok' ? (
                  <>
                    <CheckCircle2 aria-hidden="true" className="size-3.5" />
                    {t('orders.desk.promoApplied')}
                  </>
                ) : null}
                {promoState.kind === 'refused'
                  ? t(PROMO_REASONS[promoState.reason] ?? 'orders.desk.promoReason.out_of_scope')
                  : null}
                {promoState.kind === 'not_found' ? t('orders.desk.promoNotFound') : null}
                {promoState.kind === 'failed' ? t('orders.desk.promoFailed') : null}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-delivery`}>{t('orders.desk.deliveryCharge')}</Label>
              <Input
                id={`${ids}-delivery`}
                inputMode="decimal"
                value={deliveryShown}
                onChange={(event) => {
                  setDeliveryTaka(event.target.value);
                  setDeliveryTouched(true);
                }}
                aria-invalid={deliveryPoisha === null}
                className="text-right tabular-nums"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-3">
              <Label htmlFor={`${ids}-notes`}>{t('orders.desk.notes')}</Label>
              <textarea
                id={`${ids}-notes`}
                ref={notesRef}
                rows={2}
                maxLength={2000}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              />
            </div>
          </section>
        </form>

        {/* The right-hand column: who, how risky, how much, and the buttons. */}
        <aside className="space-y-4" aria-label={t('orders.desk.summary')}>
          <section className="space-y-3 rounded-lg border border-border bg-card p-4">
            <FraudBadgeView
              state={
                normalized === null
                  ? 'idle'
                  : fraud.isPending
                    ? 'loading'
                    : fraud.isError
                      ? 'error'
                      : 'ready'
              }
              badge={fraud.data}
            />
            {customer === null ? null : (
              <div className="space-y-1.5 border-t border-border pt-3">
                <p className="text-sm font-medium">{t('orders.desk.history')}</p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {customer.stats.orders} {t('orders.desk.statOrders')} · {customer.stats.delivered}{' '}
                  {t('orders.desk.statDelivered')} · {customer.stats.returned}{' '}
                  {t('orders.desk.statReturned')}
                </p>
                {customer.recentOrders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('orders.desk.noHistory')}</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {customer.recentOrders.map((recent) => (
                      <li key={recent.id} className="flex items-center justify-between gap-2">
                        <Link
                          to={ordersPath(`/orders/${recent.id}`)}
                          className="font-medium tabular-nums underline-offset-4 hover:underline"
                        >
                          {recent.orderNo}
                        </Link>
                        <OrderStatusBadge status={recent.status} />
                        <Money poisha={recent.codAmountPoisha} locale={locale} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {duplicateItems.length === 0 ? null : (
            <section
              role="alert"
              className="space-y-1.5 rounded-lg border border-warning/40 bg-warning-subtle p-3 text-sm text-warning-subtle-foreground"
            >
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle aria-hidden="true" className="size-4" />
                {t('orders.desk.duplicateTitle')}
              </p>
              <p className="text-xs">{t('orders.desk.duplicateDetail')}</p>
              <ul className="space-y-0.5 text-xs">
                {duplicateItems.map((duplicate) => (
                  <li key={duplicate.orderNo} className="flex items-center justify-between gap-2">
                    {duplicate.id === null ? (
                      <span className="tabular-nums">
                        {duplicate.orderNo} · {t('orders.desk.duplicateOther')}
                      </span>
                    ) : (
                      <Link
                        to={ordersPath(`/orders/${duplicate.id}`)}
                        className="font-medium tabular-nums underline-offset-4 hover:underline"
                      >
                        {duplicate.orderNo}
                      </Link>
                    )}
                    <OrderStatusBadge status={duplicate.status} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="space-y-2 rounded-lg border border-border bg-card p-4">
            <dl className="space-y-1 text-sm">
              <TotalRow
                label={t('orders.desk.itemsTotal')}
                poisha={totals.itemsPoisha}
                locale={locale}
              />
              <TotalRow
                label={t('orders.desk.discountTotal')}
                poisha={totals.discountPoisha}
                locale={locale}
              />
              {promoState.kind === 'ok' && promoState.discountPoisha !== '0' ? (
                <TotalRow
                  label={t('orders.desk.promoDiscount')}
                  poisha={promoState.discountPoisha}
                  locale={locale}
                />
              ) : null}
              {promoState.kind === 'ok' && promoState.deliveryDiscountPoisha !== '0' ? (
                <TotalRow
                  label={t('orders.desk.promoDelivery')}
                  poisha={promoState.deliveryDiscountPoisha}
                  locale={locale}
                />
              ) : null}
              <TotalRow
                label={t('orders.desk.deliveryTotal')}
                poisha={totals.deliveryPoisha}
                locale={locale}
              />
              <div className="flex items-baseline justify-between border-t border-border pt-2">
                <dt className="font-medium">{t('orders.desk.cod')}</dt>
                <dd className="text-base font-semibold" data-testid="desk-cod">
                  <Money poisha={totals.codPoisha} locale={locale} />
                </dd>
              </div>
            </dl>
            {totals.invalid ? (
              <p className="text-xs text-destructive" role="alert">
                {t('orders.desk.codNegative')}
              </p>
            ) : null}
            {attempted &&
            !ready &&
            (promoState.kind === 'refused' ||
              promoState.kind === 'not_found' ||
              promoState.kind === 'failed') ? (
              <p className="text-xs text-destructive" role="alert">
                {t('orders.desk.promoBlocked')}
              </p>
            ) : null}
            {attempted && !ready ? (
              <p className="text-xs text-destructive" role="alert">
                {t('orders.desk.missing')}
              </p>
            ) : null}

            {outcome === null ? (
              <div className="flex flex-col gap-2 pt-1">
                {mayConfirm ? (
                  <Button type="button" disabled={save.isPending} onClick={() => submit(true)}>
                    {save.isPending ? t('orders.desk.saving') : t('orders.desk.confirm')}
                    {/* Full-strength text, set apart by the monospace face rather than
                        by fading it: at 80% opacity on the accent it failed AA
                        contrast (M05 check 6). */}
                    <kbd className="ml-auto font-mono text-xs">Ctrl+Enter</kbd>
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant={mayConfirm ? 'outline' : 'primary'}
                  disabled={save.isPending}
                  onClick={() => submit(false)}
                >
                  {t('orders.desk.savePending')}
                  <kbd className="ml-auto font-mono text-xs">Ctrl+S</kbd>
                </Button>
              </div>
            ) : (
              <OutcomePanel outcome={outcome} onNext={reset} nextRef={nextRef} />
            )}
          </section>
        </aside>
      </div>

      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} shortcuts={shortcuts} />
    </div>
  );
}

function TotalRow({
  label,
  poisha,
  locale,
}: {
  readonly label: string;
  readonly poisha: string;
  readonly locale: 'en' | 'bn';
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Money poisha={poisha} locale={locale} />
      </dd>
    </div>
  );
}

function OutcomePanel({
  outcome,
  onNext,
  nextRef,
}: {
  readonly outcome: Outcome;
  readonly onNext: () => void;
  readonly nextRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useOrdersT();
  const heading: OrdersMessageKey =
    outcome.kind === 'confirmed'
      ? 'orders.desk.confirmed'
      : outcome.kind === 'saved'
        ? 'orders.desk.saved'
        : outcome.kind === 'saved_not_confirmed'
          ? 'orders.desk.savedNotConfirmed'
          : 'orders.desk.saveFailed';
  const good = outcome.kind === 'confirmed' || outcome.kind === 'saved';
  return (
    <div className="space-y-2 pt-1" role="status" aria-live="polite" data-testid="desk-outcome">
      <p
        className={cn(
          'flex items-center gap-1.5 text-sm font-medium',
          good ? '' : 'text-destructive',
        )}
      >
        {good ? (
          <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
        ) : (
          <AlertTriangle aria-hidden="true" className="size-4" />
        )}
        {t(heading)}
        {outcome.orderNo === undefined ? null : (
          <span className="tabular-nums" data-testid="desk-order-no">
            {outcome.orderNo}
          </span>
        )}
      </p>
      {outcome.message === undefined ? null : (
        <p className="text-xs text-muted-foreground">{outcome.message}</p>
      )}
      {outcome.kind === 'failed' ? null : (
        <div className="flex flex-col gap-2">
          {/* A plain button with the kit's classes: the kit's Button takes no ref, and this
              one is focused the moment the order is saved so Enter starts the next one. */}
          <button
            ref={nextRef}
            type="button"
            className={buttonVariants({ variant: 'primary', size: 'md' })}
            onClick={onNext}
          >
            {t('orders.desk.newOrder')}
          </button>
          {outcome.orderId === undefined ? null : (
            <Link
              to={ordersPath(`/orders/${outcome.orderId}`)}
              className="text-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {t('orders.desk.openOrder')}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/** "Savar, Dhaka" or "সাভার, ঢাকা", as the console's language reads. */
function areaLabel(area: Area, locale: 'en' | 'bn'): string {
  return locale === 'bn'
    ? `${area.thanaBn}, ${area.districtBn}`
    : `${area.thanaEn}, ${area.districtEn}`;
}
