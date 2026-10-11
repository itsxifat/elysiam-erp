import type { MessageKey } from '@elysium/i18n';
import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  PermissionGate,
  Skeleton,
  StatusBadge,
  TabList,
  cn,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { z } from 'zod';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import { listAgents } from './api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { LiveIndicator, OrderStatusBadge, OrdersNav, useOrderEvents } from './parts.js';
import { ordersPath, useSchemaSearch } from './paths.js';
import { listQueue, takeOrder, type QueuedOrder, type WorkflowQueue } from './workflow-api.js';
import { useNow } from './use-now.js';
import { callBackIsDue } from './workflow-logic.js';

/**
 * The sales desk (M11's queue, M41: D-711, D-718, D-719).
 *
 * Five tabs, each a server queue in the caller's §6 scope: **New** (nobody has it yet, oldest
 * first), **Mine** (my pending orders, due call-backs first), **Verifying** (being called),
 * **Call-backs due** and **Confirmed today**, where the desk follows each order through the
 * hub. Live: order events refetch the list, so an order someone takes leaves New at once.
 *
 * Take is optimistic about nothing: two people pressing it together is the ordinary race; the
 * server lets one win and tells the other who did.
 */

const DESK_TABS = ['new', 'mine', 'verifying', 'callbacks', 'confirmed_today'] as const;
type DeskTab = (typeof DESK_TABS)[number];

const deskSearchSchema = z.object({ tab: z.enum(DESK_TABS).catch('new') });

const TAB_LABEL: Readonly<Record<DeskTab, MessageKey>> = {
  new: 'wf.desk.new',
  mine: 'wf.desk.mine',
  verifying: 'wf.desk.verifying',
  callbacks: 'wf.desk.callbacks',
  confirmed_today: 'wf.desk.confirmed',
};

export function OrderQueuePage() {
  const ability = useAbility();
  const t = useOrdersT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Order')}
      explain={{ title: t('orders.deniedTitle'), detail: t('orders.deniedDetail') }}
    >
      <Desk />
    </PermissionGate>
  );
}

function Desk() {
  const t = useT();
  const live = useOrderEvents();
  const [search, setSearch] = useSchemaSearch(deskSearchSchema);
  const tab = search.tab;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('wf.desk.title')}
        description={t('wf.desk.subtitle')}
        meta={<LiveIndicator status={live} />}
        tabs={<OrdersNav />}
      />
      <TabList label={t('wf.desk.title')}>
        {DESK_TABS.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={tab === value ? 'page' : undefined}
            data-testid={`desk-tab-${value}`}
            className={cn(tabClassName, tab === value ? tabActiveClassName : null)}
            onClick={() => setSearch({ tab: value })}
          >
            {t(TAB_LABEL[value])}
          </button>
        ))}
      </TabList>
      <QueueTable tab={tab} />
    </div>
  );
}

function QueueTable({ tab }: { readonly tab: DeskTab }) {
  const t = useT();
  const to = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const [lost, setLost] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['orders', 'desk', tab],
    queryFn: () => listQueue(tab as WorkflowQueue, tab === 'mine' ? { status: 'pending' } : {}),
    refetchInterval: 30_000,
  });
  const agents = useQuery({
    queryKey: ['orders', 'agents'],
    queryFn: listAgents,
    staleTime: 300_000,
  });
  const names = useMemo(
    () => new Map((agents.data?.items ?? []).map((agent) => [agent.userId, agent.name])),
    [agents.data],
  );

  const take = useMutation({
    mutationFn: (id: string) => takeOrder(id),
    onSuccess: () => setLost(null),
    onError: (error) => setLost(error instanceof ApiError ? error.message : t('wf.failed')),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['orders'] }),
  });

  const mayTake = ability.can('update', 'Order');
  const items: readonly QueuedOrder[] = queue.data?.items ?? [];
  const now = useNow(30_000);

  if (queue.isPending) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t('wf.loading')}>
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-row w-full" />
        ))}
      </div>
    );
  }
  if (queue.isError) {
    return (
      <ErrorState
        title={to('orders.errorTitle')}
        detail={to('orders.errorDetail')}
        action={
          <Button variant="outline" size="sm" onClick={() => void queue.refetch()}>
            {t('wf.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {lost === null ? null : (
        <p role="status" className="text-sm text-muted-foreground" data-testid="take-lost">
          {t('wf.own.taken')} {lost}
        </p>
      )}
      {items.length === 0 ? (
        tab === 'new' ? (
          <EmptyState title={t('wf.desk.emptyNew')} detail={t('wf.desk.emptyNewDetail')} />
        ) : (
          <EmptyState title={t('wf.desk.empty')} detail={t('wf.desk.emptyDetail')} />
        )
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm" data-testid="order-queue">
            <caption className="sr-only">{t(TAB_LABEL[tab])}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{to('orders.col.orderNo')}</th>
                <th className="px-3 py-2 font-medium">{to('orders.col.channel')}</th>
                <th className="px-3 py-2 font-medium">{to('orders.col.customer')}</th>
                <th className="px-3 py-2 text-right font-medium">{to('orders.col.cod')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('wf.desk.calls')}</th>
                <th className="px-3 py-2 font-medium">
                  {tab === 'confirmed_today' ? t('wf.stage') : t('wf.calls.callBack')}
                </th>
                <th className="px-3 py-2 font-medium">
                  {tab === 'new' ? t('wf.waitingSince') : t('wf.owner')}
                </th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((order) => (
                <tr
                  key={order.id}
                  className="h-row border-b border-border last:border-b-0"
                  data-order-id={order.id}
                >
                  <td className="px-3">
                    <Link
                      to={ordersPath(`/orders/${order.id}`)}
                      className="font-medium tabular-nums underline-offset-4 hover:underline"
                    >
                      {order.orderNo}
                    </Link>
                  </td>
                  <td className="px-3">
                    {to(`orders.channel.${order.channel}` as OrdersMessageKey)}
                  </td>
                  <td className="px-3">{order.customer.name}</td>
                  <td className="px-3 text-right">
                    <Money poisha={order.amounts.codAmountPoisha} locale={locale} />
                  </td>
                  <td className="px-3 text-right tabular-nums">{order.calls.attempts}</td>
                  <td className="px-3">
                    {tab === 'confirmed_today' ? (
                      order.hubStage === null ? (
                        <OrderStatusBadge status={order.status} />
                      ) : (
                        <StatusBadge tone={order.hubStage === 'handed_over' ? 'success' : 'info'}>
                          {t(`wf.hub.${order.hubStage}`)}
                        </StatusBadge>
                      )
                    ) : order.calls.callBackAt === null ? null : (
                      <span className="inline-flex items-center gap-1.5">
                        {callBackIsDue(order.calls.callBackAt, now) ? (
                          <StatusBadge tone="warning">{t('wf.calls.due')}</StatusBadge>
                        ) : null}
                        <DateTime value={order.calls.callBackAt} />
                      </span>
                    )}
                  </td>
                  <td className="px-3">
                    {tab === 'new' ? (
                      <DateTime value={order.timestamps.createdAt} />
                    ) : order.assignedTo === null ? (
                      t('wf.nobody')
                    ) : (
                      (names.get(order.assignedTo) ?? t('wf.someone'))
                    )}
                  </td>
                  <td className="px-3 py-1 text-right">
                    {tab === 'new' && mayTake ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={take.isPending && take.variables === order.id}
                        aria-label={`${t('wf.desk.take')} ${order.orderNo}`}
                        onClick={() => take.mutate(order.id)}
                      >
                        {t('wf.desk.take')}
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
