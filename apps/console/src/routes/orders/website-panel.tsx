import { Money, StatusBadge } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';

import { useLocale } from '../../i18n/locale.js';
import { orderWebsite } from '../website/api.js';
import { useWebsiteT, type WebsiteMessageKey } from '../website/messages.js';
import { useOrdersT } from './messages.js';
import '../../i18n/website.js';

const TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  paid: 'success',
  refused: 'danger',
  failed: 'danger',
  ready: 'warning',
  initiating: 'warning',
  cancelled: 'neutral',
  expired: 'neutral',
};

/**
 * A website order's card on the order page (M34, D-533): the shopper's account (or a guest
 * checkout), how they chose to pay, and the online payments with what SSLCommerz said. Shown
 * to whoever opens the order (`read Order`, its own scope), only for an order the website placed.
 */
export function WebsitePanel({
  orderId,
  channel,
}: {
  readonly orderId: string;
  readonly channel: string;
}) {
  const t = useOrdersT();
  const tw = useWebsiteT();
  const { locale } = useLocale();
  // The card is part of the order page, under the order's own scope (ledger audit W6).
  const allowed = channel === 'website';
  const query = useQuery({
    queryKey: ['orders', orderId, 'website'],
    queryFn: () => orderWebsite(orderId),
    enabled: allowed,
  });
  const website = query.data?.website;
  if (!allowed || website === undefined || website === null) return null;

  return (
    <section
      aria-labelledby={`${orderId}-website`}
      className="space-y-3 rounded-lg border border-border bg-card p-5 text-sm"
    >
      <h2 id={`${orderId}-website`} className="text-base font-semibold tracking-tight">
        {t('orders.web.title')}
      </h2>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t('orders.web.account')}</dt>
          <dd>
            {website.account === null ? (
              t('orders.web.guest')
            ) : (
              <>
                {website.account.name} · <span className="break-all">{website.account.email}</span>{' '}
                <span className="text-xs text-muted-foreground">
                  (
                  {website.account.emailVerified
                    ? t('orders.web.verified')
                    : t('orders.web.unverified')}
                  )
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('orders.web.payment')}</dt>
          <dd>
            {website.paymentMethod === 'sslcommerz' ? t('orders.web.online') : t('orders.web.cod')}
          </dd>
        </div>
      </dl>
      {website.payments.length === 0 ? null : (
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">{t('orders.web.payments')}</h3>
          <ul className="mt-1 divide-y divide-border">
            {website.payments.map((payment) => (
              <li
                key={payment.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="font-mono text-xs">{payment.tranId}</span>
                <span className="tabular-nums">
                  <Money poisha={payment.amountPoisha} locale={locale} />
                </span>
                <StatusBadge tone={TONE[payment.status] ?? 'neutral'}>
                  {tw(`web.pay.state.${payment.status}` as WebsiteMessageKey)}
                </StatusBadge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
