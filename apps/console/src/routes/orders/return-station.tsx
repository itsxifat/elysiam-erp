import { Button, Checkbox, EmptyState, Select, Skeleton, StatusBadge, cn } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Minus, PackageOpen, Plus, TriangleAlert, Undo2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT, type ConsoleT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import { ScanField } from '../catalog/scan-field.js';
import { listLocations } from '../courier/api.js';
import { Field, control } from '../courier/courier-nav.js';
import { useTerminalBinding } from '../labels/terminal-binding.js';
import {
  IpCameraFooter,
  SourceChoice,
  usePackSource,
  type PackSourceChoice,
} from './pack-cameras.js';
import { CameraLivePreview } from './pack-live-preview.js';
import { VIDEO_TONE, lotVideoPhase, recordingClock, runningRecording } from './pack-logic.js';
import {
  BrowserPicture,
  CameraChoice,
  CameraStage,
  UploadQueueBar,
  useNow,
  useStationRecorder,
  useUploadQueue,
  type StageStatus,
  type UploadQueue,
} from './pack-recording.js';
import { playScanSound } from './pack-sound.js';
import {
  AnswerBanner,
  LotRail,
  LotVideos,
  ProgressBar,
  ScanTimeline,
  StepRail,
  type Answer,
  type LotState,
  type StepState,
} from './pack-stage.js';
import {
  openReturn,
  receiveReturnInspection,
  recentReturns,
  scanReturn,
  takeOutReturn,
  type ReturnLine,
  type ReturnScanAnswer,
  type ReturnView,
} from './pack-station-api.js';
import { useOrdersT, type OrdersMessageKey } from './messages.js';
import { ordersPath } from './paths.js';
import { RETURN_REASONS, type ReturnReason } from './returns-logic.js';
import { ProductImage } from '../../ui/product-image.js';

/**
 * Packaging → Returns: the return station (M51, D-934).
 *
 * The packing station's way, for a parcel that came back. Scanning the returned parcel's label
 * opens its order (on its way back, or partly delivered) and starts the recording; every piece is
 * scanned as it comes out of the bag, checked against what went out (a product that did not go
 * out, the wrong size, one too many is refused out loud); the label again stops the recording.
 * Ten seconds with no scan pauses the video (D-931). The bags of an order in several lots come
 * back in any order, one video each. Then the receipt: how many of each item are damaged, why it
 * came back, a note; Receive into stock books it, the stock back and the journal, in one go.
 */
export function ReturnStation({
  order,
  onOrder,
}: {
  readonly order: string | undefined;
  readonly onOrder: (order: string | undefined) => void;
}) {
  const t = useT();
  const ability = useAbility();
  const queue = useUploadQueue();
  const source = usePackSource();
  const binding = useTerminalBinding();
  const atTerminal = binding?.kind === 'packing';
  if (!ability.can('update', 'Order')) {
    return <EmptyState title={t('rs.denied')} />;
  }
  return (
    <div className="space-y-6">
      <UploadQueueBar queue={queue} />
      {order === undefined ? (
        <div className="ps-grid">
          <FindReturn
            cameraId={atTerminal ? undefined : source.cameraId}
            onOpened={(view) => onOrder(view.session.orderId)}
          />
          <aside className="space-y-4">
            {atTerminal ? null : <SourceChoice choice={source} locked={false} />}
            {source.camera === null || atTerminal ? null : (
              <CameraStage
                picture={
                  <CameraLivePreview cameraId={source.camera.id} label={source.camera.name} />
                }
                status={{ kind: 'label' }}
                idleMs={0}
                lot={null}
                name={source.camera.name}
                footer={<IpCameraFooter camera={source.camera} />}
              />
            )}
          </aside>
        </div>
      ) : (
        <Station
          key={order}
          orderId={order}
          queue={queue}
          source={source}
          atTerminal={atTerminal}
          onClose={() => onOrder(undefined)}
          onOpened={(view) => onOrder(view.session.orderId)}
        />
      )}
      <RecentReturns />
    </div>
  );
}

