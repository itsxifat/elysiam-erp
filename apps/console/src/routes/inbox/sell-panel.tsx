import { chatHintDetector } from '@elysium/domain/inbox';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { addInterest, getThread, INBOX_KEY, type ConversationItem, type PanelView } from './api.js';
import { DraftOrder } from './draft-order.js';
import { useSellDraft } from './draft-store.js';
import { HintCard } from './hint-card.js';
import { ProductPicker } from './product-picker.js';
import {
  getSellingContext,
  getSizeChart,
  pickProducts,
  SELL_KEY,
  type PickerProduct,
  type PickerVariant,
} from './sell-api.js';
import {
  addToDraft,
  chartRecommendation,
  chooseVariant,
  nationalPhone,
  prefillCustomer,
  readCard,
  refQuery,
  type SellDraft,
  type Want,
} from './sell-logic.js';
import { useSellT } from './sell-messages.js';

/**
 * Selling from the chat (M44b, D-770 to D-777): at the top of the customer panel, the side card
 * with what the customer's newest messages ask for, the draft order with its instant product
 * picker, and Place order. The owner's brief: "customer typed size or measurement, a popup opens
 * on the side to add it… as fast and efficient and user friendly as we can make it."
 *
 * The messages are the thread's own query (the same cache entry, so nothing is fetched twice and
 * M42's realtime events refresh it); the draft is this browser's, per conversation and person.
 * Alt+P finds a product and Alt+A adds what the card read, from anywhere on the page.
 */
