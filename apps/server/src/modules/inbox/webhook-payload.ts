import {
  mapWhatsAppStatus,
  type InboxChannelKind,
  type OutboundStatus,
} from '@elysium/domain/inbox';

/**
 * Meta's webhook bodies, read into what the inbox records (M42, D-731, D-735, D-744, D-745).
 *
 * Built from Meta's pages read 2026-10-11 and UNVERIFIED against real traffic:
 *
 * - **Messenger** (`object: "page"`; Messenger Platform › Webhooks, the `messages`,
 *   `message_deliveries`, `message_reads` and `message_echoes` events): `entry[].id` is the
 *   Page; each `entry[].messaging[]` has `sender.id`, `recipient.id`, `timestamp` (ms) and one of
 *   `message` (`mid`, `text`, `attachments[]` of `{type, payload: {url}}`, `is_echo`),
 *   `delivery` (`mids[]` sometimes, `watermark` always) or `read` (`watermark`).
 * - **Instagram** through the Messenger API (`object: "instagram"`; Instagram messaging
 *   webhooks): `entry[].id` is the Instagram account, `messaging[]` as above with the IGSID as
 *   the sender; echoes arrive as `messages` with `is_echo`; `messaging_seen` as `read`.
 * - **WhatsApp** (`object: "whatsapp_business_account"`; Cloud API webhooks): each
 *   `entry[].changes[]` with `field: "messages"` has `value.metadata.phone_number_id`,
 *   `value.contacts[]` (`profile.name`, `wa_id`), `value.messages[]` (`from`, `id`, `timestamp`
 *   in seconds, `type`, and `text.body` or a media object with `id`, `mime_type`, `caption`) and
 *   `value.statuses[]` (`id`, `status`, `timestamp`, `recipient_id`, `errors[]`).
 *
 * Anything else — postbacks, reactions, referrals, comments, a field this does not know — is
 * counted as skipped, never guessed at. Every string kept is length-capped; only `https` URLs
 * are kept.
 */

export type WebhookObject = 'page' | 'instagram' | 'whatsapp_business_account';

export const WEBHOOK_OBJECTS: readonly WebhookObject[] = [
  'page',
  'instagram',
  'whatsapp_business_account',
];

/** At most this many events are read from one body (Meta batches up to 1,000). */
export const MAX_EVENTS_PER_BODY = 1000;

export interface AttachmentMeta {
  readonly type: string;
  readonly url?: string;
  readonly mediaId?: string;
  readonly mimeType?: string;
  readonly caption?: string;
  readonly title?: string;
}

export interface MessageEvent {
  readonly kind: 'message';
  readonly channel: InboxChannelKind;
  /** Page id, Instagram account id or WhatsApp phone number id: which channel it is for. */
  readonly accountId: string;
  /** The person's PSID, IGSID or wa_id. */
  readonly userId: string;
  readonly providerMessageId: string;
  readonly text: string | null;
  readonly attachments: readonly AttachmentMeta[];
  readonly occurredAt: Date;
  readonly profileName: string | null;
  /** Sent by the business itself (from Meta's own inbox or another app). */
  readonly echo: boolean;
}

export interface ReceiptEvent {
  readonly kind: 'receipt';
  readonly channel: InboxChannelKind;
  readonly accountId: string;
  readonly userId: string;
  readonly status: OutboundStatus;
  /** The messages named, when Meta named them. */
  readonly providerMessageIds: readonly string[];
  /** Everything sent at or before this was delivered or read, when Meta gave one. */
  readonly watermark: Date | null;
  readonly occurredAt: Date;
  readonly error: { readonly code: string; readonly detail: string | null } | null;
}

export type WebhookEvent = MessageEvent | ReceiptEvent;

export interface ParsedWebhook {
  readonly object: WebhookObject | null;
  readonly events: readonly WebhookEvent[];
  readonly skipped: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown, max = 256): string | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, max);
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null;
};
const id = (value: unknown): string | null => {
  const text = str(value, 256);
  return text !== null && /^[A-Za-z0-9_.:=+/$-]{1,256}$/.test(text) ? text : null;
};
const https = (value: unknown): string | null => {
  const text = str(value, 2048);
  if (text === null) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
};

