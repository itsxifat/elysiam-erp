import { isNormalizableBdPhone, normalizeBdPhone, type E164Phone } from '../orders/phone.js';

/**
 * Envo, the owner's own SIP and calling service (M47, D-830 to D-853), as far as its API, its
 * webhooks and its embedded phone are pure rules. Built from Envo's source (`server/src/routes/
 * v1.ts`, `server/src/webhooks.ts`, `web/embed/phone.ts`), unverified against the live service.
 *
 * Nothing here talks to Envo or reads a clock; the server module calls these with what it
 * received and what time it is.
 */

/** The events Envo's webhooks send (`CALL_EVENTS` in Envo's `webhooks.ts`). */
export const ENVO_EVENTS = ['call.started', 'call.answered', 'call.ended'] as const;
export type EnvoEvent = (typeof ENVO_EVENTS)[number];

export function isEnvoEvent(value: unknown): value is EnvoEvent {
  return typeof value === 'string' && (ENVO_EVENTS as readonly string[]).includes(value);
}

/** Envo's directions (its CDR's `direction`), and ours for a call it has not described yet. */
export const PHONE_CALL_DIRECTIONS = ['inbound', 'outbound', 'internal', 'unknown'] as const;
export type PhoneCallDirection = (typeof PHONE_CALL_DIRECTIONS)[number];

/**
 * How a call ended, normalised (the integration rule: one table per provider, a test per entry).
 * Envo reports Asterisk's CDR disposition lower-cased (`serializeCall` and `announceEnd`):
 * `answered`, `no answer`, `busy`, `failed`, `congestion`. Anything else is `unknown`.
 */
export const PHONE_CALL_DISPOSITIONS = [
  'answered',
  'no_answer',
  'busy',
  'failed',
  'congestion',
  'unknown',
] as const;
export type PhoneCallDisposition = (typeof PHONE_CALL_DISPOSITIONS)[number];

export const ENVO_DISPOSITIONS: Readonly<Record<string, PhoneCallDisposition>> = {
  answered: 'answered',
  'no answer': 'no_answer',
  busy: 'busy',
  failed: 'failed',
  congestion: 'congestion',
};

export function dispositionFromEnvo(value: unknown): PhoneCallDisposition | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return 'unknown';
  return ENVO_DISPOSITIONS[value.trim().toLowerCase()] ?? 'unknown';
}

export function directionFromEnvo(value: unknown): PhoneCallDirection {
  return value === 'inbound' || value === 'outbound' || value === 'internal' ? value : 'unknown';
}

/** An Envo extension number: two to eight digits (`v1.ts`'s `from` rule). */
export function isExtensionNumber(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9]{2,8}$/.test(value);
}

/**
 * The number Envo dials for a customer (D-833): the national eleven digits, `01712345678`, as
 * Envo's own "Bangladesh mobile" outbound route (`01[3-9]XXXXXXXX`) and every example in its
 * Developers page write it. The ERP keeps phones as E.164 (`+8801712345678`).
 */
export function envoDialNumber(phone: string): string {
  const e164 = normalizeBdPhone(phone);
  return `0${e164.slice(4)}`;
}

/** A number Envo sent, as a customer's E.164 phone, or null when it is not a BD mobile. */
export function customerPhoneFrom(raw: string | null | undefined): E164Phone | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return isNormalizableBdPhone(raw) ? normalizeBdPhone(raw) : null;
}

/**
 * A number from Envo as the ERP stores it (D-833): a Bangladeshi mobile as E.164, anything else
 * (an extension, a landline, a short code, `anonymous`) as Envo wrote it when it is digits, `+`,
 * `*` and `#` (`v1.ts`'s own rule), else nothing.
 */
export function storedNumber(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const mobile = customerPhoneFrom(trimmed);
  if (mobile !== null) return mobile;
  return /^\+?[0-9*#]{1,32}$/.test(trimmed) ? trimmed : null;
}

/**
 * The customer's side of a call: the caller of an inbound call, the number dialled on an
 * outbound one, nobody on an internal one. A call Envo has not described yet (`unknown`, its
 * `call.started` usually is) is read by its extension: the other side of an extension; with no
 * extension on it, the one side that is a BD mobile. Two mobiles (a brand number that is a SIM
 * or a GSM gateway, called by a customer) say nothing yet, so the customer waits for Envo's
 * direction rather than being taken, once and for good, as the brand's own number.
 */
export function customerSide(input: {
  readonly direction: PhoneCallDirection;
  readonly from: string | null;
  readonly to: string | null;
}): E164Phone | null {
  switch (input.direction) {
    case 'inbound':
      return customerPhoneFrom(input.from);
    case 'outbound':
      return customerPhoneFrom(input.to);
    case 'internal':
      return null;
    case 'unknown': {
      if (isExtensionNumber(input.from)) return customerPhoneFrom(input.to);
      if (isExtensionNumber(input.to)) return customerPhoneFrom(input.from);
      const from = customerPhoneFrom(input.from);
      const to = customerPhoneFrom(input.to);
      if (from !== null && to !== null) return null;
      return from ?? to;
    }
  }
}

// --- the base URL and recordings (D-830, D-840) -----------------------------------------------

export const DEFAULT_ENVO_BASE_URL = 'https://envo.enfinito.cloud';

export type BaseUrlProblem = 'invalid' | 'not_https' | 'not_origin' | 'host_refused';

/**
 * A connection's base URL as the only origin the ERP talks to for it (D-830): `https://host` or
 * `https://host:port`, nothing after it. Refused: another scheme, a path, a query, credentials,
 * an IP literal and a host with no dot (`localhost`, a container name), because a base URL a
 * supervisor types must not turn the ERP into a way to reach its own network. `allowPlainHttp`
 * is the tests' stand-in on 127.0.0.1 (`TELEPHONY_ALLOW_PLAIN_HTTP`, refused in production).
 */
export function envoBaseUrl(
  input: string,
  options: { readonly allowPlainHttp?: boolean } = {},
):
  | { readonly ok: true; readonly origin: string }
  | { readonly ok: false; readonly problem: BaseUrlProblem } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, problem: 'invalid' };
  }
  const plain = options.allowPlainHttp === true && url.protocol === 'http:';
  if (url.protocol !== 'https:' && !plain) return { ok: false, problem: 'not_https' };
  if (url.username !== '' || url.password !== '') return { ok: false, problem: 'not_origin' };
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return { ok: false, problem: 'not_origin' };
  }
  if (!plain) {
    const host = url.hostname.toLowerCase();
    const ipLiteral = /^[0-9.]+$/.test(host) || host.startsWith('[') || host.includes(':');
    if (ipLiteral || !host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) {
      return { ok: false, problem: 'host_refused' };
    }
  }
  return { ok: true, origin: url.origin };
}

