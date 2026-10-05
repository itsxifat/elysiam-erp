import {
  Button,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Skeleton,
  buttonVariants,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, FileText, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  claimOrder,
  documentUrl,
  getOrder,
  listAgents,
  listAreas,
  type OrderDetail,
  type TimelineEntry,
} from './api.js';
import { AdvancesPanel } from './advances-panel.js';
import { OrderActions } from './order-actions.js';
import { ParcelPanel } from './parcel-panel.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { OrderStatusBadge } from './parts.js';
import { DEFAULT_ORDER_SEARCH } from './search.js';
import { ordersPath } from './paths.js';

/**
 * One order: who, where, what, how much, how risky, and its timeline (M11 Build list:
 * "order detail with a timeline (status history plus audit)").
 *
 * The timeline is the server's merge of the order's own status history and the audit
 * trail's actions on it — who claimed it, who edited it, when the courier booking was
 * queued. Action, actor and time only: the audit payloads are `read AuditLog`, org_admin's
 * alone, and the server does not send them here.
 *
 * The actions shown are the ones the caller's §6 grant and §9's table both allow — the table
 * as the server sends it (`transitions`, D-392), so the console keeps no copy of it; the
 * server re-checks every one, and a refusal is shown in words rather than swallowed.
 */
export function OrderDetailPage() {
  const ability = useAbility();
  const t = useOrdersT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Order')}
      explain={{ title: t('orders.deniedTitle'), detail: t('orders.deniedDetail') }}
    >
      <Detail />
    </PermissionGate>
  );
}

function Detail() {
  const t = useOrdersT();
  // `strict: false` for the reason `ordersPath` exists: see `paths.ts`.
  const params = useParams({ strict: false }) as unknown as { orderId?: string };
  const orderId = params.orderId ?? '';

  const order = useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => getOrder(orderId),
    enabled: orderId !== '',
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });

  return (
    <div className="space-y-5">
      <Link
        to={ordersPath('/orders')}
        search={DEFAULT_ORDER_SEARCH as never}
        className="-mb-2 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t('orders.detail.back')}
      </Link>
      {order.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label={t('orders.loading')}>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : order.isError ? (
        order.error instanceof ApiError && order.error.status === 404 ? (
          <EmptyState
            title={t('orders.detail.notFound')}
            detail={t('orders.detail.notFoundDetail')}
          />
        ) : (
          <ErrorState
            title={t('orders.errorTitle')}
            detail={t('orders.errorDetail')}
            action={
              <Button variant="outline" size="sm" onClick={() => void order.refetch()}>
                {t('orders.retry')}
              </Button>
            }
          />
        )
      ) : (
        <Loaded order={order.data} />
      )}
    </div>
  );
}