export function SellPanel({
  conversation,
  me,
  view,
}: {
  readonly conversation: ConversationItem;
  readonly me: string | null;
  readonly view: PanelView;
}) {
  const t = useSellT();
  const ids = useId();
  const [draft, update] = useSellDraft(conversation.id, me);
  const pickerInput = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [preset, setPreset] = useState<Want | null>(null);
  const [pushed, setPushed] = useState<{ q: string; n: number } | null>(null);
  const [announce, setAnnounce] = useState('');

  const thread = useQuery({
    queryKey: [...INBOX_KEY, 'thread', conversation.id],
    queryFn: () => getThread(conversation.id),
  });
  const context = useQuery({
    queryKey: [...SELL_KEY, 'context'],
    queryFn: getSellingContext,
    staleTime: 5 * 60_000,
  });
  const detector = useMemo(
    () =>
      chatHintDetector({
        colours: context.data?.colours ?? [],
        siteHosts: context.data?.siteHosts ?? [],
      }),
    [context.data],
  );
  const card = useMemo(
    () => readCard(thread.data?.messages ?? [], draft.hintsSeenAt, detector, draft.customer.phone),
    [thread.data, draft.hintsSeenAt, detector, draft.customer.phone],
  );

  // The delivery name, phone and address, from the chat, into whatever is still empty.
  const firstFound = view.addressesFound[0];
  useEffect(() => {
    update((current) =>
      prefillCustomer(current, {
        name: view.customer?.name ?? view.contact.name,
        phone: view.contact.phone ?? view.customer?.phone ?? view.phonesFound[0]?.phone ?? null,
        address:
          view.contact.address ??
          (firstFound === undefined
            ? null
            : {
                districtId: firstFound.districtId,
                thanaId: firstFound.thanaId,
                area: null,
                addressLine: firstFound.line,
              }),
      }),
    );
  }, [view, firstFound, update]);

  // The product the card's size applies to: one the chat links to, else the last one picked,
  // else the only product the customer asked about.
  const ref = card.summary.products[0]?.ref ?? null;
  const refHit = useQuery({
    queryKey: [...SELL_KEY, 'pick', ref === null ? '' : refQuery(ref)],
    queryFn: () => pickProducts({ q: ref === null ? '' : refQuery(ref) }),
    enabled: ref !== null,
    staleTime: 15_000,
  });
  const onlyInterest = view.interests.length === 1 ? view.interests[0]?.productId : undefined;
  const focusId = draft.focus?.id ?? onlyInterest ?? null;
  const focusHit = useQuery({
    queryKey: [...SELL_KEY, 'ids', focusId === null ? [] : [focusId]],
    queryFn: () => pickProducts({ ids: focusId === null ? [] : [focusId] }),
    enabled: focusId !== null && ref === null,
    staleTime: 15_000,
  });
  const target: PickerProduct | null =
    (ref !== null ? refHit.data?.items[0] : focusHit.data?.items[0]) ?? null;
  const measures = card.summary.measurements;
  const chartId = target?.sizeChartId ?? null;
  const chart = useQuery({
    queryKey: [...SELL_KEY, 'chart', chartId],
    queryFn: () => getSizeChart(chartId ?? ''),
    enabled: chartId !== null && measures.length > 0,
    staleTime: 10 * 60_000,
  });
  const recommendation = chartRecommendation(chart.data, measures);
  const want: Want = {
    size: card.summary.size?.size ?? recommendation?.canonical ?? null,
    colour: card.summary.colour?.colour ?? null,
    qty: card.summary.quantity?.qty ?? null,
  };
  const draftHasAddress = draft.customer.thanaId !== null || draft.customer.addressLine !== '';
  const place =
    firstFound === undefined || draftHasAddress
      ? null
      : `${firstFound.thanaName}, ${firstFound.districtName}`;

  const interestIds = useMemo(
    () => view.interests.map((interest) => interest.productId),
    [view.interests],
  );
  const remember = (product: PickerProduct, variant: PickerVariant) => {
    if (interestIds.includes(product.id)) return;
    // The customer looked at it: it joins their products of interest, quietly. On someone
    // else's conversation the server asks for the acknowledgement, and this simply does not.
    void addInterest(conversation.id, { productId: product.id, skuId: variant.skuId }, false).catch(
      () => undefined,
    );
  };

  const openPicker = (next: Want | null, q: string) => {
    setPreset(next);
    setPushed((current) => ({ q, n: (current?.n ?? 0) + 1 }));
    pickerInput.current?.focus();
  };

  const seen = (current: SellDraft): SellDraft =>
    card.newestAt === null ? current : { ...current, hintsSeenAt: card.newestAt };

  const addFromCard = () => {
    const variant = target === null ? null : chooseVariant(target, want);
    update((current) => {
      let next = current;
      if (card.phone !== null) {
        next = { ...next, customer: { ...next.customer, phone: nationalPhone(card.phone) } };
      }
      if (firstFound !== undefined && !draftHasAddress) {
        next = {
          ...next,
          customer: {
            ...next.customer,
            districtId: firstFound.districtId,
            thanaId: firstFound.thanaId,
            addressLine: firstFound.line,
          },
        };
      }
      if (target !== null && variant !== null) next = addToDraft(next, target, variant, want.qty);
      return seen(next);
    });
    if (target !== null && variant !== null) {
      remember(target, variant);
      setAnnounce(t('inbox.sell.card.added'));
      setPreset(null);
    } else if (want.size !== null || want.qty !== null || want.colour !== null || target !== null) {
      setAnnounce(
        target !== null && want.size !== null
          ? t('inbox.sell.card.noMatch', { size: want.size, product: target.name })
          : '',
      );
      openPicker(want, target?.name ?? '');
    } else {
      setAnnounce(t('inbox.sell.card.added'));
    }
  };

  const dismiss = () => update(seen);

  const choose = () => {
    openPicker(want, ref !== null ? refQuery(ref) : (target?.name ?? ''));
  };

  // Alt+P: find a product. Alt+A: add what the card read. From anywhere on the page.
  const latestAdd = useRef(addFromCard);
  useEffect(() => {
    latestAdd.current = addFromCard;
  });
  const showCard = !card.empty && draft.placed === null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p' || event.code === 'KeyP') {
        event.preventDefault();
        pickerInput.current?.focus();
      } else if ((key === 'a' || event.code === 'KeyA') && showCard) {
        event.preventDefault();
        latestAdd.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showCard]);

  return (
    <section
      aria-labelledby={`${ids}-title`}
      className="space-y-3 border-b border-border px-4 py-3"
    >
      <h3 id={`${ids}-title`} className="sr-only">
        {t('inbox.sell.region')}
      </h3>
      <div aria-live="polite" className="space-y-2">
        {showCard ? (
          <HintCard
            read={card}
            target={target}
            chart={chart.data}
            recommendation={recommendation}
            place={place}
            onAdd={addFromCard}
            onChoose={choose}
            onDismiss={dismiss}
            cardRef={cardRef}
          />
        ) : null}
        <p className="sr-only">{announce}</p>
      </div>
      <DraftOrder
        draft={draft}
        update={update}
        conversation={conversation}
        me={me}
        picker={
          <ProductPicker
            recentIds={interestIds}
            preset={preset}
            pushed={pushed}
            inputRef={pickerInput}
            onPick={(product, variant, qty) => {
              update((current) => addToDraft(current, product, variant, qty));
              remember(product, variant);
              setPreset(null);
              setAnnounce(t('inbox.sell.card.added'));
            }}
          />
        }
      />
      <p className="text-xs text-muted-foreground">{t('inbox.sell.shortcuts')}</p>
    </section>
  );
}
