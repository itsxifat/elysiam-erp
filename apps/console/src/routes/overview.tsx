import type { MessageKey } from '@elysium/i18n';
import { formatCount } from '@elysium/i18n';
import {
  Card,
  MetricList,
  Money,
  PageHeader,
  Section,
  Skeleton,
  StatCard,
  StatusBadge,
  buttonVariants,
  cn,
  type StatDelta,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  BadgeCheck,
  CircleCheck,
  ListChecks,
  PackageSearch,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

import { listApprovals } from '../api/approvals.js';
import { useAbility, useSession } from '../auth/session.js';
import { useLocale, useT } from '../i18n/locale.js';
import { visiblePaletteActions } from '../shell/navigation.js';
import { useProfile } from '../shell/profile.js';
import { getDashboard, type Dashboard } from './analytics/api.js';
import { dhakaToday, percent, roas, signedPercent } from './analytics/format.js';
import { TrendChart } from './analytics/trend-chart.js';
import { stuckParcels } from './courier/api.js';
import { listOrders } from './orders/api.js';

/**
 * The landing screen (D-453): where the brand stands today, and what is waiting.
 *
 * Built in the order a person reads it. A greeting and one line of context; then the
 * three or four figures that matter, large, with their trend against the week before;
 * then what needs a decision, as a list of things to open; then the rest of the
 * figures in a compact statement and the fortnight's revenue as a chart. Every block is
 * asked of the caller's own ability, so a sales agent gets their queue and their
 * shortcuts, and an owner gets the business.
 *
 * The three facts the frame used to show (brand, roles, branch scope) stay at the
 * foot, under "Your workspace": when a screen shows fewer rows than expected, they are
 * still the first place to look.
 */

type Path = ComponentProps<typeof Link>['to'];
const path = (to: string): Path => to;

function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

function greetingKey(now: Date = new Date()): MessageKey {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', hour12: false })
      .format(now)
      .slice(0, 2),
  );
  if (hour < 12) return 'overview.greetingMorning';
  if (hour < 17) return 'overview.greetingAfternoon';
  return 'overview.greetingEvening';
}

/** Change against the week before, as a signed percentage. Bigint all the way: it is money. */
function change(
  current: bigint,
  previous: bigint,
  upIsGood: boolean,
  caption: string,
): { delta?: StatDelta } {
  // Nothing to compare with: no delta at all, rather than a dash that reads as broken.
  if (previous === 0n) return {};
  const bps = ((current - previous) * 10_000n) / previous;
  const direction = bps > 0n ? 'up' : bps < 0n ? 'down' : 'flat';
  const tone =
    direction === 'flat' ? 'neutral' : (direction === 'up') === upIsGood ? 'positive' : 'negative';
  return { delta: { label: signedPercent(bps.toString()), direction, tone, caption } };
}

export function OverviewPage() {
  const session = useSession();
  const ability = useAbility();
  const profile = useProfile();
  const t = useT();
  const context = session.context;

  const org = session.orgs.find((candidate) => candidate.orgId === context?.orgId) ?? null;
  const brand = org?.displayName ?? t('org.none');
  const firstName = profile.name?.split(/\s+/)[0] ?? null;
  const greeting = `${t(greetingKey())}${firstName === null ? '' : `, ${firstName}`}.`;

  const mayDashboard = ability.can('read', 'Dashboard');

  return (
    <div className="space-y-8">
      <PageHeader
        title={t('overview.title')}
        description={
          <>
            <span className="font-medium text-foreground">{greeting}</span>{' '}
            {t('overview.contextLine').replace('{brand}', brand)}
          </>
        }
        actions={<PrimaryAction />}
      />

      {mayDashboard ? <Figures /> : null}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <Attention />
          {mayDashboard ? <WeekChart /> : null}
        </div>
        <div className="space-y-6 lg:col-span-2">
          {mayDashboard ? <MoreFigures /> : null}
          <QuickActions />
          <Workspace />
        </div>
      </div>
    </div>
  );
}

/** The one thing most people open the console to do, if they may. */
function PrimaryAction() {
  const ability = useAbility();
  const t = useT();
  if (!ability.can('create', 'Order')) return null;
  return (
    <Link to={path('/orders/new')} className={buttonVariants({ variant: 'primary' })}>
      {t('palette.actionNewOrder')}
    </Link>
  );
}

// --- the figures -------------------------------------------------------------------------

function useWeeks() {
  const today = dhakaToday();
  const from = addDays(today, -6);
  const previousTo = addDays(today, -7);
  const previousFrom = addDays(today, -13);
  const current = useQuery({
    queryKey: ['analytics', 'dashboard', from, today],
    queryFn: () => getDashboard(from, today),
  });
  const previous = useQuery({
    queryKey: ['analytics', 'dashboard', previousFrom, previousTo],
    queryFn: () => getDashboard(previousFrom, previousTo),
  });
  return { current, previous };
}

