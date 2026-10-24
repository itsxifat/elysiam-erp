import type { MessageKey } from '@elysium/i18n';
import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  PageHeader,
  PermissionGate,
  Select,
  Skeleton,
  StatCard,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { listAgents } from './api.js';
import '../../alive/alive.css';
import { LiveIndicator, OrdersNav } from './parts.js';
import { ordersPath } from './paths.js';
import {
  assignOrder,
  listQueueOf,
  teamBoard,
  type PresenceState,
  type TeamMember,
} from './workflow-api.js';

/**
 * The supervisors' team board (M41, D-720): who is active, idle or away in the ERP, who is not
 * taking orders, what each holds, what they confirmed today and the order they are being
 * offered; and, under each person, their open orders with a reassign. Live from presence and
 * order events, and refreshed every thirty seconds besides, since "away" is a silence nobody
 * announces.
 */

const BOARD_EVENTS = [
  'team.presence_changed',
  'order.claimed',
  'order.assigned',
  'order.released',
  'order.status_changed',
] as const;

const PRESENCE_TONE: Readonly<Record<PresenceState, 'success' | 'warning' | 'neutral'>> = {
  active: 'success',
  idle: 'warning',
  away: 'neutral',
};

const PRESENCE_LABEL: Readonly<Record<PresenceState, MessageKey>> = {
  active: 'wf.status.active',
  idle: 'wf.status.idle',
  away: 'wf.status.away',
};

export function TeamBoardPage() {
  const ability = useAbility();
  const t = useT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'OrderWorkflow')}
      explain={{ title: t('wf.team.title'), detail: t('wf.team.denied') }}
    >
      <Board />
    </PermissionGate>
  );
}

