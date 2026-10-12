import { randomUUID } from 'node:crypto';

import type { InboxChannelKind } from '@elysium/domain/inbox';

import { MessagingError } from './meta-messaging.js';

/**
 * Media and calls through Meta (M45, D-780 to D-788). UNVERIFIED: built from Meta's
 * documentation read on 2026-10-12 and never run against Meta (Unverified integrations in
 * decisions.md). Every URL below is from those pages.
 *
 * **Downloading what a customer sent** (D-780):
 * - WhatsApp (Cloud API › Media, developers.facebook.com/documentation/business-messaging/
 *   whatsapp/business-phone-numbers/media): `GET /<MEDIA_ID>` with the bearer token answers
 *   `{url, mime_type, sha256, file_size, id}`; `GET <url>` with the same token gives the bytes.
 *   "Media IDs in webhooks expire after 7 days", and the URL after five minutes.
 * - Messenger and Instagram: the webhook's `attachments[].payload.url`, a CDN link fetched as is.
 *
 * **Sending a voice message** (D-781):
 * - WhatsApp: `POST /<PHONE_NUMBER_ID>/media` as multipart (`messaging_product=whatsapp`,
 *   `type`, `file`) answers `{id}`; then `POST /<PHONE_NUMBER_ID>/messages` with
 *   `{"type":"audio","audio":{"id":…,"voice":true}}` (Cloud API › Audio messages).
 * - Messenger (Send API › Saving assets, "upload and send in one step"): `POST
 *   /<PAGE_ID>/messages?access_token=…` as form data, `recipient`, `message` =
 *   `{"attachment":{"type":"audio","payload":{}}}` and `filedata` with the audio's type.
 * - Instagram (Messenger API for Instagram › Upload media, "Upload and send" from a server): the
 *   same request to the linked Page's endpoint, with the IGSID.
 *
 * **Calls** (D-786, D-787):
 * - WhatsApp (Calling › User-initiated calls): `POST /<PHONE_NUMBER_ID>/calls` with
 *   `{"messaging_product":"whatsapp","call_id":…,"action":"pre_accept"|"accept"|"reject"|
 *   "terminate"}`, and for `pre_accept` and `accept` a `session` of `{"sdp_type":"answer","sdp":…}`;
 *   the answer is `{"success":true}`.
 * - Messenger (Calling › Consumer to Business Calling): `POST /<PAGE_ID>/calls` with
 *   `{"platform":"messenger","call_id":…,"action":"accept"|"reject"|"terminate"}`; `accept` takes
 *   the business's SDP **offer** (`session: {"sdp_type":"offer","sdp":…}`) and answers
 *   `{"success":true,"session":{"sdp_response":…,"sdp_renegotiation":…}}`.
 *
 * A token is never put in an error, a log line or a thrown message, and no URL is repeated in
 * one (Messenger's carries the token). A download only goes to Meta's own hosts (`MEDIA_HOSTS`),
 * following at most three redirects, each checked again; the WhatsApp token goes only to Graph
 * and to `lookaside.fbsbx.com`, never across a redirect to another host.
 */

export interface MediaDownloadRequest {
  readonly channel: InboxChannelKind;
  /** WhatsApp: the media id from the webhook. */
  readonly mediaId?: string | undefined;
  /** Messenger and Instagram: the CDN URL from the webhook. */
  readonly url?: string | undefined;
  /** WhatsApp only: the bearer token for Graph and the media URL. */
  readonly token: string | null;
  readonly maxBytes: number;
}

export interface MediaDownload {
  readonly bytes: Uint8Array;
  /** What Meta said it is (WhatsApp's `mime_type`, the CDN's content type), parameters dropped. */
  readonly declaredMime: string | null;
}

export interface SendVoiceRequest {
  readonly channel: InboxChannelKind;
  /** Messenger and Instagram: the Facebook Page's id. WhatsApp: the phone number id. */
  readonly senderId: string;
  readonly token: string;
  readonly recipientId: string;
  readonly bytes: Uint8Array;
  readonly mime: 'audio/ogg' | 'audio/mp4';
  readonly filename: string;
  /** WhatsApp's `audio.voice: true`. */
  readonly voiceNote: boolean;
}