function Figures() {
  const t = useT();
  const { locale } = useLocale();
  const { current, previous } = useWeeks();

  if (current.isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Card key={index} className="space-y-4 p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-3 w-20" />
          </Card>
        ))}
      </div>
    );
  }
  if (current.isError) {
    return (
      <Card className="px-5 py-4 text-sm text-muted-foreground" role="status">
        {t('overview.figuresFailed')}
      </Card>
    );
  }

  const now = current.data.totals;
  const before: Dashboard['totals'] | undefined = previous.data?.totals;
  const caption = t('overview.vsPrevious');
  const series = current.data.series;

  return (
    <section aria-labelledby="overview-figures" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="overview-figures" className="text-base font-semibold tracking-tight">
          {t('overview.last7Days')}
        </h2>
        <Link
          to={path('/analytics')}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {t('overview.openAnalytics')}
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('analytics.metric.revenue')}
          value={<Money poisha={now.deliveredRevenuePoisha} locale={locale} align="start" />}
          trend={series.map((day) => Number(day.deliveredRevenuePoisha))}
          {...(before === undefined
            ? {}
            : change(
                BigInt(now.deliveredRevenuePoisha),
                BigInt(before.deliveredRevenuePoisha),
                true,
                caption,
              ))}
        />
        <StatCard
          label={t('analytics.metric.confirmed')}
          value={formatCount(now.ordersConfirmed, locale)}
          trend={series.map((day) => day.ordersConfirmed)}
          {...(before === undefined
            ? {}
            : change(BigInt(now.ordersConfirmed), BigInt(before.ordersConfirmed), true, caption))}
        />
        <StatCard
          label={t('analytics.metric.deliverySuccess')}
          value={percent(now.deliverySuccessBps)}
          trend={series.map((day) => day.ordersDelivered)}
          hint={`${t('analytics.metric.delivered')} ${formatCount(now.ordersDelivered, locale)}`}
        />
        <StatCard
          label={t('analytics.metric.cash')}
          value={<Money poisha={current.data.cashPoisha} locale={locale} align="start" />}
          hint={t('analytics.metric.cashHint')}
        />
      </div>
    </section>
  );
}

function MoreFigures() {
  const t = useT();
  const { locale } = useLocale();
  const { current } = useWeeks();
  const data = current.data;
  if (data === undefined) return null;
  const totals = data.totals;
  const money = (value: string | null | undefined) =>
    value === null || value === undefined ? '—' : <Money poisha={value} locale={locale} />;

  return (
    <Section title={t('overview.moreFigures')} description={t('overview.last7Days')}>
      <MetricList
        items={[
          { label: t('analytics.metric.aov'), value: money(totals.aovPoisha) },
          { label: t('analytics.metric.returnRate'), value: percent(totals.returnRateBps) },
          { label: t('analytics.metric.spend'), value: money(totals.spendPoisha) },
          { label: t('analytics.metric.roas'), value: roas(totals.roasBps) },
          { label: t('analytics.metric.cpdo'), value: money(totals.cpdoPoisha) },
          ...(totals.grossProfitPoisha === undefined
            ? []
            : [
                {
                  label: t('analytics.metric.grossProfit'),
                  value: money(totals.grossProfitPoisha),
                },
              ]),
          ...(data.stockValuePoisha === undefined
            ? []
            : [{ label: t('analytics.metric.stockValue'), value: money(data.stockValuePoisha) }]),
        ]}
      />
    </Section>
  );
}

function WeekChart() {
  const t = useT();
  const { locale } = useLocale();
  const { current, previous } = useWeeks();
  if (current.data === undefined) return null;
  const series = [...(previous.data?.series ?? []), ...current.data.series];
  if (series.length === 0) return null;
  return (
    <Section title={t('analytics.trend')}>
      <TrendChart
        series={series}
        label={t('analytics.trend')}
        tableLabel={t('analytics.trend.table')}
        dateLabel={t('analytics.col.date')}
        revenueLabel={t('analytics.metric.revenue')}
        deliveredLabel={t('analytics.metric.delivered')}
        locale={locale}
      />
    </Section>
  );
}

// --- needs your attention --------------------------------------------------------------

interface AttentionItem {
  readonly key: string;
  readonly icon: LucideIcon;
  readonly label: string;
  readonly count: number;
  /** The list held more than it showed: "50+". */
  readonly more: boolean;
  readonly to: string;
  readonly search?: Record<string, unknown>;
  readonly tone: 'warning' | 'danger' | 'info';
}

