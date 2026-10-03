import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Select,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import {
  escalate,
  fileUrl,
  listAccounts,
  repoll,
  stuckExportPath,
  stuckParcels,
  type StuckParcel,
} from './api.js';
import { control, courierPath, CourierHeader, Field } from './courier-nav.js';
import { PARCEL_TONE, REASON_TONE } from './courier-ui.js';
import { useCourierT, type CourierMessageKey } from './messages.js';

/**
 * The stuck-parcel queue (M15: "this is where COD cash actually goes missing").
 *
 * Three ways onto the list, each named on the row: no status change for N days, a courier
 * word nobody has mapped (listed at once, because that is how a delivered parcel goes
 * unbooked), and a booking that failed. From here a person can ask the courier again for the
 * parcels they pick (the calls happen in the worker), add an escalation note to the parcel's
 * append-only trail, and export a CSV the courier's support desk can work from — carrying
 * their numbers and ours, never the recipient's details.
 */
export function StuckParcelsPage() {
  const t = useCourierT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayRead = ability.can('read', 'Order');
  const mayAct = ability.can('update', 'Order');

  const [threshold, setThreshold] = useState(3);
  const [courierId, setCourierId] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [noting, setNoting] = useState<StuckParcel | null>(null);
  const [note, setNote] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['courier', 'accounts'],
    queryFn: listAccounts,
    enabled: ability.can('read', 'CourierSettlement'),
    staleTime: 5 * 60_000,
  });

  const queue = useQuery({
    queryKey: ['courier', 'stuck', threshold, courierId],
    queryFn: () =>
      stuckParcels({
        thresholdDays: threshold,
        courierId: courierId === '' ? undefined : courierId,
      }),
    enabled: mayRead,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['courier'] });

  const repollMutation = useMutation({
    mutationFn: (ids: readonly string[]) => repoll(ids),
    onSuccess: () => {
      setNotice(t('courier.stuck.repollDone'));
      setSelected(new Set());
      invalidate();
    },
  });

  const noteMutation = useMutation({
    mutationFn: (input: { consignmentId: string; note: string }) =>
      escalate(input.consignmentId, input.note),
    onSuccess: () => {
      setNoting(null);
      setNote('');
      invalidate();
    },
  });

  async function exportCsv() {
    setExportError(null);
    try {
      const url = await fileUrl(
        stuckExportPath(threshold, courierId === '' ? undefined : courierId),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `stuck-parcels-${String(threshold)}d.csv`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('courier.errorTitle'));
    }
  }

  const items = queue.data?.items ?? [];
  // A parcel that never reached a courier cannot be asked about.
  const pollable = items.filter((item) => item.bookingState === 'booked');

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('courier.deniedTitle'), detail: t('courier.deniedDetail') }}
    >
      <div className="space-y-5">
        <CourierHeader
          title={t('courier.stuck.heading')}
          caption={t('courier.stuck.caption')}
          actions={
            <>
              {mayAct ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selected.size === 0 || repollMutation.isPending}
                  onClick={() => repollMutation.mutate([...selected])}
                >
                  <RefreshCw aria-hidden="true" className="size-4" />
                  {t('courier.stuck.repoll')}
                  {selected.size > 0 ? (
                    <span className="text-muted-foreground tabular-nums">({selected.size})</span>
                  ) : null}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => void exportCsv()}>
                <Download aria-hidden="true" className="size-4" />
                {t('courier.stuck.export')}
              </Button>
            </>
          }
        />

        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('courier.stuck.threshold')} id="stuck-threshold">
            <div className="flex items-center gap-2">
              <input
                id="stuck-threshold"
                type="number"
                min={1}
                max={60}
                value={threshold}
                className={`${control} w-20 text-right tabular-nums`}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1 && value <= 60) setThreshold(value);
                }}
              />
              <span className="text-sm text-muted-foreground">{t('courier.stuck.days')}</span>
            </div>
          </Field>
          {(accounts.data?.items.length ?? 0) > 0 ? (
            <Field label={t('courier.colCourier')} id="stuck-courier">
              <Select
                id="stuck-courier"
                className="w-48"
                value={courierId}
                onValueChange={setCourierId}
                options={[
                  { value: '', label: t('courier.allCouriers') },
                  ...(accounts.data?.items ?? []).map((account) => ({
                    value: account.courierId,
                    label: account.label,
                  })),
                ]}
              />
            </Field>
          ) : null}
        </div>

        {notice === null ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        {exportError === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {exportError}
          </p>
        )}

        {queue.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : queue.isError ? (
          <ErrorState
            title={t('courier.errorTitle')}
            detail={t('courier.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void queue.refetch()}>
                {t('courier.retry')}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={t('courier.stuck.emptyTitle')}
            detail={t('courier.stuck.emptyDetail')}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('courier.stuck.heading')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                  {mayAct ? (
                    <th scope="col" className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={t('courier.selectAll')}
                        className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
                        checked={
                          pollable.length > 0 &&
                          pollable.every((item) => selected.has(item.consignmentId))
                        }
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? new Set(pollable.map((item) => item.consignmentId))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                  ) : null}
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colOrder')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colCourier')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colConsignment')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colReason')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colLastWord')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.colDays')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.colCod')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colNote')}
                  </th>
                  {mayAct ? <th scope="col" className="px-3 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.consignmentId}
                    className="h-row border-b border-border align-middle last:border-0"
                  >
                    {mayAct ? (
                      <td className="px-3">
                        <input
                          type="checkbox"
                          aria-label={`${t('courier.selectRow')} ${item.orderNo}`}
                          className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={item.bookingState !== 'booked'}
                          checked={selected.has(item.consignmentId)}
                          onChange={() => toggle(item.consignmentId)}
                        />
                      </td>
                    ) : null}
                    <td className="px-3 font-medium tabular-nums">
                      <Link
                        to={courierPath(`/courier/parcels/${item.consignmentId}`)}
                        className="text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {item.orderNo}
                      </Link>
                    </td>
                    <td className="px-3">{item.courierName}</td>
                    <td className="px-3 tabular-nums">{item.consignmentNo ?? '—'}</td>
                    <td className="px-3">
                      <div className="flex flex-wrap gap-1">
                        {item.reasons.map((reason) => (
                          <StatusBadge key={reason} tone={REASON_TONE[reason]}>
                            {t(`courier.stuck.reason.${reason}` as CourierMessageKey)}
                          </StatusBadge>
                        ))}
                      </div>
                    </td>
                    <td className="px-3">
                      <div className="flex flex-col">
                        <StatusBadge tone={PARCEL_TONE[item.status]}>
                          {t(`courier.status.${item.status}` as CourierMessageKey)}
                        </StatusBadge>
                        {item.lastEventRawStatus === null ? null : (
                          <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                            {item.lastEventRawStatus}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 text-right tabular-nums">{item.daysStuck}</td>
                    <td className="px-3 text-right">
                      <Money poisha={item.codAmountPoisha} />
                    </td>
                    <td
                      className="max-w-64 truncate px-3 text-muted-foreground"
                      title={item.lastEscalationNote ?? ''}
                    >
                      {item.lastEscalationNote ?? '—'}
                    </td>
                    {mayAct ? (
                      <td className="px-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setNoting(item);
                            setNote('');
                          }}
                        >
                          {t('courier.stuck.escalate')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <Dialog
          open={noting !== null}
          onOpenChange={(open) => {
            if (!open) setNoting(null);
          }}
          title={`${t('courier.stuck.escalateTitle')} · ${noting?.orderNo ?? ''}`}
          description={t('courier.stuck.escalateDetail')}
          closeLabel={t('courier.close')}
          footer={
            <>
              <Button variant="outline" onClick={() => setNoting(null)}>
                {t('courier.cancel')}
              </Button>
              <Button
                disabled={note.trim() === '' || noteMutation.isPending}
                onClick={() => {
                  if (noting !== null) {
                    noteMutation.mutate({ consignmentId: noting.consignmentId, note: note.trim() });
                  }
                }}
              >
                {noteMutation.isPending ? t('courier.saving') : t('courier.save')}
              </Button>
            </>
          }
        >
          <Field label={t('courier.stuck.noteLabel')} id="stuck-note">
            <textarea
              id="stuck-note"
              rows={4}
              maxLength={1000}
              value={note}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </Dialog>
      </div>
    </PermissionGate>
  );
}
