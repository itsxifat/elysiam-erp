import type { OrderStatus } from './state.js';

/**
 * A buyer's numbers, and the people one number names (M48, D-870 to D-889).
 *
 * A person may use several numbers (their own, a WhatsApp, the shop's), and one number may
 * be used by several people (a home phone, relatives, an office). These are the rules about
 * that which have arithmetic or state in them, as pure functions (invariant 11): which person
 * an automatic path picks for a number, how numbers are ranked, when one may be retired, how a
 * merge moves numbers and notes, and what an order counted on its buyer's stats.
 */

/** What kind of line it is. */
export const PHONE_KINDS = ['mobile', 'whatsapp', 'home', 'office', 'shop', 'other'] as const;
export type PhoneKind = (typeof PHONE_KINDS)[number];

/** Whose the number is, from this person's side. */
export const PHONE_RELATIONS = [
  'own',
  'household',
  'relative',
  'work',
  'someone_else',
  'other',
] as const;
export type PhoneRelation = (typeof PHONE_RELATIONS)[number];

/** Where the number came from: a person on the Numbers card, or an automatic path. */
export const PHONE_SOURCES = ['staff', 'order', 'website', 'inbox', 'call', 'import'] as const;
export type PhoneSource = (typeof PHONE_SOURCES)[number];

/** Why a number stopped being this person's. */
export const PHONE_RETIRE_REASONS = [
  'changed_number',
  'wrong_number',
  'not_theirs',
  'other',
] as const;
export type PhoneRetireReason = (typeof PHONE_RETIRE_REASONS)[number];

/** The staff's details on a number: why and when this person uses it (D-871). */
export const PHONE_NOTE_MAX = 500;

/** Whom an order was placed for (D-878). */
export const PLACED_FOR = ['self', 'someone_else'] as const;
export type PlacedFor = (typeof PLACED_FOR)[number];

/** Why the desk should check an order's buyer (D-876). The one reason so far. */
export const BUYER_CHECKS = ['shared_number'] as const;
export type BuyerCheck = (typeof BUYER_CHECKS)[number];

export type PhoneNoteVerdict =
  | { readonly ok: true; readonly note: string | null }
  | { readonly ok: false; readonly reason: 'note_required' | 'note_too_long' };

/**
 * A number's note as it is stored (D-871): trimmed, at most 500 characters, and required when a
 * person adds the number on the Numbers card (`staff`). A number an automatic path added has none
 * until staff write one, and is shown as "needs details" until then.
 */
export function checkPhoneNote(
  raw: string | null | undefined,
  source: PhoneSource,
): PhoneNoteVerdict {
  const note = raw === null || raw === undefined ? '' : raw.trim();
  if ([...note].length > PHONE_NOTE_MAX) return { ok: false, reason: 'note_too_long' };
  if (note === '') {
    return source === 'staff' ? { ok: false, reason: 'note_required' } : { ok: true, note: null };
  }
  return { ok: true, note };
}

/** "Needs details": a number nobody has written a note for yet (D-871). */
export function needsDetails(phone: { readonly note: string | null }): boolean {
  return phone.note === null || phone.note.trim() === '';
}

/** One person an active number names, as the resolver weighs them (D-875). */
export interface BuyerCandidate {
  readonly customerId: string;
  /** The number's rank on this person: 1 is their primary. */
  readonly rank: number;
  readonly relation: PhoneRelation;
  readonly lastOrderAt: Date | null;
  /** When the number was put on this person, the last tie-break before the id. */
  readonly addedAt: Date;
}

export type BuyerPick =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly customerId: string }
  | {
      readonly kind: 'several';
      readonly customerId: string;
      /** How the automatic path chose (D-876). */
      readonly by: 'primary_own' | 'last_order';
    };

