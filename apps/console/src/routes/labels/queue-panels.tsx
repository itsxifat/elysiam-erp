import type { MessageKey } from '@elysium/i18n';
import {
  Button,
  Checkbox,
  DateTime,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Money,
  Select,
  Skeleton,
  buttonVariants,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, Printer, RotateCcw, Tag, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { useLocale, useT } from '../../i18n/locale.js';
import { ordersPath } from '../orders/paths.js';
import {
  cancelJob,
  exportJobsUrl,
  listJobs,
  readyForLabel,
  retryJob,
  type JobFilters,
  type JobSource,
  type JobState,
  type PrintJob,
  type ReadyOrder,
} from './api.js';
import {
  JobStateBadge,
  LocationSelect,
  LotsDialog,
  lotText,
  useHubLocations,
  usePrint,
} from './parts.js';

/** Labels' work lists (M46, D-817, D-818): Ready for label, the Queue and the Print log. */

function Loading() {
  const t = useT();
  return (
    <div className="space-y-2" aria-busy="true" aria-label={t('lb.loading')}>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-row w-full" />
      ))}
    </div>
  );
}

function Failed({ onRetry }: { readonly onRetry: () => void }) {
  const t = useT();
  return (
    <ErrorState
      title={t('lb.failed')}
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('lb.retry')}
        </Button>
      }
    />
  );
}

// --- Ready for label --------------------------------------------------------------------------

