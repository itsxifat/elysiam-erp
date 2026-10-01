import { describe, expect, it } from 'vitest';

import {
  EMPTY_INBOX,
  INBOX_LIMIT,
  inboxReducer,
  itemFromEvent,
  unreadCount,
  type Inbox,
  type InboxItem,
} from './inbox.js';

const ID = '0b7e9d0c-3f1a-4c55-9a53-6f0f4d1a2b01';

function requested(id: string, at: number): InboxItem {
  return { kind: 'approval_requested', id, type: 'wallet_adjustment', at, read: false };
}

function receive(inbox: Inbox, item: InboxItem): Inbox {
  return inboxReducer(inbox, { type: 'received', item });
}

describe('the notifications inbox', () => {
  it('puts the newest first and counts it unread', () => {
    const inbox = receive(receive(EMPTY_INBOX, requested('a', 1)), requested('b', 2));
    expect(inbox.items.map((item) => item.id)).toEqual(['b', 'a']);
    expect(unreadCount(inbox)).toBe(2);
  });

  it('shows a re-delivered event once', () => {
    const once = receive(EMPTY_INBOX, requested('a', 1));
    expect(receive(once, requested('a', 5))).toBe(once);
  });

  it('keeps a request and its decision apart, though they share an id', () => {
    const inbox = receive(receive(EMPTY_INBOX, requested(ID, 1)), {
      kind: 'approval_decided',
      id: ID,
      decision: 'approved',
      at: 2,
      read: false,
    });
    expect(inbox.items).toHaveLength(2);
  });

  it(`holds at most ${String(INBOX_LIMIT)} entries, dropping the oldest`, () => {
    let inbox = EMPTY_INBOX;
    for (let index = 0; index < INBOX_LIMIT + 5; index += 1) {
      inbox = receive(inbox, requested(String(index), index));
    }
    expect(inbox.items).toHaveLength(INBOX_LIMIT);
    expect(inbox.items[0]?.id).toBe(String(INBOX_LIMIT + 4));
    expect(inbox.items.some((item) => item.id === '0')).toBe(false);
  });

  it('marks everything read, and leaves a read inbox as it is', () => {
    const inbox = receive(receive(EMPTY_INBOX, requested('a', 1)), requested('b', 2));
    const read = inboxReducer(inbox, { type: 'markAllRead' });
    expect(unreadCount(read)).toBe(0);
    expect(inboxReducer(read, { type: 'markAllRead' })).toBe(read);
  });
});

describe('which events become entries', () => {
  it('turns a pending approval request into one', () => {
    expect(
      itemFromEvent(
        'approval.requested',
        { id: ID, type: 'supplier_payment', status: 'pending' },
        7,
      ),
    ).toEqual({ kind: 'approval_requested', id: ID, type: 'supplier_payment', at: 7, read: false });
  });

  it('skips a request that was approved automatically: nobody has to act on it', () => {
    expect(
      itemFromEvent(
        'approval.requested',
        { id: ID, type: 'wallet_adjustment', status: 'auto_approved' },
        7,
      ),
    ).toBeNull();
  });

  it('turns a decision into one', () => {
    expect(itemFromEvent('approval.decided', { id: ID, decision: 'rejected' }, 9)).toEqual({
      kind: 'approval_decided',
      id: ID,
      decision: 'rejected',
      at: 9,
      read: false,
    });
  });

  it('ignores anything it does not recognise rather than guessing', () => {
    expect(itemFromEvent('approval.decided', { id: ID, decision: 'maybe' }, 1)).toBeNull();
    expect(itemFromEvent('order.created', { id: ID }, 1)).toBeNull();
    expect(itemFromEvent('approval.requested', null, 1)).toBeNull();
    expect(itemFromEvent('approval.requested', { type: 'x', status: 'pending' }, 1)).toBeNull();
  });
});
