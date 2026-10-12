import type { PlaceholderValues } from '@elysium/domain/inbox';

import type { ConversationItem, MessageView, PanelView } from './api.js';

/**
 * The thread's and the list's shape (M44a, D-765), pure so they are tested without a browser:
 * Dhaka calendar days, relative times, day separators, consecutive messages grouped, which
 * chat j and k move to, and what a saved reply's placeholders are filled with.
 */

const DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', weekday: 'short' });
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  day: 'numeric',
  month: 'short',
});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const LONG_DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});
const CLOCK = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY_MS = 24 * HOUR;

/** The Dhaka calendar day of an instant, `YYYY-MM-DD` (invariant 8). */
export function dhakaDay(at: string | number | Date): string {
  return DAY.format(new Date(at));
}

/** The day before a Dhaka day. */
function previousDay(day: string): string {
  const noon = new Date(`${day}T12:00:00+06:00`).getTime();
  return dhakaDay(noon - DAY_MS);
}

export type TimeLabel =
  | { readonly key: 'alive.time.now' }
  | { readonly key: 'alive.time.minutes'; readonly n: number }
  | { readonly key: 'alive.time.hours'; readonly n: number }
  | { readonly key: 'alive.day.yesterday' }
  | { readonly text: string };

/** "Just now", "2 min ago", "3 h ago", "Yesterday", "Mon", "12 Oct", "12 Oct 2025". */
export function relativeTime(at: string, nowMs: number): TimeLabel {
  const then = new Date(at).getTime();
  const ago = nowMs - then;
  if (ago < 45_000) return { key: 'alive.time.now' };
  if (ago < HOUR) return { key: 'alive.time.minutes', n: Math.max(1, Math.round(ago / MINUTE)) };
  const today = dhakaDay(nowMs);
  const day = dhakaDay(then);
  if (day === today) return { key: 'alive.time.hours', n: Math.floor(ago / HOUR) };
  if (day === previousDay(today)) return { key: 'alive.day.yesterday' };
  if (ago < 6 * DAY_MS) return { text: WEEKDAY.format(then) };
  return {
    text:
      day.slice(0, 4) === today.slice(0, 4) ? DAY_MONTH.format(then) : DAY_MONTH_YEAR.format(then),
  };
}

export type DayLabel =
  | { readonly key: 'alive.day.today' }
  | { readonly key: 'alive.day.yesterday' }
  | { readonly text: string };

/** A day separator's words: "Today", "Yesterday", "Sat, 10 Oct". */
export function dayLabel(day: string, nowMs: number): DayLabel {
  const today = dhakaDay(nowMs);
  if (day === today) return { key: 'alive.day.today' };
  if (day === previousDay(today)) return { key: 'alive.day.yesterday' };
  return { text: LONG_DAY.format(new Date(`${day}T12:00:00+06:00`)) };
}

/** "14:05", Dhaka time, beside a message. */
export function clockTime(at: string): string {
  return CLOCK.format(new Date(at));
}

/** Messages this close together from the same side read as one group. */
export const GROUP_GAP_MS = 5 * MINUTE;

export type ThreadItem =
  | { readonly kind: 'day'; readonly key: string; readonly day: string }
  | {
      readonly kind: 'group';
      readonly key: string;
      readonly direction: 'inbound' | 'outbound';
      /** Who wrote an outbound group: a colleague's id, or null (Meta's own inbox). */
      readonly sentBy: string | null;
      readonly messages: readonly MessageView[];
    };

/**
 * The thread as it is drawn: a separator at each new Dhaka day, and consecutive messages from
 * the same side (and, for ours, the same person) within five minutes as one group.
 */
export function threadItems(messages: readonly MessageView[]): ThreadItem[] {
  interface Open {
    readonly key: string;
    readonly direction: 'inbound' | 'outbound';
    readonly sentBy: string | null;
    readonly messages: MessageView[];
    lastAt: number;
  }
  const finish = (open: Open): ThreadItem => ({
    kind: 'group',
    key: open.key,
    direction: open.direction,
    sentBy: open.sentBy,
    messages: open.messages,
  });
  const items: ThreadItem[] = [];
  let day: string | null = null;
  let open = null as Open | null;
  for (const message of messages) {
    const at = new Date(message.at).getTime();
    const messageDay = dhakaDay(at);
    if (messageDay !== day) {
      if (open !== null) items.push(finish(open));
      open = null;
      day = messageDay;
      items.push({ kind: 'day', key: `day:${messageDay}`, day: messageDay });
    }
    const sentBy = message.direction === 'outbound' ? (message.sentBy?.userId ?? null) : null;
    if (
      open?.direction === message.direction &&
      open.sentBy === sentBy &&
      at - open.lastAt <= GROUP_GAP_MS
    ) {
      open.messages.push(message);
      open.lastAt = at;
      continue;
    }
    if (open !== null) items.push(finish(open));
    open = {
      key: message.id,
      direction: message.direction,
      sentBy,
      messages: [message],
      lastAt: at,
    };
  }
  if (open !== null) items.push(finish(open));
  return items;
}

/** The chat j (forward) or k (back) moves to: wraps at neither end; the first when none is open. */
export function stepConversation(
  ids: readonly string[],
  current: string | null,
  step: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const index = current === null ? -1 : ids.indexOf(current);
  if (index === -1) return ids[0] ?? null;
  const next = Math.min(ids.length - 1, Math.max(0, index + step));
  return ids[next] ?? null;
}

/** Bytes, as Instagram counts a message's length (its cap is 1,000; a Bangla letter is three). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Whether a text has any Bangla in it, so it is marked `lang="bn"` for its font and tracking. */
export function hasBangla(text: string | null): boolean {
  return text !== null && /[ঀ-৿]/u.test(text);
}

/**
 * What a saved reply's placeholders become in this conversation: the customer's name (else the
 * contact's), the phone saved on the contact (else the customer's), and the customer's latest
 * order and its amount, as the panel shows them.
 */
export function placeholderValues(
  conversation: Pick<ConversationItem, 'contact'>,
  panel: PanelView | undefined,
): PlaceholderValues {
  const latest = panel?.customer?.recentOrders[0];
  return {
    name: panel?.customer?.name ?? conversation.contact.name,
    phoneE164: panel?.contact.phone ?? panel?.customer?.phone ?? null,
    orderNumber: latest?.orderNo ?? null,
    totalPoisha: latest?.codAmountPoisha ?? null,
  };
}

/** Whether an element takes typing, so a single-key shortcut leaves it alone. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
