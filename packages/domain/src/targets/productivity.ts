/**
 * Order desk productivity from the event log (architecture §12; M20 check 3).
 *
 * §12: "pickup time = first agent action (claim, confirm or cancel) − the time the order
 * was created or assigned … computed from outbox events; reassignments reset the clock for
 * the new assignee." This module is that sentence as a pure function of the events, so the
 * same stream gives the same answer in a test, in the report and in a re-run next year.
 *
 * ## The rules (D-276)
 *
 * Per order, the events are replayed in time order and each **assignment** is a clock:
 *
 * * An order created with an assignee starts that assignee's clock at creation. Created
 *   without one, it waits in the queue from creation.
 * * **Claimed** from the queue: the claim is the agent's first action, and their pickup is
 *   the time it spent in the queue — from creation.
 * * **Assigned** to somebody new: the clock restarts for them. The previous assignee, if
 *   they had not acted, gets no sample — the order was taken away, not picked up slowly.
 *   Assigned again to the same person changes nothing.
 * * **Confirmed or cancelled** by the assignee: their pickup, if it is their first action.
 *   By somebody else: the assignee's clock stops with no sample, because they did not pick
 *   it up. An order confirmed straight from the queue counts for whoever confirmed it, from
 *   creation, like a claim.
 * * An order the agent **created themselves** gives no pickup sample. Typing in an order
 *   from a chat and confirming it thirty seconds later is the desk working well, but it is
 *   not "picking up" anything, and counting it would let a self-entered order flatter a
 *   pickup time that exists to measure how long the queue waits.
 *
 * Events can arrive twice (the dispatcher is at least once) and out of order (two
 * transactions committed in the other order), so they are de-duplicated by event id and
 * sorted before the replay.
 */

export const DESK_EVENT_KINDS = [
  'created',
  'assigned',
  'claimed',
  'confirmed',
  'cancelled',
] as const;

export type DeskEventKind = (typeof DESK_EVENT_KINDS)[number];

export interface DeskEvent {
  /** The outbox row's id: the de-duplication key. */
  readonly eventId: string;
  readonly orderId: string;
  readonly kind: DeskEventKind;
  readonly at: Date;
  /** Created with, assigned to or claimed by. Null on a status change. */
  readonly assignee: string | null;
  /** Who acted, when the outbox knew. */
  readonly actor: string | null;
}

export interface PickupSample {
  readonly orderId: string;
  readonly agent: string;
  readonly startedAt: Date;
  readonly pickedAt: Date;
  readonly seconds: number;
  readonly via: 'claimed' | 'confirmed' | 'cancelled';
}

/** Creation sorts first on a tie, so a same-instant claim has a queue to come from. */
const KIND_ORDER: Readonly<Record<DeskEventKind, number>> = {
  created: 0,
  assigned: 1,
  claimed: 2,
  confirmed: 3,
  cancelled: 4,
};

function ordered(events: readonly DeskEvent[]): DeskEvent[] {
  const seen = new Set<string>();
  const unique: DeskEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    unique.push(event);
  }
  return unique.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
}

function byOrder(events: readonly DeskEvent[]): Map<string, DeskEvent[]> {
  const groups = new Map<string, DeskEvent[]>();
  for (const event of ordered(events)) {
    const group = groups.get(event.orderId) ?? [];
    group.push(event);
    groups.set(event.orderId, group);
  }
  return groups;
}

function seconds(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
}

interface Assignment {
  readonly agent: string;
  readonly since: Date;
  /** The agent created the order for themselves: no sample (see the file comment). */
  readonly selfCreated: boolean;
  picked: boolean;
}

