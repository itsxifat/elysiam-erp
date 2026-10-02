import {
  Button,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Skeleton,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, FileText, Tag } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  cancelOrder,
  claimOrder,
  confirmOrder,
  documentUrl,
  getOrder,
  listAgents,
  listAreas,
  type OrderDetail,
  type TimelineEntry,
} from './api.js';
import { AdvancesPanel } from './advances-panel.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { OrdersNav, OrderStatusBadge } from './parts.js';
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
 * The actions shown are the ones the caller's §6 grant and the order's status both allow;
 * the server re-checks every one, and a refusal is shown in words rather than swallowed.
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
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t('orders.detail.back')}
      </Link>
      <OrdersNav />
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
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
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
  const nameOf = (userId: string | null): string =>
    userId === null
      ? t('orders.timeline.system')
      : (names.get(userId) ??
        (userId.startsWith('intake:') ? t('orders.channel.landing_page') : userId));

  const area = areas.data?.areas.find((entry) => entry.thanaId === order.shipTo.thanaId);
  const zone = areas.data?.zones.find((entry) => entry.id === order.deliveryZoneId);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['orders'] });
  const act = useMutation({
    mutationFn: async (action: 'confirm' | 'claim' | 'cancel') => {
      if (action === 'confirm') await confirmOrder(order.id);
      else if (action === 'claim') await claimOrder(order.id);
      else await cancelOrder(order.id, reason.trim());
    },
    onSuccess: () => {
      setFailure(null);
      setCancelOpen(false);
      refresh();
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });

  const mayUpdate = ability.can('update', 'Order');
  const canConfirm = mayUpdate && order.status === 'pending';
  const canClaim = mayUpdate && order.assignedTo === null;
  const canCancel =
    mayUpdate && ['pending', 'confirmed', 'packed', 'on_hold'].includes(order.status);
  const source = order.source ?? {};
  const sourceEntries = Object.entries(source).filter(([, value]) => typeof value === 'string');

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
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
              disabled={act.isPending}
              onClick={() => act.mutate('claim')}
            >
              {t('orders.detail.claim')}
            </Button>
          ) : null}
          {canConfirm ? (
            <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('confirm')}>
              {t('orders.detail.confirm')}
            </Button>
          ) : null}
          <a
            href={documentUrl(order.id, 'invoice')}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <FileText aria-hidden="true" className="size-4" />
            {t('orders.detail.printInvoice')}
          </a>
          <a
            href={documentUrl(order.id, 'label')}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Tag aria-hidden="true" className="size-4" />
            {t('orders.detail.printLabel')}
          </a>
          {canCancel ? (
            <Button variant="ghost" size="sm" onClick={() => setCancelOpen(true)}>
              {t('orders.detail.cancel')}
            </Button>
          ) : null}
        </div>
      </header>

      {failure === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {t('orders.detail.actionFailed')} {failure}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          <section className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-2">
            <div>
              <h2 className="text-xs font-medium text-muted-foreground">
                {t('orders.detail.buyer')}
              </h2>
              {/* The buyer's profile (M16): their history across every order, not just this one. */}
              <Link
                to={ordersPath(`/customers/${order.customer.id}`)}
                className="text-sm font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                {order.customer.name}
              </Link>
              <p className="text-sm tabular-nums">{order.shipTo.phone}</p>
            </div>
            <div>
              <h2 className="text-xs font-medium text-muted-foreground">
                {t('orders.detail.shipTo')}
              </h2>
              <p className="text-sm">{order.shipTo.addressLine}</p>
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

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">{t('orders.detail.lines')}</h2>
            <table className="w-full text-sm">
              <caption className="sr-only">{t('orders.detail.lines')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="py-1.5 font-medium">{t('orders.desk.items')}</th>
                  <th className="py-1.5 text-right font-medium">{t('orders.desk.qty')}</th>
                  <th className="py-1.5 text-right font-medium">{t('orders.desk.unitPrice')}</th>
                  <th className="py-1.5 text-right font-medium">{t('orders.desk.lineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.id} className="h-row border-b border-border last:border-b-0">
                    <td>
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

          <section className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-2 text-sm font-medium">{t('orders.detail.timeline')}</h2>
            <ol className="space-y-2">
              {order.timeline.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <DateTime value={entry.at} className="text-xs text-muted-foreground" />
                  <TimelineText entry={entry} />
                  <span className="text-xs text-muted-foreground">
                    {t('orders.timeline.by')} {nameOf(entry.actorUserId)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="space-y-2 rounded-lg border border-border bg-card p-4">
            <h2 className="text-sm font-medium">{t('orders.detail.amounts')}</h2>
            <dl className="space-y-1 text-sm">
              <Row label={t('orders.desk.itemsTotal')} poisha={order.amounts.itemsPoisha} />
              <Row label={t('orders.desk.discountTotal')} poisha={order.amounts.discountPoisha} />
              <Row
                label={t('orders.desk.deliveryTotal')}
                poisha={order.amounts.deliveryChargePoisha}
              />
              <Row label={t('orders.detail.advance')} poisha={order.amounts.advancePaidPoisha} />
              <div className="flex items-baseline justify-between border-t border-border pt-2">
                <dt className="font-medium">{t('orders.desk.cod')}</dt>
                <dd className="text-base font-semibold">
                  <Money poisha={order.amounts.codAmountPoisha} locale={locale} />
                </dd>
              </div>
            </dl>
          </section>

          <AdvancesPanel order={order} />

          {order.notes === null && sourceEntries.length === 0 ? null : (
            <section className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm">
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

      <Dialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={t('orders.detail.cancelTitle')}
        closeLabel={t('orders.close')}
        footer={
          <>
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              {t('orders.detail.keep')}
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length < 3 || act.isPending}
              onClick={() => act.mutate('cancel')}
            >
              {t('orders.detail.cancel')}
            </Button>
          </>
        }
      >
        <label className="block space-y-1.5 text-sm">
          <span className="font-medium">{t('orders.detail.cancelReason')}</span>
          <textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </label>
      </Dialog>
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
