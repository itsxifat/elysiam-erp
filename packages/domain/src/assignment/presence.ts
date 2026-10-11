/**
 * Who is working in the ERP right now (M41, D-713).
 *
 * The console reports about every thirty seconds whether its tab is visible and how long ago
 * the person last touched the keyboard or mouse there. The server keeps two instants per person
 * per brand: when the last report arrived (`lastSeenAt`) and the last moment the person was
 * known to be at the screen (`lastActiveAt`). Everything else is derived here, at the moment of
 * asking, so a person who closes the laptop becomes "away" without anybody writing a row:
 *
 * - **away**: no report for more than {@link PRESENCE_AWAY_AFTER_MS};
 * - **active**: reporting, and at the screen within {@link PRESENCE_IDLE_AFTER_MS};
 * - **idle**: reporting, but not at the screen for longer than that.
 *
 * "Not taking orders" (`paused`) is the person's own switch and does not change the state: a
 * paused person who is working is still shown as active on the team board, they are simply
 * never offered new work.
 *
 * Only the ERP's own tab is observed. Nothing here, or in the console that feeds it, knows
 * anything about other tabs or applications.
 */

/** No report for this long and the person is away: three missed thirty-second beats. */
export const PRESENCE_AWAY_AFTER_MS = 90_000;

/** No input in the ERP for this long and the person is idle. */
export const PRESENCE_IDLE_AFTER_MS = 120_000;

/** How often the console reports. The server never relies on the exact cadence. */
export const PRESENCE_BEAT_MS = 30_000;

export const PRESENCE_STATES = ['active', 'idle', 'away'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export interface PresenceFacts {
  /** When the last report arrived; null for a person who has never reported. */
  readonly lastSeenAt: Date | null;
  /** The last moment the person was at the screen; null if never. */
  readonly lastActiveAt: Date | null;
  /** "Not taking orders". */
  readonly paused: boolean;
}

export interface PresenceReading {
  readonly state: PresenceState;
  readonly paused: boolean;
  /** Active and not paused: the only people new work is offered to. */
  readonly available: boolean;
}

export function presenceState(facts: PresenceFacts, now: Date): PresenceReading {
  const state = stateOf(facts, now);
  return { state, paused: facts.paused, available: state === 'active' && !facts.paused };
}

function stateOf(facts: PresenceFacts, now: Date): PresenceState {
  if (facts.lastSeenAt === null) return 'away';
  if (now.getTime() - facts.lastSeenAt.getTime() > PRESENCE_AWAY_AFTER_MS) return 'away';
  if (facts.lastActiveAt === null) return 'idle';
  return now.getTime() - facts.lastActiveAt.getTime() > PRESENCE_IDLE_AFTER_MS ? 'idle' : 'active';
}

/**
 * The instant a report says the person was last at the screen.
 *
 * A hidden tab says nothing about input in the ERP, so it leaves the earlier instant standing.
 * A visible tab with `idleSeconds` since the last input puts it at `now − idleSeconds`, never in
 * the future and never earlier than what is already known (a report that arrives late, or a
 * clock that jumped, cannot make someone look less recently active than they were).
 */
export function lastActiveFrom(input: {
  readonly previous: Date | null;
  readonly visible: boolean;
  readonly idleSeconds: number;
  readonly now: Date;
}): Date | null {
  if (!input.visible) return input.previous;
  const idleMs = Math.max(0, Math.min(input.idleSeconds, 86_400)) * 1000;
  const reported = new Date(input.now.getTime() - idleMs);
  if (input.previous === null) return reported;
  return reported.getTime() > input.previous.getTime() ? reported : input.previous;
}