/** Every pickup in the stream, one per assignment that was picked up by its assignee. */
export function pickupSamples(events: readonly DeskEvent[]): PickupSample[] {
  const samples: PickupSample[] = [];

  for (const [orderId, stream] of byOrder(events)) {
    let createdAt: Date | null = null;
    let open: Assignment | null = null;
    /** Somebody has already picked this order up; later actions are not pickups. */
    let handled = false;

    const record = (agent: string, from: Date, at: Date, via: PickupSample['via']) => {
      samples.push({
        orderId,
        agent,
        startedAt: from,
        pickedAt: at,
        seconds: seconds(from, at),
        via,
      });
    };

    for (const event of stream) {
      switch (event.kind) {
        case 'created': {
          createdAt = event.at;
          open =
            event.assignee === null
              ? null
              : {
                  agent: event.assignee,
                  since: event.at,
                  selfCreated: event.actor !== null && event.actor === event.assignee,
                  picked: false,
                };
          break;
        }
        case 'assigned': {
          if (event.assignee === null) break;
          if (open !== null && open.agent === event.assignee) break;
          // A new assignee's clock starts now; whoever held it before loses it unpicked.
          open = { agent: event.assignee, since: event.at, selfCreated: false, picked: false };
          break;
        }
        case 'claimed': {
          const agent = event.assignee ?? event.actor;
          if (agent === null) break;
          if (open !== null && open.agent === agent) {
            if (!open.picked && !open.selfCreated) record(agent, open.since, event.at, 'claimed');
            open.picked = true;
          } else {
            // Out of the queue: it has waited since it was created.
            const from = createdAt ?? event.at;
            if (!handled) record(agent, from, event.at, 'claimed');
            open = { agent, since: event.at, selfCreated: false, picked: true };
          }
          handled = true;
          break;
        }
        case 'confirmed':
        case 'cancelled': {
          const via = event.kind;
          if (open === null) {
            // Confirmed straight from the queue, without a claim.
            if (!handled && event.actor !== null) {
              record(event.actor, createdAt ?? event.at, event.at, via);
            }
          } else if (!open.picked) {
            if (event.actor === null || event.actor === open.agent) {
              if (!open.selfCreated) record(open.agent, open.since, event.at, via);
            }
            // Acted on by somebody else: the assignee's clock stops without a sample.
            open.picked = true;
          }
          handled = true;
          break;
        }
      }
    }
  }

  return samples;
}

/**
 * The nearest-rank percentile of a sorted list: the smallest value with at least `p`% of
 * the list at or below it. Always an observed value, never an interpolation, so "p90 is 4
 * minutes" means some order really waited 4 minutes.
 */
export function nearestRank(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export interface AgentProductivity {
  readonly agent: string;
  readonly pickups: number;
  readonly medianPickupSeconds: number | null;
  readonly p90PickupSeconds: number | null;
  /** Distinct orders the agent created, claimed, confirmed or cancelled in the window. */
  readonly handledOrders: number;
  /** Asia/Dhaka clock hours with at least one of those actions (D-276). */
  readonly activeHours: number;
  /** handled ÷ active hours, to two decimals; null with no active hour. Not money. */
  readonly ordersPerActiveHour: number | null;
}

const HOUR_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** `2026-10-02 14`, the Asia/Dhaka clock hour an instant falls in. */
export function dhakaHour(at: Date): string {
  const parts = HOUR_KEY.formatToParts(at);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}`;
}

/** Who did something to an order that counts as handling it. */
function handlerOf(event: DeskEvent): string | null {
  switch (event.kind) {
    case 'created':
    case 'confirmed':
    case 'cancelled':
      return event.actor;
    case 'claimed':
      return event.actor ?? event.assignee;
    case 'assigned':
      // Handing an order to somebody is a supervisor's act, not handling the order.
      return null;
  }
}

/**
 * Per agent: pickups picked up inside `[from, to)`, and the orders they handled there.
 *
 * The whole stream is replayed, not only the window's events: an order created on the
 * 30th and claimed on the 1st was waiting since the 30th, and a window that started the
 * clock on the 1st would say it waited no time at all.
 */
export function productivity(
  events: readonly DeskEvent[],
  window: { readonly from: Date; readonly to: Date },
): AgentProductivity[] {
  const inWindow = (at: Date) => at >= window.from && at < window.to;

  const pickups = new Map<string, number[]>();
  for (const sample of pickupSamples(events)) {
    if (!inWindow(sample.pickedAt)) continue;
    const list = pickups.get(sample.agent) ?? [];
    list.push(sample.seconds);
    pickups.set(sample.agent, list);
  }

  const handled = new Map<string, Set<string>>();
  const hours = new Map<string, Set<string>>();
  for (const event of ordered(events)) {
    if (!inWindow(event.at)) continue;
    const agent = handlerOf(event);
    if (agent === null) continue;
    handled.set(agent, (handled.get(agent) ?? new Set()).add(event.orderId));
    hours.set(agent, (hours.get(agent) ?? new Set()).add(dhakaHour(event.at)));
  }

  const agents = [...new Set([...pickups.keys(), ...handled.keys()])].sort();
  return agents.map((agent) => {
    const sorted = [...(pickups.get(agent) ?? [])].sort((a, b) => a - b);
    const handledOrders = handled.get(agent)?.size ?? 0;
    const activeHours = hours.get(agent)?.size ?? 0;
    return {
      agent,
      pickups: sorted.length,
      medianPickupSeconds: nearestRank(sorted, 50),
      p90PickupSeconds: nearestRank(sorted, 90),
      handledOrders,
      activeHours,
      ordersPerActiveHour:
        activeHours === 0 ? null : Math.round((handledOrders / activeHours) * 100) / 100,
    };
  });
}
