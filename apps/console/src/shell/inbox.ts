/**
 * The notifications inbox's state (M05 shell; §10 Notifications, §19 events).
 *
 * Fed by realtime events the person already receives: an approval waiting for
 * them, and the decision on one they raised. M16's in-app channel adds its own
 * `notification.created` items to the same list when it lands. Held for the
 * session — what persists across sessions is M16's delivery log, not this.
 *
 * Pure, so the rules are tested without a browser: newest first, one entry per
 * thing (a re-delivered event does not appear twice), at most `INBOX_LIMIT`
 * entries, and an unread count that only "mark all read" clears.
 */

export const INBOX_LIMIT = 50;

export type InboxItem =
  | {
      readonly kind: 'approval_requested';
      readonly id: string;
      readonly type: string;
      readonly at: number;
      readonly read: boolean;
    }
  | {
      readonly kind: 'approval_decided';
      readonly id: string;
      readonly decision: 'approved' | 'rejected' | 'auto_approved';
      readonly at: number;
      readonly read: boolean;
    }
  | {
      /** M26: a company loan instalment coming due; `id` is the instalment. */
      readonly kind: 'loan_due';
      readonly id: string;
      readonly loanId: string;
      readonly dueOn: string;
      readonly at: number;
      readonly read: boolean;
    };

export interface Inbox {
  readonly items: readonly InboxItem[];
}

export const EMPTY_INBOX: Inbox = { items: [] };

export type InboxAction =
  { readonly type: 'received'; readonly item: InboxItem } | { readonly type: 'markAllRead' };

function keyOf(item: InboxItem): string {
  return `${item.kind}:${item.id}`;
}

export function inboxReducer(inbox: Inbox, action: InboxAction): Inbox {
  switch (action.type) {
    case 'received': {
      const key = keyOf(action.item);
      // A socket reconnect can deliver the same event again; it is one thing.
      if (inbox.items.some((item) => keyOf(item) === key)) return inbox;
      return { items: [action.item, ...inbox.items].slice(0, INBOX_LIMIT) };
    }
    case 'markAllRead':
      return inbox.items.every((item) => item.read)
        ? inbox
        : { items: inbox.items.map((item) => (item.read ? item : { ...item, read: true })) };
  }
}

export function unreadCount(inbox: Inbox): number {
  return inbox.items.filter((item) => !item.read).length;
}

/**
 * The inbox entry for a realtime event, or null when there is nothing to tell.
 *
 * A request under its org's threshold arrives already `auto_approved`: nobody has
 * to act on it, so it is not a notification for the checkers.
 */
export function itemFromEvent(name: string, payload: unknown, at: number): InboxItem | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as Record<string, unknown>;
  if (name === 'loan.instalment_due') {
    if (
      typeof body.instalmentId !== 'string' ||
      typeof body.loanId !== 'string' ||
      typeof body.dueOn !== 'string'
    ) {
      return null;
    }
    return {
      kind: 'loan_due',
      id: body.instalmentId,
      loanId: body.loanId,
      dueOn: body.dueOn,
      at,
      read: false,
    };
  }
  if (typeof body.id !== 'string') return null;

  if (name === 'approval.requested') {
    if (body.status !== 'pending' || typeof body.type !== 'string') return null;
    return { kind: 'approval_requested', id: body.id, type: body.type, at, read: false };
  }
  if (name === 'approval.decided') {
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'auto_approved') {
      return null;
    }
    return { kind: 'approval_decided', id: body.id, decision, at, read: false };
  }
  return null;
}