function FindReturn({
  onOpened,
  cameraId,
  compact = false,
}: {
  readonly onOpened: (view: ReturnView) => void;
  readonly cameraId: string | null | undefined;
  readonly compact?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: (code: string) =>
      openReturn(cameraId === undefined ? { code } : { code, cameraId }),
    onSuccess: (view) => {
      setFailure(null);
      playScanSound('accepted');
      queryClient.setQueryData(['packing', 'return', view.session.orderId], view);
      onOpened(view);
    },
    onError: (error, code) => {
      playScanSound('refused');
      setFailure(
        error instanceof ApiError && error.status === 404
          ? `${t('rs.find.notFound')} ${code}`
          : error instanceof ApiError
            ? error.message
            : t('ps.failed'),
      );
    },
  });
  return (
    <section
      aria-label={t('rs.find.label')}
      className={cn('space-y-4 rounded-lg border border-border bg-card', compact ? 'p-4' : 'p-6')}
    >
      {compact ? null : (
        <div className="flex items-start gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Undo2 aria-hidden className="size-5" />
          </span>
          <div className="space-y-1">
            <h2 className="text-base font-semibold tracking-tight">{t('rs.title')}</h2>
            <p className="text-sm text-muted-foreground">{t('rs.description')}</p>
          </div>
        </div>
      )}
      <ScanField
        label={t('rs.find.label')}
        hint={t('rs.find.hint')}
        onCode={(code) => open.mutate(code)}
        message={open.isPending ? t('ps.find.looking') : failure}
        tone={failure === null ? 'neutral' : 'error'}
        className="max-w-xl"
      />
    </section>
  );
}

