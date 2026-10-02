import { Button, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { bookParcel, confirmHandover, parcelsForOrder, type ParcelRow } from '../courier/api.js';
import { courierPath } from '../courier/courier-nav.js';
import { BOOKING_TONE, PARCEL_TONE } from '../courier/courier-ui.js';
import { useCourierT, type CourierMessageKey } from '../courier/messages.js';
import type { OrderDetail } from './api.js';
import { useOrdersT } from './messages.js';

/**
 * The order's parcel, on the order detail (D-392).
 *
 * The courier half of working an order, beside the order half: book the parcel with the
 * order's courier when the brand books by hand (§9's `manual` policy), see where the courier
 * says it is, open its tracking, and confirm a rider took it — which ships the order when it
 * is still waiting to ship (D-391). Read through `GET /v1/courier/parcels?orderId=`, the
 * courier module's own list in the caller's row scope, rather than through the order: the
 * consignment is the courier module's row (invariant 12).
 */

/** The order's parcels, shared by the panel and the lifecycle buttons (one cached query). */
export function useOrderParcels(orderId: string) {
  return useQuery({
    queryKey: ['courier', 'order-parcels', orderId],
    queryFn: () => parcelsForOrder(orderId),
  });
}

/** The parcel a courier holds for this order, pending or booked, or null (`hasLiveParcel`). */
export function liveParcelOf(items: readonly ParcelRow[]): ParcelRow | null {
  return (
    items.find((parcel) => parcel.bookingState === 'pending' || parcel.bookingState === 'booked') ??
    null
  );
}

/** Statuses from which a parcel can still be booked or handed over. */
const BEFORE_SHIPMENT: readonly string[] = ['confirmed', 'packed'];

export function ParcelPanel({
  order,
  mayUpdate,
}: {
  readonly order: OrderDetail;
  readonly mayUpdate: boolean;
}) {
  const t = useOrdersT();
  const ct = useCourierT();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);

  const parcels = useOrderParcels(order.id);

  const refresh = async () => {
    setProblem(null);
    await queryClient.invalidateQueries({ queryKey: ['courier'] });
    await queryClient.invalidateQueries({ queryKey: ['orders'] });
  };
  const failed = (error: unknown) =>
    setProblem(error instanceof ApiError ? error.message : t('orders.errorDetail'));

  const book = useMutation({
    mutationFn: () => bookParcel(order.id),
    onSuccess: refresh,
    onError: failed,
  });
  const handover = useMutation({
    mutationFn: (consignmentId: string) => confirmHandover(consignmentId),
    onSuccess: refresh,
    onError: failed,
  });

  const items = (parcels.data?.items ?? []).filter((parcel) => parcel.bookingState !== 'cancelled');
  const waiting = BEFORE_SHIPMENT.includes(order.status);
  const mayBook = mayUpdate && waiting && items.length === 0 && order.courierId !== null;

  return (
    <section
      aria-labelledby="order-parcel-heading"
      className="space-y-2 rounded-lg border border-border bg-card p-4"
    >
      <h2 id="order-parcel-heading" className="text-sm font-medium">
        {t('orders.parcel.heading')}
      </h2>
      {parcels.isPending ? (
        <p className="text-sm text-muted-foreground">{t('orders.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('orders.parcel.none')}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((parcel) => (
            <li key={parcel.id} className="space-y-1.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{parcel.courierName}</span>
                {parcel.bookingState === 'booked' ? (
                  <StatusBadge tone={PARCEL_TONE[parcel.status]}>
                    {ct(`courier.status.${parcel.status}` as CourierMessageKey)}
                  </StatusBadge>
                ) : (
                  <StatusBadge tone={BOOKING_TONE[parcel.bookingState]}>
                    {ct(`courier.booking.${parcel.bookingState}` as CourierMessageKey)}
                  </StatusBadge>
                )}
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {t('orders.parcel.consignment')}: {parcel.consignmentNo ?? '—'}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  to={courierPath(`/courier/parcels/${parcel.id}`)}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {t('orders.parcel.tracking')}
                </Link>
                {mayUpdate && waiting && parcel.bookingState === 'booked' ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={handover.isPending}
                    onClick={() => handover.mutate(parcel.id)}
                  >
                    {t('orders.parcel.handover')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {mayBook ? (
        <Button size="sm" variant="outline" disabled={book.isPending} onClick={() => book.mutate()}>
          {t('orders.parcel.book')}
        </Button>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </section>
  );
}
