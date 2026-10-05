import {
  CHUNK_MS,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FRAMES_PER_SECOND,
  RECORDING_LIMIT_MS,
  RECORDING_MAX_BYTES,
  VIDEO_BITS_PER_SECOND,
  chooseRecorderMime,
} from './pack-logic.js';

/**
 * The packing video's recorder (M38b, D-611): the chosen camera, drawn frame by frame onto a
 * canvas with the order number, the Dhaka date and time and the packer's name across the
 * bottom, and the canvas recorded (`captureStream` → `MediaRecorder`, about 720p, 800 kbit/s,
 * no sound). The caption is part of the picture, so it cannot be separated from the video it
 * vouches for.
 *
 * Chunks are handed over every few seconds for the caller to keep (IndexedDB), in order; a
 * part stops itself at fifteen minutes or near the upload ceiling, whichever comes first.
 */

/** The caption band's colours: pixels of the recording, the same in either theme. */
const CAPTION_BACKGROUND = 'rgba(0, 0, 0, 0.62)';
const CAPTION_TEXT = '#ffffff';
const RECORDING_DOT = '#e5484d';

interface MediaRecorderLike {
  start(timeslice?: number): void;
  stop(): void;
  readonly state: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

type MediaRecorderClass = (new (
  stream: MediaStream,
  options: { mimeType: string; videoBitsPerSecond: number },
) => MediaRecorderLike) & { isTypeSupported(mime: string): boolean };

function recorderClass(): MediaRecorderClass | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { MediaRecorder?: MediaRecorderClass }).MediaRecorder;
}

/** Whether this browser can record the station's camera at all. */
export function recordingSupported(): boolean {
  const Recorder = recorderClass();
  if (Recorder === undefined) return false;
  if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined) {
    return false;
  }
  if (typeof HTMLCanvasElement === 'undefined') return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
  return chooseRecorderMime((mime) => Recorder.isTypeSupported(mime)) !== null;
}

/** The cameras this browser can see; labels appear once the camera has been allowed. */
export async function listCameras(): Promise<{ deviceId: string; label: string }[]> {
  if (navigator.mediaDevices?.enumerateDevices === undefined) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'videoinput' && device.deviceId !== '')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label === '' ? `Camera ${String(index + 1)}` : device.label,
    }));
}

export interface RecorderHandle {
  readonly mime: string;
  readonly startedAt: number;
  /** Bytes handed over so far. */
  bytes(): number;
  /** Stop, wait for the last chunk to be kept, and let the camera go. */
  stop(): Promise<{ readonly endedAt: number }>;
}

export class RecorderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecorderUnavailableError';
  }
}

export async function startRecording(options: {
  readonly canvas: HTMLCanvasElement;
  readonly deviceId: string | null;
  readonly caption: () => string;
  /** Called in order, one at a time; the recorder's stop waits for the last. */
  readonly onChunk: (chunk: Blob, seq: number, at: number) => Promise<void>;
  /** The part reached its limit and stopped itself. */
  readonly onLimit: () => void;
}): Promise<RecorderHandle> {
  const Recorder = recorderClass();
  const mime =
    Recorder === undefined ? null : chooseRecorderMime((value) => Recorder.isTypeSupported(value));
  if (Recorder === undefined || mime === null) {
    throw new RecorderUnavailableError('This browser cannot record video.');
  }

  const size = { width: { ideal: FRAME_WIDTH }, height: { ideal: FRAME_HEIGHT } };
  const stream = await navigator.mediaDevices.getUserMedia({
    video:
      options.deviceId === null
        ? { ...size, facingMode: 'environment' }
        : { ...size, deviceId: { exact: options.deviceId } },
    audio: false,
  });

  const source = document.createElement('video');
  source.muted = true;
  source.playsInline = true;
  source.srcObject = stream;
  try {
    await source.play();
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }

  const canvas = options.canvas;
  const sourceWidth = source.videoWidth || FRAME_WIDTH;
  const sourceHeight = source.videoHeight || FRAME_HEIGHT;
  const scale = Math.min(1, FRAME_WIDTH / sourceWidth);
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext('2d');
  if (context === null) {
    for (const track of stream.getTracks()) track.stop();
    throw new RecorderUnavailableError('This browser cannot draw the video.');
  }

  const band = Math.max(28, Math.round(canvas.height * 0.07));
  const draw = () => {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    context.fillStyle = CAPTION_BACKGROUND;
    context.fillRect(0, canvas.height - band, canvas.width, band);
    context.fillStyle = RECORDING_DOT;
    context.beginPath();
    context.arc(band * 0.5, canvas.height - band * 0.5, band * 0.18, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = CAPTION_TEXT;
    context.font = `600 ${String(Math.round(band * 0.5))}px system-ui, sans-serif`;
    context.textBaseline = 'middle';
    context.fillText(
      options.caption(),
      band * 0.9,
      canvas.height - band * 0.5,
      canvas.width - band,
    );
  };
  draw();
  const frames = window.setInterval(draw, Math.round(1000 / FRAMES_PER_SECOND));

  const recorder = new Recorder(canvas.captureStream(FRAMES_PER_SECOND), {
    mimeType: mime,
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
  });
  const startedAt = Date.now();
  let bytes = 0;
  let seq = 0;
  let kept: Promise<void> = Promise.resolve();
  let stopping: Promise<{ endedAt: number }> | null = null;

  const release = () => {
    window.clearInterval(frames);
    window.clearTimeout(limitTimer);
    for (const track of stream.getTracks()) track.stop();
    source.srcObject = null;
  };

  const stop = (): Promise<{ endedAt: number }> => {
    stopping ??= new Promise((resolve) => {
      recorder.onstop = () => {
        const endedAt = Date.now();
        release();
        // The last chunk arrives before `stop`; wait until it is kept.
        void kept.then(() => resolve({ endedAt }));
      };
      if (recorder.state === 'inactive') {
        release();
        void kept.then(() => resolve({ endedAt: Date.now() }));
      } else {
        recorder.stop();
      }
    });
    return stopping;
  };

  recorder.ondataavailable = (event) => {
    if (event.data.size === 0) return;
    seq += 1;
    bytes += event.data.size;
    const chunk = event.data;
    const number = seq;
    const at = Date.now();
    kept = kept.then(() => options.onChunk(chunk, number, at)).catch(() => undefined);
    if (bytes >= RECORDING_MAX_BYTES && stopping === null) {
      void stop().then(() => options.onLimit());
    }
  };
  recorder.onerror = () => {
    void stop();
  };
  const limitTimer = window.setTimeout(() => {
    if (stopping === null) void stop().then(() => options.onLimit());
  }, RECORDING_LIMIT_MS);

  recorder.start(CHUNK_MS);
  return { mime, startedAt, bytes: () => bytes, stop };
}
