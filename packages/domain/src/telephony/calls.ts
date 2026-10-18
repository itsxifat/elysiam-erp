import type { E164Phone } from '../orders/phone.js';
import {
  customerPhoneFrom,
  isExtensionNumber,
  storedNumber,
  type EnvoCallFacts,
  type EnvoEvent,
  type PhoneCallDirection,
  type PhoneCallDisposition,
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
export function answeredAfter(
  current: boolean,
  facts: Pick<EnvoCallFacts, 'event' | 'answered'>,
): boolean {
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
 * to a click within the window. Envo rings the click's own extension first (`"name" <ext>`), so:
 *
 * - an inbound or internal call is never a click's;
 * - a call that names an extension (`from` or `to`) belongs only to a click of that extension,
 *   and never to one whose extension is not the caller when the caller is an extension: another
 *   person's desk-phone call to the same customer, or a colleague ringing the clicking agent,
 *   is never theirs;
 * - among one person's clicks (two Calls a few seconds apart), the one whose customer number is
 *   also on the call wins; a call that names a customer's mobile no click of theirs is to (the
 *   person dialling someone else on the desk phone meanwhile) is a call of its own; a call that
 *   names no mobile takes the newest click made at or before the call started, then one made
 *   just after it (clock skew), the closest first;
 * - a call that names no extension is matched by the customer number alone only when Envo says
 *   it went out: a call of unknown direction from a customer's mobile is the customer calling
 *   back, not the click.
 */
export function matchClick(
  pending: readonly PendingClick[],
  call: Pick<EnvoCallFacts, 'from' | 'to' | 'direction'>,
  now: Date,
): PendingClick | null {
  if (call.direction === 'inbound' || call.direction === 'internal') return null;
  const numbers = [call.from, call.to].filter((value): value is string => value !== null);
  const phones = new Set(
    numbers
      .map((value) => customerPhoneFrom(value))
      .filter((phone): phone is E164Phone => phone !== null),
  );
  const extensions = new Set(numbers.filter((value) => isExtensionNumber(value)));
  // The click's own call names its extension as the caller (Envo's originate sets it so).
  const caller = call.from !== null && isExtensionNumber(call.from) ? call.from : null;
  const age = (click: PendingClick) => now.getTime() - click.requestedAt.getTime();
  const inWindow = pending
    .filter((click) => age(click) >= -5_000 && age(click) <= CLICK_TO_CALL_MATCH_MS)
    .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
  const onNumber = (click: PendingClick) => phones.has(click.toE164 as E164Phone);

  if (extensions.size > 0) {
    const theirs = inWindow.filter(
      (click) => extensions.has(click.extension) && (caller === null || caller === click.extension),
    );
    const named = theirs.find(onNumber);
    if (named !== undefined) return named;
    if (phones.size > 0) return null;
    return (
      theirs.find((click) => age(click) >= 0) ??
      [...theirs].sort((a, b) => age(b) - age(a))[0] ??
      null
    );
  }
  if (call.direction !== 'outbound') return null;
  return inWindow.find(onNumber) ?? null;
}

/**
 * A click Envo took but never described, after this long, is closed as not connected, unless
 * Envo still shows a call in progress on its extension (a long call whose webhooks were lost).
 */
export const CLICK_TO_CALL_STALE_MS = 15 * 60_000;

// --- what a word from Envo moves on a call (D-837) -----------------------------------------------

/** The parts of a call Envo's word may move, as the call has them now. */
export interface PhoneCallProgressState {
  readonly status: PhoneCallStatus;
  readonly answered: boolean;
  readonly direction: PhoneCallDirection;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  readonly disposition: PhoneCallDisposition | null;
  readonly talkSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly startedAt: Date | null;
  readonly answeredAt: Date | null;
  readonly endedAt: Date | null;
}

export type PhoneCallProgressChange = {
  -readonly [K in keyof PhoneCallProgressState]?: PhoneCallProgressState[K];
};

/**
 * What this word from Envo moves on the call, each part only when it may (D-837): the status
 * furthest along, answered once answered, the direction once known, the numbers until it ends.
 *
 * Envo measures `talkSec` and `durationSec` when it sends each event, and sends each event on its
 * own with retries, so a `call.started` or `call.answered` (talk 0, a second or two long) can
 * arrive after `call.ended`, and a history row cut by the sync's window can describe one leg of
 * the call. So the seconds never go down, and once the call is over only `call.ended` and the
 * history may raise them. Disposition: the first one said, replaced by `call.ended`'s (Envo's
 * own word at the end) and by `answered` (a call that was answered stays so), never by a
 * history row's or an earlier event's other one.
 *
 * Times: the start, the answer and the end are set once. A history row says no answer or end
 * time: the end is the start plus the duration, and the answer the end less the talk time
 * (Asterisk's `billsec` runs from the answer to the hangup); never the time the sync ran, which
 * could fall after the end. Unknown, it is left unset.
 */
export function phoneCallProgress(
  current: PhoneCallProgressState,
  facts: EnvoCallFacts,
  now: Date,
): PhoneCallProgressChange {
  const change: PhoneCallProgressChange = {};
  const status = phoneCallStatusAfter(current.status, facts.event);
  if (status !== current.status) change.status = status;
  const answered = answeredAfter(current.answered, facts);
  if (answered !== current.answered) change.answered = answered;
  if (current.direction === 'unknown' && facts.direction !== 'unknown') {
    change.direction = facts.direction;
  }

  const wasEnded = current.status === 'ended';
  const from = storedNumber(facts.from);
  const to = storedNumber(facts.to);
  if (from !== null && from !== current.fromNumber && (!wasEnded || current.fromNumber === null)) {
    change.fromNumber = from;
  }
  if (to !== null && to !== current.toNumber && (!wasEnded || current.toNumber === null)) {
    change.toNumber = to;
  }

  const final = facts.event === 'call.ended' || facts.event === 'sync';
  if (facts.disposition !== null && facts.disposition !== current.disposition) {
    const replaces =
      current.disposition === null ||
      facts.disposition === 'answered' ||
      (facts.event === 'call.ended' && current.disposition !== 'answered');
    if (replaces) change.disposition = facts.disposition;
  }
  const seconds = (said: number | null, kept: number | null): number | null => {
    if (said === null) return null;
    if (wasEnded && !final) return null;
    return kept === null || said > kept ? said : null;
  };
  const talk = seconds(facts.talkSeconds, current.talkSeconds);
  if (talk !== null) change.talkSeconds = talk;
  const duration = seconds(facts.durationSeconds, current.durationSeconds);
  if (duration !== null) change.durationSeconds = duration;

  const startedAt = current.startedAt ?? facts.startedAt ?? now;
  if (current.startedAt === null) change.startedAt = startedAt;
  const derivedEnd =
    facts.endedAt ??
    (facts.startedAt !== null && facts.durationSeconds !== null
      ? new Date(facts.startedAt.getTime() + facts.durationSeconds * 1000)
      : null);
  if (current.answeredAt === null && answered) {
    if (facts.answeredAt !== null) change.answeredAt = facts.answeredAt;
    else if (final) {
      const talked = facts.talkSeconds ?? current.talkSeconds;
      const end = derivedEnd ?? current.endedAt;
      if (end !== null && talked !== null) {
        const at = new Date(end.getTime() - talked * 1000);
        change.answeredAt = at < startedAt ? startedAt : at;
      }
    } else change.answeredAt = now;
  }
  if (current.endedAt === null && status === 'ended') {
    change.endedAt = derivedEnd ?? now;
  }
  return change;
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
