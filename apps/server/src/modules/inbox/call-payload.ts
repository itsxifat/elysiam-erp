import type { InboxChannelKind } from '@elysium/domain/inbox';

/**
 * Meta's call webhooks, read into what the inbox records (M45, D-784). UNVERIFIED: built from
 * Meta's pages read 2026-10-12 and never run against real traffic.
 *
 * - **WhatsApp** (Cloud API Calling, "User-initiated calls" and "API and Webhook Reference";
 *   developers.facebook.com/documentation/business-messaging/whatsapp/calling/): an
 *   `object: "whatsapp_business_account"` body whose `entry[].changes[]` has `field: "calls"`,
 *   with `value.metadata.phone_number_id`, `value.contacts[]` (`profile.name`, `wa_id`) and
 *   `value.calls[]`: `id` (`wacid.…`), `from` (the caller's number), `to`, `event` (`connect` or
 *   `terminate`), `direction` (`USER_INITIATED` or `BUSINESS_INITIATED`), `timestamp` (seconds,
 *   as a string), on `connect` a `session` with `sdp_type: "offer"` and the RFC 8866 `sdp`, and on
 *   `terminate` a `status` (`Completed` or `Failed`, an array in the examples), `start_time`,
 *   `end_time`, `duration` (seconds) and, for a failed call, `errors[]`.
 * - **Messenger** (Messenger Platform › Calling › Calling webhooks;
 *   developers.facebook.com/documentation/business-messaging/messenger-platform/calling/webhooks):
 *   an `object: "page"` body whose `entry[]` (`id` = the Page) carries `calls[]`: `id`, `to` (the
 *   Page), `from` (the caller's PSID), `event` (`connect`, `terminate`, and for calls the
 *   business placed `call_status` and `media_update`), `timestamp` (seconds), `call_direction`
 *   (`user_initiated` or `business_initiated`), and on `terminate` `status` (`Completed` or
 *   `Failed`), `start_time`, `end_time`, `duration`.
 * - **Instagram**: Meta documents no calling API for Instagram, so nothing is read.
 *
 * Only calls a person placed to the brand are read; the business-initiated events (`call_status`,
 * `media_update`, WhatsApp's call `statuses`) are skipped. Every string is length-capped.
 */

export interface CallConnectEvent {
  readonly kind: 'call_connect';
  readonly channel: Extract<InboxChannelKind, 'messenger' | 'whatsapp'>;
  /** The Page id or the WhatsApp phone number id. */
  readonly accountId: string;
  /** The caller's PSID or wa_id. */
  readonly userId: string;
  readonly providerCallId: string;
  /** WhatsApp's SDP offer; null for Messenger, where the business makes the offer. */
  readonly offerSdp: string | null;
  readonly occurredAt: Date;
  readonly profileName: string | null;
}

export interface CallTerminateEvent {
  readonly kind: 'call_terminate';
  readonly channel: Extract<InboxChannelKind, 'messenger' | 'whatsapp'>;
  readonly accountId: string;
  /** The caller, when Meta named them (WhatsApp does; Messenger's terminate does not). */
  readonly userId: string | null;
  readonly providerCallId: string;
  readonly status: 'completed' | 'failed' | null;
  readonly durationSeconds: number | null;
  readonly endedAt: Date;
  /** Meta's error code on a failed call (`meta:138021`). */
  readonly errorCode: string | null;
  readonly profileName: string | null;
}

export type CallEvent = CallConnectEvent | CallTerminateEvent;

