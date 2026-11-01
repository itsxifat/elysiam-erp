import {
  Button,
  Money,
  PageHeader,
  PermissionDeniedState,
  Skeleton,
  StatusBadge,
  buttonVariants,
  cn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileText, Layers, Minus, PackageCheck, Settings, Tag } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { z } from 'zod';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale, useT, type ConsoleT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import '../../i18n/labels.js';
import { ScanField } from '../catalog/scan-field.js';
import { LotsDialog } from '../labels/parts.js';
import { useTerminalBinding } from '../labels/terminal-binding.js';
import { documentUrl } from './api.js';
import {
  IpCameraFooter,
  SourceChoice,
  usePackSource,
  type PackSourceChoice,
} from './pack-cameras.js';
import { CameraLivePreview } from './pack-live-preview.js';
import { lotVideoPhase, recordingClock, runningRecording } from './pack-logic.js';
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
import { PackSettingsDialog, RecentPacking } from './pack-sessions.js';
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
  closeLot,
  finishPacking,
  openPacking,
  packingSettings,
  scanPiece,
  takeOut,
  type PackLine,
  type PackView,
  type ScanAnswer,
} from './pack-station-api.js';
import { OrdersNav } from './parts.js';
import { ordersPath, useSchemaSearch } from './paths.js';
import { ProductImage } from '../../ui/product-image.js';

/**
 * Orders → Pack: the packing station (M38b, D-610; M51, D-930 to D-933).
 *
 * Label to label. Scanning the parcel's label (or slip) opens the order and starts the lot's
 * recording; each piece's sticker is checked by the server against the order (a piece it needs
 * is ticked, anything else is refused out loud and kept on the record); scanning the label again
 * stops the recording and closes the lot, and the last lot's finishes the order. Ten seconds
 * with no scan (the brand's idle time) pauses the video, and the next scan resumes it. An order
 * in several lots has one video per lot, every one kept under the order.
 *
 * The camera is this computer's (recorded by the browser, the order number, time and packer drawn
 * onto the picture, D-611) or one of the brand's IP cameras (cut on the server along the same
 * stretches, M38c). The open order lives in the address (`?order=`), and its progress on the
 * server, so a reload comes back to the same box.
 */

const stationSearchSchema = z.object({
  order: z.string().uuid().optional().catch(undefined),
});

export function PackStationPage() {
  const [search, setSearch] = useSchemaSearch(stationSearchSchema);
  return (
    <PackStation
      order={search.order}
      onOrder={(order) => setSearch(order === undefined ? {} : { order })}
      header={(actions) => <PageHeaderFor actions={actions} />}
    />
  );
}

function PageHeaderFor({ actions }: { readonly actions: React.ReactNode }) {
  const t = useT();
  return (
    <PageHeader
      title={t('ps.title')}
      description={t('ps.description')}
      tabs={<OrdersNav />}
      actions={actions}
    />
  );
}

/**
 * The station itself (M46: Packaging → Packing embeds it, D-800). The open order is the
 * parent's (`order`); at a computer bound to a packing terminal the terminal's cameras film it
 * (D-804), so the desk's own choice of source is not offered.
 */
