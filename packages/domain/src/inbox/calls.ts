import { presenceState, type PresenceFacts, type WorkType } from '../assignment/index.js';

/**
 * Calls to the brand through Meta (M45, D-784 to D-788): where an incoming call stands, what a
 * webhook or an agent's click does to it, and whose screens ring.
 *
 * WhatsApp's Calling API and Messenger's Calling API both announce a call with a `connect`
 * webhook and end it with a `terminate` webhook (`status` Completed or Failed, a `duration`
 * counted from when the business connected, empty when it never did). Between them the
 * business has about 30 to 60 seconds (WhatsApp) or 60 seconds (Messenger) to accept or reject.
 *
 * - `ringing`: announced, nobody has picked it up.
 * - `answering`: one agent claimed it and their browser is connecting (SDP exchanged with Meta).
 * - `connected`: Meta accepted the agent's answer (the accept call returned 200).
 * - `missed`, `declined`, `completed`, `failed`: over. A call nobody answered is missed; one an
 *   agent refused is declined; one that connected and ended is completed (or failed, when Meta
 *   says the connection failed mid-call).
 *
 * The terminate webhook is the last word: it can arrive while the call still rings (the caller
 * hung up, or Meta gave up), while an agent is connecting, or after the agent hung up. Events
 * arrive late, twice and out of order, so every transition is a pure function of the current
 * state, and a finished call never changes again except to learn its duration.
 */

export const CALL_STATUSES = [
  'ringing',
  'answering',
  'connected',
  'missed',
  'declined',
  'completed',
  'failed',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const FINISHED_CALL_STATUSES: readonly CallStatus[] = [
  'missed',
  'declined',
  'completed',
  'failed',
];

export function isCallFinished(status: CallStatus): boolean {
  return FINISHED_CALL_STATUSES.includes(status);
}

/** How long a call may ring before we call it missed ourselves, if Meta never says (D-786). */
export const CALL_RING_TIMEOUT_MS = 90_000;

/** What Meta's terminate webhook says about how the call ended. */
export interface CallTermination {
  /** `Completed` (it ended normally, including a refusal) or `Failed` (it broke mid-call). */
  readonly status: 'completed' | 'failed' | null;
  /** Seconds counted from when the business connected; null when it never did. */
  readonly durationSeconds: number | null;
}

/**
 * The status after Meta's terminate webhook. A call that never connected is missed, unless an
 * agent declined it; a connected call is completed, or failed when Meta says so. A call already
 * over keeps its outcome (the agent's own hang-up or refusal was recorded first).
 */
export function statusAfterTermination(
  current: CallStatus,
  termination: CallTermination,
): CallStatus {
  if (isCallFinished(current)) return current;
  if (current === 'connected') return termination.status === 'failed' ? 'failed' : 'completed';
  // Ringing or answering: Meta ended it before an accept went through. A duration means Meta
  // counted a connection we had not recorded yet (its 200 crossed the webhook): completed.
  if ((termination.durationSeconds ?? 0) > 0) return 'completed';
  return 'missed';
}

export type CallAction = 'claim' | 'release' | 'connect' | 'decline' | 'hang_up' | 'time_out';

/**
 * An agent's (or the timer's) action on a call, or null when it does not apply now.
 *
 * - `claim`: a ringing call is picked up by one agent (the conditional update makes it one).
 * - `release`: the agent's browser could not connect; it rings again for everyone.
 * - `connect`: Meta accepted the claimed call.
 * - `decline`: a ringing call is refused (Meta's reject), or a claimed one before it connected.
 * - `hang_up`: the agent ends a connected call (or gives up on one still connecting).
 * - `time_out`: our own timer, when Meta's terminate never came.
 */
export function callAfter(current: CallStatus, action: CallAction): CallStatus | null {
  switch (action) {
    case 'claim':
      return current === 'ringing' ? 'answering' : null;
    case 'release':
      return current === 'answering' ? 'ringing' : null;
    case 'connect':
      return current === 'answering' ? 'connected' : null;
    case 'decline':
      return current === 'ringing' || current === 'answering' ? 'declined' : null;
    case 'hang_up':
      if (current === 'connected') return 'completed';
      return current === 'answering' ? 'missed' : null;
    case 'time_out':
      return current === 'ringing' || current === 'answering' ? 'missed' : null;
  }
}

/** A missed call from a customer leaves a "call back" item until someone deals with it. */
export function needsCallBack(status: CallStatus, direction: 'inbound' | 'outbound'): boolean {
  return direction === 'inbound' && status === 'missed';
}

/** One person who might be rung: their roles, desk work types and presence. */
export interface RingCandidate {
  readonly userId: string;
  readonly holdsInboxRole: boolean;
  readonly workTypes: readonly WorkType[];
  readonly presence: PresenceFacts;
}

/**
 * Whose screens ring for a call (D-785).
 *
 * The conversation's owner, when they hold an inbox role and are active in the ERP (not idle,
 * away or paused); otherwise everyone active whose desk takes messages. A call nobody can hear
 * rings nobody: it is missed and leaves a call-back item. Sorted, so the same people give the
 * same list.
 */
export function ringTargets(input: {
  readonly ownerUserId: string | null;
  readonly candidates: readonly RingCandidate[];
  readonly now: Date;
}): readonly string[] {
  const available = (candidate: RingCandidate) =>
    candidate.holdsInboxRole && presenceState(candidate.presence, input.now).available;
  if (input.ownerUserId !== null) {
    const owner = input.candidates.find((candidate) => candidate.userId === input.ownerUserId);
    if (owner !== undefined && available(owner)) return [owner.userId];
  }
  return input.candidates
    .filter((candidate) => available(candidate) && candidate.workTypes.includes('messages'))
    .map((candidate) => candidate.userId)
    .sort();
}

/** "2:05" for a call's length; "0:00" for none. */
export function callLength(seconds: number | null): string {
  const total = Math.max(0, Math.floor(seconds ?? 0));
  const minutes = Math.floor(total / 60);
  return `${String(minutes)}:${String(total % 60).padStart(2, '0')}`;
}