export function ReadyPanel() {
  const t = useT();
  const { locale } = useLocale();
  const { hub } = useHubLocations();
  const [location, setLocation] = useState<string | null>(null);
  const chosen = location ?? hub ?? '';
  const ready = useQuery({
    queryKey: ['labels', 'ready', chosen],
    queryFn: () => readyForLabel(chosen === '' ? undefined : chosen),
    refetchInterval: 30_000,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [lots, setLots] = useState<ReadyOrder | null>(null);
  const printer = usePrint((queued) => {
    setSelected(new Set());
    setNotice(`${String(queued)} ${t('lb.ready.queued')}`);
  });

  const items = ready.data?.items ?? [];
  const ids = items.filter((item) => selected.has(item.orderId)).map((item) => item.orderId);
  const every = items.length > 0 && ids.length === items.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <LocationSelect value={chosen} onChange={setLocation} />
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={every}
            onCheckedChange={() =>
              setSelected(every ? new Set() : new Set(items.map((item) => item.orderId)))
            }
            aria-label={t('lb.selectAll')}
          />
          {t('lb.selectAll')}
        </label>
        <span className="text-sm text-muted-foreground tabular-nums">
          {ids.length} {t('lb.selected')}
        </span>
        <Button
          size="sm"
          disabled={ids.length === 0 || printer.busy}
          data-testid="print-labels"
          onClick={() => printer.print({ orderIds: ids, documents: ['label'] })}
        >
          <Tag aria-hidden />
          {t('lb.ready.printLabels')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={ids.length === 0 || printer.busy}
          onClick={() => printer.print({ orderIds: ids, documents: ['label', 'packing_slip'] })}
        >
          <Printer aria-hidden />
          {t('lb.ready.printBoth')}
        </Button>
      </div>
      {notice === null && printer.error === null ? null : (
        <p role="status" className="text-sm text-muted-foreground" data-testid="ready-notice">
          {printer.error ?? notice}
        </p>
      )}
      {ready.isPending ? (
        <Loading />
      ) : ready.isError ? (
        <Failed onRetry={() => void ready.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title={t('lb.ready.empty')} detail={t('lb.ready.emptyDetail')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm" data-testid="ready-table">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="w-10 px-3 py-2" />
                <th className="px-3 py-2 font-medium">{t('lb.col.order')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.col.customer')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.col.consignment')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('lb.col.pieces')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('lb.col.cod')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.col.lots')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.col.booked')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.orderId} className="h-row border-b border-border last:border-b-0">
                  <td className="px-3">
                    <Checkbox
                      checked={selected.has(item.orderId)}
                      aria-label={`${t('lb.select')} ${item.orderNo}`}
                      onCheckedChange={() =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(item.orderId)) next.delete(item.orderId);
                          else next.add(item.orderId);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="px-3">
                    <Link
                      to={ordersPath(`/orders/${item.orderId}`)}
                      className="font-medium tabular-nums underline-offset-4 hover:underline"
                    >
                      {item.orderNo}
                    </Link>
                  </td>
                  <td className="px-3">{item.customer}</td>
                  <td className="px-3 font-mono text-xs">
                    {item.courier === null ? '' : `${item.courier} · `}
                    {item.consignmentNo}
                  </td>
                  <td className="px-3 text-right tabular-nums">{item.pieces}</td>
                  <td className="px-3 text-right">
                    <Money poisha={item.codPoisha} locale={locale} />
                  </td>
                  <td className="px-3">
                    <Button size="sm" variant="ghost" onClick={() => setLots(item)}>
                      {`${String(item.labelsPrinted)}/${String(item.lotCount)}`}
                    </Button>
                  </td>
                  <td className="px-3">
                    {item.bookedAt === null ? '' : <DateTime value={item.bookedAt} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {printer.dialog}
      {lots === null ? null : <LotsDialog order={lots} onClose={() => setLots(null)} />}
    </div>
  );
}

// --- the queue and the log ------------------------------------------------------------------

function JobsTable({
  jobs,
  actions,
}: {
  readonly jobs: readonly PrintJob[];
  readonly actions: (job: PrintJob) => ReactNode;
}) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm" data-testid="jobs-table">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t('lb.col.when')}</th>
            <th className="px-3 py-2 font-medium">{t('lb.col.order')}</th>
            <th className="px-3 py-2 font-medium">{t('lb.col.document')}</th>
            <th className="px-3 py-2 font-medium">{t('lb.col.printer')}</th>
            <th className="px-3 py-2 font-medium">{t('lb.col.by')}</th>
            <th className="px-3 py-2 font-medium">{t('lb.col.state')}</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              className="border-b border-border align-top last:border-b-0"
              data-state={job.state}
            >
              <td className="px-3 py-2 tabular-nums">
                <DateTime value={job.printedAt ?? job.createdAt} />
              </td>
              <td className="px-3 py-2">
                {job.orderId === null ? (
                  '—'
                ) : (
                  <Link
                    to={ordersPath(`/orders/${job.orderId}`)}
                    className="font-medium tabular-nums underline-offset-4 hover:underline"
                  >
                    {job.orderNo}
                  </Link>
                )}
                {job.consignmentNo === null ? null : (
                  <p className="font-mono text-xs text-muted-foreground">{job.consignmentNo}</p>
                )}
              </td>
              <td className="px-3 py-2">
                {t(`lb.doc.${job.document}` as MessageKey)}
                {job.lotCount > 1 ? (
                  <p className="text-xs text-muted-foreground">
                    {lotText(t, job.lot, job.lotCount)}
                  </p>
                ) : null}
              </td>
              <td className="px-3 py-2">
                {job.printer.name}
                <p className="text-xs text-muted-foreground">{job.terminal.name}</p>
              </td>
              <td className="px-3 py-2">
                {job.source === 'auto'
                  ? t('lb.source.auto')
                  : (job.requestedBy?.name ?? job.requestedBy?.id ?? '')}
                {job.source === 'reprint' ? (
                  <p className="text-xs text-muted-foreground">
                    {`${t('lb.source.reprint')}: ${job.reason ?? ''}`}
                  </p>
                ) : null}
              </td>
              <td className="px-3 py-2">
                <JobStateBadge state={job.state} />
                {job.attempts > 1 ? (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {`${t('lb.col.tries')}: ${String(job.attempts)}`}
                  </p>
                ) : null}
                {job.state === 'failed' && job.lastError !== null ? (
                  <p className="text-xs text-destructive-text">{job.lastError}</p>
                ) : null}
              </td>
              <td className="px-3 py-1 text-right">{actions(job)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function QueuePanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ['labels', 'jobs', 'queue'],
    queryFn: () => listJobs({ view: 'queue', limit: 200 }),
    refetchInterval: 15_000,
  });
  const done = () => queryClient.invalidateQueries({ queryKey: ['labels'] });
  const retry = useMutation({ mutationFn: retryJob, onSettled: done });
  const cancel = useMutation({ mutationFn: cancelJob, onSettled: done });
  if (queue.isPending) return <Loading />;
  if (queue.isError) return <Failed onRetry={() => void queue.refetch()} />;
  if (queue.data.items.length === 0) {
    return <EmptyState title={t('lb.queue.empty')} detail={t('lb.queue.emptyDetail')} />;
  }
  return (
    <JobsTable
      jobs={queue.data.items}
      actions={(job) => (
        <div className="flex justify-end gap-2">
          {job.state === 'failed' ? (
            <Button size="sm" variant="outline" onClick={() => retry.mutate(job.id)}>
              <RotateCcw aria-hidden />
              {t('lb.job.retry')}
            </Button>
          ) : null}
          {job.state === 'failed' || job.state === 'queued' ? (
            <Button size="sm" variant="ghost" onClick={() => cancel.mutate(job.id)}>
              <X aria-hidden />
              {t('lb.job.cancel')}
            </Button>
          ) : null}
        </div>
      )}
    />
  );
}

const SOURCES: readonly JobSource[] = ['auto', 'manual', 'reprint', 'test'];
const STATES: readonly JobState[] = ['queued', 'sending', 'printed', 'failed', 'cancelled'];
const PAGE = 50;

export function LogPanel() {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState('');
  const [state, setState] = useState('');
  const [offset, setOffset] = useState(0);
  const filters: JobFilters = {
    view: 'log',
    q: q.trim().length >= 2 ? q.trim() : undefined,
    from: from === '' ? undefined : from,
    to: to === '' ? undefined : to,
    source: source === '' ? undefined : (source as JobSource),
    state: state === '' ? undefined : (state as JobState),
    limit: PAGE,
    offset,
  };
  const log = useQuery({
    queryKey: ['labels', 'jobs', 'log', filters],
    queryFn: () => listJobs(filters),
  });
  const reprint = usePrint(() => undefined);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-q`}>{t('lb.log.search')}</Label>
          <Input
            id={`${id}-q`}
            value={q}
            onChange={(event) => {
              setQ(event.target.value);
              setOffset(0);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-from`}>{t('lb.log.from')}</Label>
          <Input
            id={`${id}-from`}
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-to`}>{t('lb.log.to')}</Label>
          <Input
            id={`${id}-to`}
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </div>
        <Select
          aria-label={t('lb.col.by')}
          size="sm"
          value={source}
          onValueChange={setSource}
          options={[
            { value: '', label: t('lb.log.allSources') },
            ...SOURCES.map((value) => ({ value, label: t(`lb.source.${value}` as MessageKey) })),
          ]}
        />
        <Select
          aria-label={t('lb.col.state')}
          size="sm"
          value={state}
          onValueChange={setState}
          options={[
            { value: '', label: t('lb.log.allStates') },
            ...STATES.map((value) => ({ value, label: t(`lb.state.${value}` as MessageKey) })),
          ]}
        />
        <a
          href={exportJobsUrl(filters)}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          data-testid="export-log"
        >
          <Download aria-hidden />
          {t('lb.log.export')}
        </a>
      </div>
      {log.isPending ? (
        <Loading />
      ) : log.isError ? (
        <Failed onRetry={() => void log.refetch()} />
      ) : log.data.items.length === 0 ? (
        <EmptyState title={t('lb.log.empty')} detail={t('lb.log.emptyDetail')} />
      ) : (
        <>
          <JobsTable
            jobs={log.data.items}
            actions={(job) =>
              job.orderId === null || job.document === 'test' || job.state !== 'printed' ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const orderId = job.orderId;
                    if (orderId === null || job.document === 'test') return;
                    reprint.print({
                      orderIds: [orderId],
                      documents: [job.document],
                      lots: [job.lot],
                    });
                  }}
                >
                  <RotateCcw aria-hidden />
                  {t('lb.job.reprint')}
                </Button>
              )
            }
          />
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground tabular-nums">
              {`${String(log.data.total)} ${t('lb.log.total')}`}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}
              >
                {t('lb.log.previous')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={offset + PAGE >= log.data.total}
                onClick={() => setOffset(offset + PAGE)}
              >
                {t('lb.log.next')}
              </Button>
            </div>
          </div>
        </>
      )}
      {reprint.error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {reprint.error}
        </p>
      )}
      {reprint.dialog}
    </div>
  );
}
