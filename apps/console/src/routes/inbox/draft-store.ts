import { useCallback, useEffect, useState } from 'react';

import { emptyDraft, type SellDraft } from './sell-logic.js';

/**
 * Each conversation's draft order, kept in this browser (M44b, D-776) so switching chats, or a
 * reload, does not lose what the agent built. Per person: the key carries the signed-in user, so
 * a colleague on the same computer starts their own. Behind try/catch everywhere: a private
 * window, blocked storage or a full quota gives a draft that simply is not kept.
 *
 * Only what the draft needs (items, the delivery name, phone and address, amounts); a draft is
 * dropped once its order is placed and its summary dealt with, and any older than three days is
 * swept when the inbox opens.
 */

const PREFIX = 'elysium.inbox.sell.v1';
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const keyOf = (userId: string, conversationId: string) => `${PREFIX}:${userId}:${conversationId}`;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isDraft(value: unknown, conversationId: string): value is SellDraft {
  if (typeof value !== 'object' || value === null) return false;
  const draft = value as Partial<SellDraft>;
  return (
    draft.version === 1 &&
    draft.conversationId === conversationId &&
    Array.isArray(draft.lines) &&
    typeof draft.customer?.name === 'string' &&
    Array.isArray(draft.typed)
  );
}

export function loadDraft(
  userId: string,
  conversationId: string,
  now = Date.now(),
): SellDraft | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(keyOf(userId, conversationId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isDraft(parsed, conversationId)) return null;
    if (now - parsed.updatedAt > MAX_AGE_MS) {
      store.removeItem(keyOf(userId, conversationId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(userId: string, draft: SellDraft): void {
  const store = storage();
  if (store === null) return;
  try {
    const empty =
      draft.lines.length === 0 &&
      draft.typed.length === 0 &&
      draft.placed === null &&
      draft.hintsSeenAt === null &&
      draft.advance === null &&
      draft.discountTaka === '' &&
      draft.promoCode === '' &&
      draft.notes === '';
    if (empty) store.removeItem(keyOf(userId, draft.conversationId));
    else store.setItem(keyOf(userId, draft.conversationId), JSON.stringify(draft));
  } catch {
    // Not kept: the draft still works for as long as the chat is open.
  }
}

/** Forget drafts older than three days, of anyone on this browser. */
export function sweepDrafts(now = Date.now()): void {
  const store = storage();
  if (store === null) return;
  try {
    const stale: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (!key?.startsWith(`${PREFIX}:`)) continue;
      try {
        const parsed = JSON.parse(store.getItem(key) ?? 'null') as { updatedAt?: unknown } | null;
        if (typeof parsed?.updatedAt !== 'number' || now - parsed.updatedAt > MAX_AGE_MS) {
          stale.push(key);
        }
      } catch {
        stale.push(key);
      }
    }
    for (const key of stale) store.removeItem(key);
  } catch {
    // Nothing to sweep.
  }
}

let swept = false;

/**
 * The conversation's draft and a way to change it; every change is kept at once. The panel is
 * mounted per conversation, so the draft is read once, when the chat opens.
 */
export function useSellDraft(
  conversationId: string,
  userId: string | null,
): readonly [SellDraft, (change: (draft: SellDraft) => SellDraft) => void] {
  const [draft, setDraft] = useState<SellDraft>(() => {
    if (!swept) {
      swept = true;
      sweepDrafts();
    }
    return (
      (userId === null ? null : loadDraft(userId, conversationId)) ?? emptyDraft(conversationId)
    );
  });
  useEffect(() => {
    if (userId !== null) saveDraft(userId, draft);
  }, [draft, userId]);

  const update = useCallback((change: (current: SellDraft) => SellDraft) => {
    setDraft((current) => {
      const next = change(current);
      return next === current ? current : { ...next, updatedAt: Date.now() };
    });
  }, []);

  return [draft, update] as const;
}