function Board() {
  const t = useT();
  const queryClient = useQueryClient();
  const onEvent = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['orders', 'team-board'] });
  }, [queryClient]);
  const live = useRealtime({ events: BOARD_EVENTS, onEvent });
  const board = useQuery({
    queryKey: ['orders', 'team-board'],
    queryFn: teamBoard,
    refetchInterval: 30_000,
  });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('wf.team.title')}
        description={t('wf.team.subtitle')}
        meta={<LiveIndicator status={live} />}
        tabs={<OrdersNav />}
      />
      {board.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <span className="sr-only">{t('wf.loading')}</span>
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-row w-full" />
          ))}
        </div>
      ) : board.isError ? (
        <ErrorState
          title={t('wf.failed')}
          action={
            <Button variant="outline" size="sm" onClick={() => void board.refetch()}>
              {t('wf.retry')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label={t('wf.team.waiting')} value={String(board.data.waiting)} />
            <StatCard
              label={t('wf.settings.title')}
              value={board.data.settings.autoAssign ? t('wf.team.autoOn') : t('wf.team.autoOff')}
            />
            <StatCard
              label={t('wf.status.active')}
              value={String(
                board.data.people.filter((person) => person.presence.state === 'active').length,
              )}
            />
          </div>
          {board.data.people.length === 0 ? (
            <EmptyState title={t('wf.team.empty')} detail={t('wf.desk.emptyDetail')} />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-sm" data-testid="team-board">
                <caption className="sr-only">{t('wf.team.title')}</caption>
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                    <th className="px-3 py-2 font-medium">{t('wf.team.person')}</th>
                    <th className="px-3 py-2 font-medium">{t('wf.team.status')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('wf.team.open')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('wf.team.confirmed')}</th>
                    <th className="px-3 py-2 font-medium">{t('wf.team.offer')}</th>
                    <th className="px-3 py-2 font-medium">{t('wf.team.lastSeen')}</th>
                  </tr>
                </thead>
                <tbody>
                  {board.data.people.map((person) => (
                    <PersonRows
                      key={person.userId}
                      person={person}
                      people={board.data.people}
                      open={open === person.userId}
                      onToggle={() => setOpen(open === person.userId ? null : person.userId)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PersonRows({
  person,
  people,
  open,
  onToggle,
}: {
  readonly person: TeamMember;
  readonly people: readonly TeamMember[];
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const t = useT();
  return (
    <>
      <tr className="h-row border-b border-border" data-user-id={person.userId}>
        <td className="px-3">
          <button
            type="button"
            aria-expanded={open}
            className="inline-flex items-center gap-1.5 rounded-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onToggle}
          >
            {open ? (
              <ChevronDown aria-hidden="true" className="size-4" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4" />
            )}
            {person.name}
            <span className="sr-only">
              {open ? t('wf.team.hideOrders') : t('wf.team.showOrders')}
            </span>
          </button>
        </td>
        <td className="px-3">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <StatusBadge
              tone={PRESENCE_TONE[person.presence.state]}
              className={person.presence.state === 'active' ? 'alive-presence' : undefined}
            >
              {t(PRESENCE_LABEL[person.presence.state])}
            </StatusBadge>
            {person.presence.paused ? (
              <StatusBadge tone="neutral">{t('wf.status.paused')}</StatusBadge>
            ) : null}
          </span>
        </td>
        <td className="px-3 text-right tabular-nums">{person.openOrders}</td>
        <td className="px-3 text-right tabular-nums">{person.confirmedToday}</td>
        <td className="px-3">
          {person.offer === null ? (
            <span className="text-muted-foreground">{t('wf.team.noOffer')}</span>
          ) : (
            <Link
              to={ordersPath(`/orders/${person.offer.orderId}`)}
              className="underline-offset-4 hover:underline"
            >
              {t('wf.team.offerOpen')}
            </Link>
          )}
        </td>
        <td className="px-3 text-muted-foreground">
          {person.presence.lastSeenAt === null ? (
            '—'
          ) : (
            <DateTime value={person.presence.lastSeenAt} />
          )}
        </td>
      </tr>
      {open ? (
        <tr className="border-b border-border bg-muted/50">
          <td colSpan={6} className="px-3 py-3">
            <PersonOrders person={person} people={people} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function PersonOrders({
  person,
  people,
}: {
  readonly person: TeamMember;
  readonly people: readonly TeamMember[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const orders = useQuery({
    queryKey: ['orders', 'held-by', person.userId],
    queryFn: () => listQueueOf(person.userId),
  });
  const agents = useQuery({
    queryKey: ['orders', 'agents'],
    queryFn: listAgents,
    staleTime: 300_000,
  });
  const reassign = useMutation({
    mutationFn: ({ orderId, to }: { orderId: string; to: string }) => assignOrder(orderId, to),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => setProblem(error instanceof ApiError ? error.message : t('wf.failed')),
  });
  const options = (agents.data?.items ?? people)
    .filter((other) => other.userId !== person.userId)
    .map((other) => ({ value: other.userId, label: other.name }));
  const open = (orders.data?.items ?? []).filter((order) =>
    ['pending', 'on_hold'].includes(order.status),
  );

  if (orders.isPending) return <Skeleton className="h-8 w-full" />;
  if (open.length === 0)
    return <p className="text-sm text-muted-foreground">{t('wf.team.noOrders')}</p>;
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {open.map((order) => (
          <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <Link
              to={ordersPath(`/orders/${order.id}`)}
              className="font-medium tabular-nums underline-offset-4 hover:underline"
            >
              {order.orderNo}
            </Link>
            <span className="text-muted-foreground">{order.customer.name}</span>
            <Select
              size="sm"
              value=""
              aria-label={`${t('wf.team.reassignTo')} ${order.orderNo}`}
              placeholder={t('wf.team.reassignTo')}
              options={options}
              onValueChange={(to) => {
                if (to !== '') reassign.mutate({ orderId: order.id, to });
              }}
            />
          </li>
        ))}
      </ul>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </div>
  );
}
