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
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { parcelTimeline } from './api.js';
import { courierPath, paramOf } from './courier-nav.js';
import { BOOKING_TONE, PARCEL_TONE } from './courier-ui.js';
import { useCourierT, type CourierMessageKey } from './messages.js';

/**
 * One parcel's tracking timeline (M12's `GET /v1/courier/parcels/:id`, M15's screen).
 *
 * Every event the courier sent, oldest first, with its **raw word** beside the status it was
 * mapped to: when a mapping turns out wrong, the raw word is what an operator corrects it
 * against, and it is also what settles an argument with the courier about what it said. An
 * event that moved the order says where it moved it to; the rest were tracking only.
 *
 * The escalation notes people added while chasing the parcel follow, in order — they cannot
 * be edited, which is what makes them worth reading in a dispute.
 */
export function ParcelTimelinePage() {
  const t = useCourierT();
  const ability = useAbility();
  const consignmentId = paramOf(useParams({ strict: false }), 'consignmentId');
  const mayRead = ability.can('read', 'Order');

  const timeline = useQuery({
    queryKey: ['courier', 'parcel', consignmentId],
    queryFn: () => parcelTimeline(consignmentId),
    enabled: mayRead && consignmentId !== '',
  });
  const data = timeline.data;

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('courier.deniedTitle'), detail: t('courier.deniedDetail') }}
    >
      <div className="space-y-5">
        <Link
          to={courierPath('/courier')}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t('courier.back')}
        </Link>

        {timeline.isPending ? (
          <Skeleton className="h-48 w-full" />
        ) : timeline.isError || data === undefined ? (
          <ErrorState
            title={t('courier.errorTitle')}
            detail={timeline.error instanceof ApiError ? timeline.error.message : t('courier.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void timeline.refetch()}>
                {t('courier.retry')}
              </Button>
            }
          />
        ) : (
          <>
            <header className="space-y-2">
              <h1 className="text-lg font-semibold tracking-tight tabular-nums">
                {t('courier.parcel.heading')} {data.consignment.orderNo}
              </h1>
              <dl className="grid gap-3 rounded-lg border border-border p-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
                <Term label={t('courier.colConsignment')}>
                  <span className="tabular-nums">{data.consignment.consignmentNo ?? '—'}</span>
                </Term>
                <Term label={t('courier.parcel.tracking')}>
                  <span className="tabular-nums">{data.consignment.trackingCode ?? '—'}</span>
                </Term>
                <Term label={t('courier.colStatus')}>
                  {data.consignment.bookingState === 'booked' ? (
                    <StatusBadge tone={PARCEL_TONE[data.consignment.status]}>
                      {t(`courier.status.${data.consignment.status}` as CourierMessageKey)}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone={BOOKING_TONE[data.consignment.bookingState]}>
                      {t(`courier.booking.${data.consignment.bookingState}` as CourierMessageKey)}
                    </StatusBadge>
                  )}
                </Term>
                <Term label={t('courier.colCod')}>
                  <Money poisha={data.consignment.codAmountPoisha} align="start" />
                </Term>
                <Term label={t('courier.colCollected')}>
                  {data.consignment.collectedPoisha === null ? (
                    '—'
                  ) : (
                    <Money poisha={data.consignment.collectedPoisha} align="start" />
                  )}
                </Term>
                <Term label={t('courier.nav.settlements')}>
                  {data.consignment.settlementId === null
                    ? t('courier.parcel.notSettled')
                    : t('courier.parcel.settled')}
                </Term>
              </dl>
            </header>

            <section aria-labelledby="timeline-heading" className="space-y-2">
              <div>
                <h2 id="timeline-heading" className="text-sm font-semibold">
                  {t('courier.parcel.timeline')}
                </h2>
                <p className="text-xs text-muted-foreground">{t('courier.parcel.timelineCaption')}</p>
              </div>
              {data.events.length === 0 ? (
                <EmptyState title={t('courier.parcel.noEvents')} />
              ) : (
                <ol className="divide-y divide-border rounded-lg border border-border text-sm">
                  {data.events.map((event) => (
                    <li key={event.id} className="grid gap-1 px-3 py-2 sm:grid-cols-[12rem_8rem_1fr_10rem] sm:items-center">
                      <span className="text-muted-foreground">
                        <DateTime value={event.occurredAt} />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {t(`courier.parcel.source.${event.source}` as CourierMessageKey)}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusBadge tone={PARCEL_TONE[event.status]}>
                          {t(`courier.status.${event.status}` as CourierMessageKey)}
                        </StatusBadge>
                        <span className="font-mono text-xs text-muted-foreground">{event.rawStatus}</span>
                      </span>
                      <span className="text-xs">
                        {event.orderToStatus === null ? '' : `→ ${event.orderToStatus}`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section aria-labelledby="escalations-heading" className="space-y-2">
              <h2 id="escalations-heading" className="text-sm font-semibold">
                {t('courier.parcel.escalations')}
              </h2>
              {data.escalations.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('courier.parcel.noEscalations')}</p>
              ) : (
                <ol className="space-y-2 text-sm">
                  {data.escalations.map((note) => (
                    <li key={note.id} className="rounded-lg border border-border px-3 py-2">
                      <p className="text-xs text-muted-foreground">
                        <DateTime value={note.createdAt} />
                      </p>
                      <p className="whitespace-pre-wrap">{note.note}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </PermissionGate>
  );
}

function Term({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
