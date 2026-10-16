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
import {
  CheckCircle2,
  FileText,
  ImageOff,
  Layers,
  Minus,
  PackageCheck,
  Settings,
  Tag,
  XOctagon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
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
  IpCameraCard,
  SourceChoice,
  usePackSource,
  type PackSourceChoice,
} from './pack-cameras.js';
import { isOrderSlip, outcomeTone } from './pack-logic.js';
import {
  CameraCard,
  UploadQueueBar,
  useStationRecorder,
  useUploadQueue,
  type UploadQueue,
} from './pack-recording.js';
import { PackSettingsDialog, RecentPacking } from './pack-sessions.js';
import { playScanSound } from './pack-sound.js';
import {
  closeLot,
  finishPacking,
  openPacking,
  packingSettings,
  scanPiece,
  takeOut,
  type PackLine,
  type PackView,
} from './pack-station-api.js';
import { OrdersNav } from './parts.js';
import { ordersPath, useSchemaSearch } from './paths.js';

/**
 * Orders → Pack: the packing station (M38b, D-610).
 *
 * Scan the order slip (or type the number) and the order opens with every line to pack. Each
 * scan of a piece's sticker is checked by the server against the order: a piece it needs is
 * ticked, anything else (the wrong product, the wrong size or colour, one too many, a code
 * that is no product) is refused out loud and kept on the record. When every piece is in,
 * scanning the slip again or "Finish packing" moves the order to packed, and the label and
 * invoice are a click away. Meanwhile the camera records the table with the order number, the
 * time and the packer drawn onto the picture (D-611).
 *
 * M38c (D-670, D-671): a desk may record with one of the brand's IP cameras instead (its choice
 * remembered by the browser). The order is opened with that camera, which is then ready; the
 * server records from two seconds before the first correct piece is scanned until the order is
 * packed, and the browser records nothing.
 *
 * The open order lives in the address (`?order=`), and its progress on the server, so a reload
 * comes back to the same box.
 */

const stationSearchSchema = z.object({
  order: z.string().uuid().optional().catch(undefined),
});

type Answer = {
  readonly kind: 'outcome';
  readonly tone: 'success' | 'danger' | 'neutral';
  readonly text: string;
} | null;

function outcomeText(t: (key: ConsoleT) => string, outcome: string): string {
  return t(`ps.outcome.${outcome}` as ConsoleT);
}

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
  const search = { order };
  const setSearch = (next: { readonly order?: string }) => onOrder(next.order);
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
      {search.order === undefined ? (
        atTerminal || (source.cameras.length === 0 && source.source.kind === 'browser') ? (
          <FindOrder
            cameraId={atTerminal ? undefined : source.cameraId}
            onOpened={(view) => setSearch({ order: view.session.orderId })}
          />
        ) : (
          // The source is chosen here, and an IP camera's live view shows from the moment the
          // station is open (D-683).
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <FindOrder
              cameraId={source.cameraId}
              onOpened={(view) => setSearch({ order: view.session.orderId })}
            />
            <aside className="space-y-4">
              <SourceChoice choice={source} locked={false} />
              {source.camera === null ? null : (
                <IpCameraCard view={undefined} camera={source.camera} />
              )}
            </aside>
          </div>
        )
      ) : (
        <Station
          key={search.order}
          orderId={search.order}
          queue={queue}
          source={source}
          atTerminal={atTerminal}
          onClose={() => setSearch({})}
          onOpened={(view) => setSearch({ order: view.session.orderId })}
        />
      )}
      <RecentPacking />
      {editing && settings.data !== undefined ? (
        <PackSettingsDialog settings={settings.data} onClose={() => setEditing(false)} />
      ) : null}
    </div>
  );
}