export function PackStation({
  order,
  onOrder,
  header,
}: {
  readonly order: string | undefined;
  readonly onOrder: (order: string | undefined) => void;
  readonly header?: (actions: React.ReactNode) => React.ReactNode;
}) {
  const t = useT();
  const ability = useAbility();
  const queue = useUploadQueue();
  const source = usePackSource();
  const settings = useQuery({ queryKey: ['packing', 'settings'], queryFn: packingSettings });
  const [editing, setEditing] = useState(false);

  const binding = useTerminalBinding();
  const atTerminal = binding?.kind === 'packing';

  if (!ability.can('update', 'Order')) {
    return (
      <div className="space-y-6">
        {header?.(undefined)}
        <PermissionDeniedState title={t('ps.find.denied')} />
      </div>
    );
  }

  const settingsButton =
    settings.data?.canEdit === true ? (
      <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
        <Settings aria-hidden />
        {t('ps.settings.open')}
      </Button>
    ) : undefined;

  return (
    <div className="space-y-6">
      {header === undefined ? (
        settingsButton === undefined ? null : (
          <div className="flex justify-end">{settingsButton}</div>
        )
      ) : (
        header(settingsButton)
      )}
      <UploadQueueBar queue={queue} />
      {order === undefined ? (
        atTerminal || (source.cameras.length === 0 && source.source.kind === 'browser') ? (
          <FindOrder
            cameraId={atTerminal ? undefined : source.cameraId}
            onOpened={(view) => onOrder(view.session.orderId)}
          />
        ) : (
          // The source is chosen here, and an IP camera's live view shows from the moment the
          // station is open (D-683).
          <div className="ps-grid">
            <FindOrder
              cameraId={source.cameraId}
              onOpened={(view) => onOrder(view.session.orderId)}
            />
            <aside className="space-y-4">
              <SourceChoice choice={source} locked={false} />
              {source.camera === null ? null : (
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
        )
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
      <RecentPacking />
      {editing && settings.data !== undefined ? (
        <PackSettingsDialog settings={settings.data} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}

/** "Parcel label": the first scan of every parcel opens it and starts its recording (D-930). */
function FindOrder({
  onOpened,
  cameraId,
  compact = false,
}: {
  readonly onOpened: (view: PackView) => void;
  /**
   * This desk's IP camera, or null for its own camera (M38c, D-670); undefined at a packing
   * terminal, whose cameras the server chooses (M46, D-804).
   */
  readonly cameraId: string | null | undefined;
  readonly compact?: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const open = useMutation({
    mutationFn: (code: string) =>
      openPacking(cameraId === undefined ? { code } : { code, cameraId }),
    onSuccess: (view) => {
      setFailure(null);
      playScanSound('accepted');
      queryClient.setQueryData(['packing', 'order', view.session.orderId], view);
      onOpened(view);
    },
    onError: (error, code) => {
      playScanSound('refused');
      setFailure(
        error instanceof ApiError && error.status === 404
          ? `${t('ps.find.notFound')} ${code}`
          : error instanceof ApiError
            ? error.message
            : t('ps.failed'),
      );
    },
  });
  return (
    <section
      aria-label={t('ps.find.label')}
      className={cn('rounded-lg border border-border bg-card', compact ? 'p-4' : 'p-6')}
    >
      <ScanField
        label={t('ps.find.label')}
        hint={t('ps.find.hint')}
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
  readonly onOpened: (view: PackView) => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const key = ['packing', 'order', orderId];
  // At a packing terminal its cameras film the order (D-804): no desk choice is sent.
  const deskCamera = atTerminal ? null : source.cameraId;
  const session = useQuery({
    queryKey: key,
    queryFn: () => openPacking(atTerminal ? { orderId } : { orderId, cameraId: deskCamera }),
    staleTime: Infinity,
    retry: false,
  });
  const view = session.data;
  // The IP camera filming this packing, as the server says (M38c).
  const ipCamera = view?.session.cameraId ?? null;
  const recordings = view?.recordings ?? [];
  const running = runningRecording(recordings);
  const lots = view?.lots ?? { count: 1, open: 1, closed: [], pieces: [] };
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
      kind: 'pack',
      lotCount: lots.count,
      recording: running?.source === 'browser' ? running : null,
      activityMs,
      localActivityAt,
    },
    queue,
  );
  const now = useNow(250, running !== null);
  const [answer, setAnswer] = useState<Answer>(null);
  const [justFinished, setJustFinished] = useState(false);

  const keep = (next: PackView) => queryClient.setQueryData(key, next);
  const refused = (error: unknown) => {
    playScanSound('refused');
    setAnswer({
      tone: 'danger',
      text: error instanceof ApiError ? error.message : t('ps.scan.offline'),
    });
  };
  const finished = (next: PackView, fresh: boolean) => {
    keep(next);
    setJustFinished(fresh);
    setAnswer(null);
    playScanSound('done');
    void queryClient.invalidateQueries({ queryKey: ['packing', 'recent'] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
  };

  // The desk changed its source while this order is open: ask the server to film it with the
  // new one (it keeps the camera that already started recording).
  const reopen = useMutation({
    mutationFn: (cameraId: string | null) => openPacking({ orderId, cameraId }),
    onSuccess: keep,
  });
  const askedCamera = useRef(deskCamera);
  const { mutate: reopenWith } = reopen;
  useEffect(() => {
    if (atTerminal || view === undefined || askedCamera.current === deskCamera) return;
    askedCamera.current = deskCamera;
    if (view.session.status === 'open') reopenWith(deskCamera);
  }, [atTerminal, deskCamera, view, reopenWith]);

  const finish = useMutation({
    mutationFn: (sessionId: string) => finishPacking(sessionId),
    onSuccess: (next) => finished(next, !next.alreadyCompleted),
    onError: refused,
  });

  const scan = useMutation({
    mutationFn: ({ sessionId, code }: { sessionId: string; code: string }) =>
      scanPiece(sessionId, crypto.randomUUID(), code),
    // The next scan resumes a paused video at once, before the server answers (D-931).
    onMutate: () => setLocalActivityAt(Date.now()),
    onSuccess: (result) => {
      if (result.label !== null && result.label !== undefined) {
        onLabel(result);
        return;
      }
      keep(result.view);
      const tone =
        result.outcome === 'accepted'
          ? 'success'
          : result.outcome === 'removed'
            ? 'neutral'
            : 'danger';
      playScanSound(tone === 'danger' ? 'refused' : 'accepted');
      const added = result.view.lines.find((line) => line.skuId === result.skuId);
      setAnswer({
        tone,
        text:
          result.outcome === 'accepted' && added !== undefined
            ? `${t('ps.outcome.accepted')}: ${describeLine(added)} (${String(added.packed)}/${String(added.required)})`
            : t(`ps.outcome.${result.outcome}` as ConsoleT),
      });
    },
    onError: refused,
  });

  /** A label scan's answer (D-930): the lot started, closed, the order finished, or a refusal. */
  const onLabel = (result: ScanAnswer) => {
    const label = result.label;
    if (label === null || label === undefined) return;
    // The scanner's own repeat: nothing changed, so nothing is said.
    if (label.action === 'ignored') {
      keep(result.view);
      return;
    }
    if (label.action === 'finished') {
      finished(result.view, true);
      return;
    }
    keep(result.view);
    const count = result.view.lots?.count ?? 1;
    if (label.action === 'refused') {
      playScanSound('refused');
      setAnswer({ tone: 'danger', text: label.message ?? t('ps.failed') });
    } else if (label.action === 'started') {
      playScanSound('accepted');
      setAnswer({
        tone: 'info',
        text:
          count > 1
            ? `${t('ps.label.startedLot')} ${String(label.lot ?? 1)} ${t('ps.of')} ${String(count)}. ${t('ps.label.scanPieces')}`
            : `${t('ps.label.started')} ${t('ps.label.scanPieces')}`,
      });
    } else {
      playScanSound('done');
      const next = (label.lot ?? 1) + 1;
      setAnswer({
        tone: 'success',
        text: `${t('ps.stage.lot')} ${String(label.lot ?? 1)} ${t('ps.label.closed')} ${t('ps.label.nextLot')} ${String(next)}.`,
      });
    }
  };

  const [lotsOpen, setLotsOpen] = useState(false);
  const close = useMutation({
    mutationFn: (sessionId: string) => closeLot(sessionId),
    onSuccess: (next) => {
      keep(next);
      playScanSound('accepted');
      setAnswer({
        tone: 'success',
        text: `${t('lb.lots.closed')}: ${t('lb.lot')} ${String(next.lots?.closed.length ?? 1)}`,
      });
    },
    onError: refused,
  });

  const remove = useMutation({
    mutationFn: ({ sessionId, skuId }: { sessionId: string; skuId: string }) =>
      takeOut(sessionId, crypto.randomUUID(), skuId),
    onMutate: () => setLocalActivityAt(Date.now()),
    onSuccess: (next, { skuId }) => {
      keep(next);
      const line = next.lines.find((entry) => entry.skuId === skuId);
      setAnswer({
        tone: 'neutral',
        text: `${t('ps.outcome.removed')}${line === undefined ? '' : `: ${describeLine(line)}`}`,
      });
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
        <FindOrder onOpened={onOpened} cameraId={atTerminal ? undefined : deskCamera} />
      </div>
    );
  }

  const open = view.session.status === 'open';
  const openLot = lots.open;
  const started = new Set(lots.started ?? []);
  const lotStarted = openLot !== null && (started.has(openLot) || running?.lot === openLot);
  const isLast = lots.count <= 1 || openLot === lots.count;
  const inLot = lots.pieces.find((entry) => entry.lot === openLot)?.pieces ?? 0;
  const labelNeeded = open && (view.labelNeeded ?? !lotStarted);
  const clock =
    running === null
      ? null
      : recordingClock({ recording: running, activityMs, localActivityAt, now });
  const ready = isLast ? view.progress.complete : inLot > 0;

  const steps: { state: StepState; title: string; detail: string }[] = [
    {
      state: lotStarted || !open ? 'done' : 'current',
      title: t('ps.step.label'),
      detail:
        lots.count > 1 && openLot !== null
          ? `${t('ps.step.labelLot')} ${String(openLot)}`
          : t('ps.step.labelDetail'),
    },
    {
      state: !open
        ? 'done'
        : !lotStarted
          ? 'todo'
          : isLast && view.progress.complete
            ? 'done'
            : 'current',
      title: t('ps.step.pieces'),
      detail: `${String(view.progress.unitsPacked)} ${t('ps.of')} ${String(view.progress.unitsRequired)} ${t('ps.step.piecesIn')}`,
    },
    {
      state: !open ? 'done' : lotStarted && ready ? 'current' : 'todo',
      title: t('ps.step.again'),
      detail: isLast ? t('ps.step.againFinish') : t('ps.step.againLot'),
    },
  ];

  const lotRail = Array.from({ length: lots.count }, (_, index) => {
    const lot = index + 1;
    const recording = recordings.filter((entry) => entry.lot === lot).at(-1);
    const state: LotState = !open
      ? 'done'
      : openLot !== null && lot < openLot
        ? 'done'
        : running?.lot === lot
          ? 'recording'
          : lot === openLot
            ? 'open'
            : 'waiting';
    return {
      lot,
      state,
      pieces: lots.pieces.find((entry) => entry.lot === lot)?.pieces ?? 0,
      video: recording === undefined ? null : lotVideoPhase(recording, view.videos),
    };
  });

  const status: StageStatus = !open
    ? { kind: 'done', lot: null }
    : running === null || clock === null
      ? labelNeeded
        ? { kind: 'label' }
        : { kind: 'none' }
      : clock.paused
        ? { kind: 'paused', recordedMs: clock.recordedMs }
        : { kind: 'recording', recordedMs: clock.recordedMs, pauseInMs: clock.pauseInMs };

  // A full box says so, unless the last thing that happened was a refusal to deal with.
  const shown: Answer =
    open && view.progress.complete && isLast && lotStarted && answer?.tone !== 'danger'
      ? { tone: 'success', text: t('ps.outcome.complete') }
      : answer;
  const camera = ipCamera === null ? null : source.lookup(ipCamera);

  return (
    <div className="ps-grid">
      <div className="min-w-0 space-y-5">
        <OrderHeader view={view} onClose={onClose} />
        {open ? (
          <section
            aria-label={t('ps.scan.label')}
            className="space-y-4 rounded-lg border border-border bg-card p-5"
          >
            <StepRail steps={steps} />
            <LotRail lots={lotRail} />
            <ScanField
              label={labelNeeded ? t('ps.scan.labelFirst') : t('ps.scan.label')}
              hint={labelNeeded ? t('ps.scan.labelHint') : t('ps.scan.hint')}
              onCode={(code) => scan.mutate({ sessionId: view.session.id, code })}
              message={scan.isPending ? t('ps.scan.sending') : null}
              className="max-w-xl"
            />
            <AnswerBanner answer={shown} />
            <div className="flex flex-wrap items-center gap-3" data-testid="pack-lots">
              <Button
                size="lg"
                disabled={!view.progress.complete || !isLast || finish.isPending}
                onClick={() => finish.mutate(view.session.id)}
              >
                <PackageCheck aria-hidden />
                {finish.isPending ? t('ps.finishing') : t('ps.finish')}
              </Button>
              {lots.count > 1 && openLot !== null && openLot < lots.count ? (
                <Button
                  variant="outline"
                  disabled={close.isPending}
                  onClick={() => close.mutate(view.session.id)}
                  data-testid="close-lot"
                >
                  {`${t('lb.lots.closeLot')} ${String(openLot)}`}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" onClick={() => setLotsOpen(true)}>
                <Layers aria-hidden />
                {`${t('lb.lots.title')}: ${String(lots.count)}`}
              </Button>
              <p className="text-sm text-muted-foreground tabular-nums" data-testid="pack-progress">
                {`${String(view.progress.unitsPacked)} ${t('ps.of')} ${String(view.progress.unitsRequired)} ${t('ps.pieces')}`}
              </p>
            </div>
          </section>
        ) : (
          <Finished
            view={view}
            fresh={justFinished}
            cameraId={atTerminal ? undefined : deskCamera}
            onNext={onClose}
            onOpened={onOpened}
          />
        )}
        <Lines
          view={view}
          onTakeOut={
            open && lotStarted
              ? (skuId) => remove.mutate({ sessionId: view.session.id, skuId })
              : undefined
          }
        />
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
          idleMs={running?.idleMs ?? view.idlePauseMs ?? 10_000}
          lot={openLot === null ? null : { no: running?.lot ?? openLot, of: lots.count }}
          name={ipCamera === null ? t('ps.source.browser') : (camera?.name ?? t('ps.camera.title'))}
          footer={ipCamera === null ? null : <IpCameraFooter camera={camera} />}
        />
        {atTerminal ? null : (
          <SourceChoice
            choice={source}
            locked={open && (view.session.cameraLocked ?? recordings.length > 0)}
          />
        )}
        {ipCamera === null ? <CameraChoice recorder={recorder} /> : null}
        {view.terminal === undefined || view.terminal === null ? null : (
          <p className="text-sm text-muted-foreground" data-testid="pack-terminal">
            {`${t('lb.thisComputer')}: ${view.terminal.name}`}
          </p>
        )}
        <LotVideos
          recordings={recordings}
          videos={view.videos}
          lotCount={lots.count}
          live={
            running === null || clock === null
              ? null
              : { id: running.id, recordedMs: clock.recordedMs }
          }
        />
        <ScanTimeline scans={view.scans} lotCount={lots.count} />
      </aside>
      {lotsOpen ? (
        <LotsDialog
          order={{ orderId: view.order.id, orderNo: view.order.orderNumber, lotCount: lots.count }}
          onClose={() => {
            setLotsOpen(false);
            void queryClient
              .fetchQuery({
                queryKey: key,
                queryFn: () =>
                  openPacking(atTerminal ? { orderId } : { orderId, cameraId: deskCamera }),
              })
              .then(keep);
          }}
        />
      ) : null}
    </div>
  );
}

function describeLine(line: PackLine): string {
  const variant = [line.size, line.color].filter((part) => part !== '').join(' / ');
  return variant === '' ? line.name : `${line.name}, ${variant}`;
}

function OrderHeader({ view, onClose }: { readonly view: PackView; readonly onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <section className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-card px-5 py-4">
      <div className="min-w-0 space-y-1">
        <p className="text-xs text-muted-foreground">{t('ps.order')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={ordersPath(`/orders/${view.order.id}`)}
            className="text-xl font-semibold tracking-tight tabular-nums underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {view.order.orderNumber}
          </Link>
          <StatusBadge tone={view.session.status === 'open' ? 'info' : 'success'}>
            {t(`ps.session.${view.session.status}`)}
          </StatusBadge>
          {view.order.courier === null ? null : (
            <StatusBadge tone="neutral">{view.order.courier}</StatusBadge>
          )}
        </div>
        <p className="text-sm">
          <span className="text-muted-foreground">{`${t('ps.deliverTo')}: `}</span>
          {view.order.recipient.name}
          {view.order.recipient.address === '' ? '' : ` · ${view.order.recipient.address}`}
        </p>
        {view.order.notes === '' ? null : (
          <p className="text-sm">
            <span className="text-muted-foreground">{`${t('ps.note')}: `}</span>
            {view.order.notes}
          </p>
        )}
      </div>
      <div className="flex items-start gap-4">
        <div className="text-right">
          {view.order.paid ? (
            <StatusBadge tone="success">{t('ps.paid')}</StatusBadge>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('ps.collect')}</p>
              <p className="text-lg font-semibold tabular-nums">
                <Money poisha={view.order.cod.poisha} locale={locale} />
              </p>
            </>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('ps.closeOrder')}
        </Button>
      </div>
    </section>
  );
}

function Lines({
  view,
  onTakeOut,
}: {
  readonly view: PackView;
  readonly onTakeOut: ((skuId: string) => void) | undefined;
}) {
  const t = useT();
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card">
      <h2 id={id} className="border-b border-border px-5 py-3 text-sm font-semibold tracking-tight">
        {t('ps.lines.title')}
      </h2>
      <ul className="divide-y divide-border" data-testid="pack-lines">
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
              <ProgressBar value={line.packed} of={line.required} state={line.state} />
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge
                tone={
                  line.state === 'done'
                    ? 'success'
                    : line.state === 'over'
                      ? 'danger'
                      : line.state === 'partial'
                        ? 'warning'
                        : 'neutral'
                }
              >
                {t(
                  line.state === 'done'
                    ? 'ps.lines.done'
                    : line.state === 'over'
                      ? 'ps.lines.over'
                      : 'ps.lines.todo',
                )}
              </StatusBadge>
              <p
                className="w-16 text-right text-2xl font-semibold tabular-nums"
                aria-label={`${t('ps.lines.packed')} ${String(line.packed)} ${t('ps.of')} ${String(line.required)}`}
              >
                {`${String(line.packed)}/${String(line.required)}`}
              </p>
              {onTakeOut !== undefined && line.packed > 0 ? (
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
      {view.extra.length === 0 ? null : (
        <div className="space-y-2 border-t border-border bg-destructive-subtle px-5 py-3">
          <p className="text-sm font-medium text-destructive-subtle-foreground">
            {t('ps.extra.title')}
          </p>
          <ul className="space-y-1 text-sm">
            {view.extra.map((entry) => (
              <li key={entry.skuId} className="flex items-center justify-between gap-3">
                <span>
                  {entry.name}
                  {entry.variant === '' ? '' : `, ${entry.variant}`}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{entry.sku}</span>
                </span>
                <span className="flex items-center gap-2 tabular-nums">
                  {`× ${String(entry.packed)}`}
                  {onTakeOut === undefined ? null : (
                    <Button size="sm" variant="outline" onClick={() => onTakeOut(entry.skuId)}>
                      <Minus aria-hidden />
                      {t('ps.takeOut')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Finished({
  view,
  fresh,
  cameraId,
  onNext,
  onOpened,
}: {
  readonly view: PackView;
  readonly fresh: boolean;
  readonly cameraId: string | null | undefined;
  readonly onNext: () => void;
  readonly onOpened: (view: PackView) => void;
}) {
  const t = useT();
  return (
    <section className="space-y-4">
      <div
        role="status"
        data-testid="pack-finished"
        className="ps-answer space-y-3 rounded-lg border-2 border-success bg-success-subtle p-5 text-success-subtle-foreground"
      >
        <div className="flex items-center gap-3">
          <PackageCheck aria-hidden className="size-7 shrink-0" />
          <div>
            <p className="text-lg font-semibold">{t('ps.done.title')}</p>
            <p className="text-sm">{fresh ? t('ps.done.detail') : t('ps.done.already')}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={documentUrl(view.order.id, 'label')}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'primary', size: 'sm' })}
          >
            <Tag aria-hidden />
            {t('ps.printLabel')}
          </a>
          <a
            href={documentUrl(view.order.id, 'invoice')}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <FileText aria-hidden />
            {t('ps.printInvoice')}
          </a>
          <Button size="sm" variant="outline" onClick={onNext}>
            {t('ps.next')}
          </Button>
        </div>
      </div>
      <FindOrder onOpened={onOpened} cameraId={cameraId} compact />
    </section>
  );
}
