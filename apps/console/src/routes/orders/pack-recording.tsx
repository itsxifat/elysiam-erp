import { Button, Select, StatusBadge, cn } from '@elysium/ui';
import { CloudUpload, RotateCcw, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import { containerOf, formatElapsed, videoCaption } from './pack-logic.js';
import {
  listCameras,
  recordingSupported,
  startRecording,
  type RecorderHandle,
} from './pack-recorder.js';
import {
  attachVideoFile,
  finalizeVideoUpload,
  putVideo,
  registerVideoPart,
  videoUploadTicket,
  type PackView,
} from './pack-station-api.js';
import { runUploadQueue, type QueueSummary, type UploadApi } from './pack-uploader.js';
import { openVideoStore } from './pack-video-store.js';

/**
 * The packing station's camera and its upload queue (M38b, D-611): the hooks that record the
 * open order and send what was recorded, and the card that shows both.
 */

const CAMERA_KEY = 'erp.pack.camera';
/** The select's word for "the browser's own choice" (an empty value is not allowed there). */
const DEFAULT_CAMERA = 'default';

function rememberedCamera(): string | null {
  try {
    return window.localStorage.getItem(CAMERA_KEY);
  } catch {
    return null;
  }
}

function rememberCamera(deviceId: string | null): void {
  try {
    if (deviceId === null) window.localStorage.removeItem(CAMERA_KEY);
    else window.localStorage.setItem(CAMERA_KEY, deviceId);
  } catch {
    // A remembered camera is a convenience; the default one works too.
  }
}

// --- the upload queue -----------------------------------------------------------------------

/** The files module's upload and the packing station's attach, as the queue calls them. */
const SERVER_UPLOAD_API: UploadApi = {
  register: registerVideoPart,
  ticket: videoUploadTicket,
  put: putVideo,
  finalize: finalizeVideoUpload,
  attach: attachVideoFile,
};

export interface UploadQueue {
  readonly summary: QueueSummary;
  readonly uploading: { readonly videoId: string; readonly fraction: number } | null;
  /** The part this page is recording now: never uploaded while it runs. */
  readonly active: string | null;
  readonly setActive: (videoId: string | null) => void;
  readonly run: (force?: boolean) => void;
}

/** Recordings kept in this browser, sent one at a time; tried on load, every minute and online. */
export function useUploadQueue(): UploadQueue {
  const activeRef = useRef<string | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const [active, setActiveState] = useState<string | null>(null);
  const [summary, setSummary] = useState<QueueSummary>({ uploaded: 0, failed: 0, waiting: 0 });
  const [uploading, setUploading] = useState<UploadQueue['uploading']>(null);

  const setActive = useCallback((videoId: string | null) => {
    activeRef.current = videoId;
    setActiveState(videoId);
  }, []);

  const run = useCallback((force = false) => {
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    void (async () => {
      try {
        do {
          again.current = false;
          const store = await openVideoStore();
          const result = await runUploadQueue({
            store,
            api: SERVER_UPLOAD_API,
            activeVideoId: activeRef.current,
            force,
            onProgress: (videoId, fraction) => setUploading({ videoId, fraction }),
          });
          setUploading(null);
          setSummary(result);
        } while (again.current);
      } catch {
        setUploading(null);
      } finally {
        running.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    run();
    const timer = window.setInterval(() => run(), 60_000);
    const online = () => run(true);
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', online);
    };
  }, [run]);

  return { summary, uploading, active, setActive, run };
}

/** The queue's line under the header: what is waiting, what is going, and "Retry now". */
export function UploadQueueBar({ queue }: { readonly queue: UploadQueue }) {
  const t = useT();
  const waiting = queue.summary.waiting - (queue.active === null ? 0 : 1);
  if (queue.uploading === null && waiting <= 0) return null;
  return (
    <div
      role="status"
      data-testid="pack-upload-queue"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5 text-sm',
        queue.summary.failed > 0
          ? 'border-warning bg-warning-subtle text-warning-subtle-foreground'
          : 'border-border bg-card',
      )}
    >
      <CloudUpload aria-hidden className="size-4 shrink-0" />
      {queue.uploading === null ? (
        <span className="min-w-0 flex-1">
          {queue.summary.failed > 0
            ? t('ps.video.failed')
            : `${String(Math.max(waiting, 0))} ${t('ps.video.queued')}`}
        </span>
      ) : (
        <span className="min-w-0 flex-1 tabular-nums">
          {`${t('ps.video.uploading')} · ${String(Math.round(queue.uploading.fraction * 100))}%`}
        </span>
      )}
      <Button size="sm" variant="outline" onClick={() => queue.run(true)}>
        <RotateCcw aria-hidden />
        {t('ps.video.retry')}
      </Button>
    </div>
  );
}

// --- the recorder ---------------------------------------------------------------------------

export type RecorderState =
  'idle' | 'starting' | 'recording' | 'limit' | 'denied' | 'unsupported' | 'off';

export interface StationRecorder {
  readonly state: RecorderState;
  /** Where the preview canvas registers itself. */
  readonly attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  readonly startedAt: number | null;
  readonly cameras: readonly { deviceId: string; label: string }[];
  readonly deviceId: string | null;
  readonly chooseCamera: (deviceId: string | null) => void;
  /** Stop the running part and hand it to the upload queue. */
  readonly stop: () => Promise<void>;
  /** Start a new part after the limit, or after the camera failed. */
  readonly restart: () => void;
}

/**
 * Record while the order's session is open and the brand records (D-611): each part under its
 * own id, registered with the server as it starts, its chunks kept as they come, handed to the
 * upload queue when it stops (the order finished, the station closed, the camera changed, the
 * fifteen minutes up).
 */
export function useStationRecorder(
  view: PackView | undefined,
  queue: Pick<UploadQueue, 'run' | 'setActive'>,
  /** False while an IP camera films the packing (M38c, D-670): the browser records nothing. */
  active = true,
): StationRecorder {
  const { run, setActive } = queue;
  const handle = useRef<{ recorder: RecorderHandle; videoId: string } | null>(null);
  const caption = useRef({ orderNo: '', packer: null as string | null });
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<RecorderState>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [cameras, setCameras] = useState<readonly { deviceId: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(rememberedCamera);
  const [attempt, setAttempt] = useState(0);
  const [supported] = useState(recordingSupported);

  const sessionId = view?.session.id ?? null;
  const videoRequired = view?.session.videoRequired ?? false;
  const wanted = active && view?.session.status === 'open' && videoRequired && supported;
  const orderNo = view?.session.orderNo ?? '';
  const packer = view?.you.name ?? null;

  useEffect(() => {
    caption.current = { orderNo, packer };
  }, [orderNo, packer]);

  const stop = useCallback(async () => {
    const running = handle.current;
    if (running === null) return;
    handle.current = null;
    const { endedAt } = await running.recorder.stop();
    const store = await openVideoStore();
    await store.finish(running.videoId, endedAt);
    setActive(null);
    setStartedAt(null);
    run(true);
  }, [run, setActive]);

  useEffect(() => {
    if (!wanted || sessionId === null || canvas === null) return undefined;
    let cancelled = false;
    const videoId = crypto.randomUUID();
    void (async () => {
      setPhase('starting');
      const store = await openVideoStore();
      let begun: Promise<void> = Promise.resolve();
      try {
        const recorder = await startRecording({
          canvas,
          deviceId,
          caption: () =>
            videoCaption({
              orderNo: caption.current.orderNo,
              packer: caption.current.packer,
              at: new Date(),
            }),
          onChunk: async (chunk, seq, at) => {
            await begun;
            await store.append(videoId, seq, chunk, at);
          },
          onLimit: () => {
            void stop().then(() => setPhase('limit'));
          },
        });
        if (cancelled) {
          await recorder.stop();
          return;
        }
        begun = store.begin({
          videoId,
          sessionId,
          orderNo: caption.current.orderNo,
          mime: recorder.mime,
          startedAt: recorder.startedAt,
          endedAt: null,
          lastChunkAt: null,
          chunks: 0,
          bytes: 0,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
        });
        await begun;
        handle.current = { recorder, videoId };
        setActive(videoId);
        setStartedAt(recorder.startedAt);
        setPhase('recording');
        // Registered now, so a video that never arrives shows as missing; the upload
        // registers again if this does not get through.
        void registerVideoPart(sessionId, {
          videoId,
          startedAt: new Date(recorder.startedAt).toISOString(),
          mime: containerOf(recorder.mime),
        }).catch(() => undefined);
        setCameras(await listCameras().catch(() => []));
      } catch {
        if (!cancelled) setPhase('denied');
      }
    })();
    return () => {
      cancelled = true;
      void stop();
    };
    // `attempt` starts a new part after the limit or a failed start.
  }, [sessionId, wanted, canvas, deviceId, attempt, stop, setActive]);

  // Leaving the page: what was kept so far is uploaded on the next visit.
  useEffect(() => {
    const leave = () => {
      handle.current?.recorder.stop().catch(() => undefined);
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);

  const state: RecorderState =
    view === undefined
      ? 'idle'
      : !videoRequired
        ? 'off'
        : !supported
          ? 'unsupported'
          : view.session.status !== 'open'
            ? 'idle'
            : phase;

  return {
    state,
    attachCanvas: setCanvas,
    startedAt,
    cameras,
    deviceId,
    chooseCamera: (next) => {
      rememberCamera(next);
      setDeviceId(next);
    },
    stop,
    restart: () => setAttempt((value) => value + 1),
  };
}

/** The camera card: what is being recorded, for how long, and which camera. */
export function CameraCard({ recorder }: { readonly recorder: StationRecorder }) {
  const { state, attachCanvas, startedAt, cameras, deviceId, chooseCamera, restart } = recorder;
  const t = useT();
  const id = useId();
  const [now, setNow] = useState(() => Date.now());
  const recording = state === 'recording';
  useEffect(() => {
    if (!recording) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const message =
    state === 'off'
      ? t('ps.camera.off')
      : state === 'denied'
        ? t('ps.camera.denied')
        : state === 'unsupported'
          ? t('ps.camera.unsupported')
          : state === 'limit'
            ? t('ps.camera.limit')
            : null;

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-sm font-semibold tracking-tight">
          {t('ps.camera.title')}
        </h2>
        {recording ? (
          <StatusBadge tone="danger">
            <span className="tabular-nums" data-testid="pack-recording">
              {`${t('ps.camera.recording')} ${formatElapsed(now - (startedAt ?? now))}`}
            </span>
          </StatusBadge>
        ) : (
          <StatusBadge tone="neutral">{t('ps.camera.stopped')}</StatusBadge>
        )}
      </div>
      <div
        className={cn(
          'relative aspect-video w-full overflow-hidden rounded-md border border-border bg-muted',
          recording || state === 'starting' ? '' : 'hidden',
        )}
      >
        <canvas
          ref={attachCanvas}
          data-testid="pack-camera"
          aria-label={t('ps.camera.preview')}
          role="img"
          className="size-full object-contain"
        />
      </div>
      {message === null ? null : (
        <p
          className={cn(
            'flex items-start gap-2 text-sm',
            state === 'denied' ? 'text-destructive-text' : 'text-muted-foreground',
          )}
        >
          <VideoOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          {message}
        </p>
      )}
      {state === 'limit' || state === 'denied' ? (
        <Button size="sm" variant="outline" onClick={restart}>
          {t('ps.camera.again')}
        </Button>
      ) : null}
      {cameras.length > 1 ? (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-camera`} className="text-xs font-medium text-muted-foreground">
            {t('ps.camera.choose')}
          </label>
          <Select
            id={`${id}-camera`}
            value={deviceId ?? DEFAULT_CAMERA}
            onValueChange={(value) => chooseCamera(value === DEFAULT_CAMERA ? null : value)}
            options={[
              { value: DEFAULT_CAMERA, label: t('ps.camera.default') },
              ...cameras.map((camera) => ({
                value: camera.deviceId,
                label: camera.label,
              })),
            ]}
          />
        </div>
      ) : null}
    </section>
  );
}
