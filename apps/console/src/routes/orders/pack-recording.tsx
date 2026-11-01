import { Button, Select, cn } from '@elysium/ui';
import { CheckCircle2, CloudUpload, Pause, RotateCcw, ScanLine, VideoOff } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import {
  containerOf,
  formatElapsed,
  recordingClock,
  videoCaption,
  type RecordingFacts,
} from './pack-logic.js';
import {
  listCameras,
  openCamera,
  recordingSupported,
  type CameraHandle,
  type RecorderHandle,
} from './pack-recorder.js';
import {
  attachVideoFile,
  finalizeVideoUpload,
  putVideo,
  registerVideoPart,
  videoUploadTicket,
} from './pack-station-api.js';
import { runUploadQueue, type QueueSummary, type UploadApi } from './pack-uploader.js';
import { openVideoStore } from './pack-video-store.js';
import './pack-station.css';

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
  | 'idle'
  | 'starting'
  | 'standby'
  | 'recording'
  | 'paused'
  | 'limit'
  | 'denied'
  | 'unsupported'
  | 'off';

export interface StationRecorder {
  readonly state: RecorderState;
  /** Where the preview canvas registers itself. */
  readonly attachCanvas: (canvas: HTMLCanvasElement | null) => void;
  readonly cameras: readonly { deviceId: string; label: string }[];
  readonly deviceId: string | null;
  readonly chooseCamera: (deviceId: string | null) => void;
  /** Stop the running part and hand it to the upload queue. */
  readonly stop: () => Promise<void>;
  /** Open the camera again after it failed, or record again after the limit. */
  readonly restart: () => void;
}

