import { Dialog, StatusBadge, cn } from '@elysium/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Radio, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { useRealtime, type RealtimeStatus } from '../../realtime/use-realtime.js';
import type { FraudBadge as Badge, OrderStatus } from './api.js';
import { ordersPath } from './paths.js';
import { DEFAULT_ORDER_SEARCH } from './search.js';
import { isOrdersKey, useOrdersT } from './messages.js';

/**
 * Pieces every orders screen shares: the tab strip, the status badge, the trust badge, the
 * live indicator and the shortcuts list.
 */

// --- tabs -----------------------------------------------------------------------

const TAB =
  'rounded-md px-2.5 py-1 text-sm text-muted-foreground motion-safe:transition-colors motion-safe:duration-fast hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const ACTIVE = { className: `${TAB} bg-muted font-medium text-foreground` };

/**
 * The four orders screens as tabs, each shown only to a caller whose §6 grant reaches it —
 * the sidebar already does this for modules, and a tab that leads to "not available to
 * your role" is the same broken promise one level down.
 */
export function OrdersNav() {
  const t = useOrdersT();
  const ability = useAbility();
  return (
    <nav aria-label={t('orders.title')} className="flex flex-wrap gap-1">
      {ability.can('create', 'Order') ? (
        <Link to={ordersPath('/orders/new')} className={TAB} activeProps={ACTIVE}>
          {t('orders.nav.desk')}
        </Link>
      ) : null}
      <Link to={ordersPath('/orders/queue')} className={TAB} activeProps={ACTIVE}>
        {t('orders.nav.queue')}
      </Link>
      <Link
        to={ordersPath('/orders')}
        search={DEFAULT_ORDER_SEARCH as never}
        className={TAB}
        activeProps={ACTIVE}
        activeOptions={{ exact: true, includeSearch: false }}
      >
        {t('orders.nav.list')}
      </Link>
      {ability.can('export', 'BuyerExport') ? (
        <Link
          to={ordersPath('/orders/buyers')}
          search={{ page: 1 } as never}
          className={TAB}
          activeProps={ACTIVE}
        >
          {t('orders.nav.buyers')}
        </Link>
      ) : null}
    </nav>
  );
}

// --- status -----------------------------------------------------------------------

const STATUS_TONE: Readonly<
  Record<OrderStatus, 'neutral' | 'success' | 'warning' | 'danger' | 'info'>
> = {
  pending: 'warning',
  confirmed: 'info',
  on_hold: 'warning',
  packed: 'info',
  shipped: 'info',
  delivered: 'success',
  partially_delivered: 'success',
  return_in_transit: 'danger',
  returned: 'danger',
  cancelled: 'neutral',
  exchange: 'neutral',
};

/** A status as a badge: colour and a word, never colour alone (§24's accessibility floor). */
export function OrderStatusBadge({ status }: { readonly status: OrderStatus }) {
  const t = useOrdersT();
  const key = `orders.status.${status}`;
  return <StatusBadge tone={STATUS_TONE[status]}>{isOrdersKey(key) ? t(key) : status}</StatusBadge>;
}

// --- trust ---------------------------------------------------------------------------

const DECISION_TONE = {
  allow: 'success',
  warn: 'warning',
  require_advance: 'warning',
  block: 'danger',
} as const;

/**
 * M13's badge, as the desk renders it: the score, the decision, the reasons, and whether
 * the courier network answered.
 *
 * `providerAvailable: false` is said in words rather than left for the agent to infer from
 * a missing reason — a score computed from our own history alone is a weaker signal, and a
 * desk that cannot tell the two apart treats them the same.
 */
export function FraudBadgeView({
  state,
  badge,
}: {
  readonly state: 'idle' | 'loading' | 'error' | 'ready';
  readonly badge?: Badge | undefined;
}) {
  const t = useOrdersT();
  if (state === 'idle') {
    return <p className="text-xs text-muted-foreground">{t('orders.fraud.noPhone')}</p>;
  }
  if (state === 'loading') {
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t('orders.fraud.checking')}
      </p>
    );
  }
  if (state === 'error' || badge === undefined) {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldQuestion aria-hidden="true" className="size-4" />
        {t('orders.fraud.unavailable')}
      </p>
    );
  }

  const Icon = badge.decision === 'allow' ? ShieldCheck : ShieldAlert;
  const decisionKey = `orders.fraud.${badge.decision}`;
  return (
    <div className="space-y-1.5" data-testid="fraud-badge">
      <div className="flex items-center gap-2">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('orders.fraud.title')}</span>
        <span className="text-sm font-semibold tabular-nums">{badge.trustScore}</span>
        <StatusBadge tone={DECISION_TONE[badge.decision]}>
          {isOrdersKey(decisionKey) ? t(decisionKey) : badge.decision}
        </StatusBadge>
      </div>
      {badge.providerAvailable ? null : (
        <p className="text-xs text-muted-foreground">{t('orders.fraud.providerUnavailable')}</p>
      )}
      {badge.reasons.length === 0 ? null : (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {badge.reasons
            .filter((reason) => reason.code !== 'provider_unavailable')
            .map((reason) => {
              const key = `orders.fraud.reason.${reason.code}`;
              return (
                <li key={reason.code} className="flex justify-between gap-3">
                  <span>{isOrdersKey(key) ? t(key) : reason.code}</span>
                  {reason.delta === 0 ? null : (
                    <span className="tabular-nums">
                      {reason.delta > 0 ? '+' : ''}
                      {reason.delta}
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

// --- realtime ---------------------------------------------------------------------------

/**
 * §19's order events, turned into refetches of whatever order data is on screen.
 *
 * The payload is not read — §19's rule: payloads are for the widest audience, the screen
 * refetches over REST where §6 applies. `order.created` reaches every sales agent in the
 * brand, and what their queue then shows is decided by the scope on the refetch, not by the
 * event.
 */
const ORDER_EVENTS = [
  'order.created',
  'order.claimed',
  'order.assigned',
  'order.status_changed',
] as const;

export function useOrderEvents(): RealtimeStatus {
  const queryClient = useQueryClient();
  const onEvent = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  }, [queryClient]);
  return useRealtime({ events: ORDER_EVENTS, onEvent });
}

export function LiveIndicator({ status }: { readonly status: RealtimeStatus }) {
  const t = useOrdersT();
  const label =
    status === 'connected'
      ? t('orders.live.connected')
      : status === 'connecting'
        ? t('orders.live.connecting')
        : t('orders.live.disconnected');
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      data-live={status}
      role="status"
    >
      <Radio
        aria-hidden="true"
        className={cn(
          'size-3.5',
          status === 'connected' ? 'text-success' : 'text-muted-foreground',
        )}
      />
      {label}
    </span>
  );
}

// --- shortcuts ------------------------------------------------------------------------

export interface Shortcut {
  readonly keys: readonly string[];
  readonly label: ReactNode;
}

/** The shortcuts list, as a dialog: focus trapped, Escape closes it (§24). */
export function ShortcutsHelp({
  open,
  onOpenChange,
  shortcuts,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly shortcuts: readonly Shortcut[];
}) {
  const t = useOrdersT();
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('orders.keys.title')}
      closeLabel={t('orders.close')}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.keys.join('+')} className="contents">
            <dt className="flex gap-1">
              {shortcut.keys.map((key) => (
                <kbd
                  key={key}
                  className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs"
                >
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="text-muted-foreground">{shortcut.label}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
