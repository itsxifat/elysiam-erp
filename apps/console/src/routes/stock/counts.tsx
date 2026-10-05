import { Button, EmptyState, PermissionGate, Select, StatusBadge, cn } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ClipboardCheck } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import { ScanField } from '../catalog/scan-field.js';
import {
  closeCount,
  getCount,
  listCounts,
  listLocations,
  openCount,
  recordCounts,
  scanCount,
  submitCount,
} from './api.js';
import {
  control,
  Field,
  StockHeader,
  TableFrame,
  TD,
  TD_NUM,
  TH,
  TH_NUM,
  TR,
} from './stock-nav.js';
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
  const t = useT();
  const queryClient = useQueryClient();
  // The answer to the last scan, and a note for figures typed over counted ones (D-606).
  const [scanned, setScanned] = useState<{ text: string; error: boolean } | null>(null);
  const [note, setNote] = useState('');

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
        note,
      ),
    onSuccess: () => {
      setEntered({});
      setNote('');
      refresh();
    },
  });

  // Each scan counts one piece on the open count; the device's key makes a retry count once.
  const scan = useMutation({
    mutationFn: (code: string) =>
      scanCount(openSessionId ?? '', { scanId: crypto.randomUUID(), code }),
    onSuccess: (result) => {
      setScanned({ text: `${result.skuCode}: ${String(result.countedQty)}`, error: false });
      void queryClient.invalidateQueries({ queryKey: ['stock', 'counts', openSessionId] });
    },
    onError: (error) =>
      setScanned({
        text: error instanceof ApiError ? error.message : st('stock.saveFailed'),
        error: true,
      }),
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
  // Typing over a figure already counted (by scans or by hand) is a correction, and a
  // correction says why (D-606).
  const correcting = Object.entries(entered).some(([skuId, value]) => {
    const line = current?.lines.find((entry) => entry.skuId === skuId);
    return (
      line !== undefined &&
      line.countedQty !== null &&
      value.trim() !== '' &&
      Number(value) !== line.countedQty
    );
  });

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('stock.deniedTitle'), detail: st('stock.deniedDetail') }}
    >
      <div className="space-y-6">
        <StockHeader title={st('stock.counts')} description={st('stock.countsHint')} />

        <PermissionGate allowed={mayCount}>
          {/* Starting a count is one choice and one button: no sheet needed. */}
          <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4">
            <Field label={st('stock.location')} id="count-location" className="w-full sm:w-72">
              <Select
                id="count-location"
                value={locationId}
                placeholder={st('stock.allLocations')}
                options={(locations.data?.items ?? [])
                  // A count is of a shelf, so in-transit is not a place to count:
                  // the stock there is in a van and nobody can see it.
                  .filter((location) => location.kind !== 'in_transit')
                  .map((location) => ({
                    value: location.id,
                    label: `${location.code} · ${location.name}`,
                  }))}
                onValueChange={setLocationId}
              />
            </Field>
            <Button disabled={locationId === '' || start.isPending} onClick={() => start.mutate()}>
              {st('stock.openCount')}
            </Button>
          </div>
        </PermissionGate>

        {failure != null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure instanceof ApiError ? failure.message : st('stock.saveFailed')}
          </p>
        ) : null}

        <section aria-label={st('stock.counts')}>
          {(sessions.data?.items ?? []).length === 0 ? (
            <EmptyState icon={ClipboardCheck} title={st('stock.emptyTitle')} />
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card text-sm">
              {(sessions.data?.items ?? []).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-current={row.id === openSessionId ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2.5 text-left',
                      'hover:bg-accent/60 motion-safe:transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
                      row.id === openSessionId && 'bg-selected',
                    )}
                    onClick={() => {
                      setOpenSessionId(row.id);
                      setEntered({});
                    }}
                  >
                    <span className="font-medium text-foreground">
                      {locations.data?.items.find((location) => location.id === row.locationId)
                        ?.code ?? row.locationId}
                    </span>
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
                    <ChevronRight
                      aria-hidden="true"
                      className="ml-auto size-4 text-muted-foreground"
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {current === undefined ? null : (
          <section aria-label={st('stock.colCounted')} className="space-y-3">
            {current.status === 'open' && mayCount ? (
              <ScanField
                label={t('st.count.scanLabel')}
                message={scanned?.text ?? null}
                tone={scanned?.error === true ? 'error' : 'neutral'}
                onCode={(code) => scan.mutate(code)}
              />
            ) : null}
            <TableFrame label={st('stock.counts')}>
              <table className="w-full border-separate border-spacing-0 text-sm">
                <caption className="sr-only">{st('stock.counts')}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      {st('stock.colSku')}
                    </th>
                    <th scope="col" className={TH_NUM}>
                      {st('stock.colSnapshot')}
                    </th>
                    <th scope="col" className={TH_NUM}>
                      {st('stock.colCounted')}
                    </th>
                    <th scope="col" className={TH_NUM}>
                      {st('stock.colVariance')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {current.lines.map((line) => (
                    <tr key={line.skuId} className={TR}>
                      <td className={`${TD} font-medium tabular-nums`}>{line.skuCode}</td>
                      <td className={TD_NUM}>{line.snapshotQty}</td>
                      <td className={`${TD} text-right`}>
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
                          className={cn(control, 'h-control-sm w-24 text-right tabular-nums')}
                          onChange={(event) =>
                            setEntered((previous) => ({
                              ...previous,
                              [line.skuId]: event.target.value,
                            }))
                          }
                        />
                      </td>
                      <td className={TD_NUM}>
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
                            {line.varianceQty > 0
                              ? `+${String(line.varianceQty)}`
                              : line.varianceQty}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>

            <PermissionGate allowed={mayCount}>
              <div className="flex flex-wrap items-center gap-2">
                {correcting ? (
                  <div className="w-full space-y-1.5 sm:w-96">
                    <label htmlFor="count-note" className="text-sm font-medium">
                      {t('st.count.note')}
                    </label>
                    <input
                      id="count-note"
                      value={note}
                      maxLength={500}
                      aria-describedby="count-note-hint"
                      onChange={(event) => setNote(event.target.value)}
                      className={control}
                    />
                    <p id="count-note-hint" className="text-xs text-muted-foreground">
                      {t('st.count.noteHint')}
                    </p>
                  </div>
                ) : null}
                <Button
                  variant="outline"
                  disabled={
                    current.status !== 'open' ||
                    save.isPending ||
                    (correcting && note.trim() === '')
                  }
                  onClick={() => save.mutate()}
                >
                  {st('stock.colCounted')}
                </Button>
                <Button
                  variant="outline"
                  disabled={current.status !== 'open' || finish.isPending}
                  onClick={() => finish.mutate()}
                >
                  {st('stock.countSubmit')}
                </Button>
                <Button
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
