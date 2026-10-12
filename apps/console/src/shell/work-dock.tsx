import { Button, cn, Money } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BellRing, Check, MessageCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import '../alive/alive.css';
import { useInboxAlerts } from '../alive/inbox-alerts.js';
import { alertIfHidden } from '../alive/notify.js';
import { playTone } from '../alive/tones.js';
import { ApiError } from '../api.js';
import { useAbility, useSession } from '../auth/session.js';
import '../i18n/alive.js';
import { useLocale, useT } from '../i18n/locale.js';
import '../i18n/workflow.js';
import { useRealtime } from '../realtime/use-realtime.js';
import { listAgents } from '../routes/orders/api.js';
import {
  acceptConversationOffer,
  acceptOffer,
  declineConversationOffer,
  declineOffer,
  myConversationOffers,
  myDesk,
  myOffers,
  reportPresence,
  type ConversationOfferCard,
  type OfferCard,
} from '../routes/orders/workflow-api.js';
import { actKey, beatFor, offerShareLeft, secondsLeft } from '../routes/orders/workflow-logic.js';

/**
 * The work dock (M41, D-713, D-717, D-721): loaded after the shell paints, it
 *
 * 1. reports this tab's presence about every thirty seconds: whether it is visible and how long
 *    since the last key, pointer or touch input **in this tab** (nothing about any other tab or
 *    application is observed);
 * 2. shows an order offered to them like a ride offer: number, area, pieces, cash to collect, a
 *    countdown, Accept and Decline. Announced politely and never stealing focus from what the
 *    person is typing; the card sits first in the tab order after the skip link;
 * 3. tells them when somebody else worked on their order;
 * 4. shows a new inbox conversation offered to them the same way (D-748), when their desk takes
 *    messages: who wrote, on which channel, the last words, and the same countdown;
 * 5. (M44a, D-766) rings: an offer arrives with an urgent tone and a gentle ring around its card
 *    (a desktop alert too while the tab is hidden), a customer's new message chimes on every
 *    screen, and the tab's title counts the unread messages that are theirs.
 */

const BEAT_MS = 30_000;
const NOTICE_MS = 15_000;
const INPUT_EVENTS = ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const;

interface Notice {
  readonly key: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly actorUserId: string;
  readonly act: unknown;
}

export function WorkDock() {
  const ability = useAbility();
  const session = useSession();
  if (session.context === null || !ability.can('update', 'Presence')) return null;
  return <Dock />;
}

