import type { MessageKey } from '@elysium/i18n';
import { Button, EmptyState, StatusBadge } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Printer } from 'lucide-react';

import { useT } from '../../i18n/locale.js';
import { stationJobs } from './api.js';
import { setStationPaused, useStationState } from './background-station.js';
import { JobStateBadge, lotText } from './parts.js';
import { useBrandBinding } from './terminal-binding.js';

/**
 * Labels → Print station (M46, D-816; D-900): what the label computer is printing. The printing
 * itself runs on every page of the console on a computer bound to a label terminal
 * (`background-station.tsx`, mounted by the work dock), so this page is its window: the jobs
 * waiting, the last one printed, a failure, Pause and Resume, and how to print without Chrome's
 * dialog. With Chrome started with `--kiosk-printing`, printing goes to the default printer
 * without a dialog.
 */
export function PrintStation() {
  const t = useT();
  const binding = useBrandBinding();
  const station = useStationState();
  const label = binding?.kind === 'label';
  // The background station's own query: the same key, so one poll serves both.
  const jobs = useQuery({
    queryKey: ['labels', 'station', binding?.token ?? 'none'],
    queryFn: stationJobs,
    enabled: label,
    refetchInterval: 15_000,
    retry: false,
  });

  if (!label) {
    return <EmptyState title={t('lb.station.title')} detail={t('lb.station.needBinding')} />;
  }
  const waiting = (jobs.data?.items ?? []).filter((job) => job.id !== station.busy);
  const { paused, busy, last, failure } = station;
  return (
    <div className="space-y-4" data-testid="print-station">
      <section className="space-y-3 rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Printer aria-hidden className="size-4" />
              {`${t('lb.station.on')} ${binding.terminalName}`}
            </h2>
            <p className="text-sm text-muted-foreground">{t('lb.station.detail')}</p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge
              tone={
                station.role !== 'here' || paused ? 'warning' : busy === null ? 'neutral' : 'info'
              }
            >
              {station.role === 'elsewhere'
                ? t('lb.station.elsewhere')
                : station.role === 'off'
                  ? t('lb.station.starting')
                  : paused
                    ? t('lb.station.paused')
                    : busy === null
                      ? t('lb.station.waiting')
                      : t('lb.station.printing')}
            </StatusBadge>
            {/* Only the tab that prints can pause it (D-900's review). */}
            <Button
              size="sm"
              variant="outline"
              disabled={station.role !== 'here'}
              onClick={() => setStationPaused(!paused)}
            >
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? t('lb.station.resume') : t('lb.station.pause')}
            </Button>
          </div>
        </div>
        {station.role === 'elsewhere' ? (
          <p className="text-sm text-muted-foreground">{t('lb.station.elsewhereDetail')}</p>
        ) : null}
        {failure === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {failure}
          </p>
        )}
        {station.dialog ? (
          <p role="status" className="text-sm text-warning-subtle-foreground">
            {t('lb.station.dialog')}
          </p>
        ) : null}
        {last === null ? null : (
          <p className="text-sm" role="status">
            {`${t('lb.station.last')}: ${last.orderNo === '' ? t('lb.doc.test') : last.orderNo} · ${t(`lb.doc.${last.document}` as MessageKey)}${last.lotCount > 1 ? ` · ${lotText(t, last.lot, last.lotCount)}` : ''}`}
          </p>
        )}
      </section>
      {waiting.length === 0 ? null : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card text-sm">
          {waiting.map((job) => (
            <li key={job.id} className="flex h-row items-center justify-between gap-3 px-3">
              <span className="tabular-nums">
                {job.orderNo === '' ? t('lb.doc.test') : job.orderNo}
                {` · ${t(`lb.doc.${job.document}` as MessageKey)}`}
                {job.lotCount > 1 ? ` · ${lotText(t, job.lot, job.lotCount)}` : ''}
              </span>
              <JobStateBadge state={job.state} />
            </li>
          ))}
        </ul>
      )}
      <section className="space-y-1 rounded-lg border border-border p-4 text-sm">
        <h3 className="font-medium">{t('lb.station.kioskTitle')}</h3>
        <p className="text-muted-foreground">{t('lb.station.kiosk')}</p>
      </section>
    </div>
  );
}
