import type { PresenceState } from './presence.js';

/**
 * Who should be offered a piece of work next (M41, D-716).
 *
 * Generic over the kind of work, because the inbox (M42) offers conversations the way the desk
 * offers orders: the same people, the same presence, the same fairness, a different work type.
 * The function is pure and total: given the same candidates it always names the same person, so
 * two dispatchers racing for one order can be reasoned about, and the database's unique
 * indexes (one live offer per order, one per person) settle the rest.
 *
 * A candidate is eligible only if **all** of these hold:
 *
 * 1. available: active in the ERP and not "Not taking orders";
 * 2. their desk profile includes the kind's work type;
 * 3. their open load is below their cap;
 * 4. they have not already declined, or let expire, an offer of this very item;
 * 5. they are not holding a live offer already (one request at a time, like a driver).
 *
 * Among the eligible, the least loaded wins; a tie goes to whoever was offered something
 * longest ago (never offered counts as longest), and a remaining tie to the smaller user id, so
 * the answer never depends on the order the candidates were read in.
 */

export const WORK_KINDS = ['order', 'conversation'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** What a person may be offered, as their desk profile says it. */
export const WORK_TYPES = ['orders', 'messages'] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const WORK_TYPE_FOR: Readonly<Record<WorkKind, WorkType>> = {
  order: 'orders',
  conversation: 'messages',
};

export interface AssignmentCandidate {
  readonly userId: string;
  readonly presence: PresenceState;
  readonly paused: boolean;
  readonly workTypes: readonly WorkType[];
  /** Work of this kind they hold now (for orders: pending or on hold). */
  readonly openLoad: number;
  /** The brand's cap on open work per person. */
  readonly maxLoad: number;
  /** When they were last offered anything; null if never. */
  readonly lastOfferedAt: Date | null;
  /** They are holding a live offer right now. */
  readonly hasLiveOffer: boolean;
}

export interface AssignmentInput {
  readonly kind: WorkKind;
  readonly candidates: readonly AssignmentCandidate[];
  /** People who already declined this item, or let an offer of it expire. */
  readonly declinedBy: ReadonlySet<string>;
}

/** Why a candidate is not eligible; the team board and the tests read it. */
export type Ineligibility =
  'not_active' | 'paused' | 'no_work_type' | 'at_capacity' | 'declined' | 'busy_with_offer';

export function ineligibility(
  candidate: AssignmentCandidate,
  kind: WorkKind,
  declinedBy: ReadonlySet<string>,
): Ineligibility | null {
  if (candidate.presence !== 'active') return 'not_active';
  if (candidate.paused) return 'paused';
  if (!candidate.workTypes.includes(WORK_TYPE_FOR[kind])) return 'no_work_type';
  if (candidate.openLoad >= candidate.maxLoad) return 'at_capacity';
  if (declinedBy.has(candidate.userId)) return 'declined';
  if (candidate.hasLiveOffer) return 'busy_with_offer';
  return null;
}

/** The person to offer the item to, or null when nobody is eligible (it waits in the queue). */
export function pickAssignee(input: AssignmentInput): string | null {
  let best: AssignmentCandidate | null = null;
  for (const candidate of input.candidates) {
    if (ineligibility(candidate, input.kind, input.declinedBy) !== null) continue;
    if (best === null || before(candidate, best)) best = candidate;
  }
  return best?.userId ?? null;
}

/** Does `a` come before `b`? Least loaded, then longest since an offer, then user id. */
function before(a: AssignmentCandidate, b: AssignmentCandidate): boolean {
  if (a.openLoad !== b.openLoad) return a.openLoad < b.openLoad;
  const aAt = a.lastOfferedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bAt = b.lastOfferedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aAt !== bAt) return aAt < bAt;
  return a.userId < b.userId;
}

/** The seconds an offer stays open, and the brand's cap on open orders, with their bounds. */
export const OFFER_SECONDS_DEFAULT = 45;
export const OFFER_SECONDS_MIN = 15;
export const OFFER_SECONDS_MAX = 300;
export const MAX_OPEN_DEFAULT = 25;
export const MAX_OPEN_MIN = 1;
export const MAX_OPEN_MAX = 200;

/**
 * The work types a person has when nobody has set their desk profile (D-714, ASSUMED).
 *
 * A sales agent takes orders and messages, which is what the role was hired for; nobody else is
 * offered anything until a supervisor says so on the Staff page. The hub is chosen by stock
 * location, not by work type.
 */
export function defaultWorkTypes(roles: readonly string[]): readonly WorkType[] {
  return roles.includes('sales') ? WORK_TYPES : [];
}