export type CallActionName = 'pre_accept' | 'accept' | 'reject' | 'terminate';

export interface CallActionRequest {
  readonly channel: 'messenger' | 'whatsapp';
  readonly senderId: string;
  readonly token: string;
  readonly providerCallId: string;
  readonly action: CallActionName;
  /** The browser's SDP: WhatsApp's answer, or Messenger's offer. */
  readonly sdp?: string | undefined;
}

export interface CallActionResult {
  /** Messenger's answer to the browser's offer, on `accept`. */
  readonly sdpAnswer: string | null;
  /** Messenger's renegotiation offer, when it sends one with the answer. */
  readonly sdpRenegotiation: string | null;
}

export class MediaTooLarge extends Error {
  constructor() {
    super('The attachment is larger than the inbox keeps.');
    this.name = 'MediaTooLarge';
  }
}

export interface MetaMediaGateway {
  readonly provider: 'graph' | 'fake';
  download(request: MediaDownloadRequest): Promise<MediaDownload>;
  sendVoice(request: SendVoiceRequest): Promise<{ readonly providerMessageId: string }>;
  callAction(request: CallActionRequest): Promise<CallActionResult>;
}

export const META_MEDIA_GATEWAY = Symbol('MetaMediaGateway');

/** Meta's media hosts (D-782): its CDNs and the WhatsApp media host. Nothing else is fetched. */
export const MEDIA_HOSTS = [
  'fbcdn.net',
  'fbsbx.com',
  'cdninstagram.com',
  'facebook.com',
  'whatsapp.net',
] as const;

/** An `https` URL on one of Meta's media hosts. */
export function isMetaMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  return MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Records what would have been done. The default everywhere until the adapter is verified. */
export class FakeMetaMediaGateway implements MetaMediaGateway {
  readonly provider = 'fake' as const;
  readonly downloads: MediaDownloadRequest[] = [];
  readonly voices: SendVoiceRequest[] = [];
  readonly calls: CallActionRequest[] = [];
  /** What the next download answers; a short Ogg header by default. */
  nextDownload: MediaDownload | Error = {
    bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0]),
    declaredMime: 'audio/ogg',
  };
  /** Set to make the next call action fail, once. */
  failNext: MessagingError | null = null;

  download(request: MediaDownloadRequest): Promise<MediaDownload> {
    this.downloads.push(request);
    const next = this.nextDownload;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }

  sendVoice(request: SendVoiceRequest): Promise<{ readonly providerMessageId: string }> {
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return Promise.reject(failure);
    }
    this.voices.push(request);
    const prefix = request.channel === 'whatsapp' ? 'wamid.fake' : 'm_fake';
    return Promise.resolve({ providerMessageId: `${prefix}.${randomUUID()}` });
  }

  callAction(request: CallActionRequest): Promise<CallActionResult> {
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return Promise.reject(failure);
    }
    this.calls.push(request);
    // Messenger answers the browser's offer with its own; the fake echoes a minimal answer.
    const answer =
      request.channel === 'messenger' && request.action === 'accept'
        ? 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n'
        : null;
    return Promise.resolve({ sdpAnswer: answer, sdpRenegotiation: null });
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GraphMediaOptions {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
  /** Injected so the adapter is tested against a stand-in, never against Meta. */
  readonly fetch?: Fetch;
  /** Which URLs a download may reach; Meta's hosts by default (tests add their stand-in). */
  readonly mediaUrlAllowed?: (url: string) => boolean;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

/** The type before its parameters, lower-cased: `audio/ogg; codecs=opus` is `audio/ogg`. */
export function bareMime(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const mime = (value.split(';')[0] ?? '').trim().toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]+$/.test(mime) ? mime : null;
}