function Dock() {
  const t = useT();
  const { locale } = useLocale();
  const ability = useAbility();
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lastInput = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const [said, setSaid] = useState<string | null>(null);

  const desk = useQuery({ queryKey: ['team', 'me'], queryFn: myDesk, staleTime: 60_000 });
  const takesOrders =
    ability.can('read', 'Order') && (desk.data?.profile.workTypes.includes('orders') ?? false);
  const offers = useQuery({
    queryKey: ['orders', 'offers', 'mine'],
    queryFn: myOffers,
    enabled: takesOrders,
    refetchInterval: 15_000,
  });
  const takesMessages =
    ability.can('read', 'Conversation') &&
    (desk.data?.profile.workTypes.includes('messages') ?? false);
  const conversationOffers = useQuery({
    queryKey: ['inbox', 'offers', 'mine'],
    queryFn: myConversationOffers,
    enabled: takesMessages,
    refetchInterval: 15_000,
  });
  // M44a (D-764, D-766): a customer's new message, heard on every screen, and the title's count.
  const inboxAlerts = useInboxAlerts({
    enabled: ability.can('read', 'Conversation'),
    me: session.context?.userId ?? null,
    takesMessages,
  });
  const agents = useQuery({
    queryKey: ['orders', 'agents'],
    queryFn: listAgents,
    staleTime: 300_000,
    enabled: notices.length > 0,
  });

  // --- presence: the heartbeat --------------------------------------------------------
  const beat = useCallback(async () => {
    try {
      const state = await reportPresence(
        beatFor({
          visible: document.visibilityState === 'visible',
          lastInputMs: lastInput.current,
          nowMs: Date.now(),
        }),
      );
      queryClient.setQueryData(
        ['team', 'me'],
        (current: Awaited<ReturnType<typeof myDesk>> | undefined) =>
          current === undefined
            ? current
            : { ...current, presence: { ...current.presence, ...state } },
      );
    } catch {
      // A missed beat is a gap the server reads as "away" after ninety seconds; nothing to show.
    }
  }, [queryClient]);

  useEffect(() => {
    // The page was just opened or switched to: that is an input in this tab.
    lastInput.current = Date.now();
    const onInput = () => {
      lastInput.current = Date.now();
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true });
    const onVisibility = () => void beat();
    document.addEventListener('visibilitychange', onVisibility);
    void beat();
    const timer = window.setInterval(() => void beat(), BEAT_MS);
    return () => {
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(timer);
    };
  }, [beat]);

  // The countdown's clock, only while an offer is showing.
  const liveOffers = offers.data?.items ?? [];
  const liveConversationOffers = conversationOffers.data?.items ?? [];
  const showing = liveOffers.length + liveConversationOffers.length;
  useEffect(() => {
    if (showing === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [showing]);

  // --- realtime: offers and news about my orders ---------------------------------------
  useRealtime({
    events: [
      'order.offered',
      'order.offer_closed',
      'order.acted_over_owner',
      'inbox.conversation_offered',
      'inbox.conversation_offer_closed',
      'inbox.message_received',
    ],
    onEvent: (name, payload) => {
      if (name === 'inbox.message_received') {
        inboxAlerts.onMessage(payload);
        return;
      }
      if (name === 'inbox.conversation_offered' || name === 'inbox.conversation_offer_closed') {
        void queryClient.invalidateQueries({ queryKey: ['inbox', 'offers', 'mine'] });
        if (name === 'inbox.conversation_offered') setSaid(t('wf.offer.conversationAnnounce'));
        return;
      }
      if (name === 'order.acted_over_owner') {
        const body = (payload ?? {}) as Record<string, unknown>;
        if (typeof body.id !== 'string' || typeof body.orderNo !== 'string') return;
        const notice: Notice = {
          key: `${body.id}:${String(Date.now())}`,
          orderId: body.id,
          orderNo: body.orderNo,
          actorUserId: typeof body.actorUserId === 'string' ? body.actorUserId : '',
          act: body.act,
        };
        setNotices((current) => [notice, ...current].slice(0, 3));
        void queryClient.invalidateQueries({ queryKey: ['orders'] });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['orders', 'offers', 'mine'] });
      if (name === 'order.offered') {
        const body = (payload ?? {}) as Record<string, unknown>;
        if (typeof body.orderNo === 'string') setSaid(`${t('wf.offer.announce')} ${body.orderNo}`);
      }
    },
  });

  useEffect(() => {
    if (notices.length === 0) return undefined;
    const timer = window.setTimeout(() => setNotices((current) => current.slice(0, -1)), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notices]);

  const nameOf = (userId: string) =>
    agents.data?.items.find((agent) => agent.userId === userId)?.name ?? t('wf.someone');

  return (
    <div
      role="region"
      aria-label={t('wf.dock.label')}
      className="pointer-events-none fixed right-4 bottom-4 left-4 z-40 ml-auto flex max-w-sm flex-col items-end gap-2"
      data-testid="work-dock"
    >
      <p className="sr-only" aria-live="polite">
        {said}
      </p>

      {notices.map((notice) => (
        <div
          key={notice.key}
          role="status"
          className="pointer-events-auto w-full rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-popover"
          data-testid="owner-notice"
        >
          <div className="flex items-start justify-between gap-2">
            <p>
              <span className="font-medium">{nameOf(notice.actorUserId)}</span>{' '}
              {t(actKey(notice.act))} {t('wf.notice.on')}{' '}
              <button
                type="button"
                className="font-medium tabular-nums underline underline-offset-4 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => void navigate({ to: `/orders/${notice.orderId}` as never })}
              >
                {notice.orderNo}
              </button>
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('wf.notice.dismiss')}
              onClick={() =>
                setNotices((current) => current.filter((one) => one.key !== notice.key))
              }
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>
      ))}

      {liveOffers.map((offer) => (
        <OfferCardView
          key={offer.id}
          offer={offer}
          now={now}
          locale={locale}
          onAccepted={(orderId) => void navigate({ to: `/orders/${orderId}` as never })}
        />
      ))}

      {liveConversationOffers.map((offer) => (
        <ConversationOfferCardView
          key={offer.id}
          offer={offer}
          now={now}
          onAccepted={(conversationId) =>
            void navigate({ to: '/inbox', search: { c: conversationId } as never })
          }
        />
      ))}
    </div>
  );
}

