import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  PermissionGate,
  Select,
  StatusBadge,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { listEmployees } from './api.js';
import { control, Field, numericControl } from './hr-nav.js';
import {
  cancelTarget,
  createTarget,
  listTargets,
  refreshTargets,
  TARGET_METRICS,
  type TargetMetric,
} from './performance-api.js';
import { usePerfT, type PerfMessageKey } from './performance-messages.js';
import {
  currentMonth,
  metricKey,
  PerformanceNav,
  ProgressBar,
  TargetFigure,
} from './performance-shared.js';

/**
 * Targets for a month (§12; M20).
 *
 * HR sets one per employee per metric, and the server splits it into weeks by the
 * employee's working days (D-271); nothing on this form says how the weeks are planned,
 * because nobody gets to choose that. A target is never edited — the agent was shown it on
 * the first of the month — so the only action on a row is cancel, after which a new one may
 * be set.
 *
 * The list is the caller's scope: an agent's own targets, a branch manager's branch, HR's
 * brand.
 */
export function TargetsPage() {
  const t = usePerfT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayRead = ability.can('read', 'Target');
  const mayCreate = ability.can('create', 'Target');
  const mayUpdate = ability.can('update', 'Target');
  const [month, setMonth] = useState(currentMonth());

  const targets = useQuery({
    queryKey: ['performance', 'targets', month],
    queryFn: () => listTargets({ month }),
    enabled: mayRead && month !== '',
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['performance'] });

  const cancel = useMutation({ mutationFn: cancelTarget, onSuccess: invalidate });
  const refresh = useMutation({ mutationFn: refreshTargets, onSuccess: invalidate });
  const items = targets.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('perf.deniedTitle'), detail: t('perf.deniedDetail') }}
    >
      <div className="space-y-6">
        <PageHeader
          title={t('perf.targets')}
          description={t('perf.targetsHint')}
          tabs={<PerformanceNav />}
        />

        <PermissionGate allowed={mayCreate}>
          <NewTargetForm month={month} onCreated={invalidate} />
        </PermissionGate>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-40">
            <Field label={t('perf.month')} id="targets-month">
              <input
                id="targets-month"
                type="month"
                value={month}
                className={control}
                onChange={(event) => setMonth(event.target.value)}
              />
            </Field>
          </div>
          <PermissionGate allowed={mayUpdate}>
            <Button
              size="sm"
              variant="secondary"
              disabled={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              {t('perf.refresh')}
            </Button>
          </PermissionGate>
        </div>

        {targets.isError ? (
          <ErrorState
            title={t('hr.errorTitle')}
            detail={t('hr.errorDetail')}
            action={
              <Button size="sm" variant="secondary" onClick={() => void targets.refetch()}>
                {t('hr.retry')}
              </Button>
            }
          />
        ) : items.length === 0 && !targets.isLoading ? (
          <EmptyState title={t('hr.emptyTitle')} detail={t('perf.emptyTargets')} />
        ) : (
          <section aria-label={t('perf.targets')}>
            <table className="w-full text-sm">
              <caption className="sr-only">{t('perf.targets')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('perf.employee')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('perf.metric')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.target')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('perf.achieved')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('perf.progress')}
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((target) => (
                  <tr key={target.id} className="h-9 border-b border-border/60">
                    <td className="py-2">
                      <span className="text-muted-foreground tabular-nums">
                        {target.employeeCode ?? ''}
                      </span>{' '}
                      {target.employeeName ?? target.teamName ?? ''}
                    </td>
                    <td className="py-2">{t(metricKey(target.metric))}</td>
                    <td className="py-2 text-right">
                      <TargetFigure metric={target.metric} value={target.targetValue} />
                    </td>
                    <td className="py-2 text-right">
                      <TargetFigure metric={target.metric} value={target.achieved} />
                    </td>
                    <td className="py-2">
                      {target.status === 'active' ? (
                        <ProgressBar pctBps={target.pctBps} label={t('perf.progress')} />
                      ) : (
                        <StatusBadge tone="neutral">
                          {t(`perf.status.${target.status}` as PerfMessageKey)}
                        </StatusBadge>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {mayUpdate && target.status === 'active' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate(target.id)}
                        >
                          {t('perf.cancelTarget')}
                        </Button>
                      ) : null}
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

function NewTargetForm({
  month,
  onCreated,
}: {
  readonly month: string;
  readonly onCreated: () => void;
}) {
  const t = usePerfT();
  const [employeeId, setEmployeeId] = useState('');
  const [metric, setMetric] = useState<TargetMetric>('confirmed_orders');
  const [value, setValue] = useState('');

  const employees = useQuery({
    queryKey: ['hr', 'employees', 'for-targets'],
    queryFn: () => listEmployees({ status: 'active', pageSize: 200 }),
    staleTime: 5 * 60_000,
  });

  const create = useMutation({
    mutationFn: () => {
      // Revenue is typed in taka and sent as poisha; a count is sent as typed.
      const targetValue =
        metric === 'delivered_revenue' ? takaToPoisha(value) : /^\d+$/.test(value) ? value : null;
      if (targetValue === null) throw new ApiError(400, null, t('hr.saveFailed'));
      return createTarget({ scope: 'employee', month, metric, employeeId, targetValue });
    },
    onSuccess: () => {
      setValue('');
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
      <Field label={t('perf.employee')} id="target-employee">
        <Select
          id="target-employee"
          value={employeeId}
          required
          placeholder={t('perf.employee')}
          onValueChange={setEmployeeId}
          options={(employees.data?.items ?? []).map((employee) => ({
            value: employee.id,
            label: `${employee.code} · ${employee.fullName}`,
          }))}
        />
      </Field>
      <Field label={t('perf.metric')} id="target-metric">
        <Select
          id="target-metric"
          value={metric}
          onValueChange={(value) =>
            setMetric(TARGET_METRICS.find((one) => one === value) ?? 'confirmed_orders')
          }
          options={TARGET_METRICS.map((one) => ({ value: one, label: t(metricKey(one)) }))}
        />
      </Field>
      <Field label={t('perf.target')} id="target-value">
        <input
          id="target-value"
          inputMode={metric === 'delivered_revenue' ? 'decimal' : 'numeric'}
          value={value}
          required
          className={numericControl}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <div className="flex items-end">
        <Button
          type="submit"
          size="sm"
          disabled={employeeId === '' || value === '' || create.isPending}
        >
          {t('perf.newTarget')}
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