/** Read a body up to `maxBytes`, refusing (not truncating) anything longer. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new MediaTooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Node's web stream is async-iterable; read it chunk by chunk and stop at the ceiling.
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new MediaTooLarge();
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class GraphMetaMediaGateway implements MetaMediaGateway {
  readonly provider = 'graph' as const;
  private readonly fetch: Fetch;
  private readonly allowed: (url: string) => boolean;

  constructor(private readonly options: GraphMediaOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    // Meta's media hosts, or Graph's own origin (the configured base URL: a stand-in in tests).
    const graph = new URL(options.baseUrl).origin;
    this.allowed =
      options.mediaUrlAllowed ??
      ((url) => {
        if (isMetaMediaUrl(url)) return true;
        try {
          return new URL(url).origin === graph;
        } catch {
          return false;
        }
      });
  }

  private root(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/${this.options.apiVersion}`;
  }

  private graphHost(): string {
    return new URL(this.options.baseUrl).host;
  }

  // --- downloads ----------------------------------------------------------------------------------

  async download(request: MediaDownloadRequest): Promise<MediaDownload> {
    if (request.channel === 'whatsapp') {
      if (request.mediaId === undefined || request.token === null) {
        throw new MessagingError('The WhatsApp media id or token is missing.', false, null, null);
      }
      const meta = (await this.json(`${this.root()}/${encodeURIComponent(request.mediaId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${request.token}` },
      })) as { url?: unknown; mime_type?: unknown; file_size?: unknown } | null;
      const url = text(meta?.url);
      const size = Number(meta?.file_size ?? NaN);
      if (Number.isFinite(size) && size > request.maxBytes) throw new MediaTooLarge();
      if (url === '') throw new MessagingError('Meta gave no media URL.', false, null, null);
      const bytes = await this.fetchBytes(url, request.maxBytes, request.token);
      return { bytes: bytes.bytes, declaredMime: bareMime(text(meta?.mime_type)) ?? bytes.mime };
    }
    if (request.url === undefined) {
      throw new MessagingError('The attachment has no URL.', false, null, null);
    }
    const fetched = await this.fetchBytes(request.url, request.maxBytes, null);
    return { bytes: fetched.bytes, declaredMime: fetched.mime };
  }

  /**
   * GET a media URL on Meta's hosts, following at most three redirects by hand so each hop is
   * checked; the token goes only to Graph's host and WhatsApp's media host.
   */
  private async fetchBytes(
    start: string,
    maxBytes: number,
    token: string | null,
  ): Promise<{ bytes: Uint8Array; mime: string | null }> {
    let url = start;
    for (let hop = 0; hop < 4; hop += 1) {
      if (!this.allowed(url)) {
        throw new MessagingError('The attachment is not on a Meta host.', false, null, null);
      }
      const host = new URL(url).host;
      const sendToken =
        token !== null && (host === this.graphHost() || host === 'lookaside.fbsbx.com');
      let response: Response;
      try {
        response = await this.fetch(url, {
          method: 'GET',
          redirect: 'manual',
          headers: sendToken ? { authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (cause) {
        throw this.unreachable(cause);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location === null) break;
        url = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new MessagingError(
          `Meta refused the download (HTTP ${String(response.status)}).`,
          response.status >= 500 || response.status === 429,
          response.status,
          null,
        );
      }
      return {
        bytes: await readCapped(response, maxBytes),
        mime: bareMime(response.headers.get('content-type')),
      };
    }
    throw new MessagingError('The attachment redirected too often.', false, null, null);
  }

  // --- voice --------------------------------------------------------------------------------------

  async sendVoice(request: SendVoiceRequest): Promise<{ readonly providerMessageId: string }> {
    const sender = encodeURIComponent(request.senderId);
    const audio = new Blob([request.bytes], { type: request.mime });
    if (request.channel === 'whatsapp') {
      const upload = new FormData();
      upload.set('messaging_product', 'whatsapp');
      upload.set('type', request.mime);
      upload.set('file', audio, request.filename);
      const uploaded = (await this.json(`${this.root()}/${sender}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${request.token}` },
        body: upload,
      })) as { id?: unknown } | null;
      const mediaId = text(uploaded?.id);
      if (mediaId === '') {
        throw new MessagingError('Meta answered the upload without a media id.', false, null, null);
      }
      const sent = (await this.json(`${this.root()}/${sender}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${request.token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: request.recipientId,
          type: 'audio',
          audio: request.voiceNote ? { id: mediaId, voice: true } : { id: mediaId },
        }),
      })) as { messages?: readonly { id?: unknown }[] } | null;
      return this.idOrFail(text(sent?.messages?.[0]?.id));
    }

    const form = new FormData();
    form.set('recipient', JSON.stringify({ id: request.recipientId }));
    form.set('messaging_type', 'RESPONSE');
    form.set('message', JSON.stringify({ attachment: { type: 'audio', payload: {} } }));
    form.set('filedata', audio, request.filename);
    const query = new URLSearchParams({ access_token: request.token }).toString();
    const sent = (await this.json(`${this.root()}/${sender}/messages?${query}`, {
      method: 'POST',
      body: form,
    })) as { message_id?: unknown } | null;
    return this.idOrFail(text(sent?.message_id));
  }

  // --- calls --------------------------------------------------------------------------------------

  async callAction(request: CallActionRequest): Promise<CallActionResult> {
    const sender = encodeURIComponent(request.senderId);
    const withSession = request.action === 'pre_accept' || request.action === 'accept';
    if (withSession && (request.sdp === undefined || request.sdp === '')) {
      throw new MessagingError('An answer needs the browser’s session.', false, null, null);
    }
    if (request.channel === 'whatsapp') {
      await this.json(`${this.root()}/${sender}/calls`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${request.token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          call_id: request.providerCallId,
          action: request.action,
          ...(withSession ? { session: { sdp_type: 'answer', sdp: request.sdp } } : {}),
        }),
      });
      return { sdpAnswer: null, sdpRenegotiation: null };
    }
    if (request.action === 'pre_accept') {
      // Messenger has no pre-accept: the offer goes with the accept.
      return { sdpAnswer: null, sdpRenegotiation: null };
    }
    const query = new URLSearchParams({ access_token: request.token }).toString();
    const body = (await this.json(`${this.root()}/${sender}/calls?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'messenger',
        call_id: request.providerCallId,
        action: request.action,
        ...(withSession ? { session: { sdp_type: 'offer', sdp: request.sdp } } : {}),
      }),
    })) as { session?: { sdp_response?: unknown; sdp_renegotiation?: unknown } } | null;
    const answer = text(body?.session?.sdp_response);
    const renegotiation = text(body?.session?.sdp_renegotiation);
    return {
      sdpAnswer: answer === '' ? null : answer,
      sdpRenegotiation: renegotiation === '' ? null : renegotiation,
    };
  }

  // --- plumbing -----------------------------------------------------------------------------------

  private idOrFail(id: string): { readonly providerMessageId: string } {
    if (id === '') {
      throw new MessagingError('Meta answered without a message id.', false, null, null);
    }
    return { providerMessageId: id };
  }

  private unreachable(cause: unknown): MessagingError {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    return new MessagingError(
      timedOut ? 'Meta did not answer in time.' : 'Meta could not be reached.',
      true,
      null,
      null,
    );
  }

  /** One Graph call answering JSON. Never lets the URL — which may hold a token — into an error. */
  private async json(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        // Graph answers; it never sends us elsewhere, so a redirect is a failure, not followed.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      throw this.unreachable(cause);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = (body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
      const code = typeof error?.code === 'number' ? error.code : null;
      throw new MessagingError(
        `Meta refused the request (HTTP ${String(response.status)}${
          code === null ? '' : `, code ${String(code)}`
        }): ${text(error?.message).slice(0, 300) || 'no message'}`,
        response.status >= 500 || response.status === 429,
        response.status,
        code,
      );
    }
    return body;
  }
}