function Loaded({ order }: { readonly order: OrderDetail }) {
  const t = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);

  const agents = useQuery({
    queryKey: ['orders', 'agents'],
    queryFn: listAgents,
    staleTime: 5 * 60_000,
  });
  const areas = useQuery({
    queryKey: ['orders', 'areas'],
    queryFn: listAreas,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const names = useMemo(
    () => new Map((agents.data?.items ?? []).map((agent) => [agent.userId, agent.name])),
    [agents.data],
  );
  // An intake order is created by the site key, not by a person (`intake:<key>`), and is
  // named as the channel it came through rather than shown as an opaque id.
  // An owner is named only to another owner; everyone else reads "Owner" (D-473).
  const owners = new Map((order.owners ?? []).map((owner) => [owner.userId, owner.name]));
  const nameOf = (userId: string | null): string =>
    userId === null
      ? t('orders.timeline.system')
      : owners.has(userId)
        ? (owners.get(userId) ?? t('orders.timeline.owner'))
        : (names.get(userId) ??
          (userId.startsWith('intake:') ? t('orders.channel.landing_page') : userId));

  const area = areas.data?.areas.find((entry) => entry.thanaId === order.shipTo.thanaId);
  const zone = areas.data?.zones.find((entry) => entry.id === order.deliveryZoneId);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['orders'] });
  const claim = useMutation({
    mutationFn: () => claimOrder(order.id),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });

  const mayUpdate = ability.can('update', 'Order');
  const canClaim = mayUpdate && order.assignedTo === null;
  const source = order.source ?? {};
  const sourceEntries = Object.entries(source).filter(([, value]) => typeof value === 'string');

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-3 text-lg font-semibold tracking-tight">
            <span className="tabular-nums">{order.orderNo}</span>
            <OrderStatusBadge status={order.status} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {t(`orders.channel.${order.channel}` as OrdersMessageKey)} ·{' '}
            <DateTime value={order.timestamps.createdAt} /> · {t('orders.detail.assigned')}:{' '}
            {order.assignedTo === null ? t('orders.detail.unassigned') : nameOf(order.assignedTo)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canClaim ? (
            <Button
              variant="outline"
              size="sm"
              disabled={claim.isPending}
              onClick={() => claim.mutate()}
            >
              {t('orders.detail.claim')}
            </Button>
          ) : null}
          <OrderActions order={order} mayUpdate={mayUpdate} />
          <a
            href={documentUrl(order.id, 'invoice')}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <FileText aria-hidden="true" />
            {t('orders.detail.printInvoice')}
          </a>
          <a
            href={documentUrl(order.id, 'label')}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Tag aria-hidden="true" />
            {t('orders.detail.printLabel')}
          </a>
        </div>
      </header>

      {failure === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {t('orders.detail.actionFailed')} {failure}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <section className="grid gap-5 rounded-lg border border-border bg-card p-5 sm:grid-cols-2">
            <div>
              <h2 className="text-xs font-medium text-muted-foreground">
                {t('orders.detail.buyer')}
              </h2>
              {/* The buyer's profile (M16): their history across every order, not just this one. */}
              <Link
                to={ordersPath(`/customers/${order.customer.id}`)}
                className="mt-1 inline-block text-sm font-medium underline-offset-4 hover:text-primary hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {order.customer.name}
              </Link>
              <p className="text-sm tabular-nums">{order.shipTo.phone}</p>
            </div>
            <div>
              <h2 className="text-xs font-medium text-muted-foreground">
                {t('orders.detail.shipTo')}
              </h2>
              <p className="mt-1 text-sm">{order.shipTo.addressLine}</p>
              <p className="text-sm text-muted-foreground">
                {[
                  order.shipTo.area,
                  area === undefined
                    ? null
                    : locale === 'bn'
                      ? `${area.thanaBn}, ${area.districtBn}`
                      : `${area.thanaEn}, ${area.districtEn}`,
                ]
                  .filter((part) => part !== null && part !== '')
                  .join(', ')}
              </p>
              {zone === undefined ? null : (
                <p className="text-xs text-muted-foreground">
                  {t('orders.desk.zone')}: {locale === 'bn' ? zone.nameBn : zone.nameEn}
                </p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-3 text-base font-semibold tracking-tight">
              {t('orders.detail.lines')}
            </h2>
            <table className="w-full text-sm">
              <caption className="sr-only">{t('orders.detail.lines')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="pb-2 font-medium">{t('orders.desk.items')}</th>
                  <th className="pb-2 text-right font-medium">{t('orders.desk.qty')}</th>
                  <th className="pb-2 text-right font-medium">{t('orders.desk.unitPrice')}</th>
                  <th className="pb-2 text-right font-medium">{t('orders.desk.lineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.id} className="border-b border-border last:border-b-0">
                    <td className="py-2.5">
                      <span className="block font-medium tabular-nums">{line.skuCode}</span>
                      <span className="block text-xs text-muted-foreground">
                        {line.productName}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">{line.qty}</td>
                    <td className="text-right">
                      <Money poisha={line.unitPricePoisha} locale={locale} />
                    </td>
                    <td className="text-right">
                      <Money
                        poisha={(
                          BigInt(line.unitPricePoisha) * BigInt(line.qty) -
                          BigInt(line.discountPoisha)
                        ).toString()}
                        locale={locale}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="mb-4 text-base font-semibold tracking-tight">
              {t('orders.detail.timeline')}
            </h2>
            {/* A vertical line of events, newest last: what happened, then when and by whom. */}
            <ol className="relative ml-1.5 space-y-5 border-l border-border pl-5">
              {order.timeline.map((entry) => (
                <li key={entry.id} className="relative">
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 -left-6 size-2 rounded-full bg-muted-foreground ring-4 ring-card"
                  />
                  <div className="text-sm">
                    <TimelineText entry={entry} />
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    <DateTime value={entry.at} /> · {t('orders.timeline.by')}{' '}
                    {nameOf(entry.actorUserId)}
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="space-y-3 rounded-lg border border-border bg-card p-5">
            <h2 className="text-base font-semibold tracking-tight">{t('orders.detail.amounts')}</h2>
            <dl className="space-y-1.5 text-sm">
              <Row label={t('orders.desk.itemsTotal')} poisha={order.amounts.itemsPoisha} />
              <Row label={t('orders.desk.discountTotal')} poisha={order.amounts.discountPoisha} />
              <Row
                label={t('orders.desk.deliveryTotal')}
                poisha={order.amounts.deliveryChargePoisha}
              />
              <Row label={t('orders.detail.advance')} poisha={order.amounts.advancePaidPoisha} />
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-3">
                <dt className="font-medium">{t('orders.desk.cod')}</dt>
                <dd className="text-xl font-semibold">
                  <Money poisha={order.amounts.codAmountPoisha} locale={locale} />
                </dd>
              </div>
            </dl>
          </section>

          <ParcelPanel order={order} mayUpdate={mayUpdate} />

          <AdvancesPanel order={order} />

          {order.notes === null && sourceEntries.length === 0 ? null : (
            <section className="space-y-3 rounded-lg border border-border bg-card p-5 text-sm">
              {order.notes === null ? null : (
                <div>
                  <h2 className="text-xs font-medium text-muted-foreground">
                    {t('orders.detail.notes')}
                  </h2>
                  <p>{order.notes}</p>
                </div>
              )}
              {sourceEntries.length === 0 ? null : (
                <div>
                  <h2 className="text-xs font-medium text-muted-foreground">
                    {t('orders.detail.source')}
                  </h2>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                    {sourceEntries.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd className="break-all">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ label, poisha }: { readonly label: string; readonly poisha: string }) {
  const { locale } = useLocale();
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        <Money poisha={poisha} locale={locale} />
      </dd>
    </div>
  );
}

const ACTIVITY: Readonly<Record<string, OrdersMessageKey>> = {
  'order.claimed': 'orders.timeline.claimed',
  'order.assigned': 'orders.timeline.assigned',
  'order.edited': 'orders.timeline.edited',
  'order.advance_received': 'orders.timeline.advance',
  'order.advance_claimed': 'orders.timeline.advanceClaimed',
  'order.advance_verified': 'orders.timeline.advanceVerified',
  'order.advance_rejected': 'orders.timeline.advanceRejected',
  'order.advance_refunded': 'orders.timeline.advanceRefunded',
  'order.advance_voided': 'orders.timeline.advanceVoided',
  'intake.order_received': 'orders.timeline.intake',
  'courier.booking.queued': 'orders.timeline.courier',
  'courier.handover.confirmed': 'orders.timeline.handover',
  'courier.status.set_manually': 'orders.timeline.courierStatus',
};

function TimelineText({ entry }: { readonly entry: TimelineEntry }) {
  const t = useOrdersT();
  if (entry.kind === 'status') {
    if (entry.from === null) return <span>{t('orders.timeline.created')}</span>;
    return (
      <span className="inline-flex items-center gap-1.5">
        {t('orders.timeline.moved')} <OrderStatusBadge status={entry.to} />
        {entry.reason === null ? null : (
          <span className="text-muted-foreground">({entry.reason})</span>
        )}
      </span>
    );
  }
  const key = ACTIVITY[entry.action];
  return (
    <span>{key === undefined ? `${t('orders.timeline.other')}: ${entry.action}` : t(key)}</span>
  );
}
