import {
  Button,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  PermissionGate,
  Select,
  Sheet,
  StatusBadge,
} from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Wallet } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { createRun, listRuns } from './api.js';
import { control, Field, HrNav, hrPath, RUN_TONE } from './hr-nav.js';
import { useHrT, type HrMessageKey } from './messages.js';

/* The runs table in the kit DataTable's frame and rhythm (D-448). */
const TH =
  'h-10 border-b border-border px-4 text-left text-xs font-medium whitespace-nowrap text-muted-foreground';
const TH_NUMERIC = `${TH} text-right`;
const TD = 'h-row border-b border-border px-4 whitespace-nowrap';
const TD_NUMERIC = `${TD} text-right tabular-nums`;
const TR =
  'motion-safe:duration-fast hover:bg-accent/60 motion-safe:transition-colors [&:last-child>td]:border-b-0';

/**
 * The payroll runs list (§12; M19's Build list).
 *
 * The screen's job is to be honest about where each month stands, which is why the status
 * column is the widest thing on it. `draft → waiting for approval → posted, not yet paid →
 * paid` are four genuinely different states of the *books*, not four steps of a wizard: a
 * draft has changed nothing, a run waiting for a checker has changed nothing either, a posted
 * run is a liability the company owes, and a paid one has left the wallet. A screen that
 * collapsed the middle two into "submitted" would be hiding the one distinction the whole
 * maker-checker design exists to make.
 *
 * There is no "post" button anywhere in the console, for anybody. A run is posted by the
 * transaction that approves it, from the approvals inbox — so the only way to book a month's
 * salary is for a second person to agree to it (§6, D-072).
 */
export function PayrollPage() {
  const t = useHrT();
  const ability = useAbility();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Payroll');
  const mayCreate = ability.can('create', 'Payroll');

  const runs = useQuery({
    queryKey: ['hr', 'runs'],
    queryFn: () => listRuns(),
    enabled: mayRead,
  });

  const items = runs.data?.items ?? [];
  const [starting, setStarting] = useState(false);

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('hr.deniedTitle'), detail: t('hr.deniedDetail') }}
    >
      <div className="space-y-6">
        <PageHeader
          title={t('hr.payroll')}
          description={t('hr.payrollHint')}
          actions={
            mayCreate ? (
              <Button onClick={() => setStarting(true)}>
                <CalendarPlus aria-hidden="true" />
                {t('hr.newRun')}
              </Button>
            ) : undefined
          }
          tabs={<HrNav />}
        />

        {mayCreate ? (
          <NewRunSheet
            open={starting}
            onOpenChange={setStarting}
            onCreated={() => void queryClient.invalidateQueries({ queryKey: ['hr', 'runs'] })}
          />
        ) : null}

        {runs.isError ? (
          <ErrorState
            title={t('hr.errorTitle')}
            detail={t('hr.errorDetail')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void runs.refetch()}>
                {t('hr.retry')}
              </Button>
            }
          />
        ) : items.length === 0 && !runs.isLoading ? (
          <EmptyState
            icon={Wallet}
            title={t('hr.emptyTitle')}
            detail={t('hr.emptyRuns')}
            {...(mayCreate
              ? {
                  action: (
                    <Button size="sm" onClick={() => setStarting(true)}>
                      <CalendarPlus aria-hidden="true" />
                      {t('hr.newRun')}
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <section
            aria-label={t('hr.payroll')}
            className="overflow-x-auto rounded-lg border border-border bg-card"
          >
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">{t('hr.payroll')}</caption>
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    {t('hr.colMonth')}
                  </th>
                  <th scope="col" className={TH_NUMERIC}>
                    {t('hr.colStaff')}
                  </th>
                  <th scope="col" className={TH_NUMERIC}>
                    {t('hr.colGross')}
                  </th>
                  <th scope="col" className={TH_NUMERIC}>
                    {t('hr.colDeductions')}
                  </th>
                  <th scope="col" className={TH_NUMERIC}>
                    {t('hr.colNet')}
                  </th>
                  <th scope="col" className={TH}>
                    {t('hr.colStatus')}
                  </th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">{t('hr.open')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((run) => (
                  <tr key={run.id} className={TR}>
                    <td className={`${TD} font-medium tabular-nums`}>{run.month}</td>
                    <td className={TD_NUMERIC}>{run.employeeCount}</td>
                    <td className={TD_NUMERIC}>
                      <Money poisha={run.grossPoisha} />
                    </td>
                    <td className={`${TD_NUMERIC} text-muted-foreground`}>
                      <Money poisha={run.deductionsPoisha} />
                    </td>
                    <td className={`${TD_NUMERIC} font-medium`}>
                      <Money poisha={run.netPoisha} />
                    </td>
                    <td className={TD}>
                      <StatusBadge tone={RUN_TONE[run.status] ?? 'neutral'}>
                        {t(`hr.run.${run.status}` as HrMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className={`${TD} text-right`}>
                      <Link
                        to={hrPath(`/payroll/runs/${run.id}`)}
                        className="rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {t('hr.open')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </PermissionGate>
  );
}

/** This month in Asia/Dhaka, as `YYYY-MM`. */
function currentMonth(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

/**
 * Starting a month's run, in a sheet (D-447): three fields asked for once a month, so they
 * no longer sit open above the list of runs.
 */
function NewRunSheet({
  open,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: () => void;
}) {
  const t = useHrT();
  const common = useT();
  const [month, setMonth] = useState(currentMonth());
  const [policy, setPolicy] = useState<'present' | 'absent'>('present');
  const [memo, setMemo] = useState('');

  const create = useMutation({
    mutationFn: () =>
      createRun({
        month,
        unrecordedPolicy: policy,
        ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
      }),
    onSuccess: () => {
      setMemo('');
      onCreated();
      onOpenChange(false);
    },
  });

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('hr.newRun')}
      description={t('hr.payrollHint')}
      closeLabel={common('common.close')}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('hr.cancel')}
          </Button>
          <Button type="submit" form="new-run-form" disabled={month === '' || create.isPending}>
            {t('hr.newRun')}
          </Button>
        </>
      }
    >
      <form
        id="new-run-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (month !== '' && !create.isPending) create.mutate();
        }}
      >
        <Field label={t('hr.colMonth')} id="run-month">
          <input
            id="run-month"
            type="month"
            value={month}
            required
            className={control}
            onChange={(event) => setMonth(event.target.value)}
          />
        </Field>
        {/*
          The unrecorded-day policy is set per run and shown on the form rather than buried in
          settings, because it is the single assumption that most changes what people are paid
          (D-186) — and the person starting the run is the person who knows whether the
          biometric export for that month is complete.
        */}
        <Field label={t('hr.unrecordedPolicy')} id="run-policy">
          <Select
            id="run-policy"
            value={policy}
            onValueChange={(value) => setPolicy(value === 'absent' ? 'absent' : 'present')}
            options={[
              { value: 'present', label: t('hr.unrecorded.present') },
              { value: 'absent', label: t('hr.unrecorded.absent') },
            ]}
          />
        </Field>
        <Field label={t('hr.field.note')} id="run-memo">
          <input
            id="run-memo"
            value={memo}
            maxLength={500}
            className={control}
            onChange={(event) => setMemo(event.target.value)}
          />
        </Field>
        {create.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {create.error instanceof ApiError ? create.error.message : t('hr.saveFailed')}
          </p>
        )}
      </form>
    </Sheet>
  );
}
