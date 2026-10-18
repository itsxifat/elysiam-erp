import type { MessageKey } from '@elysium/i18n';
import { Button, Monogram, Money, StatusBadge, cn } from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Grid3x3, Phone, PhoneIncoming, PhoneOff, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import '../../alive/alive.css';
import { alertIfHidden } from '../../alive/notify.js';
import { ApiError } from '../../api.js';
import { useAbility, useSession } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
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
import { useTelT, type TelT } from './messages.js';
import { lookupAgainIn, nationalDigits, takeRingBack } from './phone-store.js';
import {
  EnvoLoadError,
  loadEnvo,
  phoneSocketAllowed,
  type EnvoPhone,
  type EnvoPhoneEvent,
} from './widget.js';

/**
 * The console's phone (M47, D-843): loaded after the shell paints, only for a person who places
 * calls and has an extension on a switched-on connection whose extension has Envo's web phone. It
 * runs Envo's embedded phone headless (no floating button), with a token the ERP mints for the
 * person's own extension, and shows its own card in the console's look:
 *
 * - an incoming call is a ringing card (M44a's ring motion; Envo's phone plays the ring itself,
 *   the same two-tone burst as M44a's `ring`, so the console does not ring a second time) with the
 *   caller's customer and their open orders, found by the number (the screen pop), Answer and
 *   Decline, and a desktop alert when the tab is hidden;
 * - the ring-back of the person's own Call (Envo rings them first, showing the customer's number
 *   and `Envo call <number>` as the name) is answered at once and says whom it is connecting to;
 * - a call in progress shows its clock, Envo's own panel for the keypad, mute and hold, and
 *   Hang up;
 * - a phone that is offline, still connecting after a few seconds, or could not start says so,
 *   and offers to start again with a fresh token or to be left alone for this visit.
 *
 * The widget lives as long as its connection, extension and start attempt: never one render. A
 * widget the console has let go of is destroyed once Envo's phone has finished starting (its
 * `connect()` does not stop for a `destroy()` made meanwhile), and nothing it says afterwards
 * reaches the card.
 */
