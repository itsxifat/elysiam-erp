import { Button, EmptyState, ErrorState, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { createRun, listRuns } from './api.js';
import { control, Field, HrNav, hrPath, RUN_TONE } from './hr-nav.js';
import { useHrT, type HrMessageKey } from './messages.js';

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

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('hr.deniedTitle'), detail: t('hr.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{t('hr.payroll')}</h1>
          <p className="text-sm text-muted-foreground">{t('hr.payrollHint')}</p>
        </header>

        <HrNav />

        <PermissionGate allowed={mayCreate}>
          <NewRunForm
            onCreated={() => void queryClient.invalidateQueries({ queryKey: ['hr', 'runs'] })}
          />
        </PermissionGate>

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
          <EmptyState title={t('hr.emptyTitle')} detail={t('hr.emptyRuns')} />
        ) : (
          <section aria-label={t('hr.payroll')}>
            <table className="w-full text-sm">
              <caption className="sr-only">{t('hr.payroll')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('hr.colMonth')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colStaff')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colGross')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colDeductions')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colNet')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colStatus')}
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((run) => (
                  <tr key={run.id} className="h-9 border-b border-border/60">
                    <td className="py-2 tabular-nums">{run.month}</td>
                    <td className="py-2 text-right tabular-nums">{run.employeeCount}</td>
                    <td className="py-2 text-right">
                      <Money poisha={run.grossPoisha} />
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={run.deductionsPoisha} />
                    </td>
                    <td className="py-2 text-right font-medium">
                      <Money poisha={run.netPoisha} />
                    </td>
                    <td className="py-2">
                      <StatusBadge tone={RUN_TONE[run.status] ?? 'neutral'}>
                        {t(`hr.run.${run.status}` as HrMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className="py-2 text-right">
                      <Link
                        to={hrPath(`/payroll/runs/${run.id}`)}
                        className="rounded-md px-2 py-1 text-sm text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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

function NewRunForm({ onCreated }: { readonly onCreated: () => void }) {
  const t = useHrT();
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
    },
  });

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
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
        <select
          id="run-policy"
          value={policy}
          className={control}
          onChange={(event) => setPolicy(event.target.value === 'absent' ? 'absent' : 'present')}
        >
          <option value="present">{t('hr.unrecorded.present')}</option>
          <option value="absent">{t('hr.unrecorded.absent')}</option>
        </select>
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
      <div className="flex items-end gap-3">
        <Button type="submit" size="sm" disabled={month === '' || create.isPending}>
          {t('hr.newRun')}
        </Button>
      </div>
      {create.error === null ? null : (
        <p role="alert" className="text-sm text-destructive sm:col-span-4">
          {create.error instanceof ApiError ? create.error.message : t('hr.saveFailed')}
        </p>
      )}
    </form>
  );
}