/**
 * The recording a `recordingUrl` names, when it is on the connection's own origin and is Envo's
 * recording path (`https://<host>/api/v1/recordings/<id>`, `serializeCall`), else null (D-840):
 * a link anywhere else is never fetched, whoever signed it.
 */
export function recordingIdFrom(url: unknown, baseOrigin: string): string | null {
  if (typeof url !== 'string' || url.length > 500) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== baseOrigin || parsed.username !== '' || parsed.password !== '') return null;
  const match = /^\/api\/v1\/recordings\/([1-9][0-9]{0,17})$/.exec(parsed.pathname);
  return match?.[1] ?? null;
}

// --- the signature (D-832) ----------------------------------------------------------------------

/** How old (or how far ahead) a webhook's signed timestamp may be: five minutes. */
export const ENVO_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * `X-Envo-Signature: t=<unix seconds>,v1=<hex>` (Envo's `deliver`), parsed; null when it is not
 * that shape. Several `v1` values are allowed (a rotated secret), as Stripe-style headers allow.
 */
export function parseEnvoSignature(
  header: string | undefined,
): { readonly timestamp: number; readonly signatures: readonly string[] } | null {
  if (typeof header !== 'string' || header.length > 1000) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined && /^[0-9]{1,12}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === 'v1' && value !== undefined && /^[0-9a-f]{64}$/i.test(value)) {
      signatures.push(value.toLowerCase());
    }
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

/** Whether a signed timestamp is within the tolerance of `nowSeconds`, either way. */
export function signatureFresh(
  timestamp: number,
  nowSeconds: number,
  toleranceSeconds = ENVO_SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  return Math.abs(nowSeconds - timestamp) <= toleranceSeconds;
}

// --- a call, as Envo describes it (webhooks and the call history) -------------------------------

/** One call, from a webhook body or a row of `GET /api/v1/calls`, normalised. */
export interface EnvoCallFacts {
  /** The event, or `sync` for a row of the call history (which lists finished calls only). */
  readonly event: EnvoEvent | 'sync';
  /** Envo's call id: Asterisk's `linkedid`, `1789455634.59`. */
  readonly callId: string;
  /** Envo's SIP server (its tenant) id, when the body names one. */
  readonly sipServerId: number | null;
  readonly direction: PhoneCallDirection;
  readonly from: string | null;
  readonly to: string | null;
  readonly answered: boolean | null;
  readonly disposition: PhoneCallDisposition | null;
  readonly talkSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly startedAt: Date | null;
  readonly answeredAt: Date | null;
  readonly endedAt: Date | null;
  readonly recordingUrl: string | null;
  /** Envo's "Send test" delivery (`sampleCallPayload`): acknowledged, never recorded as a call. */
  readonly test: boolean;
}

const CALL_ID = /^[0-9]{1,20}(\.[0-9]{1,10})?$/;

function stringOrNull(value: unknown, max = 64): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

function secondsOrNull(value: unknown): number | null {
  const number =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number < 86_400 * 7 ? Math.round(number) : null;
}

function instantOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

function sipServerIdOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

/**
 * A webhook body (`event` set) or a call-history row (`event` absent, read as `sync`), or null
 * when it is not a call Envo would send: no valid id, or an event the ERP does not know.
 */
export function parseEnvoCall(body: unknown, fallbackEvent?: 'sync'): EnvoCallFacts | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const event = isEnvoEvent(record.event) ? record.event : fallbackEvent;
  if (event === undefined) return null;
  const callId = typeof record.id === 'string' ? record.id.trim() : '';
  if (!CALL_ID.test(callId)) return null;
  const answered = typeof record.answered === 'boolean' ? record.answered : null;
  return {
    event,
    callId,
    sipServerId: sipServerIdOf(record.sipServer),
    direction: directionFromEnvo(record.direction),
    from: stringOrNull(record.from, 40),
    to: stringOrNull(record.to, 40),
    answered,
    disposition: dispositionFromEnvo(record.disposition),
    talkSeconds: secondsOrNull(record.talkSec),
    durationSeconds: secondsOrNull(record.durationSec),
    startedAt: instantOrNull(record.startedAt),
    answeredAt: instantOrNull(record.answeredAt),
    endedAt: instantOrNull(record.endedAt),
    recordingUrl: stringOrNull(record.recordingUrl, 500),
    test: record.test === true,
  };
}
