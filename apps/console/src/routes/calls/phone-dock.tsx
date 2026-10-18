import { Button, Monogram, Money, StatusBadge, cn } from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Grid3x3, Phone, PhoneIncoming, PhoneOff, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import '../../alive/alive.css';
import { alertIfHidden } from '../../alive/notify.js';
import { useAbility, useSession } from '../../auth/session.js';
import { ordersPath } from '../orders/paths.js';
import {
  answeredHere,
  lookupCaller,
  MY_PHONE_KEY,
  myPhone,
  phoneToken,
  TELEPHONY_KEY,
  type MyPhone,
} from './api.js';
import { useTelT } from './messages.js';
import { nationalDigits, takeRingBack } from './phone-store.js';
import { loadEnvo, type EnvoPhone, type EnvoPhoneEvent } from './widget.js';

/**
 * The console's phone (M47, D-843): loaded after the shell paints, only for a person who places
 * calls and has an extension on a switched-on connection. It runs Envo's embedded phone headless
 * (no floating button), with a token the ERP mints for the person's own extension, and shows its
 * own card in the console's look:
 *
 * - an incoming call is a ringing card (M44a's ring motion; Envo's phone plays the ring itself,
 *   the same two-tone burst as M44a's `ring`, so the console does not ring a second time) with the
 *   caller's customer and their open orders, found by the number (the screen pop), Answer and
 *   Decline, and a desktop alert when the tab is hidden;
 * - the ring-back of the person's own Call (Envo rings them first, showing the customer's number)
 *   is answered at once and says whom it is connecting to;
 * - a call in progress shows its clock, Keypad (Envo's own panel, for digits) and Hang up;
 * - a phone that could not start says why and offers to start again with a fresh token.
 */
export function PhoneDock() {
  const ability = useAbility();
  const session = useSession();
  const allowed = session.context !== null && ability.can('create', 'PhoneCall');
  const mine = useQuery({
    queryKey: MY_PHONE_KEY,
    queryFn: myPhone,
    enabled: allowed,
    staleTime: 60_000,
  });
  const phone = mine.data?.phone ?? null;
  if (!allowed || phone?.ready !== true) return null;
  return <Dock phone={phone} />;
}

type Registration = 'starting' | 'connecting' | 'online' | 'offline' | 'error';

type Card =
  | {
      readonly kind: 'incoming';
      readonly from: string;
      readonly name: string | null;
      readonly at: number;
    }
  | {
      readonly kind: 'ringBack';
      readonly from: string;
      readonly label: string;
      readonly at: number;
    }
  | {
      readonly kind: 'active';
      readonly from: string;
      readonly label: string | null;
      readonly since: number;
      readonly incoming: boolean;
    }
  | { readonly kind: 'ended'; readonly from: string; readonly label: string | null };

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

function displayNumber(raw: string): string {
  const national = nationalDigits(raw);
  return national === '' ? raw : national;
}

