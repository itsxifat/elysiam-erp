import { Button, Money } from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';

import { ApiError } from '../../api.js';
import { applyRunBonuses, listRunBonuses } from './performance-api.js';
import { usePerfT } from './performance-messages.js';
import { percentText } from './performance-shared.js';

/**
 * A payroll run's target bonuses (M20; D-275): what each approved bonus rule paid whom,
 * and why.
 *
 * On a draft, HR applies the rules; the server evaluates every approved version against
 * the run month's targets and replaces the bonuses an earlier apply made, leaving the ones
 * typed by hand. Once the run is submitted the list is what the checker approved, and the
 * button is gone — the server refuses it anyway.
 */
export function RunTargetBonuses({
  runId,
  canApply,
  onChanged,
}: {
  readonly runId: string;
  readonly canApply: boolean;
  readonly onChanged: () => void;
}) {
  const t = usePerfT();
  const awards = useQuery({
    queryKey: ['hr', 'run', runId, 'target-bonuses'],
    queryFn: () => listRunBonuses(runId),
    enabled: runId !== '',
  });
  const apply = useMutation({
    mutationFn: () => applyRunBonuses(runId),
    onSuccess: () => {
      void awards.refetch();
      onChanged();
    },
  });
  const items = awards.data?.items ?? [];

  return (
    <section
      aria-label={t('perf.runBonuses')}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{t('perf.runBonuses')}</h2>
          {canApply ? (
            <p className="text-xs text-muted-foreground">{t('perf.runBonusesHint')}</p>
          ) : null}
        </div>
        {canApply ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={apply.isPending}
            onClick={() => apply.mutate()}
          >
            {t('perf.applyBonuses')}
          </Button>
        ) : null}
      </div>
      {apply.error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {apply.error instanceof ApiError ? apply.error.message : t('hr.saveFailed')}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('perf.emptyAwards')}</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('perf.runBonuses')}</caption>
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2">
                {t('perf.employee')}
              </th>
              <th scope="col" className="py-2">
                {t('perf.rule')}
              </th>
              <th scope="col" className="py-2 text-right">
                {t('perf.progress')}
              </th>
              <th scope="col" className="py-2 text-right">
                {t('perf.total')}
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((award) => (
              <tr key={award.id} className="h-9 border-b border-border/60">
                <td className="py-2">
                  <span className="text-muted-foreground tabular-nums">{award.employeeCode}</span>{' '}
                  {award.employeeName}
                </td>
                <td className="py-2">
                  {award.ruleName}{' '}
                  <span className="text-muted-foreground tabular-nums">
                    {t('perf.version')} {award.version}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">{percentText(award.pctBps)}</td>
                <td className="py-2 text-right">
                  <Money poisha={award.amountPoisha} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
