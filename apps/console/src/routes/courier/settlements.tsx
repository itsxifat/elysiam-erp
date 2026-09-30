import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CloudDownload } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { fetchRuns, fetchSettlements, listAccounts, listSettlements } from './api.js';
import { control, courierPath, CourierHeader } from './courier-nav.js';
import { SETTLEMENT_TONE } from './courier-ui.js';
import { useCourierT, type CourierMessageKey } from './messages.js';

/**
 * Courier settlements (§9's "import → match → exceptions → approval → posting"; M15's fetch).
 *
 * The list of statements, however they arrived — uploaded by a person or fetched from a
 * courier's API — with what matched, what the courier kept in charges, and how many rows are
 * exceptions. A statement opens into its exceptions and the maker's two actions, request
 * approval and reject; the checker decides on the Approvals screen, which is where the journals
 * post (D-088). Nothing on this screen posts anything.
 *
 * "Fetch from courier" queues the fetch job for one courier. Today no real courier's adapter
 * has a settlement API (none of their first-party material describes one), so the server
 * refuses it with that reason for Steadfast, Pathao and RedX, and the button exists for the
 * day one does. Recent fetch runs are listed with what each one did, because an unattended
 * job that skipped a statement silently is cash nobody hears about.
 */
export function CourierSettlementsPage() {
  const t = useCourierT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayRead = ability.can('read', 'CourierSettlement');
  const mayFetch = ability.can('create', 'CourierSettlement');

  const [courierId, setCourierId] = useState('');
  const [notice, setNotice] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);

  const settlements = useQuery({
    queryKey: ['courier', 'settlements'],
    queryFn: listSettlements,
    enabled: mayRead,
  });
  const runs = useQuery({
    queryKey: ['courier', 'fetch-runs'],
    queryFn: fetchRuns,
    enabled: mayRead,
  });
  const accounts = useQuery({
    queryKey: ['courier', 'accounts'],
    queryFn: listAccounts,
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const fetchMutation = useMutation({
    mutationFn: (id: string) => fetchSettlements(id),
    onSuccess: () => {
      setNotice({ tone: 'status', text: t('courier.settlements.fetchQueued') });
      void queryClient.invalidateQueries({ queryKey: ['courier'] });
    },
    onError: (error) =>
      setNotice({
        tone: 'alert',
        text: error instanceof ApiError ? error.message : t('courier.errorTitle'),
      }),
  });

  const accountByCourier = new Map(
    (accounts.data?.items ?? []).map((account) => [account.courierId, account]),
  );
  const items = settlements.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('courier.deniedTitle'), detail: t('courier.deniedDetail') }}
    >
      <div className="space-y-5">
        <CourierHeader
          title={t('courier.settlements.heading')}
          caption={t('courier.settlements.caption')}
          actions={
            mayFetch ? (
              <div className="flex items-center gap-2">
                <select
                  aria-label={t('courier.colCourier')}
                  value={courierId}
                  className={`${control} w-48`}
                  onChange={(event) => setCourierId(event.target.value)}
                >
                  <option value="">{t('courier.allCouriers')}</option>
                  {(accounts.data?.items ?? [])
                    .filter((account) => account.isActive)
                    .map((account) => (
                      <option key={account.id} value={account.courierId}>
                        {account.label}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={courierId === '' || fetchMutation.isPending}
                  onClick={() => fetchMutation.mutate(courierId)}
                >
                  <CloudDownload aria-hidden="true" className="size-4" />
                  {t('courier.settlements.fetchNow')}
                </Button>
              </div>
            ) : undefined
          }
        />

        {notice === null ? null : (
          <p
            role={notice.tone}
            className={`text-sm ${notice.tone === 'alert' ? 'text-destructive' : 'text-muted-foreground'}`}
          >
            {notice.text}
          </p>
        )}

        {settlements.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : settlements.isError ? (
          <ErrorState
            title={t('courier.errorTitle')}
            detail={t('courier.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void settlements.refetch()}>
                {t('courier.retry')}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={t('courier.settlements.emptyTitle')}
            detail={t('courier.settlements.emptyDetail')}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('courier.settlements.heading')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2">
                    {t('courier.settlements.colReference')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colCourier')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.settlements.colDate')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.settlements.colSource')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.settlements.colGross')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.settlements.colCharges')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.settlements.colNet')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.settlements.colExceptions')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colStatus')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="h-row border-b border-border last:border-0">
                    <td className="px-3 font-medium">
                      <Link
                        to={courierPath(`/courier/settlements/${row.id}`)}
                        className="text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {row.reference ?? t('courier.settlements.open')}
                      </Link>
                    </td>
                    <td className="px-3">{accountByCourier.get(row.courierId)?.label ?? '—'}</td>
                    <td className="px-3 tabular-nums">{row.settlementDate}</td>
                    <td className="px-3 text-muted-foreground">
                      {t(`courier.settlements.source.${row.source}` as CourierMessageKey)}
                    </td>
                    <td className="px-3 text-right">
                      <Money poisha={row.matchedGrossPoisha} />
                    </td>
                    <td className="px-3 text-right">
                      <Money poisha={row.matchedChargesPoisha} />
                    </td>
                    <td className="px-3 text-right font-medium">
                      <Money poisha={row.matchedNetPoisha} />
                    </td>
                    <td
                      className={`px-3 text-right tabular-nums ${row.exceptionCount > 0 ? 'font-medium text-destructive' : ''}`}
                    >
                      {row.exceptionCount}
                    </td>
                    <td className="px-3">
                      <StatusBadge tone={SETTLEMENT_TONE[row.status]}>
                        {t(`courier.settlements.status.${row.status}` as CourierMessageKey)}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <section aria-labelledby="fetch-runs-heading" className="space-y-2">
          <h2 id="fetch-runs-heading" className="text-sm font-semibold">
            {t('courier.settlements.fetchRuns')}
          </h2>
          {(runs.data?.items.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('courier.settlements.fetchRunsEmpty')}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {(runs.data?.items ?? []).slice(0, 10).map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
                  <span className="text-muted-foreground">
                    <DateTime value={run.startedAt} />
                  </span>
                  {run.error === null ? (
                    <span className="tabular-nums">
                      {run.seen} {t('courier.settlements.fetchSeen')} · {run.created}{' '}
                      {t('courier.settlements.fetchCreated')} · {run.duplicate}{' '}
                      {t('courier.settlements.fetchDuplicate')} ·{' '}
                      <span className={run.refused > 0 ? 'font-medium text-destructive' : ''}>
                        {run.refused} {t('courier.settlements.fetchRefused')}
                      </span>
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-destructive">{run.error}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </PermissionGate>
  );
}
