import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { listLocations, listParcels, receiveReturn, returnable, type ParcelRow } from './api.js';
import { control, courierPath, CourierHeader, Field } from './courier-nav.js';
import {
  PARCEL_TONE,
  quantity,
  receiptProblem,
  type ReceiptEntry,
  type ReceiptProblem,
} from './courier-ui.js';
import { useCourierT, type CourierMessageKey } from './messages.js';
import { RETURN_REASONS, type ReturnReason } from '../orders/returns-logic.js';
import { useOrdersT, type OrdersMessageKey } from '../orders/messages.js';

/**
 * Returns receiving, with per-line inspection (M12's returns path; §7, §8).
 *
 * The list is every parcel on its way back, back with the courier, or partly delivered, that
 * the warehouse has not received yet. Receiving one is an inspection, line by line: how many
 * units are sellable and how many damaged. §7 sends the two to different locations and
 * writing damaged stock off is a separate approval, so a single "damaged" tick for the whole
 * box would send a whole parcel to the damaged shelf because one kurti in it was torn.
 *
 * The server does the rest in one transaction — the receipt, the stock movements at the
 * dispatch cost and the return journal — and none of the cost reaches this screen
 * (invariant 5): the lines carry quantities only.
 */
const RETURN_STATUSES = 'return_in_transit,returned_to_merchant,partial_delivered';