function OfferCardView({
  offer,
  now,
  locale,
  onAccepted,
}: {
  readonly offer: OfferCard;
  readonly now: number;
  readonly locale: ReturnType<typeof useLocale>['locale'];
  readonly onAccepted: (orderId: string) => void;
}) {
  const t = useT();
  const area = [offer.area.thana, offer.area.district].filter((part) => part !== null).join(', ');
  return (
    <OfferShell
      id={offer.id}
      testId="offer-card"
      dataLabel={offer.orderNo}
      icon={<BellRing aria-hidden="true" className="size-3.5" />}
      title={t('wf.offer.title')}
      heading={<span className="tabular-nums">{offer.orderNo}</span>}
      sub={area === '' ? offer.area.detail : area}
      aside={
        <>
          <p className="text-xs text-muted-foreground">{t('wf.cod')}</p>
          <p className="text-lg font-semibold">
            <Money poisha={offer.codAmountPoisha} locale={locale} />
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {offer.itemCount} {t('wf.offer.pieces')}
          </p>
        </>
      }
      detail={t('wf.offer.detail')}
      alert={{
        title: t('alive.notify.orderOffer'),
        body: [offer.orderNo, area === '' ? offer.area.detail : area].filter(Boolean).join(' · '),
      }}
      offeredAt={offer.offeredAt}
      expiresAt={offer.expiresAt}
      now={now}
      refreshKey={['orders']}
      accept={async () => onAccepted((await acceptOffer(offer.id)).orderId)}
      decline={async () => {
        await declineOffer(offer.id);
      }}
    />
  );
}

/** D-748: a conversation offered to this person, on the same card as an order. */
function ConversationOfferCardView({
  offer,
  now,
  onAccepted,
}: {
  readonly offer: ConversationOfferCard;
  readonly now: number;
  readonly onAccepted: (conversationId: string) => void;
}) {
  const t = useT();
  const name = offer.contactName ?? t('wf.offer.customer');
  return (
    <OfferShell
      id={offer.id}
      testId="conversation-offer-card"
      dataLabel={offer.conversationId}
      icon={<MessageCircle aria-hidden="true" className="size-3.5" />}
      title={t('wf.offer.conversationTitle')}
      heading={name}
      sub={offer.lastPreview}
      aside={
        <>
          <p className="text-xs text-muted-foreground">{t(`wf.channel.${offer.channel}`)}</p>
          {offer.unreadCount > 0 ? (
            <p className="text-xs text-muted-foreground tabular-nums">
              {offer.unreadCount} {t('wf.offer.unread')}
            </p>
          ) : null}
        </>
      }
      detail={t('wf.offer.conversationDetail')}
      alert={{
        title: t('alive.notify.chatOffer'),
        body: [name, offer.lastPreview].filter(Boolean).join(' · '),
      }}
      offeredAt={offer.offeredAt}
      expiresAt={offer.expiresAt}
      now={now}
      refreshKey={['inbox']}
      accept={async () => onAccepted((await acceptConversationOffer(offer.id)).conversationId)}
      decline={async () => {
        await declineConversationOffer(offer.id);
      }}
    />
  );
}