function Attention() {
  const t = useT();
  const { locale } = useLocale();
  const ability = useAbility();

  const mayApprove = ability.can('approve', 'ApprovalRequest');
  const mayOrders = ability.can('read', 'Order');

  const approvals = useQuery({
    queryKey: ['overview', 'approvals'],
    queryFn: () => listApprovals({ status: 'pending', limit: 50 }),
    enabled: mayApprove,
  });
  const toConfirm = useQuery({
    queryKey: ['overview', 'to-confirm'],
    queryFn: () => listOrders({ status: 'pending', limit: 50, offset: 0 }),
    enabled: mayOrders,
  });
  const stuck = useQuery({
    queryKey: ['overview', 'stuck'],
    queryFn: () => stuckParcels({ thresholdDays: 3 }),
    enabled: mayOrders,
    retry: false,
  });

  const items: AttentionItem[] = [];
  if (mayApprove && approvals.data !== undefined && approvals.data.rows.length > 0) {
    items.push({
      key: 'approvals',
      icon: BadgeCheck,
      label: t('overview.attentionApprovals'),
      count: approvals.data.rows.length,
      more: approvals.data.nextCursor !== null,
      to: '/approvals',
      tone: 'warning',
    });
  }
  if (mayOrders && toConfirm.data !== undefined && toConfirm.data.items.length > 0) {
    items.push({
      key: 'to-confirm',
      icon: ListChecks,
      label: t('overview.attentionToConfirm'),
      count: toConfirm.data.items.length,
      more: toConfirm.data.hasNext,
      to: '/orders',
      search: { status: 'pending' },
      tone: 'info',
    });
  }
  if (mayOrders && stuck.data !== undefined && stuck.data.items.length > 0) {
    items.push({
      key: 'stuck',
      icon: PackageSearch,
      label: t('overview.attentionStuck'),
      count: stuck.data.items.length,
      more: false,
      to: '/courier/stuck',
      tone: 'danger',
    });
  }

  const loading =
    (mayApprove && approvals.isPending) || (mayOrders && (toConfirm.isPending || stuck.isPending));

  return (
    <Section title={t('overview.needsAttention')} bodyClassName="px-2 pb-2">
      {loading && items.length === 0 ? (
        <div className="space-y-2 px-3 pb-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="flex items-center gap-2.5 px-3 pt-1 pb-3 text-sm text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 text-success" />
          {t('overview.allClear')}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                to={path(item.to)}
                {...(item.search === undefined ? {} : { search: item.search as never })}
                className="group flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-md',
                    item.tone === 'warning' && 'bg-warning-subtle text-warning-subtle-foreground',
                    item.tone === 'danger' &&
                      'bg-destructive-subtle text-destructive-subtle-foreground',
                    item.tone === 'info' && 'bg-info-subtle text-info-subtle-foreground',
                  )}
                >
                  <item.icon aria-hidden="true" className="size-4" />
                </span>
                <span className="min-w-0 flex-1 text-sm text-foreground">{item.label}</span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatCount(item.count, locale)}
                  {item.more ? '+' : ''}
                </span>
                <ArrowRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground group-hover:translate-x-0.5 motion-safe:transition-transform"
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// --- quick actions and the workspace -------------------------------------------------

function QuickActions() {
  const t = useT();
  const ability = useAbility();
  const actions = visiblePaletteActions(ability).slice(0, 5);
  if (actions.length === 0) return null;
  return (
    <Section
      title={t('overview.quickActions')}
      description={t('overview.paletteTip')}
      bodyClassName="px-2 pb-2"
    >
      <ul className="space-y-0.5">
        {actions.map((action) => (
          <li key={action.id}>
            <Link
              to={path(action.to)}
              className="group flex items-center gap-3 rounded-md px-3 py-2 text-sm text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <action.icon aria-hidden="true" className="size-4 text-primary" />
              <span className="flex-1">{t(action.labelKey)}</span>
              <ArrowRight
                aria-hidden="true"
                className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              />
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Workspace() {
  const session = useSession();
  const t = useT();
  const context = session.context;
  const org = session.orgs.find((candidate) => candidate.orgId === context?.orgId) ?? null;

  return (
    <Section title={t('overview.workspace')}>
      <dl className="divide-y divide-border">
        <Fact label={t('overview.activeOrg')}>{org?.displayName ?? t('org.none')}</Fact>
        <Fact label={t('overview.yourRoles')}>
          <span className="flex flex-wrap justify-end gap-1">
            {session.roles.length === 0 ? (
              <span className="text-muted-foreground">{t('common.none')}</span>
            ) : (
              session.roles.map((role) => (
                <StatusBadge key={role} tone="neutral">
                  {role}
                </StatusBadge>
              ))
            )}
          </span>
        </Fact>
        <Fact label={t('overview.branchScope')}>
          {context === null || context.branchIds.length === 0
            ? t('workspace.wholeOrg')
            : String(context.branchIds.length)}
        </Fact>
      </dl>
    </Section>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm font-medium text-foreground">{children}</dd>
    </div>
  );
}
