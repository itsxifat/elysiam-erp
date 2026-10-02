import { Button, EmptyState, ErrorState, PermissionGate, Skeleton } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { formatShare, monthStartOf, todayInDhaka } from './returns-logic.js';
import { returnReasonReport } from './advances-api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { OrdersNav } from './parts.js';

/**
 * Returns by reason (M17 check 3, D-234).
 *
 * Every return and exchange the warehouse received in the chosen Asia/Dhaka dates, counted
 * by the reason recorded with it, with each reason's share of the whole. The server counts
 * within the caller's own order scope, so an agent sees the returns of orders they may read.
 */
export function ReturnReasonsPage() {
  const t = useOrdersT();
  const ability = useAbility();
  const id = useId();
  const today = todayInDhaka(new Date());
  const [from, setFrom] = useState(monthStartOf(today));
  const [to, setTo] = useState(today);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;

  const report = useQuery({
    queryKey: ['orders', 'return-reasons', from, to],
    queryFn: () => returnReasonReport({ from, to }),
    enabled: valid && ability.can('read', 'Order'),
  });
  const lines = report.data?.reasons ?? [];

  return (
    <PermissionGate
      allowed={ability.can('read', 'Order')}
      explain={{ title: t('orders.deniedTitle'), detail: t('orders.deniedDetail') }}
    >
      <div className="space-y-5">
        <header className="space-y-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{t('orders.returns.heading')}</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">{t('orders.returns.caption')}</p>
          </div>
          <OrdersNav />
        </header>

        <div className="flex flex-wrap items-end gap-3">
          <label
            className="space-y-1 text-xs font-medium text-muted-foreground"
            htmlFor={`${id}-from`}
          >
            <span className="block">{t('orders.returns.from')}</span>
            <input
              id={`${id}-from`}
              type="date"
              value={from}
              max={to}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label
            className="space-y-1 text-xs font-medium text-muted-foreground"
            htmlFor={`${id}-to`}
          >
            <span className="block">{t('orders.returns.to')}</span>
            <input
              id={`${id}-to`}
              type="date"
              value={to}
              min={from}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        </div>

        {report.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : report.isError ? (
          <ErrorState
            title={t('orders.errorTitle')}
            detail={t('orders.errorDetail')}
            action={
              <Button size="sm" variant="outline" onClick={() => void report.refetch()}>
                {t('orders.retry')}
              </Button>
            }
          />
        ) : lines.length === 0 ? (
          <EmptyState
            title={t('orders.returns.emptyTitle')}
            detail={t('orders.returns.emptyDetail')}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('orders.returns.heading')}</caption>
              <thead>
                <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-3 py-2">
                    {t('orders.returns.colReason')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('orders.returns.colReturns')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('orders.returns.colExchanges')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('orders.returns.colTotal')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('orders.returns.colShare')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.reason} className="h-row border-b border-border">
                    <td className="px-3">
                      {t(`orders.reason.${line.reason}` as OrdersMessageKey)}
                    </td>
                    <td className="px-3 text-right tabular-nums">{line.returns}</td>
                    <td className="px-3 text-right tabular-nums">{line.exchanges}</td>
                    <td className="px-3 text-right tabular-nums">{line.total}</td>
                    <td className="px-3 text-right tabular-nums">{formatShare(line.shareBps)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-medium">
                  <td className="px-3 py-2">{t('orders.returns.total')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{report.data?.returns ?? 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {report.data?.exchanges ?? 0}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{report.data?.total ?? 0}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatShare(10_000)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </PermissionGate>
  );
}
