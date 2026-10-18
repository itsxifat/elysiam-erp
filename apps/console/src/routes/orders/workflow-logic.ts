import type { WorkflowKey } from '@elysium/i18n';

/**
 * The order workflow's console logic (M41), pure so it is tested without a browser: times for
 * the call log and the offer countdown, the heartbeat's report, and the hub's hand-over list.
 */

/** A `datetime-local` value (the browser's own zone, Asia/Dhaka at the desk) as ISO, or null. */
export function localInputToIso(value: string): string | null {
  if (value.trim() === '') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

export function callBackIsDue(callBackAt: string, nowMs: number): boolean {
  return new Date(callBackAt).getTime() <= nowMs;
}

/** Whole seconds until an offer runs out, never below zero. */
export function secondsLeft(expiresAt: string, nowMs: number): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - nowMs) / 1000));
}

/** The countdown as a share of the whole offer, for the bar: 1 at the start, 0 at the end. */
export function offerShareLeft(offeredAt: string, expiresAt: string, nowMs: number): number {
  const start = new Date(offeredAt).getTime();
  const end = new Date(expiresAt).getTime();
  if (end <= start) return 0;
  return Math.min(1, Math.max(0, (end - nowMs) / (end - start)));
}

/**
 * What the heartbeat says about this tab (D-713): visible or not, and whole seconds since the
 * last input here. Nothing about any other tab or application.
 */
export function beatFor(input: {
  readonly visible: boolean;
  readonly lastInputMs: number;
  readonly nowMs: number;
}): { visible: boolean; idleSeconds: number } {
  const idle = Math.floor(Math.max(0, input.nowMs - input.lastInputMs) / 1000);
  return { visible: input.visible, idleSeconds: Math.min(idle, 86_400) };
}

const ACT_KEYS: Readonly<Record<string, WorkflowKey>> = {
  edit: 'wf.act.edit',
  confirm: 'wf.act.confirm',
  hold: 'wf.act.hold',
  release_hold: 'wf.act.release_hold',
  cancel: 'wf.act.cancel',
  exchange: 'wf.act.exchange',
  advance: 'wf.act.advance',
  call: 'wf.act.call',
  reassign: 'wf.act.reassign',
  release: 'wf.act.release',
  hand_over: 'wf.act.hand_over',
  take: 'wf.act.take',
};

/** The words for what somebody did to your order; anything unknown reads "acted". */
export function actKey(act: unknown): WorkflowKey {
  return typeof act === 'string' ? (ACT_KEYS[act] ?? 'wf.act.other') : 'wf.act.other';
}

const INBOX_ACT_KEYS: Readonly<Record<string, WorkflowKey>> = {
  call: 'wf.inboxAct.call',
  call_back: 'wf.inboxAct.call_back',
  reply: 'wf.inboxAct.reply',
  voice: 'wf.inboxAct.voice',
  note: 'wf.inboxAct.note',
  take: 'wf.inboxAct.take',
  hand_over: 'wf.inboxAct.hand_over',
  release: 'wf.inboxAct.release',
};

/**
 * The words for what somebody did in your conversation (`inbox.owner_overridden`'s action,
 * D-737, D-862): `contact.*` and `interest.*` by their family; anything unknown reads "acted".
 */
export function inboxActKey(action: unknown): WorkflowKey {
  if (typeof action !== 'string') return 'wf.inboxAct.other';
  if (action.startsWith('contact.')) return 'wf.inboxAct.contact';
  if (action.startsWith('interest.')) return 'wf.inboxAct.interest';
  return INBOX_ACT_KEYS[action] ?? 'wf.inboxAct.other';
}

export interface HandoverEntry {
  readonly id: string;
  readonly orderNo: string;
}

export type HandoverAdd =
  | { readonly ok: true; readonly list: readonly HandoverEntry[]; readonly added: HandoverEntry }
  | { readonly ok: false; readonly reason: 'not_packed' | 'already'; readonly code: string };

/**
 * Add a scanned or typed order number to the courier hand-over list (D-719). Only an order
 * packed and waiting at this hub can go; each once. Matched on the order number, case and
 * surrounding space ignored, because a slip's barcode and a typed number must agree.
 */
export function addToHandover(
  list: readonly HandoverEntry[],
  code: string,
  packed: readonly HandoverEntry[],
): HandoverAdd {
  const wanted = code.trim().toUpperCase();
  const found = packed.find((entry) => entry.orderNo.toUpperCase() === wanted);
  if (found === undefined) return { ok: false, reason: 'not_packed', code: code.trim() };
  if (list.some((entry) => entry.id === found.id)) {
    return { ok: false, reason: 'already', code: found.orderNo };
  }
  return { ok: true, list: [...list, found], added: found };
}