export function PhoneDock() {
  const t = useTelT();
  const ability = useAbility();
  const session = useSession();
  const allowed = session.context !== null && ability.can('create', 'PhoneCall');
  // Asked again every minute: an extension taken off the person, or a connection switched
  // off, stops this tab's phone within a minute rather than at its next focus or reload.
  const mine = useQuery({
    queryKey: MY_PHONE_KEY,
    queryFn: myPhone,
    enabled: allowed,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  const [dismissed, setDismissed] = useDismissed();
  const phone = mine.data?.phone ?? null;
  if (!allowed || phone === null) return null;
  if (phone.ready) return <Dock phone={phone} />;
  // A connection switched off, a key that no longer opens or an extension Envo has switched off:
  // the person's Call buttons fail too, so say so, once a visit. An extension with no web phone
  // (a desk phone) or the stand-in for Envo is no fault: nothing is shown.
  const text =
    phone.notReady === 'switched_off'
      ? t('tel.phone.notReady')
      : phone.notReady === 'no_key'
        ? t('tel.phone.noKey')
        : phone.notReady === 'extension_off'
          ? t('tel.phone.extensionOff', { extension: phone.extension })
          : null;
  if (text === null || dismissed) return null;
  return <StatusBar t={t} text={text} onDismiss={() => setDismissed(true)} tone="muted" />;
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

/** A phone still connecting after this long is said to be. */
const CONNECTING_GRACE_MS = 10_000;

/** The open statuses the screen pop lists, with the order list's own labels. */
const ORDER_STATUSES = new Set([
  'pending',
  'on_hold',
  'confirmed',
  'packed',
  'shipped',
  'return_in_transit',
  'exchange',
]);

const DISMISSED_KEY = 'tel.phone.dismissed';

/** "Leave me alone" for this visit (this tab's session); storage denied, for this page. */
function useDismissed(): [boolean, (value: boolean) => void] {
  const [dismissed, setDismissedState] = useState(() => {
    try {
      return window.sessionStorage.getItem(DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const setDismissed = useCallback((value: boolean) => {
    setDismissedState(value);
    try {
      if (value) window.sessionStorage.setItem(DISMISSED_KEY, '1');
      else window.sessionStorage.removeItem(DISMISSED_KEY);
    } catch {
      // Storage denied: the choice holds for this page.
    }
  }, []);
  return [dismissed, setDismissed];
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`;
}

function displayNumber(raw: string): string {
  const national = nationalDigits(raw);
  return national === '' ? raw : national;
}

/** Why the phone could not start, in the console's words where it knows them. */
function startProblem(error: unknown, t: TelT): string {
  if (error instanceof EnvoLoadError) {
    return t(error.reason === 'blocked' ? 'tel.phone.loadBlocked' : 'tel.phone.loadMissing', {
      host: error.host,
    });
  }
  if (error instanceof ApiError) return error.message;
  return t('tel.failed');
}

/**
 * Envo's phone could not get its session. Envo refuses an origin missing from its API key's
 * allowed browser origins with no CORS header, so the browser reports only that the request
 * failed: say what to check.
 */
function sessionProblem(message: string, t: TelT): string {
  if (/fetch|network|load failed|origin/i.test(message)) return t('tel.phone.sessionRefused');
  return message === '' ? t('tel.failed') : message;
}

function StatusBar({
  t,
  text,
  onRestart,
  onDismiss,
  tone,
}: {
  readonly t: TelT;
  readonly text: string;
  readonly onRestart?: () => void;
  readonly onDismiss: () => void;
  readonly tone: 'error' | 'muted';
}) {
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md justify-center">
      <div
        role="status"
        className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-popover"
      >
        <PhoneOff
          aria-hidden="true"
          className={cn('size-4', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}
        />
        <span className="min-w-0 flex-1">{text}</span>
        {onRestart === undefined ? null : (
          <Button size="sm" variant="outline" onClick={onRestart}>
            <RotateCcw aria-hidden="true" />
            {t('tel.phone.restart')}
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={t('tel.phone.dismiss')}
          onClick={onDismiss}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/** The phone itself, for a person whose phone can start (exported for its test). */
export function Dock({ phone }: { readonly phone: MyPhone }) {
  const t = useTelT();
  const { t: appT } = useLocale();
  const queryClient = useQueryClient();
  const widget = useRef<EnvoPhone | null>(null);
  const [registration, setRegistration] = useState<Registration>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [dismissed, setDismissed] = useDismissed();
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
          setDismissed(false);
          break;
        case 'offline':
        case 'failed':
          setRegistration('offline');
          break;
        case 'error':
          setRegistration('error');
          setProblem(sessionProblem(text('message'), t));
          break;
        case 'incoming': {
          // Envo's own panel opens for every call; the console's card stands in for it.
          widget.current?.close();
          const from = text('from');
          const name = text('name');
          const label = takeRingBack(from, name);
          if (label !== null) {
            setCard({ kind: 'ringBack', from, label, at: Date.now() });
            widget.current?.answer();
          } else {
            setCard({ kind: 'incoming', from, name: name === '' ? null : name, at: Date.now() });
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
          // Envo says `accepted` twice for one call (JsSIP's accepted and confirmed): the second
          // changes nothing, so the ring-back keeps its label and the clock its start.
          const current = cardNow.current;
          if (current === null || current.kind === 'active' || current.kind === 'ended') break;
          const incoming = current.kind === 'incoming';
          const next: Card = {
            kind: 'active',
            from: current.from,
            label: current.kind === 'ringBack' ? current.label : current.name,
            since: Date.now(),
            incoming,
          };
          cardNow.current = next;
          setCard(next);
          if (incoming) claim(current.from);
          break;
        }
        case 'ended': {
          // Envo's panel falls back to its own dialer after a call: close it, so every call goes
          // through the console's Call buttons.
          widget.current?.close();
          const current = cardNow.current;
          const next: Card | null =
            current === null
              ? null
              : {
                  kind: 'ended',
                  from: current.from,
                  label: current.kind === 'incoming' ? current.name : current.label,
                };
          cardNow.current = next;
          setCard(next);
          void queryClient.invalidateQueries({ queryKey: TELEPHONY_KEY });
          break;
        }
      }
    },
    [claim, queryClient, setDismissed, t],
  );
  // The widget is given a relay that reads the newest handler: the widget outlives renders.
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  // Start Envo's phone: its script from the connection's host, a fresh token, headless. Runs
  // again only for another connection, another extension or a new start.
  useEffect(() => {
    let cancelled = false;
    let instance: EnvoPhone | null = null;
    let settled = false;
    let destroyWhenSettled = false;
    const relay = (event: EnvoPhoneEvent) => {
      if (event.type === 'ready' || event.type === 'error') {
        settled = true;
        if (destroyWhenSettled) {
          instance?.destroy();
          return;
        }
      }
      if (cancelled || widget.current !== instance) return;
      handler.current(event);
    };
    void (async () => {
      try {
        const envo = await loadEnvo(phone.baseUrl);
        const minted = await phoneToken();
        if (cancelled) return;
        // The phone registers over `wss://<Envo's SIP domain>/ws`: a host this console's policy
        // does not list would be refused by the browser without a word, so say it here.
        if (!phoneSocketAllowed(minted.sipDomain)) {
          setRegistration('error');
          setProblem(t('tel.phone.socketBlocked', { host: minted.sipDomain ?? '' }));
          return;
        }
        instance = envo.phone({
          token: minted.token,
          baseUrl: phone.baseUrl,
          headless: true,
          position: 'bottom-right',
          onEvent: relay,
        });
        widget.current = instance;
      } catch (error) {
        if (cancelled) return;
        setRegistration('error');
        setProblem(startProblem(error, t));
      }
    })();
    return () => {
      cancelled = true;
      if (widget.current === instance) widget.current = null;
      if (instance !== null) {
        if (settled) instance.destroy();
        else destroyWhenSettled = true;
      }
    };
    // `t` is the same from render to render (useTelT): the phone starts again only for another
    // connection, another extension or a new attempt.
  }, [phone.baseUrl, phone.extension, attempt, t]);

  // Still connecting after a few seconds: say so.
  useEffect(() => {
    if (registration !== 'starting' && registration !== 'connecting') return;
    const timer = window.setTimeout(() => setSlow(true), CONNECTING_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [registration, attempt]);

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

  // The screen pop. A ringing call may be asked about before Envo's word of it has reached the
  // ERP (the phone rings first): a ringing card that names nobody yet asks again every two
  // seconds for its first moments (D-843).
  const caller = useQuery({
    queryKey: [...TELEPHONY_KEY, 'lookup', card === null ? '' : nationalDigits(card.from)],
    queryFn: () => lookupCaller(card?.from ?? ''),
    enabled: card !== null && card.from !== '',
    staleTime: 30_000,
    refetchInterval: (query) => lookupAgainIn(card, query.state.data?.customer ?? null, Date.now()),
  });

  const restart = () => {
    setProblem(null);
    setRegistration('starting');
    setSlow(false);
    setAttempt((value) => value + 1);
  };

  if (card === null) {
    if (dismissed) return null;
    if (registration === 'error') {
      return (
        <StatusBar
          t={t}
          tone="error"
          text={t('tel.phone.error', { reason: problem ?? t('tel.failed') })}
          onRestart={restart}
          onDismiss={() => setDismissed(true)}
        />
      );
    }
    if (registration === 'offline') {
      return (
        <StatusBar
          t={t}
          tone="error"
          text={t('tel.phone.offlineDetail', { extension: phone.extension })}
          onRestart={restart}
          onDismiss={() => setDismissed(true)}
        />
      );
    }
    if ((registration === 'starting' || registration === 'connecting') && slow) {
      return (
        <StatusBar
          t={t}
          tone="muted"
          text={t('tel.phone.connectingDetail', { extension: phone.extension })}
          onRestart={restart}
          onDismiss={() => setDismissed(true)}
        />
      );
    }
    return null;
  }

  const lookup = caller.data;
  const name =
    lookup?.customer?.name ?? (card.kind === 'incoming' ? card.name : card.label) ?? null;
  const ringing = card.kind === 'incoming';
  const state =
    card.kind === 'incoming'
      ? t('tel.phone.incoming')
      : card.kind === 'ringBack'
        ? t('tel.phone.ringBack', { name: card.label })
        : card.kind === 'active'
          ? t('tel.phone.onCall')
          : t('tel.phone.ended');
  const orderStatus = (status: string): string | null =>
    ORDER_STATUSES.has(status) ? appT(`orders.status.${status}` as MessageKey) : null;

  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md justify-center">
      <section
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
              {/* Only the state is announced: the clock below ticks every second. */}
              <span role="status" aria-live="polite">
                {state}
              </span>
              {card.kind === 'active' ? (
                <span aria-hidden="true" className="tabular-nums">
                  · {clock(now - card.since)}
                </span>
              ) : null}
            </p>
            {/* A number the ERP names nobody for may still be a buyer this person may not
                open: "Caller", never "not a customer". */}
            <p className="truncate text-base font-semibold">
              {name ?? (lookup?.phone === null ? t('tel.phone.unknown') : t('tel.phone.caller'))}
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
                    <span className="text-muted-foreground">{orderStatus(order.status)}</span>
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
