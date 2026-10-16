import type { MessageKey } from '@elysium/i18n';
import { Button, EmptyState, StatusBadge } from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, Printer } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { playTone } from '../../alive/tones.js';
import { useT } from '../../i18n/locale.js';
import { useRealtime } from '../../realtime/use-realtime.js';
import { stationDocument, stationJobs, stationResult, type PrintJob } from './api.js';
import { JobStateBadge, lotText } from './parts.js';
import { useTerminalBinding } from './terminal-binding.js';

/**
 * Labels → Print station (M46, D-816): left open on the label desk's computer, it prints this
 * terminal's jobs for its browser printers by itself. A job arrives over the realtime socket
 * (`labels.job_changed`, ids only) or the quarter-minute poll; its PDF is fetched with the
 * session and the binding, opened as a blob in a hidden frame and printed from there, one copy
 * after another, and the result is confirmed to the server. With Chrome started with
 * `--kiosk-printing`, printing goes to the default printer without a dialog.
 */

/** Print a PDF from a hidden frame: resolves once the browser's print call returned. */
async function printPdf(frame: HTMLIFrameElement, blob: Blob, copies: number): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('The page did not load to print.')),
        20_000,
      );
      frame.onload = () => {
        window.clearTimeout(timer);
        resolve();
      };
      frame.src = url;
    });
    // The PDF viewer draws a moment after the frame loads.
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    const target = frame.contentWindow;
    if (target === null) throw new Error('The print frame is gone.');
    for (let copy = 0; copy < copies; copy += 1) {
      target.focus();
      target.print();
    }
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

export function PrintStation() {
  const t = useT();
  const binding = useTerminalBinding();
  const queryClient = useQueryClient();
  const frame = useRef<HTMLIFrameElement>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<PrintJob | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const label = binding?.kind === 'label';
  const jobs = useQuery({
    queryKey: ['labels', 'station', binding?.token ?? 'none'],
    queryFn: stationJobs,
    enabled: label,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: false,
  });
  const onEvent = useCallback(
    (_name: string, payload: unknown) => {
      const event = payload as { terminalId?: unknown; state?: unknown } | null;
      if (event?.terminalId === binding?.terminalId && event?.state === 'queued') {
        void queryClient.invalidateQueries({ queryKey: ['labels', 'station'] });
      }
    },
    [binding?.terminalId, queryClient],
  );
  useRealtime({ events: ['labels.job_changed'], onEvent, enabled: label });

  const next = (jobs.data?.items ?? []).find(
    (job) => job.state === 'queued' || job.state === 'sending',
  );

  useEffect(() => {
    if (!label || paused || busy !== null || next === undefined || frame.current === null) return;
    const job = next;
    const target = frame.current;
    setBusy(job.id);
    setFailure(null);
    void (async () => {
      try {
        const blob = await stationDocument(job.id);
        await printPdf(target, blob, job.copies);
        await stationResult(job.id, 'printed');
        setLast(job);
        playTone('sent');
      } catch (error) {
        const message = error instanceof Error ? error.message : t('lb.failed');
        setFailure(message);
        playTone('error');
        await stationResult(job.id, 'failed', message).catch(() => undefined);
      } finally {
        setBusy(null);
        await queryClient.invalidateQueries({ queryKey: ['labels'] });
      }
    })();
  }, [label, paused, busy, next, queryClient, t]);

  if (!label) {
    return <EmptyState title={t('lb.station.title')} detail={t('lb.station.needBinding')} />;
  }
  const waiting = (jobs.data?.items ?? []).filter((job) => job.id !== busy);
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
            <StatusBadge tone={paused ? 'warning' : busy === null ? 'neutral' : 'info'}>
              {paused
                ? t('lb.station.paused')
                : busy === null
                  ? t('lb.station.waiting')
                  : t('lb.station.printing')}
            </StatusBadge>
            <Button size="sm" variant="outline" onClick={() => setPaused(!paused)}>
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? t('lb.station.resume') : t('lb.station.pause')}
            </Button>
          </div>
        </div>
        {failure === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {failure}
          </p>
        )}
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
      {/* The frame the PDFs print from: off-screen, never shown. */}
      <iframe
        ref={frame}
        title={t('lb.station.title')}
        aria-hidden="true"
        tabIndex={-1}
        className="pointer-events-none fixed size-1 opacity-0"
      />
    </div>
  );
}
