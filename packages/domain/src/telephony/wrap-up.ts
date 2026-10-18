import { callAttemptProblem, type CallOutcome } from '../orders/ownership.js';
import type { PhoneCallStatus } from './calls.js';
import type { PhoneCallDirection, PhoneCallDisposition } from './envo.js';

/**
 * The person's wrap-up after a call (M47, D-859): the ERP never records a call's result by
 * itself; it asks the person on the call, suggests one of M41's five results, and the person
 * chooses. What the suggestion may rest on is what Envo's data really says, read from Envo's
 * source (`server/src/asterisk/envo-lib.conf`, `server/src/services/calls.ts`,
 * `server/src/webhooks.ts`):
 *
 * - A Call button call (`first_seen = 'click'`) is Envo's `Originate` of `Local/<ext>@envo-cc`:
 *   Envo first rings the person's own phone and dials the customer only once that leg answers.
 *   Envo then describes the call by its legs together: `answered` is true and the disposition
 *   `answered` as soon as the person's own leg answered, and the talk time is the longest leg's
 *   `billsec`, the person's, which runs from their answer through the customer's ringing (up to
 *   the trunk's 120 seconds) to the hang-up. So neither says whether the customer picked up, nor
 *   whether they were busy. What does: a recording (Envo starts it on the leg that dials the
 *   customer, writes audio only while that leg is bridged, and offers a recording only when its
 *   file has audio), or a talk time longer than the customer's leg could have rung.
 * - A call the person dialled on their own phone (outbound, not a click) has one leg to the
 *   customer: its answer, busy and no-answer are the customer's.
 * - An inbound call has a person only when they answered it here (`answered()` checks Envo shows
 *   their phone talking, D-836), so `answered` is theirs with the customer.
 *
 * Anything else is unsure, and the suggestion is null: the person picks.
 */

/** How long after a call ended the console still asks for its wrap-up (D-859). */
export const WRAP_UP_ASK_HOURS = 24;

/** How many waiting wrap-ups the console is given at once, newest first. */
export const WRAP_UPS_LISTED = 20;

/** How long a wrap-up's note may be. */
export const WRAP_UP_NOTE_MAX = 1000;

/** M41's attempt keeps at most this much of the note (`call_attempts_note_length`). */
export const ATTEMPT_NOTE_MAX = 500;

/** The results whose wrap-up needs a note: what was agreed, or what to call back about. */
export const RESULTS_NEEDING_NOTE: readonly CallOutcome[] = ['reached', 'call_back'];

/**
 * On a Call button call, a talk time longer than this is more than the customer's leg could have
 * rung unanswered: Envo's trunk dial gives up after 120 seconds (`envo-dial-trunk`), and the rest
 * is the time to set the leg up.
 */
export const CALL_BUTTON_TALK_PROVES_ANSWER_SECONDS = 135;

/** What a call says about how it went, as the call row has it. */
export interface WrapUpCallFacts {
  readonly status: PhoneCallStatus;
  readonly direction: PhoneCallDirection;
  /** A Call button call (`first_seen = 'click'`): Envo rang the person's own phone first. */
  readonly callButton: boolean;
  readonly answered: boolean;
  readonly disposition: PhoneCallDisposition | null;
  readonly talkSeconds: number | null;
  /** Why a click failed or never connected (`envo_refused`, `envo_unreachable`, `not_connected`). */
  readonly errorCode: string | null;
  /** Envo named a recording on the connection's own host (`recording_url` is set). */
  readonly hasRecording: boolean;
}

/**
 * Whether a call asks for a wrap-up at all: it is over and it rang a customer. Not a click Envo
 * refused or never connected (`failed`, an error code), not a colleague's internal call, and not
 * a Call button call whose ring-back the person never picked up (Envo had not dialled the
 * customer yet). In SQL over `telephony.calls c`: `c.status = 'ended' and c.error_code is null
 * and c.direction <> 'internal' and (c.first_seen <> 'click' or c.answered)`.
 */
export function wrapUpAsked(call: WrapUpCallFacts): boolean {
  if (call.status !== 'ended' || call.errorCode !== null) return false;
  if (call.direction === 'internal') return false;
  return !call.callButton || call.answered;
}

/** The result the ERP suggests for a call's wrap-up, or null when Envo's data cannot tell. */
export function suggestWrapUp(call: WrapUpCallFacts): CallOutcome | null {
  if (!wrapUpAsked(call)) return null;
  if (call.callButton) {
    if (call.hasRecording) return 'reached';
    const talk = call.talkSeconds ?? 0;
    return talk > CALL_BUTTON_TALK_PROVES_ANSWER_SECONDS ? 'reached' : null;
  }
  if (call.direction === 'inbound') return call.answered ? 'reached' : null;
  if (call.direction !== 'outbound') return null;
  if (call.answered || call.disposition === 'answered') return 'reached';
  if (call.disposition === 'busy') return 'busy';
  if (call.disposition === 'no_answer') return 'no_answer';
  return null;
}

/** Why a person may not wrap up this call now, or null when they may. */
export type WrapUpRefusal = 'not_yours' | 'not_over' | 'not_asked' | 'wrapped_up';

export const WRAP_UP_REFUSALS: Readonly<Record<WrapUpRefusal, string>> = {
  not_yours: 'Only the person on the call wraps it up.',
  not_over: 'This call has not ended yet.',
  not_asked: 'This call never reached the customer, so there is nothing to wrap up.',
  wrapped_up: 'This call is already wrapped up.',
};

/**
 * Whether `viewerId` may wrap up this call now (D-859): the person on it, once it is over, a
 * call that asks for one (`wrapUpAsked`), and not yet wrapped up. The API's `canWrapUp` is
 * `wrapUpRefusal(...) === null`.
 */
export function wrapUpRefusal(
  call: WrapUpCallFacts & { readonly personId: string | null; readonly wrappedUp: boolean },
  viewerId: string,
): WrapUpRefusal | null {
  if (call.personId === null || call.personId !== viewerId) return 'not_yours';
  if (call.wrappedUp) return 'wrapped_up';
  if (call.status !== 'ended') return 'not_over';
  return wrapUpAsked(call) ? null : 'not_asked';
}

/**
 * What is wrong with a wrap-up as given, or null when it can be written: the note's length, a
 * note for `reached` and `call_back` (two characters at least), and M41's call-back rules (only,
 * and always, for `call_back`; not in the past; at most 30 days ahead).
 */
export function wrapUpInputProblem(input: {
  readonly result: CallOutcome;
  readonly note: string | null;
  readonly callBackAt: Date | null;
  readonly now: Date;
}): string | null {
  const note = wrapUpNoteOf(input.note) ?? '';
  if (note.length > WRAP_UP_NOTE_MAX) return 'Keep the note to 1,000 characters.';
  if (RESULTS_NEEDING_NOTE.includes(input.result) && note.length < 2) {
    return input.result === 'call_back'
      ? 'Say what to call back about.'
      : 'Say what the call was about, or what was agreed.';
  }
  return callAttemptProblem({
    outcome: input.result,
    callBackAt: input.callBackAt,
    now: input.now,
  });
}

/** The note as it is kept: trimmed, and null when nothing is left. */
export function wrapUpNoteOf(note: string | null | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** The note as M41's attempt on the order keeps it: its first 500 characters, or none. */
export function attemptNoteOf(note: string | null | undefined): string | undefined {
  const kept = wrapUpNoteOf(note);
  if (kept === null) return undefined;
  return kept.length <= ATTEMPT_NOTE_MAX ? kept : `${kept.slice(0, ATTEMPT_NOTE_MAX - 1)}…`;
}