/** Meta's millisecond timestamps (Messenger) or second strings (WhatsApp), as a Date. */
function instant(value: unknown, unit: 'ms' | 's', fallback: Date): Date {
  const number =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const at = new Date(unit === 's' ? number * 1000 : number);
  return Number.isNaN(at.getTime()) ? fallback : at;
}

function compact(meta: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) if (value !== null) out[key] = value;
  return out;
}

function messengerAttachments(value: unknown): AttachmentMeta[] {
  return list(value)
    .filter(isObject)
    .slice(0, 10)
    .map((item) => {
      const payload = isObject(item.payload) ? item.payload : {};
      return compact({
        type: str(item.type, 40) ?? 'unknown',
        url: https(payload.url),
        title: str(payload.title, 200),
      }) as unknown as AttachmentMeta;
    });
}

/** Messenger and Instagram: `entry[].messaging[]`. */
function parseMessaging(
  body: Json,
  channel: 'messenger' | 'instagram',
  now: Date,
): { events: WebhookEvent[]; skipped: number } {
  const events: WebhookEvent[] = [];
  let skipped = 0;
  for (const entry of list(body.entry).filter(isObject)) {
    const accountId = id(entry.id);
    for (const item of list(entry.messaging).filter(isObject)) {
      if (events.length >= MAX_EVENTS_PER_BODY) return { events, skipped: skipped + 1 };
      const sender = isObject(item.sender) ? id(item.sender.id) : null;
      const recipient = isObject(item.recipient) ? id(item.recipient.id) : null;
      const occurredAt = instant(item.timestamp, 'ms', now);
      if (accountId === null || sender === null) {
        skipped += 1;
        continue;
      }
      if (isObject(item.message)) {
        const message = item.message;
        const echo = message.is_echo === true;
        const mid = id(message.mid);
        // An echo is from the business to the person: the person is the recipient.
        const userId = echo ? recipient : sender;
        if (mid === null || userId === null || message.is_deleted === true) {
          skipped += 1;
          continue;
        }
        const text = str(message.text, 4096);
        const attachments = messengerAttachments(message.attachments);
        if (text === null && attachments.length === 0 && message.is_unsupported !== true) {
          skipped += 1;
          continue;
        }
        events.push({
          kind: 'message',
          channel,
          accountId,
          userId,
          providerMessageId: mid,
          text,
          attachments:
            message.is_unsupported === true && attachments.length === 0
              ? [{ type: 'unsupported' }]
              : attachments,
          occurredAt,
          profileName: null,
          echo,
        });
        continue;
      }
      const delivery = isObject(item.delivery) ? item.delivery : null;
      const read = isObject(item.read) ? item.read : null;
      const receipt = delivery ?? read;
      if (receipt !== null) {
        const mids = list(receipt.mids)
          .map(id)
          .filter((value): value is string => value !== null);
        const single = id(receipt.mid);
        if (single !== null) mids.push(single);
        const watermark =
          receipt.watermark === undefined ? null : instant(receipt.watermark, 'ms', now);
        if (mids.length === 0 && watermark === null) {
          skipped += 1;
          continue;
        }
        events.push({
          kind: 'receipt',
          channel,
          accountId,
          userId: sender,
          status: delivery !== null ? 'delivered' : 'read',
          providerMessageIds: mids,
          watermark,
          occurredAt,
          error: null,
        });
        continue;
      }
      skipped += 1;
    }
  }
  return { events, skipped };
}

const WHATSAPP_MEDIA = ['image', 'audio', 'video', 'document', 'sticker'] as const;

function whatsAppMessage(
  message: Json,
): { text: string | null; attachments: AttachmentMeta[] } | null {
  const type = str(message.type, 40);
  if (type === 'text') {
    const text = isObject(message.text) ? str(message.text.body, 4096) : null;
    return text === null ? null : { text, attachments: [] };
  }
  if (type !== null && (WHATSAPP_MEDIA as readonly string[]).includes(type)) {
    const raw = message[type];
    const media: Json = isObject(raw) ? raw : {};
    const caption = str(media.caption, 1024);
    return {
      text: caption,
      attachments: [
        compact({
          type,
          mediaId: id(media.id),
          mimeType: str(media.mime_type, 100),
          caption,
          title: str(media.filename, 200),
          url: https(media.url),
        }) as unknown as AttachmentMeta,
      ],
    };
  }
  // A reaction is not a message, and a type this does not know is not guessed at.
  if (type === null || type === 'reaction') return null;
  return { text: null, attachments: [{ type }] };
}

