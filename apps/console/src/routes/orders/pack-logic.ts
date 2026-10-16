/**
 * The packing station's rules that need no browser (M38b, D-610, D-611): which recorder
 * format, what the video's caption says, when an upload is tried again, what a scanned code
 * means at the table. Pure, and tested in `pack-station-ui.test.ts`.
 */

/** The longest one recorded part may run (D-611). */
export const RECORDING_LIMIT_MS = 15 * 60_000;

/**
 * The most one part may hold before the recorder stops it: under the server's 90 MiB ceiling
 * for a packing video, with room for the last chunk.
 */
export const RECORDING_MAX_BYTES = 86 * 1024 * 1024;

/** About 720p at 800 kbit/s: fifteen minutes is about 90 MB (D-611). */
export const VIDEO_BITS_PER_SECOND = 800_000;
export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;
export const FRAMES_PER_SECOND = 15;

/** How often the recorder hands over a chunk, which is kept at once (IndexedDB). */
export const CHUNK_MS = 4_000;

/**
 * The formats a recorder is asked for, best first: VP8 WebM (the cheapest to encode on an old
 * packing-desk PC, and what Chrome, Edge and Firefox write), then whatever WebM the browser
 * has, then MP4 (Safari's only one).
 */
export const RECORDER_MIME_PREFERENCE = [
  'video/webm;codecs=vp8',
  'video/webm;codecs=vp9',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
] as const;

/** The first format this browser can record, or null when it can record none of them. */
export function chooseRecorderMime(isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of RECORDER_MIME_PREFERENCE) {
    try {
      if (isTypeSupported(mime)) return mime;
    } catch {
      // A browser that throws on the question cannot record that format.
    }
  }
  return null;
}

/** The container a recorder format is stored as on the server. */
export function containerOf(mime: string): 'video/webm' | 'video/mp4' {
  return (mime.split(';')[0] ?? '').trim().toLowerCase() === 'video/mp4'
    ? 'video/mp4'
    : 'video/webm';
}

const DHAKA_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * The caption drawn onto every frame of the packing video: the order, the Asia/Dhaka date and
 * time to the second, and who is packing. Latin digits and the English month, so the video
 * reads the same whatever language the console is in.
 */
export function videoCaption(input: {
  readonly orderNo: string;
  readonly packer: string | null;
  readonly at: Date;
}): string {
  const when = DHAKA_TIME.format(input.at).replace(',', '');
  return [input.orderNo, when, input.packer ?? ''].filter((part) => part !== '').join('  ·  ');
}

/** `mm:ss` (or `h:mm:ss`) for a recording's running time. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${two(minutes)}:${two(seconds)}`
    : `${two(minutes)}:${two(seconds)}`;
}

/** How long before a failed upload is tried again: 30 s, 1, 2, 5, then every 10 minutes. */
export function retryDelayMs(attempts: number): number {
  const steps = [30_000, 60_000, 120_000, 300_000];
  return steps[Math.max(0, attempts - 1)] ?? 600_000;
}

/** Whether a recording waiting in this browser is due another try. */
export function uploadDue(
  recording: { readonly attempts: number; readonly lastAttemptAt: number | null },
  now: number,
): boolean {
  if (recording.lastAttemptAt === null || recording.attempts === 0) return true;
  return now - recording.lastAttemptAt >= retryDelayMs(recording.attempts);
}

/**
 * Whether a scanned code is this order's own slip (its number, or the courier code its QR
 * carries once booked): scanning the slip again finishes the packing.
 */
export function isOrderSlip(
  code: string,
  order: {
    readonly orderNumber: string;
    readonly trackingCode: string;
    readonly consignmentId: string | null;
  },
): boolean {
  const typed = code.trim().toUpperCase();
  if (typed === '') return false;
  // M46 (D-806): one lot's slip carries the order number with its lot, `…-L2`.
  const scanned = /^(.+)-L[1-9]\d?$/.exec(typed)?.[1] ?? typed;
  return [order.orderNumber, order.trackingCode, order.consignmentId ?? '']
    .map((value) => value.trim().toUpperCase())
    .some((value) => value !== '' && (value === scanned || value === typed));
}

export type ScanTone = 'success' | 'danger' | 'neutral';

/** How a scan's answer looks and sounds at the table. */
export function outcomeTone(outcome: string): ScanTone {
  if (outcome === 'accepted') return 'success';
  if (outcome === 'removed') return 'neutral';
  return 'danger';
}

/** Megabytes, one decimal, for a video's size. */
export function formatMegabytes(bytes: number): string {
  const tenths = Math.round(bytes / 100_000);
  return `${String(Math.floor(tenths / 10))}.${String(tenths % 10)} MB`;
}

/** How a session's video state looks (D-611): saved, on its way, missing, deleted or off. */
export const VIDEO_TONE: Readonly<
  Record<
    'off' | 'pending' | 'uploaded' | 'missing' | 'deleted',
    'success' | 'warning' | 'danger' | 'neutral'
  >
