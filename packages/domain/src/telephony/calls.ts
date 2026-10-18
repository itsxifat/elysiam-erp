import type { E164Phone } from '../orders/phone.js';
import {
  customerPhoneFrom,
  isExtensionNumber,
  type EnvoCallFacts,
  type EnvoEvent,
} from './envo.js';

/**
 * A phone call's place in its life (M47, D-837), from the ERP's click to Envo's last word.
 *
 * - `requested`: a person pressed Call; Envo has not been asked yet (the row is written first).
 * - `dialing`: Envo took the request (`202`) and is ringing the person's own phone.
 * - `failed`: Envo refused the request or could not be reached. Over; no call happened.
 * - `ringing`: Envo announced the call (`call.started`).
 * - `answered`: two parties are talking (`call.answered`).
 * - `ended`: Envo's `call.ended`, or the call history (the sync) listing it. Over; only its
 *   numbers (talk time, duration, recording) may still be learned.
 *
 * Webhooks arrive late, twice and out of order, and the sync can tell the end before any webhook,
 * so the next status is the furthest along of the current one and what the event says. `ended`
 * and `failed` never move.
 */
export const PHONE_CALL_STATUSES = [
  'requested',
  'dialing',
  'failed',
  'ringing',
  'answered',
  'ended',
] as const;
export type PhoneCallStatus = (typeof PHONE_CALL_STATUSES)[number];

const RANK: Readonly<Record<PhoneCallStatus, number>> = {
  requested: 0,
  dialing: 1,
  ringing: 2,
  answered: 3,
  ended: 4,
  failed: 4,
};

/** What each of Envo's events says about a call. */
export const EVENT_STATUS: Readonly<Record<EnvoEvent | 'sync', PhoneCallStatus>> = {
  'call.started': 'ringing',
  'call.answered': 'answered',
  'call.ended': 'ended',
  sync: 'ended',
};

export function isPhoneCallOver(status: PhoneCallStatus): boolean {
  return status === 'ended' || status === 'failed';
}

/** The status after an event: the furthest along of the two; a finished call stays finished. */
export function phoneCallStatusAfter(
  current: PhoneCallStatus | null,
  event: EnvoEvent | 'sync',
): PhoneCallStatus {
  const said = EVENT_STATUS[event];
  if (current === null) return said;
  if (isPhoneCallOver(current)) return current;
  return RANK[said] > RANK[current] ? said : current;
}

/**
 * Whether the call was answered, after an event: once answered, always answered (a later
 * `call.ended` of a call nobody picked up cannot unsay `call.answered`). Envo's `call.ended`
 * carries `answered`; `call.answered` is itself the news.
 */
export function answeredAfter(current: boolean, facts: Pick<EnvoCallFacts, 'event' | 'answered'>): boolean {
  if (current) return true;
  if (facts.event === 'call.answered') return true;
  return facts.answered === true;
}

// --- linking a call to the click that started it (D-835) ----------------------------------------

/** How long after a person's click Envo's first word about the call may still be about it. */
export const CLICK_TO_CALL_MATCH_MS = 3 * 60_000;

/** A click-to-call waiting for Envo's first word: its id, extension and number, and when. */
export interface PendingClick {
  readonly id: string;
  readonly extension: string;
  readonly toE164: string;
  readonly requestedAt: Date;
}

/**
 * The click a new call of the connection belongs to (D-835), or null. Envo's `POST /calls`
 * answers with no call id, so the first event of a call Envo has not told us about is matched
 * to the newest click within the window whose extension or customer number appears on the call
 * (`from` or `to`): Envo rings the extension from `"name" <ext>` and dials the number given, and
 * which of the two each event carries depends on where the call was when Envo described it.
 */
export function matchClick(
  pending: readonly PendingClick[],
  call: Pick<EnvoCallFacts, 'from' | 'to' | 'direction'>,
  now: Date,
): PendingClick | null {
  if (call.direction === 'inbound') return null;
  const numbers = [call.from, call.to].filter((value): value is string => value !== null);
  const phones = new Set(
    numbers.map((value) => customerPhoneFrom(value)).filter((phone): phone is E164Phone => phone !== null),
  );
  const extensions = new Set(numbers.filter((value) => isExtensionNumber(value)));
  const candidates = pending
    .filter((click) => {
      const age = now.getTime() - click.requestedAt.getTime();
      return age >= -5_000 && age <= CLICK_TO_CALL_MATCH_MS;
    })
    .filter((click) => extensions.has(click.extension) || phones.has(click.toE164 as E164Phone))
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  return candidates[0] ?? null;
}

/** A click Envo took but never described, after this long, is closed as not connected. */
export const CLICK_TO_CALL_STALE_MS = 15 * 60_000;

// --- recordings (D-840, D-842) -------------------------------------------------------------------

export const RECORDING_STATUSES = ['none', 'pending', 'stored', 'failed', 'expired'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

export const RECORDING_RETENTION_DEFAULT_DAYS = 365;
export const RECORDING_RETENTION_MIN_DAYS = 30;
export const RECORDING_RETENTION_MAX_DAYS = 3650;

/** Whether a recording kept since `endedAt` is past the connection's retention at `now`. */
export function recordingExpired(endedAt: Date, retentionDays: number, now: Date): boolean {
  return now.getTime() - endedAt.getTime() > retentionDays * 86_400_000;
}

/** Talk time as a person reads it: `0:38`, `12:05`, `1:02:09`. */
export function talkTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${ss}` : `${String(m)}:${ss}`;
}
