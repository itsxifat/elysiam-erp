import { Button, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  closeCount,
  getCount,
  listCounts,
  listLocations,
  openCount,
  recordCounts,
  submitCount,
} from './api.js';
import { StockNav } from './stock-nav.js';
import { useStockT, type StockMessageKey } from './messages.js';

/**
 * Stock counts (M07 Build list: "count sessions with variance approval").
 *
 * The screen is built around the thing a count gets wrong in practice. The column
 * headed "System" is the **snapshot taken when the session opened**, not the live
 * level, and it does not move while people are counting. A screen that showed the live
 * number would produce a difference for every sale that happened during the count, and
 * the staff who did the counting are the ones who get asked about it.
 *
 * Three buttons, in the order the work happens, because they are three different
 * decisions:
 *
 * * **Start a count** freezes the snapshot for a location;
 * * **Finish counting** closes the entry step — nothing has changed yet;
 * * **Send differences for approval** raises up to two approvals, a write-off for what
 *   came up short and a gain for what came up long. Never a net figure: §7 gives them
 *   different accounts, and a floor full of miscounts that nets to zero is exactly the
 *   case where netting hides the problem.
 *
 * Stock does not move at any of those three points. It moves when a checker approves,
 * and the screen says so rather than implying the count itself changed anything.
 */

export function StockCountsPage() {
  const ability = useAbility();
  const st = useStockT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Stock');
  const mayCount = ability.can('request', 'StockAdjustment');

  const [locationId, setLocationId] = useState('');
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [entered, setEntered] = useState<Readonly<Record<string, string>>>({});

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    staleTime: 5 * 60_000,
  });

  const sessions = useQuery({
    queryKey: ['stock', 'counts'],
    queryFn: listCounts,
    enabled: mayRead,
  });

  const session = useQuery({
    queryKey: ['stock', 'counts', openSessionId],
    queryFn: () => getCount(openSessionId ?? ''),
    enabled: openSessionId !== null,
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['stock'] });

  const start = useMutation({
    mutationFn: () => openCount({ locationId }),
    onSuccess: (created) => {
      setOpenSessionId(created.id);
      setEntered({});
      refresh();
    },
  });

  const save = useMutation({
    mutationFn: () =>
      recordCounts(
        openSessionId ?? '',
        Object.entries(entered)
          .filter(([, value]) => value.trim() !== '')
          .map(([skuId, value]) => ({ skuId, countedQty: Number(value) })),
      ),
    onSuccess: refresh,
  });

  const finish = useMutation({
    mutationFn: () => submitCount(openSessionId ?? ''),
    onSuccess: refresh,
  });

  const send = useMutation({
    mutationFn: () => closeCount(openSessionId ?? ''),
    onSuccess: refresh,
  });

  const current = session.data;
  const failure = [start.error, save.error, finish.error, send.error].find(
    (error) => error != null,
  );

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('stock.deniedTitle'), detail: st('stock.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{st('stock.counts')}</h1>
          <p className="text-sm text-muted-foreground">{st('stock.countsHint')}</p>
        </header>

        <StockNav />

        <PermissionGate allowed={mayCount}>
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
            <div className="space-y-1">
              <label htmlFor="count-location" className="text-xs font-medium text-muted-foreground">
                {st('stock.location')}
              </label>
              <select
                id="count-location"
                value={locationId}
                className="h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{st('stock.allLocations')}</option>
                {(locations.data?.items ?? [])
                  // A count is of a shelf, so in-transit is not a place to count:
                  // the stock there is in a van and nobody can see it.
                  .filter((location) => location.kind !== 'in_transit')
                  .map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.code} · {location.name}
                    </option>
                  ))}
              </select>
            </div>
            <Button
              size="sm"
              disabled={locationId === '' || start.isPending}
              onClick={() => start.mutate()}
            >
              {st('stock.openCount')}
            </Button>
          </div>
        </PermissionGate>

        {failure != null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure instanceof ApiError ? failure.message : st('stock.saveFailed')}
          </p>
        ) : null}

        <section aria-label={st('stock.counts')} className="space-y-2">
          <ul className="space-y-1 text-sm">
            {(sessions.data?.items ?? []).map((row) => (
              <li key={row.id} className="flex items-center gap-3">
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                  onClick={() => {
                    setOpenSessionId(row.id);
                    setEntered({});
                  }}
                >
                  {locations.data?.items.find((location) => location.id === row.locationId)?.code ??
                    row.locationId}
                </button>
                <StatusBadge
                  tone={
                    row.status === 'open'
                      ? 'info'
                      : row.status === 'submitted'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {st(`stock.status.${row.status}` as StockMessageKey)}
                </StatusBadge>
              </li>
            ))}
          </ul>
          {(sessions.data?.items ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{st('stock.emptyTitle')}</p>
          ) : null}
        </section>

        {current === undefined ? null : (
          <section
            aria-label={st('stock.colCounted')}
            className="space-y-3 rounded-lg border border-border bg-card p-4"
          >
            <table className="w-full text-sm">
              <caption className="sr-only">{st('stock.counts')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {st('stock.colSku')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('stock.colSnapshot')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('stock.colCounted')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('stock.colVariance')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {current.lines.map((line) => (
                  <tr key={line.skuId} className="border-b border-border/60">
                    <td className="py-2 font-medium tabular-nums">{line.skuCode}</td>
                    <td className="py-2 text-right tabular-nums">{line.snapshotQty}</td>
                    <td className="py-2 text-right">
                      <label className="sr-only" htmlFor={`count-${line.skuId}`}>
                        {`${st('stock.colCounted')} ${line.skuCode}`}
                      </label>
                      <input
                        id={`count-${line.skuId}`}
                        type="number"
                        min={0}
                        step={1}
                        disabled={current.status !== 'open' || !mayCount}
                        value={entered[line.skuId] ?? line.countedQty?.toString() ?? ''}
                        className="h-8 w-20 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                        onChange={(event) =>
                          setEntered((previous) => ({
                            ...previous,
                            [line.skuId]: event.target.value,
                          }))
                        }
                      />
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {line.varianceQty === null ? (
                        <span className="text-muted-foreground">{st('stock.uncounted')}</span>
                      ) : (
                        // A sign, not a colour alone: §24's accessibility floor asks
                        // for a label beside every status colour.
                        <span
                          className={
                            line.varianceQty === 0
                              ? ''
                              : line.varianceQty < 0
                                ? 'text-destructive'
                                : 'text-success'
                          }
                        >
                          {line.varianceQty > 0 ? `+${String(line.varianceQty)}` : line.varianceQty}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <PermissionGate allowed={mayCount}>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={current.status !== 'open' || save.isPending}
                  onClick={() => save.mutate()}
                >
                  {st('stock.colCounted')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={current.status !== 'open' || finish.isPending}
                  onClick={() => finish.mutate()}
                >
                  {st('stock.countSubmit')}
                </Button>
                <Button
                  size="sm"
                  disabled={current.status !== 'submitted' || send.isPending}
                  onClick={() => send.mutate()}
                >
                  {st('stock.countClose')}
                </Button>
                {send.data === undefined ? null : (
                  <p role="status" className="text-sm text-muted-foreground">
                    {st('stock.awaitingApproval')}
                  </p>
                )}
              </div>
            </PermissionGate>
          </section>
        )}
      </div>
    </PermissionGate>
  );
}