/** Offers that have rung in this tab: a card that re-renders or remounts rings once (D-766). */
const rung = new Set<string>();

/**
 * One offer, whatever it offers: the summary the caller passes, Accept and Decline, and the
 * countdown on a native <progress>. Announced by the dock; never steals focus. It arrives with
 * the urgent tone and a soft ring around the card while it waits; the countdown turns amber in
 * its last quarter (M44a, D-765, D-766).
 */
function OfferShell({
  id,
  testId,
  dataLabel,
  icon,
  title,
  heading,
  sub,
  aside,
  detail,
  alert,
  offeredAt,
  expiresAt,
  now,
  refreshKey,
  accept,
  decline,
}: {
  readonly id: string;
  readonly testId: string;
  readonly dataLabel: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly heading: ReactNode;
  readonly sub: string | null;
  readonly aside: ReactNode;
  readonly detail: string;
  /** The desktop alert while the tab is hidden. */
  readonly alert: { readonly title: string; readonly body: string };
  readonly offeredAt: string;
  readonly expiresAt: string;
  readonly now: number;
  readonly refreshKey: readonly string[];
  readonly accept: () => Promise<void>;
  readonly decline: () => Promise<void>;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const left = secondsLeft(expiresAt, now);
  const share = offerShareLeft(offeredAt, expiresAt, now);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: [...refreshKey] });

  const accepting = useMutation({
    mutationFn: accept,
    onSuccess: refresh,
    onError: (error) => {
      setProblem(error instanceof ApiError ? error.message : t('wf.offer.gone'));
      refresh();
    },
  });
  const declining = useMutation({ mutationFn: decline, onSettled: refresh });
  const busy = accepting.isPending || declining.isPending || left === 0;

  useEffect(() => {
    if (rung.has(id)) return;
    rung.add(id);
    playTone('offer');
    alertIfHidden({ title: alert.title, body: alert.body, tag: `offer:${id}` });
    // Once per offer: the alert's words are read when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <section
      aria-labelledby={`offer-${id}`}
      className={cn(
        'pointer-events-auto w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-popover',
        'alive-in',
        !busy && 'alive-ring',
      )}
      data-testid={testId}
      data-order-no={testId === 'offer-card' ? dataLabel : undefined}
      data-conversation-id={testId === 'offer-card' ? undefined : dataLabel}
    >
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <span className="alive-wiggle inline-flex">{icon}</span>
              {title}
            </p>
            <h2 id={`offer-${id}`} className="truncate text-lg font-semibold">
              {heading}
            </h2>
            {sub === null ? null : (
              <p className="line-clamp-2 text-sm text-muted-foreground">{sub}</p>
            )}
          </div>
          <div className="shrink-0 text-right">{aside}</div>
        </div>
        <p className="text-xs text-muted-foreground">{detail}</p>
        <div className="flex items-center gap-2">
          <Button className="flex-1" disabled={busy} onClick={() => accepting.mutate()}>
            <Check aria-hidden="true" />
            {t('wf.offer.accept')}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => declining.mutate()}>
            {t('wf.offer.decline')}
          </Button>
        </div>
        {problem === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
      {/* A native <progress>, styled through its pseudo-elements rather than an inline width. */}
      <progress
        aria-label={t('wf.offer.left')}
        aria-valuetext={`${String(left)} ${t('wf.offer.left')}`}
        value={Math.round(share * 100)}
        max={100}
        className={cn(
          'h-1.5 w-full appearance-none bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary',
          share < 0.25 && 'alive-urgent',
        )}
      />
      <p
        className="px-4 pb-2 text-right text-xs text-muted-foreground tabular-nums"
        aria-hidden="true"
      >
        {left} {t('wf.offer.left')}
      </p>
    </section>
  );
}