function Dock({ phone }: { readonly phone: MyPhone }) {
  const t = useTelT();
  const queryClient = useQueryClient();
  const widget = useRef<EnvoPhone | null>(null);
  const [registration, setRegistration] = useState<Registration>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [card, setCard] = useState<Card | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cardNow = useRef<Card | null>(null);
  useEffect(() => {
    cardNow.current = card;
  }, [card]);

  // The browser's phone answered an inbound call: the call becomes this person's (D-836). Envo's
  // `call.started` may still be on its way, so ask a few times.
  const claim = useCallback(
    (from: string) => {
      let tries = 0;
      const tryOnce = () => {
        tries += 1;
        void answeredHere(from).then(
          () => void queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY }),
          () => {
            if (tries < 4) window.setTimeout(tryOnce, 3_000);
          },
        );
      };
      tryOnce();
    },
    [queryClient],
  );

  const onEvent = useCallback(
    (event: EnvoPhoneEvent) => {
      const detail = event.detail ?? {};
      const text = (key: string): string => {
        const value = detail[key];
        return typeof value === 'string' ? value : '';
      };
      switch (event.type) {
        case 'ready':
          setRegistration('connecting');
          break;
        case 'registered':
          setRegistration('online');
          setProblem(null);
          break;
        case 'offline':
        case 'failed':
          setRegistration('offline');
          break;
        case 'error':
          setRegistration('error');
          setProblem(text('message'));
          break;
        case 'incoming': {
          // Envo's own panel opens for every call; the console's card stands in for it.
          widget.current?.close();
          const from = text('from');
          const label = takeRingBack(from);
          if (label !== null) {
            setCard({ kind: 'ringBack', from, label, at: Date.now() });
            widget.current?.answer();
          } else {
            setCard({ kind: 'incoming', from, name: text('name') || null, at: Date.now() });
            alertIfHidden({
              title: t('tel.phone.alertTitle'),
              body: t('tel.phone.alertBody', { number: displayNumber(from) }),
              tag: `envo-call-${from}`,
              onClick: () => window.focus(),
            });
          }
          break;
        }
        case 'accepted': {
          const current = cardNow.current;
          if (current === null) break;
          const incoming = current.kind === 'incoming';
          setCard({
            kind: 'active',
            from: current.from,
            label: current.kind === 'ringBack' ? current.label : null,
            since: Date.now(),
            incoming,
          });
          if (incoming) claim(current.from);
          break;
        }
        case 'ended': {
          const current = cardNow.current;
          setCard(
            current === null
              ? null
              : {
                  kind: 'ended',
                  from: current.from,
                  label: current.kind === 'incoming' ? null : (current.label ?? null),
                },
          );
          void queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY });
          break;
        }
      }
    },
    [claim, queryClient, t],
  );

  // Start Envo's phone: its script from the connection's host, a fresh token, headless.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const envo = await loadEnvo(phone.baseUrl);
        const minted = await phoneToken();
        if (cancelled) return;
        widget.current = envo.phone({
          token: minted.token,
          baseUrl: phone.baseUrl,
          headless: true,
          position: 'bottom-right',
          onEvent,
        });
      } catch (error) {
        if (cancelled) return;
        setRegistration('error');
        setProblem(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
      widget.current?.destroy();
      widget.current = null;
    };
  }, [phone.baseUrl, phone.extension, attempt, onEvent]);

  // A finished call's card goes after a few seconds; a call's clock ticks.
  useEffect(() => {
    if (card?.kind !== 'ended') return;
    const timer = window.setTimeout(() => setCard(null), 4_000);
    return () => window.clearTimeout(timer);
  }, [card]);
  useEffect(() => {
    if (card?.kind !== 'active') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [card]);

  const caller = useQuery({
    queryKey: [...TELEPHONY_KEY, 'lookup', card === null ? '' : nationalDigits(card.from)],
    queryFn: () => lookupCaller(card?.from ?? ''),
    enabled: card !== null && card.from !== '',
    staleTime: 30_000,
  });

  if (card === null) {
    if (registration !== 'error') return null;
    return (
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md justify-center">
        <div
          role="status"
          className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-popover"
        >
          <PhoneOff aria-hidden="true" className="size-4 text-destructive" />
          <span>{t('tel.phone.error', { reason: problem ?? t('tel.failed') })}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setRegistration('starting');
              setAttempt((value) => value + 1);
            }}
          >
            <RotateCcw aria-hidden="true" />
            {t('tel.phone.restart')}
          </Button>
        </div>
      </div>
    );
  }

  const lookup = caller.data;
  const name =
    lookup?.customer?.name ??
    (card.kind === 'ringBack' || card.kind === 'active' || card.kind === 'ended'
      ? card.label
      : card.name) ??
    null;
  const ringing = card.kind === 'incoming';
  const heading =
    card.kind === 'incoming'
      ? t('tel.phone.incoming')
      : card.kind === 'ringBack'
        ? t('tel.phone.ringBack', { name: card.label })
        : card.kind === 'active'
          ? `${t('tel.phone.onCall')} · ${clock(now - card.since)}`
          : t('tel.phone.ended');

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md justify-center">
      <section
        aria-live="assertive"
        aria-label={t('tel.phone.title')}
        className={cn(
          'pointer-events-auto w-full rounded-xl border border-border bg-card p-4 shadow-popover',
          'motion-safe:animate-in',
          ringing && 'alive-ring',
        )}
      >
        <div className="flex items-start gap-3">
          <Monogram name={name ?? '?'} size="md" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <PhoneIncoming aria-hidden="true" className="size-3.5" />
              {heading}
            </p>
            <p className="truncate text-base font-semibold">
              {name ??
                (lookup?.phone === null ? t('tel.phone.unknown') : t('tel.phone.notCustomer'))}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">{displayNumber(card.from)}</p>
            {lookup?.customer?.reachable === true && lookup.customer.orders !== undefined ? (
              <p className="text-xs text-muted-foreground">
                {t('tel.phone.history', {
                  orders: lookup.customer.orders,
                  delivered: lookup.customer.delivered ?? 0,
                  returned: lookup.customer.returned ?? 0,
                })}
              </p>
            ) : null}
          </div>
          <StatusBadge tone="neutral">
            {t('tel.phone.ext', { extension: phone.extension })}
          </StatusBadge>
        </div>

        {lookup?.customer == null ? null : (
          <div className="mt-3 space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t('tel.phone.openOrders')}</p>
            {lookup.openOrders.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('tel.phone.noOpenOrders')}</p>
            ) : (
              <ul className="space-y-1">
                {lookup.openOrders.slice(0, 4).map((order) => (
                  <li key={order.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link
                      to={ordersPath(`/orders/${order.id}`)}
                      className="font-medium underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {order.orderNo}
                    </Link>
                    <span className="text-muted-foreground">{order.status.replace(/_/g, ' ')}</span>
                    <Money poisha={order.codAmountPoisha} />
                  </li>
                ))}
              </ul>
            )}
            {lookup.customer.reachable ? (
              <Link
                to={ordersPath(`/customers/${lookup.customer.id}`)}
                className="inline-block text-sm underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {t('tel.phone.openCustomer')}
              </Link>
            ) : null}
          </div>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {card.kind === 'incoming' ? (
            <>
              <Button variant="outline" size="sm" onClick={() => widget.current?.hangup()}>
                <PhoneOff aria-hidden="true" />
                {t('tel.phone.decline')}
              </Button>
              <Button size="sm" onClick={() => widget.current?.answer()}>
                <Phone aria-hidden="true" />
                {t('tel.phone.answer')}
              </Button>
            </>
          ) : card.kind === 'ended' ? (
            <Button variant="ghost" size="sm" onClick={() => setCard(null)}>
              {t('tel.close')}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={() => widget.current?.open()}>
                <Grid3x3 aria-hidden="true" />
                {t('tel.phone.keypad')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => widget.current?.hangup()}>
                <PhoneOff aria-hidden="true" />
                {t('tel.phone.hangUp')}
              </Button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
