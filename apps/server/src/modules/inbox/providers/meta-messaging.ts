import { randomUUID } from 'node:crypto';

import type { InboxChannelKind } from '@elysium/domain/inbox';

/**
 * Sending a text reply through Meta (M42, D-731). UNVERIFIED: built from Meta's documentation
 * read on 2026-10-11 and never run against Meta (Unverified integrations in decisions.md).
 *
 * - **Messenger** (Messenger Platform, "Send a message"): `POST
 *   https://graph.facebook.com/v25.0/{PAGE-ID}/messages?access_token={PAGE-ACCESS-TOKEN}` with
 *   `{"recipient":{"id":"<PSID>"},"messaging_type":"RESPONSE","message":{"text":"…"}}`; the answer
 *   is `{"recipient_id":"…","message_id":"…"}`.
 * - **Instagram** through the Messenger API for Instagram: "You send messages using the same
 *   /<PAGE_ID>/messages endpoint as Messenger, using the Instagram-scoped ID (IGSID) as the
 *   recipient", with the Page's token, so the same request with the IGSID.
 * - **WhatsApp** (Cloud API, "Service messages"): `POST
 *   https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/messages` with `Authorization: Bearer …`
 *   and `{"messaging_product":"whatsapp","recipient_type":"individual","to":"…","type":"text",
 *   "text":{"preview_url":false,"body":"…"}}`; the answer carries `messages[0].id` (a `wamid`).
 *
 * A token is never put in an error, a log line or a thrown message: the Messenger URL carries
 * it, so no URL is ever repeated either.
 */

export interface SendTextRequest {
  readonly channel: InboxChannelKind;
  /** Messenger and Instagram: the Facebook Page's id. WhatsApp: the phone number id. */
  readonly senderId: string;
  readonly token: string;
  /** The PSID, IGSID or wa_id the message goes to. */
  readonly recipientId: string;
  readonly text: string;
}

export interface SendTextResult {
  /** Meta's id for the message (`mid`, `wamid`), which its receipts name. */
  readonly providerMessageId: string;
}

export class MessagingError extends Error {
  constructor(
    message: string,
    /** Worth trying again later: no answer, a timeout, a 5xx or a 429. */
    readonly retryable: boolean,
    readonly status: number | null,
    readonly metaCode: number | null,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}

export interface MessagingGateway {
  /** `graph` or `fake`, shown in Settings → Inbox so nobody mistakes one for the other. */
  readonly provider: 'graph' | 'fake';
  sendText(request: SendTextRequest): Promise<SendTextResult>;
}

export const MESSAGING_GATEWAY = Symbol('MessagingGateway');

/** Records what would have been sent. The default everywhere until the adapter is verified. */
export class FakeMessagingGateway implements MessagingGateway {
  readonly provider = 'fake' as const;
  readonly sent: SendTextRequest[] = [];
  /** Set to make the next send fail, once. */
  failNext: MessagingError | null = null;

  sendText(request: SendTextRequest): Promise<SendTextResult> {
    if (this.failNext !== null) {
      const failure = this.failNext;
      this.failNext = null;
      return Promise.reject(failure);
    }
    this.sent.push(request);
    const prefix = request.channel === 'whatsapp' ? 'wamid.fake' : 'm_fake';
    return Promise.resolve({ providerMessageId: `${prefix}.${randomUUID()}` });
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GraphMessagingOptions {
  readonly baseUrl: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
  /** Injected so the adapter is tested against a stand-in, never against Meta. */
  readonly fetch?: Fetch;
}

interface GraphErrorBody {
  readonly error?: { readonly message?: unknown; readonly code?: unknown };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export class GraphMessagingGateway implements MessagingGateway {
  readonly provider = 'graph' as const;
  private readonly fetch: Fetch;

  constructor(private readonly options: GraphMessagingOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
  }

  private root(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/${this.options.apiVersion}`;
  }

  async sendText(request: SendTextRequest): Promise<SendTextResult> {
    const sender = encodeURIComponent(request.senderId);
    if (request.channel === 'whatsapp') {
      const body = await this.call(`${this.root()}/${sender}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${request.token}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: request.recipientId,
          type: 'text',
          text: { preview_url: false, body: request.text },
        }),
      });
      const messages = (body as { messages?: readonly { id?: unknown }[] } | null)?.messages;
      return this.idOrFail(text(messages?.[0]?.id));
    }

    const query = new URLSearchParams({ access_token: request.token }).toString();
    const body = await this.call(`${this.root()}/${sender}/messages?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: request.recipientId },
        messaging_type: 'RESPONSE',
        message: { text: request.text },
      }),
    });
    return this.idOrFail(text((body as { message_id?: unknown } | null)?.message_id));
  }

  private idOrFail(id: string): SendTextResult {
    if (id === '') {
      // Accepted, but with no id to match its receipts against: recorded as sent by us anyway
      // would be a guess, so it is a failure a person can look at.
      throw new MessagingError('Meta answered without a message id.', false, null, null);
    }
    return { providerMessageId: id };
  }

  /** One call. Never lets the URL — which holds a Messenger token — into an error. */
  private async call(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new MessagingError(
        timedOut ? 'Meta did not answer in time.' : 'Meta could not be reached.',
        true,
        null,
        null,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const error = (body as GraphErrorBody | null)?.error;
      const code = typeof error?.code === 'number' ? error.code : null;
      throw new MessagingError(
        `Meta refused the message (HTTP ${String(response.status)}${
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