/** "Order slip or number": the first scan of every parcel. */
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
  // The IP camera filming this packing, as the server says (M38c): the desk's choice until the
  // recording starts, the camera that started it after.
  const ipCamera = view?.session.cameraId ?? null;
  const recorder = useStationRecorder(view, queue, ipCamera === null && deskCamera === null);
  const [answer, setAnswer] = useState<Answer>(null);
  const [justFinished, setJustFinished] = useState(false);

  const keep = (next: PackView) => queryClient.setQueryData(key, next);

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
    onSuccess: (next) => {
      keep(next);
      setJustFinished(!next.alreadyCompleted);
      setAnswer(null);
      playScanSound('done');
      void recorder.stop();
      void queryClient.invalidateQueries({ queryKey: ['packing', 'recent'] });
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => {
      playScanSound('refused');
      setAnswer({
        kind: 'outcome',
        tone: 'danger',
        text: error instanceof ApiError ? error.message : t('ps.failed'),
      });
    },
  });

  const scan = useMutation({
    mutationFn: ({ sessionId, code }: { sessionId: string; code: string }) =>
      scanPiece(sessionId, crypto.randomUUID(), code),
    onSuccess: (result) => {
      keep(result.view);
      const tone = outcomeTone(result.outcome);
      playScanSound(tone === 'danger' ? 'refused' : 'accepted');
      const added = result.view.lines.find((line) => line.skuId === result.skuId);
      setAnswer({
        kind: 'outcome',
        tone,
        text:
          result.outcome === 'accepted' && added !== undefined
            ? `${t('ps.outcome.accepted')}: ${describeLine(added)} (${String(added.packed)}/${String(added.required)})`
            : outcomeText(t, result.outcome),
      });
    },
    onError: (error) => {
      playScanSound('refused');
      setAnswer({
        kind: 'outcome',
        tone: 'danger',
        text: error instanceof ApiError ? error.message : t('ps.scan.offline'),
      });
    },
  });

  const [lotsOpen, setLotsOpen] = useState(false);
  const close = useMutation({
    mutationFn: (sessionId: string) => closeLot(sessionId),
    onSuccess: (next) => {
      keep(next);
      playScanSound('accepted');
      setAnswer({
        kind: 'outcome',
        tone: 'success',
        text: `${t('lb.lots.closed')}: ${t('lb.lot')} ${String(next.lots?.closed.length ?? 1)}`,
      });
    },
    onError: (error) => {
      playScanSound('refused');
      setAnswer({
        kind: 'outcome',
        tone: 'danger',
        text: error instanceof ApiError ? error.message : t('ps.failed'),
      });
    },
  });

  const remove = useMutation({
    mutationFn: ({ sessionId, skuId }: { sessionId: string; skuId: string }) =>
      takeOut(sessionId, crypto.randomUUID(), skuId),
    onSuccess: (next, { skuId }) => {
      keep(next);
      const line = next.lines.find((entry) => entry.skuId === skuId);
      setAnswer({
        kind: 'outcome',
        tone: 'neutral',
        text: `${t('ps.outcome.removed')}${line === undefined ? '' : `: ${describeLine(line)}`}`,
      });
    },
    onError: (error) =>
      setAnswer({
        kind: 'outcome',
        tone: 'danger',
        text: error instanceof ApiError ? error.message : t('ps.failed'),
      }),
  });

  if (session.isPending) {
    return (
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
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
  const lots = view.lots ?? { count: 1, open: 1, closed: [], pieces: [] };
  // D-807: with several lots, Finish closes the last one only.
  const lastLotOpen = lots.count <= 1 || lots.open === lots.count;
  // A full box says so, unless the last thing that happened was a refusal to deal with.
  const shown: Answer =
    open && view.progress.complete && answer?.tone !== 'danger'
      ? { kind: 'outcome', tone: 'success', text: t('ps.outcome.complete') }
      : answer;
  const onCode = (code: string) => {
    if (isOrderSlip(code, view.order)) {
      if (view.progress.complete && lastLotOpen) {
        finish.mutate(view.session.id);
      } else {
        playScanSound('refused');
        setAnswer({
          kind: 'outcome',
          tone: 'danger',
          text: `${String(view.progress.unitsRequired - view.progress.unitsPacked)} ${t('ps.outcome.stillToScan')}`,
        });
      }
      return;
    }
    scan.mutate({ sessionId: view.session.id, code });
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-5">
        <OrderHeader view={view} onClose={onClose} />
        {open ? (
          <section
            aria-label={t('ps.scan.label')}
            className="space-y-4 rounded-lg border border-border bg-card p-5"
          >
            <ScanField
              label={t('ps.scan.label')}
              hint={t('ps.scan.hint')}
              onCode={onCode}
              message={scan.isPending ? t('ps.scan.sending') : null}
              className="max-w-xl"
            />
            <AnswerBanner answer={shown} />
            <LotsBar
              lots={lots}
              busy={close.isPending}
              onClose={() => close.mutate(view.session.id)}
              onChange={() => setLotsOpen(true)}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="lg"
                disabled={!view.progress.complete || !lastLotOpen || finish.isPending}
                onClick={() => finish.mutate(view.session.id)}
              >
                <PackageCheck aria-hidden />
                {finish.isPending ? t('ps.finishing') : t('ps.finish')}
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
            open ? (skuId) => remove.mutate({ sessionId: view.session.id, skuId }) : undefined
          }
        />
      </div>
      <aside className="space-y-4">
        {view.terminal === undefined || view.terminal === null ? null : (
          <p className="text-sm text-muted-foreground" data-testid="pack-terminal">
            {`${t('lb.thisComputer')}: ${view.terminal.name}`}
          </p>
        )}
        {atTerminal ? null : (
          <SourceChoice
            choice={source}
            locked={
              open && (view.session.cameraLocked ?? (view.session.recordingFrom ?? null) !== null)
            }
          />
        )}
        {ipCamera === null ? (
          <CameraCard recorder={recorder} />
        ) : (
          <IpCameraCard view={view} camera={source.lookup(ipCamera)} />
        )}
        <ScanLog view={view} />
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

/**
 * The order's lots at the station (M46, D-807): each bag's pieces, the one being filled, and
 * closing it so the next scans fill the next. One lot shows only the "Lots" button.
 */
function LotsBar({
  lots,
  busy,
  onClose,
  onChange,
}: {
  readonly lots: NonNullable<PackView['lots']>;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onChange: () => void;
}) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="pack-lots">
      <Button size="sm" variant="outline" onClick={onChange}>
        <Layers aria-hidden />
        {`${t('lb.lots.title')}: ${String(lots.count)}`}
      </Button>
      {lots.count <= 1
        ? null
        : lots.pieces.map((entry) => (
            <StatusBadge
              key={entry.lot}
              tone={
                entry.lot === lots.open
                  ? 'info'
                  : entry.lot < (lots.open ?? lots.count + 1)
                    ? 'success'
                    : 'neutral'
              }
            >
              {`${t('lb.lot')} ${String(entry.lot)} · ${String(entry.pieces)} ${t('lb.lots.pieces')}`}
            </StatusBadge>
          ))}
      {lots.count > 1 && lots.open !== null && lots.open < lots.count ? (
        <Button size="sm" disabled={busy} onClick={onClose} data-testid="close-lot">
          {`${t('lb.lots.closeLot')} ${String(lots.open)}`}
        </Button>
      ) : null}
      {lots.count > 1 ? (
        <p className="w-full text-xs text-muted-foreground">{t('lb.lots.closeHint')}</p>
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

/** The last scan's answer, big: green for a piece taken, red (and a buzz) for a refusal. */
function AnswerBanner({ answer }: { readonly answer: Answer }) {
  if (answer === null) return null;
  const Icon = answer.tone === 'danger' ? XOctagon : CheckCircle2;
  return (
    <div
      role={answer.tone === 'danger' ? 'alert' : 'status'}
      data-testid="pack-answer"
      data-tone={answer.tone}
      className={cn(
        'flex items-center gap-3 rounded-lg border-2 px-4 py-3 text-base font-semibold',
        answer.tone === 'danger'
          ? 'border-destructive bg-destructive-subtle text-destructive-subtle-foreground'
          : answer.tone === 'success'
            ? 'border-success bg-success-subtle text-success-subtle-foreground'
            : 'border-border bg-muted text-foreground',
      )}
    >
      <Icon aria-hidden className="size-6 shrink-0" />
      <span>{answer.text}</span>
    </div>
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
            <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
              {line.image === '' ? (
                <ImageOff aria-hidden className="size-5 text-muted-foreground" />
              ) : (
                <img src={line.image} alt="" className="size-full object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium">{line.name}</p>
              <p className="text-xs text-muted-foreground">
                {[line.size, line.color].filter((part) => part !== '').join(' / ')}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {line.sku}
                {line.barcode === null ? '' : ` · ${line.barcode}`}
              </p>
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
        className="space-y-3 rounded-lg border-2 border-success bg-success-subtle p-5 text-success-subtle-foreground"
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

function ScanLog({ view }: { readonly view: PackView }) {
  const t = useT();
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card">
      <h2 id={id} className="border-b border-border px-4 py-3 text-sm font-semibold tracking-tight">
        {t('ps.log.title')}
      </h2>
      {view.scans.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('ps.log.none')}</p>
      ) : (
        <ol className="max-h-80 divide-y divide-border overflow-y-auto" data-testid="pack-log">
          {view.scans.slice(0, 40).map((entry) => (
            <li key={entry.id} className="space-y-0.5 px-4 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <StatusBadge tone={outcomeTone(entry.outcome)}>
                  {t(`ps.log.${entry.outcome}` as ConsoleT)}
                </StatusBadge>
                <span className="text-muted-foreground tabular-nums">
                  {new Date(entry.at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka' })}
                </span>
              </div>
              <p className="truncate">
                {entry.name === null ? (
                  <span className="font-mono">{entry.code}</span>
                ) : (
                  `${entry.name}${entry.variant === null || entry.variant === '' ? '' : `, ${entry.variant}`}`
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
