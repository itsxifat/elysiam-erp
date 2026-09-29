/**
 * An order's timeline: its status history and its audit trail, as one list (M11 Build
 * list: "order detail with a timeline (status history plus audit)").
 *
 * Two sources because they answer different questions. `sales.order_events` is the order's
 * own history — every status it passed through, with the reason — and it is what a return
 * dispute is argued from. `audit.audit_log` is everything else that happened to the row: an
 * edit, a claim, an advance, a parcel booked. Neither alone is the story.
 *
 * A transition writes to both, so the audit rows that merely restate a status change are
 * dropped: `order.confirm` beside a `pending → confirmed` event is the same fact twice, and
 * a timeline that says everything twice is one people stop reading.
 */

export interface StatusEntry {
  readonly id: string;
  readonly from: string | null;
  readonly to: string;
  readonly trigger: string;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

export interface AuditEntryRow {
  readonly id: string;
  readonly action: string;
  readonly actor_user_id: string | null;
  readonly created_at: string;
}

export type TimelineEntry =
  | {
      readonly kind: 'status';
      readonly id: string;
      readonly at: string;
      readonly from: string | null;
      readonly to: string;
      readonly trigger: string;
      readonly reason: string | null;
      readonly actorUserId: string | null;
    }
  | {
      readonly kind: 'activity';
      readonly id: string;
      readonly at: string;
      readonly action: string;
      readonly actorUserId: string | null;
    };

export function orderTimeline(
  history: readonly StatusEntry[],
  audited: readonly AuditEntryRow[],
): TimelineEntry[] {
  // `order.create` is how creation's event is spelled in the trigger column, and
  // `order.created` is how its audit row is spelled; both describe the same moment.
  const restated = new Set(
    history.flatMap((entry) =>
      entry.trigger === 'create' ? ['order.created'] : [`order.${entry.trigger}`],
    ),
  );

  const entries: TimelineEntry[] = [
    ...history.map((entry): TimelineEntry => ({
      kind: 'status',
      id: entry.id,
      at: entry.occurredAt,
      from: entry.from,
      to: entry.to,
      trigger: entry.trigger,
      reason: entry.reason,
      actorUserId: entry.actorUserId,
    })),
    ...audited
      .filter((row) => !restated.has(row.action))
      .map((row): TimelineEntry => ({
        kind: 'activity',
        id: row.id,
        at: new Date(row.created_at).toISOString(),
        action: row.action,
        actorUserId: row.actor_user_id,
      })),
  ];

  // Oldest first, like a conversation. Ties keep status before activity: a status change
  // and the audit row the same transaction wrote share a timestamp to the microsecond, and
  // reading "confirmed" before "booking queued" is the order it happened in.
  return entries.sort((left, right) => {
    const byTime = Date.parse(left.at) - Date.parse(right.at);
    if (byTime !== 0) return byTime;
    return left.kind === right.kind ? 0 : left.kind === 'status' ? -1 : 1;
  });
}
