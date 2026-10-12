import { ACKNOWLEDGE_OWNER_HEADER, type InboxChannelKindName } from '@elysium/contracts';

import { api, ApiError, NetworkError, request } from '../../../api.js';
import { env } from '../../../env.js';

/**
 * Voice messages and calls (M45, D-780 to D-788): the inbox's media route, the recording's
 * upload and send, and the call routes. A write that may land on someone else's conversation
 * takes `acknowledged`, as M42's writes do (D-737).
 */

export type CallStatus =
  'ringing' | 'answering' | 'connected' | 'missed' | 'declined' | 'completed' | 'failed';

export interface PersonRef {
  readonly userId: string;
  readonly name: string | null;
}

/** A call as a thread entry shows it. */
export interface CallEntry {
  readonly id: string;
  readonly channel: InboxChannelKindName;
  readonly direction: 'inbound' | 'outbound';
  readonly status: CallStatus;
  readonly startedAt: string;
  readonly connectedAt: string | null;
  readonly endedAt: string | null;
  readonly durationSeconds: number | null;
  readonly answeredBy: PersonRef | null;
  readonly declinedBy: PersonRef | null;
  readonly callbackNeeded: boolean;
  readonly callbackDoneBy: PersonRef | null;
  readonly callbackDoneAt: string | null;
  readonly callbackPhone: string | null;
}

/** A live call, as the call bar shows it. */
export interface LiveCall extends CallEntry {
  readonly conversationId: string;
  readonly contact: { readonly name: string | null };
  readonly ringingForMe: boolean;
  readonly mine: boolean;
  /** WhatsApp's SDP offer, to the person who picked the call up. */
  readonly offerSdp?: string | null;
}

/** An attachment as the thread gives it, with M45's fields where they apply. */
export interface MediaAttachment {
  readonly type: string;
  readonly fileId?: string;
  readonly media?: 'pending' | 'stored' | 'failed' | 'expired';
  readonly mimeType?: string;
  readonly durationMs?: number | string;
  readonly callId?: string;
  readonly call?: CallEntry;
}

/** The bytes of a kept voice message or picture, as a blob the page can play or show. */
export async function fetchMedia(fileId: string, signal?: AbortSignal): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(
      new URL(`/v1/inbox/media/${encodeURIComponent(fileId)}`, env.VITE_API_URL),
      { credentials: 'include', ...(signal === undefined ? {} : { signal }) },
    );
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!response.ok) throw new ApiError(response.status, null, response.statusText);
  return response.blob();
}

interface UploadTicket {
  readonly fileId: string;
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
}

/** The container a recorder's type names: `audio/webm;codecs=opus` is `audio/webm`. */
export function containerOf(mime: string): 'audio/webm' | 'audio/ogg' | 'audio/mp4' {
  const bare = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (bare === 'audio/ogg') return 'audio/ogg';
  if (bare === 'audio/mp4' || bare === 'video/mp4') return 'audio/mp4';
  return 'audio/webm';
}

/** Upload a recording as a private `inbox-media` file: ticket, PUT, finalize (§22). */
export async function uploadRecording(blob: Blob): Promise<string> {
  const contentType = containerOf(blob.type);
  const extension =
    contentType === 'audio/mp4' ? 'm4a' : contentType === 'audio/ogg' ? 'ogg' : 'webm';
  const ticket = await api.post<UploadTicket>('/v1/files', {
    purpose: 'inbox-media',
    contentType,
    sizeBytes: blob.size,
    visibility: 'private',
    originalName: `voice.${extension}`,
  });
  let put: Response;
  try {
    put = await fetch(ticket.url, {
      method: ticket.method,
      headers: { ...ticket.headers },
      body: new Blob([blob], { type: contentType }),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!put.ok) throw new ApiError(put.status, null, 'The recording could not be uploaded.');
  await api.post(`/v1/files/${encodeURIComponent(ticket.fileId)}/finalize`);
  return ticket.fileId;
}

const acknowledgedHeaders = (acknowledged: boolean) =>
  acknowledged ? { headers: { [ACKNOWLEDGE_OWNER_HEADER]: '1' } } : {};

export const sendVoice = (
  conversationId: string,
  body: { readonly id: string; readonly fileId: string; readonly durationMs: number },
  acknowledged: boolean,
) =>
  request<{ id: string; status: string }>(
    `/v1/inbox/conversations/${encodeURIComponent(conversationId)}/voice`,
    { method: 'POST', body, ...acknowledgedHeaders(acknowledged) },
  );

// --- calls ---------------------------------------------------------------------------------------

export const CALLS_KEY = ['inbox', 'calls', 'live'] as const;

const call = (id: string, suffix: string) => `/v1/inbox/calls/${encodeURIComponent(id)}${suffix}`;

export const liveCalls = () => api.get<{ items: LiveCall[] }>('/v1/inbox/calls/live');
export const claimCall = (id: string) => api.post<LiveCall>(call(id, '/claim'));
export const answerCall = (id: string, body: { step: 'pre_accept' | 'accept'; sdp: string }) =>
  api.post<{ status: string; sdpAnswer: string | null; sdpRenegotiation: string | null }>(
    call(id, '/answer'),
    body,
  );
export const releaseCall = (id: string) => api.post<unknown>(call(id, '/release'));
export const declineCall = (id: string) => api.post<unknown>(call(id, '/decline'));
export const hangUpCall = (id: string) => api.post<unknown>(call(id, '/hang-up'));
export const callbackDone = (id: string, acknowledged: boolean) =>
  request<unknown>(call(id, '/callback-done'), {
    method: 'POST',
    ...acknowledgedHeaders(acknowledged),
  });
