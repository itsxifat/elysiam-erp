import { Button, Money } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { BellRing, Check, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError } from '../api.js';
import { useAbility, useSession } from '../auth/session.js';
import { useLocale, useT } from '../i18n/locale.js';
import '../i18n/workflow.js';
import { useRealtime } from '../realtime/use-realtime.js';
import { listAgents } from '../routes/orders/api.js';
import {
  acceptOffer,
  declineOffer,
  myDesk,
  myOffers,
  reportPresence,
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
 * 3. tells them when somebody else worked on their order.
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
  useEffect(() => {
    if (liveOffers.length === 0) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [liveOffers.length]);

  // --- realtime: offers and news about my orders ---------------------------------------
  useRealtime({
    events: ['order.offered', 'order.offer_closed', 'order.acted_over_owner'],
    onEvent: (name, payload) => {
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
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const left = secondsLeft(offer.expiresAt, now);
  const share = offerShareLeft(offer.offeredAt, offer.expiresAt, now);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['orders'] });

  const accept = useMutation({
    mutationFn: () => acceptOffer(offer.id),
    onSuccess: (result) => {
      refresh();
      onAccepted(result.orderId);
    },
    onError: (error) => {
      setProblem(error instanceof ApiError ? error.message : t('wf.offer.gone'));
      refresh();
    },
  });
  const decline = useMutation({
    mutationFn: () => declineOffer(offer.id),
    onSettled: refresh,
  });

  const area = [offer.area.thana, offer.area.district].filter((part) => part !== null).join(', ');

  return (
    <section
      aria-labelledby={`offer-${offer.id}`}
      className="pointer-events-auto w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-popover"
      data-testid="offer-card"
      data-order-no={offer.orderNo}
    >
      <div className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <BellRing aria-hidden="true" className="size-3.5" />
              {t('wf.offer.title')}
            </p>
            <h2 id={`offer-${offer.id}`} className="text-lg font-semibold tabular-nums">
              {offer.orderNo}
            </h2>
            <p className="text-sm text-muted-foreground">
              {area === '' ? offer.area.detail : area}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">{t('wf.cod')}</p>
            <p className="text-lg font-semibold">
              <Money poisha={offer.codAmountPoisha} locale={locale} />
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              {offer.itemCount} {t('wf.offer.pieces')}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t('wf.offer.detail')}</p>
        <div className="flex items-center gap-2">
          <Button
            className="flex-1"
            disabled={accept.isPending || decline.isPending || left === 0}
            onClick={() => accept.mutate()}
          >
            <Check aria-hidden="true" />
            {t('wf.offer.accept')}
          </Button>
          <Button
            variant="outline"
            disabled={accept.isPending || decline.isPending || left === 0}
            onClick={() => decline.mutate()}
          >
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
        className="h-1.5 w-full appearance-none bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
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
