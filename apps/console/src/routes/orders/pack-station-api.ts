import { api } from '../../api.js';

/**
 * The packing station's and the packing video's endpoints (M38b, D-610 to D-615), and the
 * packing tables' IP cameras (M38c, D-668 to D-676), typed to what the server returns.
 */

export type PackLineState = 'todo' | 'partial' | 'done' | 'over';
export type PackScanOutcome =
  'accepted' | 'removed' | 'unknown_code' | 'wrong_item' | 'wrong_variant' | 'over';
export type PackingVideoState = 'off' | 'pending' | 'uploaded' | 'missing' | 'deleted';

export interface PersonRef {
  readonly id: string;
  readonly name: string | null;
}

export interface PackLine {
  readonly skuId: string;
  readonly name: string;
  readonly image: string;
  readonly sku: string;
  readonly barcode: string | null;
  readonly size: string;
  readonly color: string;
  readonly required: number;
  readonly packed: number;
  readonly state: PackLineState;
}

export interface PackScan {
  readonly id: string;
  readonly scanId: string;
  readonly code: string;
  readonly skuId: string | null;
  readonly sku: string | null;
  readonly name: string | null;
  readonly variant: string | null;
  readonly outcome: PackScanOutcome;
  readonly at: string;
  readonly by: PersonRef;
}

export interface PackVideoPart {
  readonly id: string;
  readonly part: number;
  readonly state: 'waiting' | 'uploaded' | 'deleted';
  readonly mime: string;
  readonly startedAt: string;
  readonly durationMs: number | null;
  readonly sizeBytes: number | null;
  readonly uploadedAt: string | null;
  readonly deletedAt: string | null;
  readonly deletedReason: string | null;
  readonly recordedBy: PersonRef;
  /** M38c: the desk's camera (uploaded by the browser) or an IP camera (cut on the server). */
  readonly source?: 'browser' | 'camera';
  readonly cameraId?: string | null;
}

export interface PackView {
  readonly you: PersonRef;
  readonly session: {
    readonly id: string;
    readonly orderId: string;
    readonly orderNo: string;
    readonly status: 'open' | 'completed';
    readonly videoRequired: boolean;
    readonly startedAt: string;
    readonly startedBy: PersonRef;
    readonly completedAt: string | null;
    readonly completedBy: PersonRef | null;
    /** M38c (D-670, D-671): the IP camera filming it, and its recording's window. */
    readonly cameraId?: string | null;
    /** The source is fixed: recording started, or a piece is in the box (ledger audit N1). */
    readonly cameraLocked?: boolean;
    readonly recordingFrom?: string | null;
    readonly recordingTo?: string | null;
    readonly recordingBy?: PersonRef | null;
  };
  readonly order: {
    readonly id: string;
    readonly orderNumber: string;
    readonly status: string;
    readonly channel: string;
    readonly paid: boolean;
    readonly cod: { readonly poisha: string; readonly taka: string };
    readonly notes: string;
    readonly courier: string | null;
    readonly consignmentId: string | null;
    readonly trackingCode: string;
    readonly recipient: { readonly name: string; readonly address: string };
  };
  readonly lines: readonly PackLine[];
  readonly extra: readonly {
    readonly skuId: string;
    readonly packed: number;
    readonly sku: string;
    readonly name: string;
    readonly variant: string;
  }[];
  readonly progress: {
    readonly unitsRequired: number;
    readonly unitsPacked: number;
    readonly complete: boolean;
  };
  readonly scans: readonly PackScan[];
  readonly videos: readonly PackVideoPart[];
  readonly video: PackingVideoState;
}

export interface ScanAnswer {
  readonly outcome: PackScanOutcome;
  readonly accepted: boolean;
  readonly skuId: string | null;
  readonly message: string | null;
  readonly repeated: boolean;
  readonly view: PackView;
}

/**
 * Open the station on an order, or resume it. `cameraId` is this desk's recording source: an
 * IP camera's id, `null` for the desk's own camera, absent to leave the session's choice.
 */
export function openPacking(
  input: ({ code: string } | { orderId: string }) & { cameraId?: string | null },
): Promise<PackView> {
  return api.post('/v1/packing/sessions', input);
}

export function packingSession(id: string): Promise<PackView> {
  return api.get(`/v1/packing/sessions/${id}`);
}

export function scanPiece(sessionId: string, scanId: string, code: string): Promise<ScanAnswer> {
  return api.post(`/v1/packing/sessions/${sessionId}/scans`, { scanId, code });
}

export function takeOut(sessionId: string, scanId: string, skuId: string): Promise<PackView> {
  return api.post(`/v1/packing/sessions/${sessionId}/removals`, { scanId, skuId });
}

export function finishPacking(
  sessionId: string,
): Promise<PackView & { alreadyCompleted: boolean }> {
  return api.post(`/v1/packing/sessions/${sessionId}/complete`);
}