export interface ParsedCalls {
  readonly events: readonly CallEvent[];
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

/** Meta's call timestamps are Unix seconds, as a number or a string. */
function seconds(value: unknown, fallback: Date): Date {
  const number =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const at = new Date(number * 1000);
  return Number.isNaN(at.getTime()) ? fallback : at;
}

function wholeSeconds(value: unknown): number | null {
  const number =
    typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(number) && number >= 0 && number < 86_400 * 7 ? Math.floor(number) : null;
}

/** `Completed` or `Failed`, given as a string or (WhatsApp's examples) an array of one. */
function endStatus(value: unknown): 'completed' | 'failed' | null {
  const raw: unknown = Array.isArray(value) ? (value as unknown[])[0] : value;
  const text = str(raw, 20)?.toLowerCase() ?? null;
  return text === 'completed' || text === 'failed' ? text : null;
}

/** An SDP offer: RFC 8866 text, starting `v=0`, capped. Anything else is not kept. */
function sdpOf(session: unknown): string | null {
  if (!isObject(session)) return null;
  if (str(session.sdp_type, 20) !== 'offer') return null;
  const sdp = typeof session.sdp === 'string' ? session.sdp : null;
  return sdp !== null && sdp.startsWith('v=0') && sdp.length <= 16_000 ? sdp : null;
}

function inbound(direction: unknown): boolean {
  const text = str(direction, 40)?.toLowerCase() ?? 'user_initiated';
  return text === 'user_initiated';
}

function whatsAppCalls(body: Json, now: Date): ParsedCalls {
  const events: CallEvent[] = [];
  let skipped = 0;
  for (const entry of list(body.entry).filter(isObject)) {
    for (const change of list(entry.changes).filter(isObject)) {
      if (change.field !== 'calls' || !isObject(change.value)) continue;
      const value = change.value;
      const metadata = isObject(value.metadata) ? value.metadata : {};
      const accountId = id(metadata.phone_number_id);
      const names = new Map<string, string>();
      for (const contact of list(value.contacts).filter(isObject)) {
        const waId = id(contact.wa_id);
        const name = isObject(contact.profile) ? str(contact.profile.name, 200) : null;
        if (waId !== null && name !== null) names.set(waId, name);
      }
      for (const call of list(value.calls).filter(isObject)) {
        const providerCallId = id(call.id);
        const event = str(call.event, 40);
        const from = id(call.from);
        if (accountId === null || providerCallId === null || !inbound(call.direction)) {
          skipped += 1;
          continue;
        }
        if (event === 'connect' && from !== null) {
          events.push({
            kind: 'call_connect',
            channel: 'whatsapp',
            accountId,
            userId: from,
            providerCallId,
            offerSdp: sdpOf(call.session),
            occurredAt: seconds(call.timestamp, now),
            profileName: names.get(from) ?? null,
          });
        } else if (event === 'terminate') {
          const first = list(call.errors).find(isObject);
          events.push({
            kind: 'call_terminate',
            channel: 'whatsapp',
            accountId,
            userId: from,
            providerCallId,
            status: endStatus(call.status),
            durationSeconds: wholeSeconds(call.duration),
            endedAt: seconds(call.end_time ?? call.timestamp, now),
            errorCode: first === undefined ? null : `meta:${str(first.code, 20) ?? 'unknown'}`,
            profileName: from === null ? null : (names.get(from) ?? null),
          });
        } else {
          skipped += 1;
        }
      }
    }
  }
  return { events, skipped };
}

function messengerCalls(body: Json, now: Date): ParsedCalls {
  const events: CallEvent[] = [];
  let skipped = 0;
  for (const entry of list(body.entry).filter(isObject)) {
    const accountId = id(entry.id);
    for (const call of list(entry.calls).filter(isObject)) {
      const providerCallId = id(call.id);
      const event = str(call.event, 40);
      const from = id(call.from);
      if (accountId === null || providerCallId === null) {
        skipped += 1;
        continue;
      }
      if (event === 'connect' && from !== null && inbound(call.call_direction)) {
        events.push({
          kind: 'call_connect',
          channel: 'messenger',
          accountId,
          userId: from,
          providerCallId,
          offerSdp: null,
          occurredAt: seconds(call.timestamp, now),
          profileName: null,
        });
      } else if (event === 'terminate') {
        events.push({
          kind: 'call_terminate',
          channel: 'messenger',
          accountId,
          userId: from,
          providerCallId,
          status: endStatus(call.status),
          durationSeconds: wholeSeconds(call.duration),
          endedAt: seconds(call.end_time ?? call.timestamp, now),
          errorCode: null,
          profileName: null,
        });
      } else {
        skipped += 1;
      }
    }
  }
  return { events, skipped };
}

/** The calls in a body Meta signed. Never throws: an unknown shape reads as no calls. */
export function parseCallWebhook(body: unknown, now: Date = new Date()): ParsedCalls {
  if (!isObject(body)) return { events: [], skipped: 0 };
  if (body.object === 'whatsapp_business_account') return whatsAppCalls(body, now);
  if (body.object === 'page') return messengerCalls(body, now);
  return { events: [], skipped: 0 };
}
