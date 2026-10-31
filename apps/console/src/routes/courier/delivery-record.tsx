import { Button, Skeleton, StatusBadge } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';

import { useAbility } from '../../auth/session.js';
import { deliveryRecord, type DeliveryRecordAnswer, type DeliveryRisk } from './api.js';
import { dhakaDateTime } from './courier-ui.js';
import { useCourierT, type CourierMessageKey } from './messages.js';

const RISK_TONE = {
  new: 'neutral',
  good: 'success',
  caution: 'warning',
  risky: 'danger',
} as const satisfies Readonly<Record<DeliveryRisk, string>>;

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'fake_order',
  'no_response',
  'blocked',
  'cancelled_after_confirm',
  'other',
]);

/**
 * A buyer's delivery record with the brand's courier (D-918), on the order desk and the order
 * page: Steadfast's own fraud check, counts across every shop it delivers for, and one word
 * (New buyer, Good, Caution, Risky) with what to do about it. Advice only: nothing here stops
 * an order.
 *
 * Shown to roles that read customers, like the desk's own lookup. A brand with no Steadfast
 * connected sees a pointer to Settings → Couriers only when the person can connect one;
 * everyone else sees nothing.
 */
export function DeliveryRecordPanel({ phone }: { readonly phone: string | null }) {
  const ability = useAbility();
  const mayRead = ability.can('read', 'Customer');
  const query = useQuery({
    queryKey: ['courier', 'delivery-record', phone],
    queryFn: () => deliveryRecord(phone ?? ''),
    enabled: phone !== null && mayRead,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  if (phone === null || !mayRead) return null;
  if (query.isPending) return <RecordSkeleton />;
  if (query.isError) return <RecordProblem onRetry={() => void query.refetch()} />;
  const answer = query.data;
  if (answer.reason === 'no_courier') {
    return ability.can('update', 'CourierSettlement') ? <NoCourier /> : null;
  }
  if (!answer.available || answer.record === null || answer.risk === null) {
    return <RecordProblem message={answer.message} onRetry={() => void query.refetch()} />;
  }
  return <RecordCard answer={answer} record={answer.record} risk={answer.risk} />;
}

function RecordCard({
  answer,
  record,
  risk,
}: {
  readonly answer: DeliveryRecordAnswer;
  readonly record: NonNullable<DeliveryRecordAnswer['record']>;
  readonly risk: DeliveryRisk;
}) {
  const t = useCourierT();
  const name = answer.courier?.name ?? '';
  return (
    <section
      aria-labelledby="delivery-record-title"
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="delivery-record-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck aria-hidden="true" className="size-4 text-muted-foreground" />
          {t('courier.record.title')}
        </h2>
        <StatusBadge tone={RISK_TONE[risk]}>
          {t(`courier.record.risk.${risk}` as CourierMessageKey)}
        </StatusBadge>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(`courier.record.riskHint.${risk}` as CourierMessageKey)}
      </p>
      <dl className="grid grid-cols-3 gap-2 text-center">
        <Stat label={t('courier.record.delivered')} value={String(record.delivered)} />
        <Stat label={t('courier.record.cancelled')} value={String(record.cancelled)} />
        <Stat
          label={t('courier.record.success')}
          value={record.successPercent === null ? '—' : `${String(record.successPercent)}%`}
        />
      </dl>
      {record.reports === 0 ? null : (
        <div className="space-y-1 text-xs">
          <p className="flex justify-between gap-2">
            <span className="text-muted-foreground">{t('courier.record.reports')}</span>
            <span className="font-medium tabular-nums">{record.reports}</span>
          </p>
          <ul className="flex flex-wrap gap-1">
            {record.reportReasons.map((reason) => (
              <li
                key={reason.code}
                className="rounded-sm border border-border px-1.5 py-0.5 text-muted-foreground"
              >
                {reasonLabel(t, reason.code)}{' '}
                <span className="text-foreground tabular-nums">{reason.count}</span>
              </li>
            ))}
          </ul>
          {record.doubtfulReports ? (
            <p className="text-muted-foreground">{t('courier.record.doubtful')}</p>
          ) : null}
        </div>
      )}
      <dl className="space-y-1 text-xs">
        {record.volumeRange === null ? null : (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{t('courier.record.volume')}</dt>
            <dd className="tabular-nums">{record.volumeRange}</dd>
          </div>
        )}
        {record.courierLevel === null ? null : (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{t('courier.record.courierLevel')}</dt>
            <dd>{record.courierLevel}</dd>
          </div>
        )}
      </dl>
      <p className="border-t border-border pt-2 text-xs text-muted-foreground">
        {t('courier.record.source').replaceAll('{name}', name)}
        {answer.checkedAt === null
          ? null
          : ` ${t('courier.record.checked').replace('{when}', dhakaDateTime(answer.checkedAt))}`}
      </p>
    </section>
  );
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="rounded-md border border-border px-2 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** A reason Steadfast added after this screen was written reads as its own words. */
function reasonLabel(t: (key: CourierMessageKey) => string, code: string): string {
  if (KNOWN_REASONS.has(code)) return t(`courier.record.reason.${code}` as CourierMessageKey);
  const words = code.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function RecordSkeleton() {
  const t = useCourierT();
  return (
    <section
      aria-busy="true"
      aria-label={t('courier.record.loading')}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <Skeleton className="h-4 w-32" />
      <div className="grid grid-cols-3 gap-2">
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
      </div>
    </section>
  );
}

function RecordProblem({
  message = null,
  onRetry,
}: {
  readonly message?: string | null;
  readonly onRetry: () => void;
}) {
  const t = useCourierT();
  return (
    <section className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-4 text-xs">
      <p className="text-muted-foreground">
        <span className="block text-sm font-medium text-foreground">
          {t('courier.record.title')}
        </span>
        {message ?? t('courier.record.unavailable')}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t('courier.record.retry')}
      </Button>
    </section>
  );
}

function NoCourier() {
  const t = useCourierT();
  return (
    <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
      {t('courier.record.noCourier')}
    </p>
  );
}