function newestFirst(a: BuyerCandidate, b: BuyerCandidate): number {
  const at = (candidate: BuyerCandidate) => candidate.lastOrderAt?.getTime() ?? -Infinity;
  if (at(a) !== at(b)) return at(b) - at(a);
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.addedAt.getTime() !== b.addedAt.getTime()) return a.addedAt.getTime() - b.addedAt.getTime();
  return a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0;
}

/**
 * The person an automatic path (a website or ncom order, an imported row, a call being linked)
 * takes a number to mean (D-876): the one whose primary own number it is; else, or when the data
 * says it is more than one person's primary own number, the one who ordered last (then the
 * number's rank, then who had it first). `several` tells the caller it had to choose, so an
 * order is flagged "check the buyer: shared number" and a call's panel offers the others.
 */
export function pickBuyer(candidates: readonly BuyerCandidate[]): BuyerPick {
  const byPerson = new Map<string, BuyerCandidate>();
  for (const candidate of candidates) {
    const seen = byPerson.get(candidate.customerId);
    // One person holds a number once among active rows. Were it twice, the two are one person:
    // the better rank (then the earlier, then the closer relation) with their latest order.
    if (seen === undefined) {
      byPerson.set(candidate.customerId, candidate);
      continue;
    }
    const better =
      candidate.rank !== seen.rank
        ? candidate.rank < seen.rank
        : candidate.addedAt.getTime() !== seen.addedAt.getTime()
          ? candidate.addedAt.getTime() < seen.addedAt.getTime()
          : candidate.relation < seen.relation;
    const base = better ? candidate : seen;
    const latest = [candidate.lastOrderAt, seen.lastOrderAt].reduce<Date | null>(
      (max, at) => (at !== null && (max === null || at.getTime() > max.getTime()) ? at : max),
      null,
    );
    byPerson.set(candidate.customerId, { ...base, lastOrderAt: latest });
  }
  const people = [...byPerson.values()];
  const [only] = people;
  if (only === undefined) return { kind: 'none' };
  if (people.length === 1) return { kind: 'one', customerId: only.customerId };

  const primaryOwn = people.filter(
    (candidate) => candidate.rank === 1 && candidate.relation === 'own',
  );
  const [owner] = primaryOwn;
  if (owner !== undefined && primaryOwn.length === 1) {
    return { kind: 'several', customerId: owner.customerId, by: 'primary_own' };
  }
  const pool = primaryOwn.length > 1 ? primaryOwn : people;
  const [chosen] = [...pool].sort(newestFirst);
  // `pool` is never empty here: `people` has two or more entries.
  return { kind: 'several', customerId: chosen?.customerId ?? only.customerId, by: 'last_order' };
}

/**
 * The candidates in the order a screen lists them (D-875): the automatic pick first, then whoever
 * ordered last.
 */
export function rankCandidates<T extends BuyerCandidate>(candidates: readonly T[]): T[] {
  const pick = pickBuyer(candidates);
  const chosen = pick.kind === 'none' ? null : pick.customerId;
  return [...candidates].sort((a, b) => {
    if (a.customerId === chosen && b.customerId !== chosen) return -1;
    if (b.customerId === chosen && a.customerId !== chosen) return 1;
    return newestFirst(a, b);
  });
}

/**
 * A person's active numbers after one moves to `toRank` (D-872): the ids in their new order,
 * rank 1 first. `toRank` is clamped to the list, so "make primary" is `toRank: 1`.
 */
export function moveToRank(
  idsByRank: readonly string[],
  phoneId: string,
  toRank: number,
): string[] | null {
  if (!idsByRank.includes(phoneId)) return null;
  const rest = idsByRank.filter((id) => id !== phoneId);
  const at = Math.min(Math.max(Math.trunc(toRank), 1), idsByRank.length) - 1;
  return [...rest.slice(0, at), phoneId, ...rest.slice(at)];
}

export type RetireVerdict =
  | { readonly ok: true; readonly remaining: readonly string[] }
  | { readonly ok: false; readonly reason: 'not_active' | 'last_number' };