export interface PackSessionSummary {
  readonly id: string;
  readonly orderId: string;
  readonly orderNo: string;
  readonly orderStatus: string | null;
  readonly status: 'open' | 'completed';
  readonly startedAt: string;
  readonly startedBy: PersonRef;
  readonly completedAt: string | null;
  readonly completedBy: PersonRef | null;
  readonly durationMs: number | null;
  readonly pieces: number;
  readonly scans: number;
  readonly mismatches: number;
  readonly video: PackingVideoState;
}

export function recentPacking(): Promise<{ items: readonly PackSessionSummary[] }> {
  return api.get('/v1/packing/sessions?limit=30');
}

export function orderPacking(
  orderId: string,
): Promise<(PackView & { canPlay: boolean }) | { session: null; canPlay: boolean }> {
  return api.get(`/v1/packing/orders/${orderId}`);
}

export function videoUrl(videoId: string): Promise<{
  id: string;
  url: string;
  expiresAt: string;
  mime: string;
  durationMs: number | null;
}> {
  return api.get(`/v1/packing/videos/${videoId}/url`);
}

export interface PackingSettings {
  readonly videoEnabled: boolean;
  readonly updatedAt: string | null;
  readonly canEdit: boolean;
}

export function packingSettings(): Promise<PackingSettings> {
  return api.get('/v1/packing/settings');
}

export function savePackingSettings(videoEnabled: boolean): Promise<PackingSettings> {
  return api.put('/v1/packing/settings', { videoEnabled });
}

// --- the video's upload (the files module's ticket, PUT and finalize, §22) ------------------

export interface VideoPartAnswer {
  readonly id: string;
  readonly part: number;
  readonly state: 'waiting' | 'uploaded' | 'deleted';
  /** This person may bring the part's file: its recorder or an org admin. */
  readonly mayAttach?: boolean;
}

export function registerVideoPart(
  sessionId: string,
  input: { videoId: string; startedAt: string; mime: 'video/webm' | 'video/mp4' },
): Promise<VideoPartAnswer> {
  return api.post(`/v1/packing/sessions/${sessionId}/videos`, input);
}

export function attachVideoFile(
  sessionId: string,
  videoId: string,
  input: { fileId: string; durationMs: number },
): Promise<VideoPartAnswer> {
  return api.post(`/v1/packing/sessions/${sessionId}/videos/${videoId}/file`, input);
}

export interface VideoUploadTicket {
  readonly fileId: string;
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBytes: number;
}

export function videoUploadTicket(input: {
  contentType: string;
  sizeBytes: number;
  originalName: string;
}): Promise<VideoUploadTicket> {
  return api.post('/v1/files', { ...input, purpose: 'packing-video', visibility: 'private' });
}

export function finalizeVideoUpload(fileId: string): Promise<{ id: string; status: string }> {
  return api.post(`/v1/files/${fileId}/finalize`);
}

/** PUT the bytes where the ticket says, reporting progress (a fetch cannot). */
export function putVideo(
  ticket: VideoUploadTicket,
  blob: Blob,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(ticket.method, ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`The video upload was refused (${String(request.status)}).`));
    };
    request.onerror = () => reject(new Error('The video upload did not reach the server.'));
    request.onabort = () => reject(new Error('The video upload was stopped.'));
    request.send(blob);
  });
}

// --- the packing tables' IP cameras (M38c, D-668, D-669) ------------------------------------

export type PackCameraState = 'off' | 'ready' | 'offline';

export interface PackCamera {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly state: PackCameraState;
  readonly lastSegmentAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  /** For an org admin only: the address (never with credentials) and the user name. */
  readonly rtspUrl?: string;
  readonly username?: string;
  /** The password itself never leaves the server: whether one is set, and its fingerprint. */
  readonly passwordSet?: boolean;
  readonly passwordFingerprint?: string | null;
  readonly updatedAt?: string | null;
}

export interface PackCameras {
  readonly cameras: readonly PackCamera[];
  readonly canEdit: boolean;
  /** Whether this server can keep a camera's password (its credentials key is set). */
  readonly credentialsKey: boolean;
}

export function packingCameras(): Promise<PackCameras> {
  return api.get('/v1/packing/cameras');
}

export interface PackCameraInput {
  readonly name: string;
  readonly rtspUrl: string;
  readonly username: string;
  /** Absent keeps the stored password, a string replaces it, null removes it. */
  readonly password?: string | null;
  readonly enabled: boolean;
}

export function addPackingCamera(input: PackCameraInput): Promise<PackCamera> {
  return api.post('/v1/packing/cameras', input);
}

export function updatePackingCamera(id: string, input: PackCameraInput): Promise<PackCamera> {
  return api.put(`/v1/packing/cameras/${id}`, input);
}