> = {
  uploaded: 'success',
  pending: 'warning',
  missing: 'danger',
  deleted: 'neutral',
  off: 'neutral',
};

// --- M38c: the recording source and the IP camera (D-670, D-673) ----------------------------

/**
 * Where a packing desk's browser remembers its recording source (D-670): this computer's own
 * camera, or one of the brand's IP cameras. A neutral key, like `erp.pack.camera`: the console
 * names no brand (D-472).
 */
export const PACK_SOURCE_KEY = 'erp.pack.source';

export type PackSource =
  { readonly kind: 'browser' } | { readonly kind: 'camera'; readonly cameraId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The source a stored value names; anything else is this computer's camera. */
export function parsePackSource(stored: string | null): PackSource {
  const match = /^camera:(.+)$/.exec(stored ?? '');
  const cameraId = match?.[1];
  return cameraId !== undefined && UUID.test(cameraId)
    ? { kind: 'camera', cameraId: cameraId.toLowerCase() }
    : { kind: 'browser' };
}

export function serializePackSource(source: PackSource): string {
  return source.kind === 'camera' ? `camera:${source.cameraId}` : 'browser';
}

/**
 * The IP camera this desk records with, if any: the one it chose, while that camera is still
 * one of the brand's cameras in use. A camera switched off or removed falls back to this
 * computer's own camera (null).
 */
export function effectiveCameraId(
  source: PackSource,
  cameras: readonly { readonly id: string; readonly enabled: boolean }[] | undefined,
): string | null {
  if (source.kind !== 'camera') return null;
  if (cameras === undefined) return source.cameraId;
  return cameras.some((camera) => camera.id === source.cameraId && camera.enabled)
    ? source.cameraId
    : null;
}

/**
 * Where an IP camera's recording of the open order stands (D-671): `ready` until the first
 * correct piece is scanned, `recording` from two seconds before it, then `cutting` while the
 * server cuts the video, `saved` once it is filed, `missing` if it never was.
 */
export type IpRecordingPhase = 'ready' | 'recording' | 'cutting' | 'saved' | 'missing' | 'off';

export function ipRecordingPhase(view: {
  readonly session: {
    readonly status: 'open' | 'completed';
    readonly videoRequired: boolean;
    readonly recordingFrom?: string | null;
    readonly recordingTo?: string | null;
  };
  readonly videos: readonly { readonly source?: string; readonly state: string }[];
  readonly video: string;
}): IpRecordingPhase {
  if (!view.session.videoRequired) return 'off';
  const from = view.session.recordingFrom ?? null;
  const to = view.session.recordingTo ?? null;
  if (from === null) return view.session.status === 'open' ? 'ready' : 'missing';
  if (to === null) return 'recording';
  const parts = view.videos.filter((video) => video.source === 'camera');
  if (parts.length > 0 && parts.every((video) => video.state !== 'waiting')) return 'saved';
  return view.video === 'missing' ? 'missing' : 'cutting';
}

/** The reasons the recorder gives (D-673), each with its own words; others are a stream error. */
export const CAMERA_ERROR_CODES = [
  'auth_failed',
  'not_found',
  'unreachable',
  'timeout',
  'stream_ended',
  'stalled',
  'ffmpeg_missing',
  'credentials_unreadable',
  'address_refused',
  'disk_low',
  'stream_error',
] as const;
export type CameraErrorCode = (typeof CAMERA_ERROR_CODES)[number];

export function cameraErrorCode(code: string | null): CameraErrorCode | null {
  if (code === null) return null;
  return (CAMERA_ERROR_CODES as readonly string[]).includes(code)
    ? (code as CameraErrorCode)
    : 'stream_error';
}

/** A camera form as filled: an empty password keeps the stored one (or sets none). */
export interface CameraFormValues {
  readonly name: string;
  readonly rtspUrl: string;
  readonly username: string;
  readonly password: string;
  readonly removePassword: boolean;
  readonly enabled: boolean;
}

/**
 * What a filled camera form asks the server for (D-669): the password replaced when one was
 * typed, removed when asked to (an edit only), and otherwise left out so the stored one stays.
 */
export function cameraInput(
  values: CameraFormValues,
  editing: boolean,
): {
  readonly name: string;
  readonly rtspUrl: string;
  readonly username: string;
  readonly enabled: boolean;
  readonly password?: string | null;
} {
  const password =
    values.removePassword && editing ? null : values.password === '' ? undefined : values.password;
  return {
    name: values.name.trim(),
    rtspUrl: values.rtspUrl.trim(),
    username: values.username.trim(),
    enabled: values.enabled,
    ...(password === undefined ? {} : { password }),
  };
}

/** How a camera's state looks: ready is good news, offline is trouble, off is neither. */
export const CAMERA_STATE_TONE: Readonly<
  Record<'off' | 'ready' | 'offline', 'success' | 'danger' | 'neutral'>
> = {
  ready: 'success',
  offline: 'danger',
  off: 'neutral',
};
