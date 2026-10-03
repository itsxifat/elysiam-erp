import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Skeleton,
  PageHeader,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { claimOrder, listOrders } from './api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { LiveIndicator, OrdersNav, useOrderEvents } from './parts.js';
import { ordersPath } from './paths.js';

/**
 * §6's unassigned queue, live (M11 Build list; acceptance check 4).
 *
 * The front door of the COD workflow: orders from landing pages, brand websites and
 * colleagues who took an order without keeping it. Every sales agent on shift watches it,
 * so it updates itself — `order.created` and `order.claimed` arrive over the realtime
 * gateway and refetch the list, and a claimed order leaves every other agent's screen the
 * moment it is taken, without anybody pressing refresh.
 *
 * Claim is optimistic about nothing: two agents pressing it together is the ordinary race,
 * the server lets exactly one win (M10's `onlyIfUnassigned`), and the loser is told plainly.
 */
export function OrderQueuePage() {
  const ability = useAbility();
  const t = useOrdersT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Order')}
      explain={{ title: t('orders.deniedTitle'), detail: t('orders.deniedDetail') }}
    >
      <Queue />
    </PermissionGate>
  );
}

function Queue() {
  const t = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const [lost, setLost] = useState<string | null>(null);
  // The events refetch everything keyed `orders`, this list included.
  const live = useOrderEvents();

  const queue = useQuery({
    queryKey: ['orders', 'queue'],
    queryFn: () => listOrders({ queue: 'unassigned', limit: 100, offset: 0 }),
  });

  const claim = useMutation({
    mutationFn: (id: string) => claimOrder(id),
    onSuccess: () => setLost(null),
    onError: (error, id) => {
      setLost(
        error instanceof ApiError && (error.status === 409 || error.status === 404) ? id : null,
      );
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  const mayClaim = ability.can('update', 'Order');
  const items = queue.data?.items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('orders.queue.title')}
        description={t('orders.queue.subtitle')}
        meta={<LiveIndicator status={live} />}
        tabs={<OrdersNav />}
      />

      {lost === null ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {t('orders.queue.lost')}
        </p>
      )}

      {queue.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label={t('orders.loading')}>
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-row w-full" />
          ))}
        </div>
      ) : queue.isError ? (
        <ErrorState
          title={t('orders.errorTitle')}
          detail={t('orders.errorDetail')}
          action={
            <Button variant="outline" size="sm" onClick={() => void queue.refetch()}>
              {t('orders.retry')}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState title={t('orders.queue.emptyTitle')} detail={t('orders.queue.emptyDetail')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm" data-testid="order-queue">
            <caption className="sr-only">{t('orders.queue.title')}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('orders.col.orderNo')}</th>
                <th className="px-3 py-2 font-medium">{t('orders.col.channel')}</th>
                <th className="px-3 py-2 font-medium">{t('orders.col.customer')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('orders.col.cod')}</th>
                <th className="px-3 py-2 font-medium">{t('orders.queue.waiting')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((order) => (
                <tr key={order.id} className="h-row border-b border-border last:border-b-0">
                  <td className="px-3">
                    <Link
                      to={ordersPath(`/orders/${order.id}`)}
                      className="font-medium tabular-nums underline-offset-4 hover:underline"
                    >
                      {order.orderNo}
                    </Link>
                  </td>
                  <td className="px-3">
                    {t(`orders.channel.${order.channel}` as OrdersMessageKey)}
                  </td>
                  <td className="px-3">{order.customer.name}</td>
                  <td className="px-3 text-right">
                    <Money poisha={order.amounts.codAmountPoisha} locale={locale} />
                  </td>
                  <td className="px-3">
                    <DateTime value={order.timestamps.createdAt} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    {mayClaim ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={claim.isPending && claim.variables === order.id}
                        aria-label={`${t('orders.queue.claim')} ${order.orderNo}`}
                        onClick={() => claim.mutate(order.id)}
                      >
                        {t('orders.queue.claim')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