export function CourierReturnsPage() {
  const t = useCourierT();
  const ability = useAbility();
  const mayRead = ability.can('read', 'Order');
  const mayReceive = ability.can('update', 'Order');

  const [receiving, setReceiving] = useState<ParcelRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const parcels = useQuery({
    queryKey: ['courier', 'returns'],
    queryFn: () =>
      listParcels({ status: RETURN_STATUSES, awaitingReturn: true, page: 1, pageSize: 200 }),
    enabled: mayRead,
  });
  const items = parcels.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('courier.deniedTitle'), detail: t('courier.deniedDetail') }}
    >
      <div className="space-y-5">
        <CourierHeader
          title={t('courier.returns.heading')}
          caption={t('courier.returns.caption')}
        />

        {notice === null ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}

        {parcels.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : parcels.isError ? (
          <ErrorState
            title={t('courier.errorTitle')}
            detail={t('courier.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void parcels.refetch()}>
                {t('courier.retry')}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={t('courier.returns.emptyTitle')}
            detail={t('courier.returns.emptyDetail')}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('courier.returns.heading')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
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
                    {t('courier.colStatus')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('courier.colCod')}
                  </th>
                  {mayReceive ? <th scope="col" className="px-3 py-2" /> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id} className="h-row border-b border-border last:border-0">
                    <td className="px-3 font-medium tabular-nums">
                      <Link
                        to={courierPath(`/courier/parcels/${row.id}`)}
                        className="text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {row.orderNo}
                      </Link>
                    </td>
                    <td className="px-3">{row.courierName}</td>
                    <td className="px-3 tabular-nums">{row.consignmentNo ?? '—'}</td>
                    <td className="px-3">
                      <StatusBadge tone={PARCEL_TONE[row.status]}>
                        {t(`courier.status.${row.status}` as CourierMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className="px-3 text-right">
                      <Money poisha={row.codAmountPoisha} />
                    </td>
                    {mayReceive ? (
                      <td className="px-3 text-right">
                        <Button size="sm" variant="outline" onClick={() => setReceiving(row)}>
                          {t('courier.returns.receive')}
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {receiving === null ? null : (
          <ReceiveDialog
            parcel={receiving}
            onClose={() => setReceiving(null)}
            onReceived={() => {
              setReceiving(null);
              setNotice(t('courier.returns.received'));
            }}
          />
        )}
      </div>
    </PermissionGate>
  );
}

function ReceiveDialog({
  parcel,
  onClose,
  onReceived,
}: {
  readonly parcel: ParcelRow;
  readonly onClose: () => void;
  readonly onReceived: () => void;
}) {
  const t = useCourierT();
  const o = useOrdersT();
  const queryClient = useQueryClient();

  const [entries, setEntries] = useState<Record<string, { sellable: string; damaged: string }>>({});
  const [damagedLocationId, setDamagedLocationId] = useState('');
  const [reason, setReason] = useState('');
  // M17 (D-234): why it came back, from the fixed list. Required, like the note.
  const [returnReason, setReturnReason] = useState<ReturnReason | ''>('');
  const [inspectionNote, setInspectionNote] = useState('');
  const [problem, setProblem] = useState<ReceiptProblem | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const lines = useQuery({
    queryKey: ['courier', 'returnable', parcel.id],
    queryFn: () => returnable(parcel.id),
  });
  const locations = useQuery({
    queryKey: ['courier', 'locations'],
    queryFn: listLocations,
    staleTime: 10 * 60_000,
  });
  const damagedLocations = (locations.data?.items ?? []).filter(
    (location) => location.kind === 'damaged' && location.isActive,
  );

  const counted: Record<string, ReceiptEntry> = Object.fromEntries(
    Object.entries(entries).map(([skuId, entry]) => [
      skuId,
      { sellableQty: quantity(entry.sellable), damagedQty: quantity(entry.damaged) },
    ]),
  );

  const receive = useMutation({
    mutationFn: () =>
      receiveReturn(parcel.id, {
        reason: reason.trim(),
        returnReason: returnReason === '' ? 'other' : returnReason,
        ...(inspectionNote.trim() === '' ? {} : { inspectionNote: inspectionNote.trim() }),
        ...(damagedLocationId === '' ? {} : { damagedLocationId }),
        lines: (lines.data?.lines ?? [])
          .map((line) => ({
            skuId: line.skuId,
            sellableQty: counted[line.skuId]?.sellableQty ?? 0,
            damagedQty: counted[line.skuId]?.damagedQty ?? 0,
          }))
          .filter((line) => line.sellableQty + line.damagedQty > 0),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['courier'] });
      onReceived();
    },
    onError: (error) =>
      setServerError(error instanceof ApiError ? error.message : t('courier.errorTitle')),
  });

  function submit() {
    const found = receiptProblem(lines.data?.lines ?? [], counted, damagedLocationId);
    setProblem(found);
    setServerError(null);
    if (found === null && reason.trim() !== '' && returnReason !== '') receive.mutate();
  }

  const problemText: Record<ReceiptProblem, string> = {
    nothing: t('courier.returns.nothing'),
    too_many: t('courier.returns.tooMany'),
    needs_damaged_location: t('courier.returns.damagedLocationHint'),
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${t('courier.returns.receiveTitle')} · ${parcel.orderNo}`}
      description={t('courier.returns.receiveDetail')}
      closeLabel={t('courier.close')}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('courier.cancel')}
          </Button>
          <Button
            disabled={reason.trim() === '' || returnReason === '' || receive.isPending}
            onClick={submit}
          >
            {receive.isPending ? t('courier.saving') : t('courier.returns.receive')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {lines.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t('courier.returns.receiveTitle')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2">
                  {t('courier.returns.colSku')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {t('courier.returns.colOutstanding')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {t('courier.returns.colSellable')}
                </th>
                <th scope="col" className="py-2 text-right">
                  {t('courier.returns.colDamaged')}
                </th>
              </tr>
            </thead>
            <tbody>
              {(lines.data?.lines ?? []).map((line) => (
                <tr key={line.skuId} className="border-b border-border last:border-0">
                  <td className="py-2 font-medium tabular-nums">{line.skuCode}</td>
                  <td className="py-2 text-right tabular-nums">{line.outstandingQty}</td>
                  <td className="py-2 text-right">
                    <input
                      aria-label={`${t('courier.returns.colSellable')} ${line.skuCode}`}
                      inputMode="numeric"
                      value={entries[line.skuId]?.sellable ?? ''}
                      className={`${control} ml-auto w-20 text-right tabular-nums`}
                      onChange={(event) =>
                        setEntries((current) => ({
                          ...current,
                          [line.skuId]: {
                            sellable: event.target.value,
                            damaged: current[line.skuId]?.damaged ?? '',
                          },
                        }))
                      }
                    />
                  </td>
                  <td className="py-2 text-right">
                    <input
                      aria-label={`${t('courier.returns.colDamaged')} ${line.skuCode}`}
                      inputMode="numeric"
                      value={entries[line.skuId]?.damaged ?? ''}
                      className={`${control} ml-auto w-20 text-right tabular-nums`}
                      onChange={(event) =>
                        setEntries((current) => ({
                          ...current,
                          [line.skuId]: {
                            sellable: current[line.skuId]?.sellable ?? '',
                            damaged: event.target.value,
                          },
                        }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Field label={t('courier.returns.reasonCode')} id="return-reason-code">
          <select
            id="return-reason-code"
            required
            value={returnReason}
            className={control}
            onChange={(event) => setReturnReason(event.target.value as ReturnReason | '')}
          >
            <option value="">{t('courier.returns.chooseReason')}</option>
            {RETURN_REASONS.map((code) => (
              <option key={code} value={code}>
                {o(`orders.reason.${code}` as OrdersMessageKey)}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('courier.returns.damagedLocation')}
            id="return-damaged-location"
            hint={t('courier.returns.damagedLocationHint')}
          >
            <select
              id="return-damaged-location"
              value={damagedLocationId}
              className={control}
              onChange={(event) => setDamagedLocationId(event.target.value)}
            >
              <option value="">—</option>
              {damagedLocations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.code} · {location.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('courier.returns.reasonLabel')} id="return-reason">
            <input
              id="return-reason"
              value={reason}
              maxLength={500}
              className={control}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
        <Field label={t('courier.returns.inspectionNote')} id="return-note">
          <textarea
            id="return-note"
            rows={2}
            maxLength={1000}
            value={inspectionNote}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={(event) => setInspectionNote(event.target.value)}
          />
        </Field>

        {problem === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {problemText[problem]}
          </p>
        )}
        {serverError === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}
      </div>
    </Dialog>
  );
}
