import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  SearchInput,
  Select,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Printer } from 'lucide-react';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { fileUrl, labelsPath, listAccounts, listParcels, type ParcelStatus } from './api.js';
import { courierPath, CourierHeader } from './courier-nav.js';
import { BOOKING_TONE, PARCEL_TONE } from './courier-ui.js';
import { useCourierT, type CourierMessageKey } from './messages.js';

const PAGE_SIZE = 50;

const STATUSES: readonly ParcelStatus[] = [
  'booked',
  'pickup_pending',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'hold',
  'delivered',
  'partial_delivered',
  'return_in_transit',
  'returned_to_merchant',
  'cancelled',
  'unknown',
];

/**
 * Every parcel booked with a courier (M15), with label printing.
 *
 * The list is the way into a parcel's timeline and the place labels are printed from: pick
 * the booked parcels a rider is taking, print one 4 × 6 label each. Only booked parcels can be
 * picked — a label without the courier's number is a box the pickup desk cannot scan, and the
 * server refuses it too.
 *
 * No recipient name, phone or address appears here (invariant 10): the order number is what
 * a person searches by, and the address is on the label.
 */
export function CourierParcelsPage() {
  const t = useCourierT();
  const ability = useAbility();
  const mayRead = ability.can('read', 'Order');

  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [courierId, setCourierId] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ['courier', 'accounts'],
    queryFn: listAccounts,
    enabled: ability.can('read', 'CourierSettlement'),
    staleTime: 5 * 60_000,
  });

  const parcels = useQuery({
    queryKey: ['courier', 'parcels', q, status, courierId, page],
    queryFn: () =>
      listParcels({
        q: q.trim() === '' ? undefined : q.trim(),
        status: status === '' ? undefined : status,
        courierId: courierId === '' ? undefined : courierId,
        page,
        pageSize: PAGE_SIZE,
      }),
    enabled: mayRead,
  });

  const items = parcels.data?.items ?? [];
  const printable = items.filter(
    (row) => row.bookingState === 'booked' && row.consignmentNo !== null,
  );

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function printLabels() {
    setPrinting(true);
    setPrintError(null);
    try {
      const url = await fileUrl(labelsPath([...selected]));
      window.open(url, '_blank', 'noopener');
      // Kept long enough for the new tab to load it, then released.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : t('courier.errorTitle'));
    } finally {
      setPrinting(false);
    }
  }

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('courier.deniedTitle'), detail: t('courier.deniedDetail') }}
    >
      <div className="space-y-5">
        <CourierHeader
          title={t('courier.parcels.heading')}
          caption={t('courier.parcels.caption')}
          actions={
            <Button
              size="sm"
              variant="outline"
              disabled={selected.size === 0 || printing}
              onClick={() => void printLabels()}
            >
              <Printer aria-hidden="true" className="size-4" />
              {printing ? t('courier.labels.printing') : t('courier.labels.print')}
              {selected.size > 0 ? (
                <span className="text-muted-foreground tabular-nums">({selected.size})</span>
              ) : null}
            </Button>
          }
        />

        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="courier-parcel-search">
            {t('courier.search')}
          </label>
          <SearchInput
            id="courier-parcel-search"
            value={q}
            placeholder={t('courier.search')}
            onChange={(event) => {
              setQ(event.target.value);
              setPage(1);
            }}
          />
          <Select
            variant="filter"
            aria-label={t('courier.allStatuses')}
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
            options={[
              { value: '', label: t('courier.allStatuses') },
              ...STATUSES.map((value) => ({
                value,
                label: t(`courier.status.${value}` as CourierMessageKey),
              })),
            ]}
          />
          {(accounts.data?.items.length ?? 0) > 0 ? (
            <Select
              variant="filter"
              aria-label={t('courier.allCouriers')}
              value={courierId}
              onValueChange={(value) => {
                setCourierId(value);
                setPage(1);
              }}
              options={[
                { value: '', label: t('courier.allCouriers') },
                ...(accounts.data?.items ?? []).map((account) => ({
                  value: account.courierId,
                  label: account.label,
                })),
              ]}
            />
          ) : null}
          <p className="text-xs text-muted-foreground">{t('courier.labels.hint')}</p>
        </div>

        {printError === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {printError}
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
            title={t('courier.parcels.emptyTitle')}
            detail={t('courier.parcels.emptyDetail')}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('courier.parcels.caption')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                  <th scope="col" className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={t('courier.selectAll')}
                      className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
                      checked={
                        printable.length > 0 && printable.every((row) => selected.has(row.id))
                      }
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? new Set(printable.map((row) => row.id))
                            : new Set(),
                        )
                      }
                    />
                  </th>
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
                  <th scope="col" className="px-3 py-2">
                    {t('courier.colSince')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const canPrint = row.bookingState === 'booked' && row.consignmentNo !== null;
                  return (
                    <tr key={row.id} className="h-row border-b border-border last:border-0">
                      <td className="px-3">
                        <input
                          type="checkbox"
                          aria-label={`${t('courier.selectRow')} ${row.orderNo}`}
                          className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
                          disabled={!canPrint}
                          checked={selected.has(row.id)}
                          onChange={() => toggle(row.id)}
                        />
                      </td>
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
                        {row.bookingState === 'booked' ? (
                          <StatusBadge tone={PARCEL_TONE[row.status]}>
                            {t(`courier.status.${row.status}` as CourierMessageKey)}
                          </StatusBadge>
                        ) : (
                          <StatusBadge tone={BOOKING_TONE[row.bookingState]}>
                            {t(`courier.booking.${row.bookingState}` as CourierMessageKey)}
                          </StatusBadge>
                        )}
                      </td>
                      <td className="px-3 text-right">
                        <Money poisha={row.codAmountPoisha} />
                      </td>
                      <td className="px-3 text-muted-foreground">
                        {row.statusChangedAt === null ? (
                          '—'
                        ) : (
                          <DateTime value={row.statusChangedAt} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('courier.page')} {page}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page === 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            {t('courier.previous')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={items.length < PAGE_SIZE}
            onClick={() => setPage((current) => current + 1)}
          >
            {t('courier.next')}
          </Button>
        </div>
      </div>
    </PermissionGate>
  );
}