/** A clock that ticks while `enabled`, for the countdown to the pause and the running time. */
export function useNow(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

/**
 * This computer's camera at the station (D-611; M51, D-930 to D-932). The camera opens with the
 * order (its picture shows while the station waits for the label); each lot's recording records
 * one part from it, registered under the lot's recording as it starts, its chunks kept as they
 * come, handed to the upload queue when the recording stops. The recorder pauses when the lot's
 * idle time runs out with no scan and resumes at the next scan, this page's own included.
 */
export function useStationRecorder(
  input: {
    readonly sessionId: string | null;
    readonly open: boolean;
    readonly videoRequired: boolean;
    /** False while an IP camera films the packing (M38c, D-670): the browser records nothing. */
    readonly active: boolean;
    readonly orderNo: string;
    readonly packer: string | null;
    readonly kind: 'pack' | 'return';
    readonly lotCount: number;
    /** The lot's recording running now, if this computer's camera records it. */
    readonly recording: RecordingFacts | null;
    readonly activityMs: readonly number[];
    readonly localActivityAt: number | null;
  },
  queue: Pick<UploadQueue, 'run' | 'setActive'>,
): StationRecorder {
  const { run, setActive } = queue;
  const camera = useRef<CameraHandle | null>(null);
  const part = useRef<{ recorder: RecorderHandle; videoId: string; recordingId: string } | null>(
    null,
  );
  const caption = useRef<{
    orderNo: string;
    packer: string | null;
    lot: { no: number; of: number } | null;
    kind: 'pack' | 'return';
  }>({ orderNo: '', packer: null, lot: null, kind: 'pack' });
  const clock = useRef(input);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<RecorderState>('idle');
  const [opened, setOpened] = useState(0);
  const [cameras, setCameras] = useState<readonly { deviceId: string; label: string }[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(rememberedCamera);
  const [attempt, setAttempt] = useState(0);
  const [limited, setLimited] = useState<string | null>(null);
  const [supported] = useState(recordingSupported);

  const wantCamera =
    input.active && input.open && input.videoRequired && supported && input.sessionId !== null;
  const recording = input.recording;
  const recordingId =
    wantCamera &&
    recording !== null &&
    recording.state === 'recording' &&
    recording.source === 'browser' &&
    recording.videoRequired
      ? recording.id
      : null;

  useEffect(() => {
    clock.current = input;
    caption.current = {
      orderNo: input.orderNo,
      packer: input.packer,
      lot: recording === null ? null : { no: recording.lot, of: input.lotCount },
      kind: input.kind,
    };
  });

  const stopPart = useCallback(async () => {
    const running = part.current;
    if (running === null) return;
    part.current = null;
    const { endedAt } = await running.recorder.stop();
    const store = await openVideoStore();
    await store.finish(running.videoId, endedAt);
    setActive(null);
    run(true);
  }, [run, setActive]);

  // The camera, open while the order is open here.
  useEffect(() => {
    if (!wantCamera || canvas === null) return undefined;
    let cancelled = false;
    void (async () => {
      setPhase('starting');
      try {
        const handle = await openCamera({
          canvas,
          deviceId,
          caption: () =>
            videoCaption({
              orderNo: caption.current.orderNo,
              packer: caption.current.packer,
              at: new Date(),
              lot: caption.current.lot,
              kind: caption.current.kind,
            }),
          live: () => part.current !== null && !part.current.recorder.paused(),
        });
        if (cancelled) {
          handle.close();
          return;
        }
        camera.current = handle;
        setPhase('standby');
        setOpened((value) => value + 1);
        setCameras(await listCameras().catch(() => []));
      } catch {
        if (!cancelled) setPhase('denied');
      }
    })();
    return () => {
      cancelled = true;
      void stopPart().finally(() => {
        camera.current?.close();
        camera.current = null;
      });
    };
  }, [wantCamera, canvas, deviceId, attempt, stopPart]);

  // One part per lot's recording, started the moment its label is scanned.
  useEffect(() => {
    const handle = camera.current;
    const sessionId = input.sessionId;
    if (handle === null || recordingId === null || sessionId === null) return undefined;
    if (part.current?.recordingId === recordingId || limited === recordingId) return undefined;
    let cancelled = false;
    const videoId = crypto.randomUUID();
    void (async () => {
      await stopPart();
      const store = await openVideoStore();
      let begun: Promise<void> = Promise.resolve();
      const recorder = handle.record({
        onChunk: async (chunk, seq, at) => {
          await begun;
          await store.append(videoId, seq, chunk, at);
        },
        onLimit: () => {
          setLimited(recordingId);
          void stopPart().then(() => setPhase('limit'));
        },
      });
      if (cancelled) {
        await recorder.stop();
        return;
      }
      part.current = { recorder, videoId, recordingId };
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
        recordingId,
      });
      await begun;
      setActive(videoId);
      setPhase('recording');
      // Registered now, so a video that never arrives shows as missing; the upload
      // registers again if this does not get through.
      void registerVideoPart(sessionId, {
        videoId,
        startedAt: new Date(recorder.startedAt).toISOString(),
        mime: containerOf(recorder.mime),
        recordingId,
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [recordingId, input.sessionId, opened, limited, stopPart, setActive]);

  // The lot's recording stopped (its label again, Close lot, Finish, the receipt).
  useEffect(() => {
    if (recordingId !== null || part.current === null) return;
    void stopPart().then(() => setPhase((current) => (current === 'denied' ? current : 'standby')));
  }, [recordingId, stopPart]);

  // The pause (D-931): after the idle time with no scan, and back at the next.
  useEffect(() => {
    if (recordingId === null) return undefined;
    const timer = window.setInterval(() => {
      const running = part.current;
      const facts = clock.current;
      if (running === null || facts.recording === null) return;
      const { paused } = recordingClock({
        recording: facts.recording,
        activityMs: facts.activityMs,
        localActivityAt: facts.localActivityAt,
        now: Date.now(),
      });
      if (paused && !running.recorder.paused()) {
        running.recorder.pause();
        setPhase('paused');
      } else if (!paused && running.recorder.paused()) {
        running.recorder.resume();
        setPhase('recording');
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [recordingId]);

  // Leaving the page: what was kept so far is uploaded on the next visit.
  useEffect(() => {
    const leave = () => {
      part.current?.recorder.stop().catch(() => undefined);
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);

  const state: RecorderState =
    input.sessionId === null
      ? 'idle'
      : !input.videoRequired
        ? 'off'
        : !supported
          ? 'unsupported'
          : !input.open
            ? 'idle'
            : phase;

  return {
    state,
    attachCanvas: setCanvas,
    cameras,
    deviceId,
    chooseCamera: (next) => {
      rememberCamera(next);
      setDeviceId(next);
    },
    stop: stopPart,
    restart: () => {
      setLimited(null);
      setAttempt((value) => value + 1);
    },
  };
}

// --- the stage ------------------------------------------------------------------------------

/** What the stage says about the lot's recording (D-930, D-931). */
export type StageStatus =
  | { readonly kind: 'label' }
  | { readonly kind: 'recording'; readonly recordedMs: number; readonly pauseInMs: number }
  | { readonly kind: 'paused'; readonly recordedMs: number }
  | { readonly kind: 'done'; readonly lot: number | null }
  | { readonly kind: 'none' };

/**
 * The camera at the station, large: the picture (this computer's camera, or the IP camera's
 * live view), and over it the recording's state as the packer reads it from across the table:
 * REC with its running time and a ring that empties toward the pause, PAUSED until the next
 * scan, or the label to scan first. The overlay is the page's, not the video's.
 */
export function CameraStage({
  picture,
  status,
  idleMs,
  lot,
  name,
  footer,
}: {
  readonly picture: React.ReactNode;
  readonly status: StageStatus;
  readonly idleMs: number;
  readonly lot: { readonly no: number; readonly of: number } | null;
  readonly name: string;
  readonly footer?: React.ReactNode;
}) {
  const t = useT();
  const id = useId();
  const fraction =
    status.kind === 'recording' && idleMs > 0
      ? Math.max(0, Math.min(1, status.pauseInMs / idleMs))
      : 0;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="space-y-3 rounded-lg border border-border bg-card p-3"
      data-testid="pack-stage"
      data-status={status.kind}
    >
      <div className="ps-stage">
        {picture}
        <div className="ps-stage-top">
          <span className="ps-chip" data-tone={TONE[status.kind]} role="status">
            {status.kind === 'recording' ? (
              <>
                <span className="ps-dot" aria-hidden />
                <span className="tabular-nums" data-testid="pack-recording">
                  {`${t('ps.stage.rec')} ${formatElapsed(status.recordedMs)}`}
                </span>
              </>
            ) : status.kind === 'paused' ? (
              <>
                <Pause aria-hidden className="size-3.5" />
                <span className="tabular-nums" data-testid="pack-paused">
                  {`${t('ps.stage.paused')} · ${formatElapsed(status.recordedMs)}`}
                </span>
              </>
            ) : status.kind === 'label' ? (
              <>
                <ScanLine aria-hidden className="size-3.5" />
                {t('ps.stage.scanLabel')}
              </>
            ) : status.kind === 'done' ? (
              <>
                <CheckCircle2 aria-hidden className="size-3.5" />
                {t('ps.stage.stopped')}
              </>
            ) : (
              t('ps.camera.stopped')
            )}
          </span>
          {lot === null || lot.of <= 1 ? null : (
            <span className="ps-chip" data-tone="neutral">
              {`${t('ps.stage.lot')} ${String(lot.no)}/${String(lot.of)}`}
            </span>
          )}
        </div>
        {status.kind === 'recording' ? (
          <div className="ps-stage-bottom">
            <span className="ps-chip" data-tone="neutral">
              <svg viewBox="0 0 20 20" className="ps-ring" aria-hidden>
                <circle cx="10" cy="10" r="8" className="ps-ring-track" />
                <circle
                  cx="10"
                  cy="10"
                  r="8"
                  className="ps-ring-fill"
                  strokeDasharray="50.27"
                  strokeDashoffset={String(Math.round(5027 * (1 - fraction)) / 100)}
                />
              </svg>
              <span className="tabular-nums">
                {`${t('ps.stage.pausesIn')} ${String(Math.ceil(status.pauseInMs / 1000))} s`}
              </span>
            </span>
          </div>
        ) : status.kind === 'paused' ? (
          <div className="ps-stage-bottom">
            <span className="ps-chip" data-tone="neutral">
              {t('ps.stage.resumeHint')}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id={`${id}-title`} className="truncate text-sm font-semibold tracking-tight">
          {name}
        </h2>
        {footer}
      </div>
    </section>
  );
}

const TONE: Readonly<Record<StageStatus['kind'], string>> = {
  label: 'info',
  recording: 'danger',
  paused: 'warning',
  done: 'success',
  none: 'neutral',
};

/** This computer's camera on the stage: the canvas it records, and what keeps it from it. */
export function BrowserPicture({ recorder }: { readonly recorder: StationRecorder }) {
  const t = useT();
  const { state, attachCanvas, restart } = recorder;
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
    <>
      <canvas
        ref={attachCanvas}
        data-testid="pack-camera"
        aria-label={t('ps.camera.preview')}
        role="img"
        className={cn('ps-stage-media', message === null ? '' : 'hidden')}
      />
      {message === null ? null : (
        <div className="ps-stage-empty">
          <VideoOff aria-hidden className="size-6" />
          <p className="max-w-xs text-sm">{message}</p>
          {state === 'limit' || state === 'denied' ? (
            <Button size="sm" variant="outline" onClick={restart}>
              {t('ps.camera.again')}
            </Button>
          ) : null}
        </div>
      )}
    </>
  );
}

/** The choice of this computer's camera, when it has more than one. */
export function CameraChoice({ recorder }: { readonly recorder: StationRecorder }) {
  const t = useT();
  const id = useId();
  const { cameras, deviceId, chooseCamera } = recorder;
  if (cameras.length <= 1) return null;
  return (
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
          ...cameras.map((camera) => ({ value: camera.deviceId, label: camera.label })),
        ]}
      />
    </div>
  );
}