/**
 * Whether a number may be retired (D-873), and the person's numbers after it (the next one up
 * becomes primary when the primary goes). The last active number cannot be: a buyer is always
 * reachable on one, and the primary's copy on the buyer row needs one to copy.
 */
export function retirePlan(idsByRank: readonly string[], phoneId: string): RetireVerdict {
  if (!idsByRank.includes(phoneId)) return { ok: false, reason: 'not_active' };
  const remaining = idsByRank.filter((id) => id !== phoneId);
  if (remaining.length === 0) return { ok: false, reason: 'last_number' };
  return { ok: true, remaining };
}

/** A number as a merge moves it. */
export interface MergeNumber {
  readonly id: string;
  readonly phoneE164: string;
  readonly rank: number;
}

/**
 * How a merge moves numbers (D-884): the kept person's stay where they are, the other's follow in
 * their own order, and a number both already had is retired on the merged side (its history kept)
 * rather than held twice.
 */
export function mergeNumbersPlan(
  kept: readonly MergeNumber[],
  merged: readonly MergeNumber[],
): {
  readonly ranks: readonly { readonly id: string; readonly rank: number }[];
  readonly retire: readonly string[];
} {
  const keptByRank = [...kept].sort((a, b) => a.rank - b.rank);
  const held = new Set(keptByRank.map((phone) => phone.phoneE164));
  const ranks = keptByRank.map((phone, index) => ({ id: phone.id, rank: index + 1 }));
  const retire: string[] = [];
  for (const phone of [...merged].sort((a, b) => a.rank - b.rank)) {
    if (held.has(phone.phoneE164)) {
      retire.push(phone.id);
      continue;
    }
    held.add(phone.phoneE164);
    ranks.push({ id: phone.id, rank: ranks.length + 1 });
  }
  return { ranks, retire };
}

/** The buyer notes a merge leaves (D-884): both, kept first, within the field's 2,000. */
export function mergeNotes(kept: string | null, merged: string | null, max = 2000): string | null {
  const a = kept?.trim() ?? '';
  const b = merged?.trim() ?? '';
  if (b === '' || a === b) return a === '' ? null : a;
  if (a === '') return [...b].slice(0, max).join('');
  return [...`${a}\n\n${b}`].slice(0, max).join('');
}

/** A buyer's counters, as an order or a merge moves them. */
export interface BuyerStatsDelta {
  readonly orders: number;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  readonly ltvPoisha: bigint;
}

/**
 * What one order counted on its buyer (D-883), from the statuses it reached, as the transitions
 * counted it: one order; delivered once it was delivered or partly delivered, with the net revenue
 * recognised; returned when it came back in transit (a partly delivered order's return counts no
 * second return); cancelled once cancelled.
 */
export function orderStatsContribution(input: {
  readonly reached: ReadonlySet<OrderStatus>;
  readonly deliveredNetPoisha: bigint;
}): BuyerStatsDelta {
  const delivered = input.reached.has('delivered') || input.reached.has('partially_delivered');
  return {
    orders: 1,
    delivered: delivered ? 1 : 0,
    returned: input.reached.has('returned') && !input.reached.has('partially_delivered') ? 1 : 0,
    cancelled: input.reached.has('cancelled') ? 1 : 0,
    ltvPoisha: delivered && input.deliveredNetPoisha > 0n ? input.deliveredNetPoisha : 0n,
  };
}

export function negateStats(delta: BuyerStatsDelta): BuyerStatsDelta {
  return {
    orders: -delta.orders,
    delivered: -delta.delivered,
    returned: -delta.returned,
    cancelled: -delta.cancelled,
    ltvPoisha: -delta.ltvPoisha,
  };
}

/**
 * Whether an order with two phones was placed for someone else (D-879): the contact's phone
 * names the buyer, the shipping phone the recipient; one phone, or the same twice, is the buyer's
 * own order.
 */
export function placedForOf(contactE164: string, shipE164: string | null): PlacedFor {
  return shipE164 === null || shipE164 === contactE164 ? 'self' : 'someone_else';
}