function Station({
  orderId,
  queue,
  source,
  atTerminal,
  onClose,
  onOpened,
}: {
  readonly orderId: string;
  readonly queue: UploadQueue;
  readonly source: PackSourceChoice;
  readonly atTerminal: boolean;
  readonly onClose: () => void;
  readonly onOpened: (view: ReturnView) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = ['packing', 'return', orderId];
  const deskCamera = atTerminal ? null : source.cameraId;
  const session = useQuery({
    queryKey: key,
    queryFn: () => openReturn(atTerminal ? { orderId } : { orderId, cameraId: deskCamera }),
    staleTime: Infinity,
    retry: false,
  });
  const view = session.data;
  const ipCamera = view?.session.cameraId ?? null;
  const recordings = view?.recordings ?? [];
  const running = runningRecording(recordings);
  const lotCount = view?.lots.count ?? 1;
  const [localActivityAt, setLocalActivityAt] = useState<number | null>(null);
  const activityMs = useMemo(
    () =>
      running === null
        ? []
        : (view?.scans ?? [])
            .filter((scan) => (scan.lot ?? 1) === running.lot)
            .map((scan) => Date.parse(scan.at)),
    [running, view?.scans],
  );
  const recorder = useStationRecorder(
    {
      sessionId: view?.session.id ?? null,
      open: view?.session.status === 'open',
      videoRequired: view?.session.videoRequired ?? false,
      active: ipCamera === null && deskCamera === null,
      orderNo: view?.session.orderNo ?? '',
      packer: view?.you.name ?? null,
      kind: 'return',
      lotCount,
      recording: running?.source === 'browser' ? running : null,
      activityMs,
      localActivityAt,
    },
    queue,
  );
  const now = useNow(250, running !== null);
  const [answer, setAnswer] = useState<Answer>(null);
  const [received, setReceived] = useState(false);

  const keep = (next: ReturnView) => queryClient.setQueryData(key, next);
  const refused = (error: unknown) => {
    playScanSound('refused');
    setAnswer({
      tone: 'danger',
      text: error instanceof ApiError ? error.message : t('ps.scan.offline'),
    });
  };

  const scan = useMutation({
    mutationFn: ({ sessionId, code }: { sessionId: string; code: string }) =>
      scanReturn(sessionId, crypto.randomUUID(), code),
    onMutate: () => setLocalActivityAt(Date.now()),
    onSuccess: (result) => {
      keep(result.view);
      if (result.label !== null) {
        onLabel(result);
        return;
      }
      const tone = result.outcome === 'accepted' ? 'success' : 'danger';
      playScanSound(tone === 'danger' ? 'refused' : 'accepted');
      const added = result.view.lines.find((line) => line.skuId === result.skuId);
      setAnswer({
        tone,
        text:
          result.outcome === 'accepted' && added !== undefined
            ? `${t('rs.outcome.accepted')}: ${describeLine(added)} (${String(added.back)}/${String(added.expected)})`
            : (result.message ?? t(`ps.outcome.${result.outcome}` as ConsoleT)),
      });
    },
    onError: refused,
  });

  const onLabel = (result: ReturnScanAnswer) => {
    const label = result.label;
    // The scanner's own repeat: nothing changed, so nothing is said.
    if (label === null || label.action === 'ignored') return;
    const count = result.view.lots.count;
    if (label.action === 'refused') {
      playScanSound('refused');
      setAnswer({ tone: 'danger', text: label.message ?? t('ps.failed') });
    } else if (label.action === 'started') {
      playScanSound('accepted');
      setAnswer({
        tone: 'info',
        text:
          count > 1
            ? `${t('rs.label.startedBag')} ${String(label.lot ?? 1)} ${t('ps.of')} ${String(count)}. ${t('rs.label.scanPieces')}`
            : `${t('ps.label.started')} ${t('rs.label.scanPieces')}`,
      });
    } else {
      playScanSound('done');
      setAnswer({
        tone: 'success',
        text:
          count > 1
            ? `${t('rs.label.bag')} ${String(label.lot ?? 1)} ${t('rs.label.stopped')}`
            : t('rs.label.stoppedOne'),
      });
    }
  };

  const remove = useMutation({
    mutationFn: ({ sessionId, skuId }: { sessionId: string; skuId: string }) =>
      takeOutReturn(sessionId, crypto.randomUUID(), skuId),
    onMutate: () => setLocalActivityAt(Date.now()),
    onSuccess: (next) => {
      keep(next);
      setAnswer({ tone: 'neutral', text: t('ps.outcome.removed') });
    },
    onError: refused,
  });

  if (session.isPending) {
    return (
      <div className="ps-grid">
        <Skeleton className="h-96" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (view === undefined) {
    const message = session.error instanceof ApiError ? session.error.message : t('ps.failed');
    return (
      <div className="space-y-4">
        <p role="alert" className="text-sm text-destructive-text">
          {message}
        </p>
        <FindReturn onOpened={onOpened} cameraId={atTerminal ? undefined : deskCamera} compact />
      </div>
    );
  }

  const open = view.session.status === 'open';
  const bag = running?.lot ?? null;
  const inBag =
    bag === null ? 0 : (view.lots.pieces.find((entry) => entry.lot === bag)?.pieces ?? 0);
  const clock =
    running === null
      ? null
      : recordingClock({ recording: running, activityMs, localActivityAt, now });
  const done = new Set(view.lots.done);
  const anyDone = view.lots.done.length > 0;
  const allDone = done.size >= lotCount;

  const steps: { state: StepState; title: string; detail: string }[] = [
    {
      state: !open || running !== null || allDone ? 'done' : 'current',
      title: t('ps.step.label'),
      detail: lotCount > 1 ? t('rs.step.labelBag') : t('ps.step.labelDetail'),
    },
    {
      state: !open ? 'done' : running === null ? (anyDone ? 'done' : 'todo') : 'current',
      title: t('rs.step.pieces'),
      detail: `${String(view.progress.unitsBack)} ${t('ps.of')} ${String(view.progress.unitsExpected)} ${t('rs.step.piecesBack')}`,
    },
    {
      state: !open ? 'done' : running !== null && inBag > 0 ? 'current' : anyDone ? 'done' : 'todo',
      title: t('ps.step.again'),
      detail: t('rs.step.againDetail'),
    },
  ];

  const lotRail = Array.from({ length: lotCount }, (_, index) => {
    const lot = index + 1;
    const recording = recordings.filter((entry) => entry.lot === lot).at(-1);
    const state: LotState =
      bag === lot ? 'recording' : done.has(lot) ? 'done' : open ? 'waiting' : 'done';
    return {
      lot,
      state,
      pieces: view.lots.pieces.find((entry) => entry.lot === lot)?.pieces ?? 0,
      expected: view.lots.pieces.find((entry) => entry.lot === lot)?.expected ?? null,
      video: recording === undefined ? null : lotVideoPhase(recording, view.videos),
    };
  });

  const status: StageStatus = !open
    ? { kind: 'done', lot: null }
    : running === null || clock === null
      ? allDone
        ? { kind: 'done', lot: null }
        : { kind: 'label' }
      : clock.paused
        ? { kind: 'paused', recordedMs: clock.recordedMs }
        : { kind: 'recording', recordedMs: clock.recordedMs, pauseInMs: clock.pauseInMs };
  const camera = ipCamera === null ? null : source.lookup(ipCamera);

  return (
    <div className="ps-grid">
      <div className="min-w-0 space-y-5">
        <ReturnHeader view={view} onClose={onClose} />
        {open ? (
          <section
            aria-label={t('rs.scan.label')}
            className="space-y-4 rounded-lg border border-border bg-card p-5"
          >
            <StepRail steps={steps} />
            <LotRail lots={lotRail} />
            <ScanField
              label={
                running !== null
                  ? t('rs.scan.label')
                  : allDone
                    ? t('rs.scan.reopen')
                    : t('rs.scan.labelFirst')
              }
              hint={
                running !== null
                  ? t('rs.scan.hint')
                  : allDone
                    ? t('rs.scan.reopenHint')
                    : t('rs.scan.labelHint')
              }
              onCode={(code) => scan.mutate({ sessionId: view.session.id, code })}
              message={scan.isPending ? t('ps.scan.sending') : null}
              className="max-w-xl"
            />
            <AnswerBanner answer={answer} />
          </section>
        ) : (
          <ReceivedPanel
            view={view}
            fresh={received}
            onNext={onClose}
            onOpened={onOpened}
            cameraId={atTerminal ? undefined : deskCamera}
          />
        )}
        <ReturnLines
          view={view}
          onTakeOut={
            open ? (skuId) => remove.mutate({ sessionId: view.session.id, skuId }) : undefined
          }
        />
        {open && running === null && view.progress.unitsBack > 0 ? (
          <ReceivePanel
            view={view}
            onReceived={(next) => {
              keep(next);
              setReceived(true);
              setAnswer(null);
              playScanSound('done');
              void queryClient.invalidateQueries({ queryKey: ['packing', 'returns'] });
              void queryClient.invalidateQueries({ queryKey: ['orders'] });
              void queryClient.invalidateQueries({ queryKey: ['courier'] });
            }}
          />
        ) : null}
      </div>
      <aside className="space-y-4">
        <CameraStage
          picture={
            ipCamera === null ? (
              <BrowserPicture recorder={recorder} />
            ) : camera?.enabled === true ? (
              <CameraLivePreview cameraId={camera.id} label={camera.name} />
            ) : null
          }
          status={view.session.videoRequired ? status : { kind: 'none' }}
          idleMs={running?.idleMs ?? view.idlePauseMs}
          lot={bag === null ? null : { no: bag, of: lotCount }}
          name={ipCamera === null ? t('ps.source.browser') : (camera?.name ?? t('ps.camera.title'))}
          footer={ipCamera === null ? null : <IpCameraFooter camera={camera} />}
        />
        {atTerminal ? null : (
          <SourceChoice choice={source} locked={open && view.session.cameraLocked} />
        )}
        {ipCamera === null ? <CameraChoice recorder={recorder} /> : null}
        <LotVideos
          recordings={recordings}
          videos={view.videos}
          lotCount={lotCount}
          live={
            running === null || clock === null
              ? null
              : { id: running.id, recordedMs: clock.recordedMs }
          }
        />
        <ScanTimeline scans={view.scans} lotCount={lotCount} />
      </aside>
    </div>
  );
}

function describeLine(line: ReturnLine): string {
  const variant = [line.size, line.color].filter((part) => part !== '').join(' / ');
  return variant === '' ? line.name : `${line.name}, ${variant}`;
}

function ReturnHeader({
  view,
  onClose,
}: {
  readonly view: ReturnView;
  readonly onClose: () => void;
}) {
  const t = useT();
  return (
    <section className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-card px-5 py-4">
      <div className="min-w-0 space-y-1">
        <p className="text-xs text-muted-foreground">{t('rs.order')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={ordersPath(`/orders/${view.order.id}`)}
            className="text-xl font-semibold tracking-tight tabular-nums underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {view.order.orderNumber}
          </Link>
          <StatusBadge tone={view.session.status === 'open' ? 'warning' : 'success'}>
            {t(view.session.status === 'open' ? 'rs.session.open' : 'rs.session.completed')}
          </StatusBadge>
          {view.order.courier === null ? null : (
            <StatusBadge tone="neutral">{view.order.courier}</StatusBadge>
          )}
          {view.order.consignmentId === null ? null : (
            <span className="font-mono text-xs text-muted-foreground">
              {view.order.consignmentId}
            </span>
          )}
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">{`${t('rs.from')}: `}</span>
          {view.order.recipient.name}
          {view.order.recipient.address === '' ? '' : ` · ${view.order.recipient.address}`}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={onClose}>
        {t('ps.closeOrder')}
      </Button>
    </section>
  );
}

function ReturnLines({
  view,
  onTakeOut,
}: {
  readonly view: ReturnView;
  readonly onTakeOut: ((skuId: string) => void) | undefined;
}) {
  const t = useT();
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
        <h2 id={id} className="text-sm font-semibold tracking-tight">
          {t('rs.lines.title')}
        </h2>
        <p className="text-sm text-muted-foreground tabular-nums" data-testid="return-progress">
          {`${String(view.progress.unitsBack)} ${t('ps.of')} ${String(view.progress.unitsExpected)} ${t('rs.step.piecesBack')}`}
        </p>
      </div>
      <ul className="divide-y divide-border" data-testid="return-lines">
        {view.lines.map((line) => (
          <li
            key={line.skuId}
            data-state={line.state}
            className="flex flex-wrap items-center gap-4 px-5 py-3"
          >
            <ProductImage skuId={line.skuId} alt={line.name} size="md" />
            <div className="min-w-0 flex-1 space-y-1 text-sm">
              <p className="truncate font-medium">{line.name}</p>
              <p className="text-xs text-muted-foreground">
                {[line.size, line.color].filter((part) => part !== '').join(' / ')}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {line.sku}
                {line.barcode === null ? '' : ` · ${line.barcode}`}
              </p>
              <ProgressBar value={line.back} of={line.expected} state={line.state} />
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge
                tone={
                  line.state === 'done'
                    ? 'success'
                    : line.state === 'partial'
                      ? 'warning'
                      : line.state === 'over'
                        ? 'danger'
                        : 'neutral'
                }
              >
                {t(
                  line.state === 'done'
                    ? 'rs.lines.back'
                    : line.state === 'todo'
                      ? 'rs.lines.notBack'
                      : 'rs.lines.partial',
                )}
              </StatusBadge>
              <p className="w-16 text-right text-2xl font-semibold tabular-nums">
                {`${String(line.back)}/${String(line.expected)}`}
              </p>
              {onTakeOut !== undefined && line.back > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('ps.takeOut')}: ${describeLine(line)}`}
                  onClick={() => onTakeOut(line.skuId)}
                >
                  <Minus aria-hidden />
                  {t('ps.takeOut')}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The receipt (D-934): every piece scanned back goes to stock as sellable but the ones marked
 * damaged (to the damaged shelf), with why the parcel came back. Pieces that did not come back
 * are said in the receipt's note.
 */
function ReceivePanel({
  view,
  onReceived,
}: {
  readonly view: ReturnView;
  readonly onReceived: (view: ReturnView) => void;
}) {
  const t = useT();
  const o = useOrdersT();
  const id = useId();
  const [damaged, setDamaged] = useState<Record<string, number>>({});
  const [returnReason, setReturnReason] = useState<ReturnReason | ''>('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [damagedLocationId, setDamagedLocationId] = useState('');
  const locations = useQuery({
    queryKey: ['courier', 'locations'],
    queryFn: listLocations,
    staleTime: 10 * 60_000,
  });
  const damagedLocations = (locations.data?.items ?? []).filter(
    (location) => location.kind === 'damaged' && location.isActive,
  );
  const damagedTotal = Object.values(damaged).reduce((sum, qty) => sum + qty, 0);
  const back = view.lines.filter((line) => line.back > 0);
  // A parcel has one receipt: what it leaves out can never be booked in later (D-939).
  const opened = new Set(view.recordings.map((recording) => recording.lot));
  const unopened = Array.from({ length: view.lots.count }, (_, index) => index + 1).filter(
    (lot) => !opened.has(lot),
  );
  const short = view.progress.missing > 0 || unopened.length > 0;
  const [acknowledged, setAcknowledged] = useState(false);
  const receive = useMutation({
    mutationFn: () =>
      receiveReturnInspection(view.session.id, {
        damaged: Object.entries(damaged)
          .filter(([, qty]) => qty > 0)
          .map(([skuId, qty]) => ({ skuId, qty })),
        returnReason,
        reason: reason.trim(),
        ...(note.trim() === '' ? {} : { inspectionNote: note.trim() }),
        ...(damagedTotal === 0 || damagedLocationId === '' ? {} : { damagedLocationId }),
        ...(short ? { acknowledgeShort: acknowledged } : {}),
      }),
    onSuccess: onReceived,
  });
  const ready =
    returnReason !== '' &&
    reason.trim() !== '' &&
    (damagedTotal === 0 || damagedLocationId !== '') &&
    (!short || acknowledged) &&
    !receive.isPending;
  const step = (skuId: string, by: number, max: number) =>
    setDamaged((current) => ({
      ...current,
      [skuId]: Math.max(0, Math.min(max, (current[skuId] ?? 0) + by)),
    }));

  return (
    <section
      aria-labelledby={id}
      className="space-y-4 rounded-lg border border-border bg-card p-5"
      data-testid="return-receive"
    >
      <div className="flex items-start gap-3">
        <PackageOpen aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="space-y-0.5">
          <h2 id={id} className="text-base font-semibold tracking-tight">
            {t('rs.receive.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('rs.receive.detail')}</p>
        </div>
      </div>
      {short ? (
        <div
          role="status"
          className="space-y-2 rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm text-warning-subtle-foreground"
        >
          <p className="flex items-start gap-2 font-medium">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            {[
              view.progress.missing > 0
                ? `${t('rs.receive.missing')}: ${String(view.progress.missing)}`
                : null,
              unopened.length > 0 ? `${t('rs.receive.unopened')}: ${unopened.join(', ')}` : null,
            ]
              .filter((part) => part !== null)
              .join(' · ')}
          </p>
          <p>{t('rs.receive.missingNote')}</p>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`${id}-short`}
              checked={acknowledged}
              onCheckedChange={(next) => setAcknowledged(next === true)}
            />
            <label htmlFor={`${id}-short`} className="font-medium">
              {t('rs.receive.acknowledge')}
            </label>
          </div>
        </div>
      ) : null}
      <ul className="divide-y divide-border rounded-md border border-border">
        {back.map((line) => {
          const count = damaged[line.skuId] ?? 0;
          return (
            <li
              key={line.skuId}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {describeLine(line)}
                <span className="ml-2 text-muted-foreground tabular-nums">{`× ${String(line.back)}`}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{t('rs.receive.damaged')}</span>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`${t('rs.receive.lessDamaged')}: ${describeLine(line)}`}
                  disabled={count === 0}
                  onClick={() => step(line.skuId, -1, line.back)}
                >
                  <Minus aria-hidden />
                </Button>
                <span className="w-6 text-center font-semibold tabular-nums" aria-live="polite">
                  {String(count)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`${t('rs.receive.moreDamaged')}: ${describeLine(line)}`}
                  disabled={count >= line.back}
                  onClick={() => step(line.skuId, 1, line.back)}
                >
                  <Plus aria-hidden />
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('rs.receive.reasonCode')} id={`${id}-code`}>
          <Select
            id={`${id}-code`}
            required
            value={returnReason}
            placeholder={t('rs.receive.chooseReason')}
            onValueChange={(value) => setReturnReason(value as ReturnReason | '')}
            options={RETURN_REASONS.map((code) => ({
              value: code,
              label: o(`orders.reason.${code}` as OrdersMessageKey),
            }))}
          />
        </Field>
        <Field label={t('rs.receive.reason')} id={`${id}-reason`}>
          <input
            id={`${id}-reason`}
            value={reason}
            maxLength={500}
            className={control}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {damagedTotal === 0 ? null : (
          <Field
            label={t('rs.receive.damagedShelf')}
            id={`${id}-shelf`}
            hint={t('rs.receive.damagedShelfHint')}
          >
            <Select
              id={`${id}-shelf`}
              value={damagedLocationId}
              onValueChange={setDamagedLocationId}
              placeholder={t('rs.receive.chooseShelf')}
              options={damagedLocations.map((location) => ({
                value: location.id,
                label: `${location.code} · ${location.name}`,
              }))}
            />
          </Field>
        )}
      </div>
      <Field label={t('rs.receive.note')} id={`${id}-note`}>
        <textarea
          id={`${id}-note`}
          rows={2}
          maxLength={600}
          value={note}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 focus-visible:outline-none"
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {receive.error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {receive.error instanceof ApiError ? receive.error.message : t('ps.failed')}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          disabled={!ready}
          onClick={() => receive.mutate()}
          data-testid="return-receive-button"
        >
          <PackageOpen aria-hidden />
          {receive.isPending ? t('rs.receive.receiving') : t('rs.receive.button')}
        </Button>
        <p className="text-sm text-muted-foreground tabular-nums">
          {`${String(view.progress.unitsBack - damagedTotal)} ${t('rs.receive.sellable')} · ${String(damagedTotal)} ${t('rs.receive.damagedCount')}`}
        </p>
      </div>
    </section>
  );
}

function ReceivedPanel({
  view,
  fresh,
  onNext,
  onOpened,
  cameraId,
}: {
  readonly view: ReturnView;
  readonly fresh: boolean;
  readonly onNext: () => void;
  readonly onOpened: (view: ReturnView) => void;
  readonly cameraId: string | null | undefined;
}) {
  const t = useT();
  return (
    <section className="space-y-4">
      <div
        role="status"
        data-testid="return-received"
        className="ps-answer space-y-3 rounded-lg border-2 border-success bg-success-subtle p-5 text-success-subtle-foreground"
      >
        <div className="flex items-center gap-3">
          <PackageOpen aria-hidden className="size-7 shrink-0" />
          <div>
            <p className="text-lg font-semibold">{t('rs.done.title')}</p>
            <p className="text-sm">
              {fresh ? t('rs.done.detail') : t('rs.done.already')}
              {` · ${String(view.progress.unitsBack)} ${t('ps.pieces')}`}
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onNext}>
          {t('rs.next')}
        </Button>
      </div>
      <FindReturn onOpened={onOpened} cameraId={cameraId} compact />
    </section>
  );
}

/** The latest returns opened at the station: who, how many pieces, what was caught, the video. */
function RecentReturns() {
  const t = useT();
  const id = useId();
  const recent = useQuery({ queryKey: ['packing', 'returns'], queryFn: recentReturns });
  const items = recent.data?.items ?? [];
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card">
      <h2
        id={id}
        className="border-b border-border px-5 py-3 text-base font-semibold tracking-tight"
      >
        {t('rs.recent.title')}
      </h2>
      {recent.isPending ? (
        <div className="p-4">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">{t('rs.recent.none')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="recent-returns">
            <thead>
              <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('ps.recent.order')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('rs.recent.by')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('ps.recent.pieces')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  {t('ps.recent.mismatches')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('ps.recent.video')}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t('ps.recent.status')}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} className="h-row border-b border-border last:border-0">
                  <td className="px-3 font-medium tabular-nums">
                    <Link
                      to={ordersPath(`/orders/${row.orderId}`)}
                      className="text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {row.orderNo}
                    </Link>
                  </td>
                  <td className="px-3">{row.startedBy.name ?? '—'}</td>
                  <td className="px-3 text-right tabular-nums">{String(row.pieces)}</td>
                  <td className="px-3 text-right tabular-nums">{String(row.mismatches)}</td>
                  <td className="px-3">
                    <StatusBadge tone={VIDEO_TONE[row.video]}>
                      {t(`ps.video.state.${row.video}` as ConsoleT)}
                    </StatusBadge>
                  </td>
                  <td className="px-3">
                    <StatusBadge tone={row.status === 'open' ? 'warning' : 'success'}>
                      {t(row.status === 'open' ? 'rs.session.open' : 'rs.session.completed')}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
