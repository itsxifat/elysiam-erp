import {
  Button,
  ConfirmDialog,
  DateTime,
  EmptyState,
  ErrorState,
  Input,
  Label,
  PageHeader,
  PermissionGate,
  Select,
  Skeleton,
  StatusBadge,
  TabList,
  cn,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PhoneOff } from 'lucide-react';
import { useId, useState } from 'react';
import { z } from 'zod';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { listAgents } from '../orders/api.js';
import { ordersPath, useSchemaSearch } from '../orders/paths.js';
import {
  hangUpLive,
  listCalls,
  listConnections,
  listExtensions,
  liveCalls,
  TELEPHONY_KEY,
  type CallFilters,
  type LiveCall,
} from './api.js';
import { CallState, DirectionMark, outcomeLabel, partyNumber, talkText } from './call-parts.js';
import { useTelT, type TelephonyKey, type TelT } from './messages.js';
import { RecordingPlayer } from './recording-player.js';

/**
 * The Calls page (M47, D-845): every call through Envo the viewer may see, with filters in the
 * URL (Asia/Dhaka dates, person, direction, answered or missed, order number, phone) and each
 * call's recording; the calls in progress with a supervisor's Hang up; and each extension's state
 * and person. Its own sidebar entry under Sell, for `read PhoneCall`. A lazy route.
 */

const TABS = ['history', 'live', 'extensions'] as const;
type Tab = (typeof TABS)[number];

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);
const searchSchema = z.object({
  tab: z.enum(TABS).catch('history'),
  from: date,
  to: date,
  userId: z.string().max(64).optional().catch(undefined),
  direction: z.enum(['inbound', 'outbound', 'internal']).optional().catch(undefined),
  answered: z.enum(['answered', 'missed']).optional().catch(undefined),
  orderNo: z.string().max(40).optional().catch(undefined),
  phone: z.string().max(32).optional().catch(undefined),
});
type Search = z.infer<typeof searchSchema>;

const EVENTS = ['telephony.call_changed'] as const;

export function CallsPage() {
  const ability = useAbility();
  const t = useTelT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'PhoneCall')}
      explain={{ title: t('tel.page.title'), detail: t('tel.page.denied') }}
    >
      <Calls />
    </PermissionGate>
  );
}