/** WhatsApp: `entry[].changes[]` with `field: "messages"`. */
function parseWhatsApp(body: Json, now: Date): { events: WebhookEvent[]; skipped: number } {
  const events: WebhookEvent[] = [];
  let skipped = 0;
  for (const entry of list(body.entry).filter(isObject)) {
    for (const change of list(entry.changes).filter(isObject)) {
      if (change.field !== 'messages' || !isObject(change.value)) {
        skipped += 1;
        continue;
      }
      const value = change.value;
      const metadata = isObject(value.metadata) ? value.metadata : {};
      const accountId = id(metadata.phone_number_id);
      if (accountId === null) {
        skipped += 1;
        continue;
      }
      const names = new Map<string, string>();
      for (const contact of list(value.contacts).filter(isObject)) {
        const waId = id(contact.wa_id);
        const name = isObject(contact.profile) ? str(contact.profile.name, 200) : null;
        if (waId !== null && name !== null) names.set(waId, name);
      }
      for (const message of list(value.messages).filter(isObject)) {
        if (events.length >= MAX_EVENTS_PER_BODY) return { events, skipped: skipped + 1 };
        const from = id(message.from);
        const wamid = id(message.id);
        const content = whatsAppMessage(message);
        if (from === null || wamid === null || content === null) {
          skipped += 1;
          continue;
        }
        events.push({
          kind: 'message',
          channel: 'whatsapp',
          accountId,
          userId: from,
          providerMessageId: wamid,
          text: content.text,
          attachments: content.attachments,
          occurredAt: instant(message.timestamp, 's', now),
          profileName: names.get(from) ?? null,
          echo: false,
        });
      }
      for (const status of list(value.statuses).filter(isObject)) {
        if (events.length >= MAX_EVENTS_PER_BODY) return { events, skipped: skipped + 1 };
        const wamid = id(status.id);
        const recipient = id(status.recipient_id);
        const mapped = mapWhatsAppStatus(str(status.status, 40) ?? '');
        if (wamid === null || recipient === null || mapped === null) {
          skipped += 1;
          continue;
        }
        const first = list(status.errors).find(isObject);
        const errorData = first !== undefined && isObject(first.error_data) ? first.error_data : {};
        events.push({
          kind: 'receipt',
          channel: 'whatsapp',
          accountId,
          userId: recipient,
          status: mapped,
          providerMessageIds: [wamid],
          watermark: null,
          occurredAt: instant(status.timestamp, 's', now),
          error:
            mapped === 'failed'
              ? {
                  code: `meta:${str(first?.code, 20) ?? 'unknown'}`,
                  detail: str(errorData.details, 300) ?? str(first?.title, 300),
                }
              : null,
        });
      }
    }
  }
  return { events, skipped };
}

/** Read a body Meta signed. Never throws: an unknown shape is all skipped. */
export function parseMetaWebhook(body: unknown, now: Date = new Date()): ParsedWebhook {
  if (!isObject(body)) return { object: null, events: [], skipped: 1 };
  const object = WEBHOOK_OBJECTS.find((candidate) => candidate === body.object) ?? null;
  switch (object) {
    case 'page':
      return { object, ...parseMessaging(body, 'messenger', now) };
    case 'instagram':
      return { object, ...parseMessaging(body, 'instagram', now) };
    case 'whatsapp_business_account':
      return { object, ...parseWhatsApp(body, now) };
    case null:
      return { object: null, events: [], skipped: 1 };
  }
}

/** A short, single-line preview for the conversation list. */
export function previewOf(text: string | null, attachments: readonly AttachmentMeta[]): string {
  if (text !== null && text.trim() !== '') return text.replace(/\s+/g, ' ').trim().slice(0, 140);
  const first = attachments[0];
  return first === undefined ? '' : `[${first.type}]`;
}