function Calls() {
  const t = useTelT();
  const ability = useAbility();
  const [search, setSearch] = useSchemaSearch(searchSchema);
  const tabs = TABS.filter(
    (tab) =>
      tab === 'history' ||
      (tab === 'live' && ability.can('read', 'Telephony')) ||
      (tab === 'extensions' && ability.can('read', 'PhoneExtension')),
  );
  const tab: Tab = tabs.includes(search.tab) ? search.tab : 'history';
  return (
    <div className="space-y-5">
      <PageHeader title={t('tel.page.title')} description={t('tel.page.subtitle')} />
      {tabs.length > 1 ? (
        <TabList label={t('tel.page.title')}>
          {tabs.map((value) => (
            <button
              key={value}
              type="button"
              aria-current={tab === value ? 'page' : undefined}
              className={cn(tabClassName, tab === value ? tabActiveClassName : null)}
              onClick={() => setSearch({ ...search, tab: value })}
            >
              {t(`tel.tab.${value}`)}
            </button>
          ))}
        </TabList>
      ) : null}
      {tab === 'history' ? (
        <History search={search} setSearch={setSearch} />
      ) : tab === 'live' ? (
        <Live />
      ) : (
        <Extensions />
      )}
    </div>
  );
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function History({
  search,
  setSearch,
}: {
  readonly search: Search;
  readonly setSearch: (next: Search) => void;
}) {
  const t = useTelT();
  const ids = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const supervisor = ability.can('update', 'PhoneCall');
  const agents = useQuery({
    queryKey: ['orders', 'agents'],
    queryFn: listAgents,
    enabled: supervisor,
  });
  const filters: CallFilters = {
    from: search.from,
    to: search.to,
    userId: search.userId,
    direction: search.direction,
    answered: search.answered,
    orderNo: search.orderNo,
    phone: search.phone,
    limit: 50,
  };
  const calls = useInfiniteQuery({
    queryKey: [...TELEPHONY_KEY, 'calls', filters],
    queryFn: ({ pageParam }) =>
      listCalls({ ...filters, ...(pageParam === null ? {} : { cursor: pageParam }) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  useRealtime({
    events: EVENTS,
    onEvent: () => void queryClient.invalidateQueries({ queryKey: [...TELEPHONY_KEY, 'calls'] }),
  });
  const set = (patch: Partial<Search>) => setSearch({ ...search, ...patch });
  const items = calls.data?.pages.flatMap((page) => page.items) ?? [];
  const [orderNo, setOrderNo] = useState(search.orderNo ?? '');
  const [phone, setPhone] = useState(search.phone ?? '');

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          set({
            orderNo: orderNo.trim() === '' ? undefined : orderNo.trim(),
            phone: phone.trim() === '' ? undefined : phone.trim(),
          });
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`${ids}-from`}>{t('tel.filter.from')}</Label>
          <Input
            id={`${ids}-from`}
            type="date"
            value={search.from ?? ''}
            onChange={(event) =>
              set({ from: event.target.value === '' ? undefined : event.target.value })
            }
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-to`}>{t('tel.filter.to')}</Label>
          <Input
            id={`${ids}-to`}
            type="date"
            value={search.to ?? ''}
            onChange={(event) =>
              set({ to: event.target.value === '' ? undefined : event.target.value })
            }
          />
        </div>
        {supervisor ? (
          <div className="w-44 space-y-1">
            <Label htmlFor={`${ids}-person`}>{t('tel.filter.person')}</Label>
            <Select
              id={`${ids}-person`}
              value={search.userId ?? ''}
              onValueChange={(value) => set({ userId: value === '' ? undefined : value })}
              options={[
                { value: '', label: t('tel.filter.anyone') },
                ...(agents.data?.items ?? []).map((agent) => ({
                  value: agent.userId,
                  label: agent.name,
                })),
              ]}
            />
          </div>
        ) : null}
        <div className="w-40 space-y-1">
          <Label htmlFor={`${ids}-direction`}>{t('tel.filter.direction')}</Label>
          <Select
            id={`${ids}-direction`}
            value={search.direction ?? ''}
            onValueChange={(value) =>
              set({ direction: value === '' ? undefined : (value as Search['direction']) })
            }
            options={[
              { value: '', label: t('tel.filter.anyDirection') },
              { value: 'inbound', label: t('tel.direction.inbound') },
              { value: 'outbound', label: t('tel.direction.outbound') },
              { value: 'internal', label: t('tel.direction.internal') },
            ]}
          />
        </div>
        <div className="w-40 space-y-1">
          <Label htmlFor={`${ids}-answered`}>{t('tel.filter.answered')}</Label>
          <Select
            id={`${ids}-answered`}
            value={search.answered ?? ''}
            onValueChange={(value) =>
              set({ answered: value === '' ? undefined : (value as Search['answered']) })
            }
            options={[
              { value: '', label: t('tel.filter.any') },
              { value: 'answered', label: t('tel.answered') },
              { value: 'missed', label: t('tel.missed') },
            ]}
          />
        </div>
        <div className="w-36 space-y-1">
          <Label htmlFor={`${ids}-order`}>{t('tel.filter.orderNo')}</Label>
          <Input
            id={`${ids}-order`}
            value={orderNo}
            autoComplete="off"
            onChange={(event) => setOrderNo(event.target.value)}
          />
        </div>
        <div className="w-36 space-y-1">
          <Label htmlFor={`${ids}-phone`}>{t('tel.filter.phone')}</Label>
          <Input
            id={`${ids}-phone`}
            value={phone}
            inputMode="tel"
            autoComplete="off"
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        <Button type="submit" size="sm" variant="outline">
          {t('tel.filter.apply')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setOrderNo('');
            setPhone('');
            setSearch({ tab: 'history' });
          }}
        >
          {t('tel.filter.clear')}
        </Button>
      </form>

      {calls.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label={t('tel.loading')}>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : calls.isError ? (
        <ErrorState
          title={t('tel.failed')}
          detail={errorText(calls.error, t('tel.failed'))}
          action={
            <Button size="sm" variant="outline" onClick={() => void calls.refetch()}>
              {t('tel.retry')}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState title={t('tel.page.empty')} detail={t('tel.page.emptyDetail')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr className="h-9">
                <th className="px-3 font-medium">{t('tel.col.when')}</th>
                <th className="px-3 font-medium">{t('tel.col.direction')}</th>
                <th className="px-3 font-medium">{t('tel.col.number')}</th>
                <th className="px-3 font-medium">{t('tel.col.customer')}</th>
                <th className="px-3 font-medium">{t('tel.col.order')}</th>
                <th className="px-3 font-medium">{t('tel.col.person')}</th>
                <th className="px-3 text-right font-medium">{t('tel.col.talk')}</th>
                <th className="px-3 font-medium">{t('tel.col.status')}</th>
                <th className="px-3 font-medium">{t('tel.col.recording')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((call) => (
                <tr key={call.id} className="h-9 align-middle">
                  <td className="px-3 whitespace-nowrap tabular-nums">
                    <DateTime value={call.occurredAt} />
                  </td>
                  <td className="px-3">
                    <DirectionMark call={call} />
                  </td>
                  <td className="px-3 tabular-nums">{partyNumber(call)}</td>
                  <td className="px-3">
                    {call.customer === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Link
                        to={ordersPath(`/customers/${call.customer.id}`)}
                        className="underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {call.customer.name ?? '—'}
                      </Link>
                    )}
                  </td>
                  <td className="px-3">
                    {call.order === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <Link
                          to={ordersPath(`/orders/${call.order.id}`)}
                          className="tabular-nums underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {call.order.orderNo}
                        </Link>
                        {call.outcome === null ? null : (
                          <StatusBadge tone="neutral">{outcomeLabel(t, call.outcome)}</StatusBadge>
                        )}
                      </span>
                    )}
                  </td>
                  <td className="px-3">{call.person?.name ?? call.extension ?? '—'}</td>
                  <td className="px-3 text-right tabular-nums">{talkText(call)}</td>
                  <td className="px-3">
                    <CallState call={call} />
                  </td>
                  <td className="px-3 py-1">
                    <RecordingPlayer call={call} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {calls.hasNextPage ? (
        <Button
          size="sm"
          variant="outline"
          disabled={calls.isFetchingNextPage}
          onClick={() => void calls.fetchNextPage()}
        >
          {calls.isFetchingNextPage ? t('tel.loading') : t('tel.page.more')}
        </Button>
      ) : null}
    </div>
  );
}

/** The connections a supervisor may look at live, and the one chosen. */
function useConnections() {
  const connections = useQuery({
    queryKey: [...TELEPHONY_KEY, 'connections'],
    queryFn: listConnections,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const list = connections.data?.connections ?? [];
  const id = chosen ?? list[0]?.id ?? null;
  return { connections, list, id, setChosen };
}

function ConnectionPicker({
  list,
  id,
  onChange,
}: {
  readonly list: readonly { readonly id: string; readonly name: string }[];
  readonly id: string | null;
  readonly onChange: (id: string) => void;
}) {
  const t = useTelT();
  const ids = useId();
  if (list.length < 2) return null;
  return (
    <div className="w-56 space-y-1">
      <Label htmlFor={`${ids}-connection`}>{t('tel.live.connection')}</Label>
      <Select
        id={`${ids}-connection`}
        value={id ?? ''}
        onValueChange={onChange}
        options={list.map((row) => ({ value: row.id, label: row.name }))}
      />
    </div>
  );
}

/** Envo's live call state (`talking`, or Asterisk's channel state lower-cased), in words. */
const LIVE_STATES = new Set(['talking', 'ring', 'ringing', 'up', 'down', 'busy', 'dialing']);
function liveState(state: string, t: TelT): string {
  return LIVE_STATES.has(state)
    ? t(`tel.live.state.${state}` as TelephonyKey)
    : t('tel.live.state.other');
}

/** Envo's extension state (Asterisk's device state as Envo names it), or nothing to add. */
const EXTENSION_STATES = new Set(['idle', 'inuse', 'busy', 'ringing', 'onhold', 'removed']);
function extensionState(status: string, t: TelT): string | null {
  return EXTENSION_STATES.has(status) ? t(`tel.ext.state.${status}` as TelephonyKey) : null;
}

function Live() {
  const t = useTelT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const { connections, list, id, setChosen } = useConnections();
  const [ending, setEnding] = useState<LiveCall | null>(null);
  const [hangUpProblem, setHangUpProblem] = useState<string | null>(null);
  const live = useQuery({
    queryKey: [...TELEPHONY_KEY, 'live', id],
    queryFn: () => liveCalls(id ?? ''),
    enabled: id !== null,
    refetchInterval: 5_000,
  });
  const hangUp = useMutation({
    mutationFn: (call: LiveCall) => hangUpLive(id ?? '', call.id),
    onMutate: () => setHangUpProblem(null),
    onError: (error) =>
      setHangUpProblem(t('tel.live.hangUpFailed', { reason: errorText(error, t('tel.failed')) })),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: [...TELEPHONY_KEY, 'live'] }),
  });
  if (connections.isPending) return <Skeleton className="h-24 w-full" />;
  if (list.length === 0)
    return <EmptyState title={t('tel.settings.none')} detail={t('tel.settings.noneDetail')} />;
  const items = live.data?.items ?? [];
  return (
    <div className="space-y-4">
      <ConnectionPicker list={list} id={id} onChange={setChosen} />
      {hangUpProblem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {hangUpProblem}
        </p>
      )}
      {live.isError ? (
        <ErrorState
          title={t('tel.failed')}
          detail={t('tel.live.unavailable', { reason: errorText(live.error, t('tel.failed')) })}
        />
      ) : items.length === 0 ? (
        <EmptyState title={t('tel.live.empty')} />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((call) => (
            <li key={call.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="tabular-nums">{call.from ?? '—'}</span>
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
              <span className="tabular-nums">{call.to ?? '—'}</span>
              <StatusBadge tone="info">{liveState(call.state, t)}</StatusBadge>
              <span className="text-muted-foreground tabular-nums">
                {`${String(Math.floor(call.durationSec / 60))}:${String(call.durationSec % 60).padStart(2, '0')}`}
              </span>
              {call.call?.person?.name == null ? null : (
                <span className="text-muted-foreground">{call.call.person.name}</span>
              )}
              {call.call?.customerName == null ? null : <span>{call.call.customerName}</span>}
              {call.call?.orderNo == null ? null : (
                <span className="text-muted-foreground tabular-nums">{call.call.orderNo}</span>
              )}
              {ability.can('update', 'PhoneCall') ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => setEnding(call)}
                >
                  <PhoneOff aria-hidden="true" />
                  {t('tel.live.hangUp')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(open) => {
          if (!open) setEnding(null);
        }}
        title={t('tel.live.hangUp')}
        description={t('tel.live.hangUpConfirm')}
        confirmLabel={t('tel.live.hangUp')}
        cancelLabel={t('tel.cancel')}
        closeLabel={t('tel.close')}
        destructive
        onConfirm={async () => {
          // A refusal (the call already over, Envo's reason) closes the dialog and is said above.
          if (ending !== null) await hangUp.mutateAsync(ending).catch(() => undefined);
        }}
      />
    </div>
  );
}

function Extensions() {
  const t = useTelT();
  const { connections, list, id, setChosen } = useConnections();
  const extensions = useQuery({
    queryKey: [...TELEPHONY_KEY, 'extensions', id],
    queryFn: () => listExtensions(id ?? ''),
    enabled: id !== null,
    refetchInterval: 15_000,
  });
  if (connections.isPending) return <Skeleton className="h-24 w-full" />;
  if (list.length === 0)
    return <EmptyState title={t('tel.settings.none')} detail={t('tel.settings.noneDetail')} />;
  const view = extensions.data;
  return (
    <div className="space-y-4">
      <ConnectionPicker list={list} id={id} onChange={setChosen} />
      {view?.liveError == null ? null : (
        <p
          role="status"
          className="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground"
        >
          {t('tel.settings.liveError', { reason: view.liveError })}
        </p>
      )}
      {extensions.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr className="h-9">
                <th className="px-3 font-medium">{t('tel.ext.extension')}</th>
                <th className="px-3 font-medium">{t('tel.settings.name')}</th>
                <th className="px-3 font-medium">{t('tel.ext.person')}</th>
                <th className="px-3 font-medium">{t('tel.ext.state')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(view?.extensions ?? []).map((row) => (
                <tr key={row.extension} className="h-9">
                  <td className="px-3 tabular-nums">{row.extension}</td>
                  <td className="px-3">{row.name}</td>
                  <td className="px-3">
                    {row.assignee?.name ?? (
                      <span className="text-muted-foreground">{t('tel.ext.nobody')}</span>
                    )}
                  </td>
                  <td className="px-3">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                      <StatusBadge tone={row.online ? 'success' : 'neutral'}>
                        {row.online ? t('tel.ext.online') : t('tel.ext.offline')}
                      </StatusBadge>
                      {row.dnd ? (
                        <StatusBadge tone="warning">{t('tel.ext.dnd')}</StatusBadge>
                      ) : null}
                      {row.webPhone ? (
                        <StatusBadge tone="info">{t('tel.ext.webPhone')}</StatusBadge>
                      ) : null}
                      {row.inEnvo ? null : (
                        <StatusBadge tone="warning">{t('tel.settings.notInEnvo')}</StatusBadge>
                      )}
                      {extensionState(row.status, t) === null ? null : (
                        <span className="text-xs text-muted-foreground">
                          {extensionState(row.status, t)}
                        </span>
                      )}
                    </span>
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
