import { INBOX_CHANNEL_KINDS, INBOX_CONTACT_STAGES } from '@elysium/contracts';

import type { ChannelKind, ContactStage, ConversationItem, MessageView } from './api.js';

/**
 * The inbox screen's rules, pure so they are tested without a browser (M42).
 */

export { inboxSearchSchema, type InboxSearch } from './search.js';

/** Replace each `{name}` in a message with its value; an unknown name is left as it is. */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/**
 * Whether a write here needs the owner acknowledged first (D-737): the conversation is someone
 * else's. Mine or nobody's needs nothing.
 */
export function ownerToAcknowledge(
  conversation: Pick<ConversationItem, 'assignedTo'>,
  me: string | null,
): { readonly userId: string; readonly name: string | null } | null {
  const owner = conversation.assignedTo;
  if (owner === null || owner.userId === me) return null;
  return owner;
}

/** The server said someone else has it (a race the screen did not see coming). */
export function isAckRequired(error: unknown): boolean {
  // Read by its code, as `ApiError` carries it, so this module needs no HTTP client to test.
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'INBOX_OWNER_ACK_REQUIRED'
  );
}

/** Tags typed as `vip, eid ,  wholesale`: trimmed, each once, as the server takes them. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(',')) {
    const tag = part.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (tag === '' || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length === 20) break;
  }
  return out;
}

/** `+8801712345678` → `01712-345678`, how a Bangladeshi reads their own number back. */
export function displayPhone(e164: string): string {
  if (!/^\+8801\d{9}$/.test(e164)) return e164;
  const national = `0${e164.slice(4)}`;
  return `${national.slice(0, 5)}-${national.slice(5)}`;
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function stageTone(stage: ContactStage): Tone {
  switch (stage) {
    case 'fraud':
      return 'danger';
    case 'customer':
      return 'success';
    case 'lead':
      return 'info';
    case 'not_qualified':
    case 'visitor':
      return 'neutral';
  }
}

export function statusTone(status: MessageView['status']): Tone {
  switch (status) {
    case 'failed':
      return 'danger';
    case 'read':
    case 'delivered':
      return 'success';
    case 'queued':
      return 'warning';
    case 'sent':
    case 'received':
      return 'neutral';
  }
}

/** The words for why one of our messages failed: ours, Meta's coded refusal, or Meta's. */
export function failureKey(code: string):
  | {
      readonly key:
        | 'inbox.error.window_closed'
        | 'inbox.error.channel_not_ready'
        | 'inbox.error.meta_unreachable'
        | 'inbox.error.meta_refused';
    }
  | { readonly key: 'inbox.error.meta'; readonly code: string } {
  switch (code) {
    case 'window_closed':
      return { key: 'inbox.error.window_closed' };
    case 'channel_not_ready':
      return { key: 'inbox.error.channel_not_ready' };
    case 'meta_unreachable':
      return { key: 'inbox.error.meta_unreachable' };
    default:
      return code.startsWith('meta:')
        ? { key: 'inbox.error.meta', code: code.slice('meta:'.length) }
        : { key: 'inbox.error.meta_refused' };
  }
}

export const CHANNEL_KINDS: readonly ChannelKind[] = INBOX_CHANNEL_KINDS;
export const CONTACT_STAGES: readonly ContactStage[] = INBOX_CONTACT_STAGES;

/** Areas as the desk lists them, reduced to the district picker's options. */
export function districtsOf(
  areas: readonly { readonly districtId: number; readonly districtEn: string }[],
): { readonly id: number; readonly name: string }[] {
  const seen = new Map<number, string>();
  for (const area of areas)
    if (!seen.has(area.districtId)) seen.set(area.districtId, area.districtEn);
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function thanasOf(
  areas: readonly {
    readonly districtId: number;
    readonly thanaId: number;
    readonly thanaEn: string;
  }[],
  districtId: number | null,
): { readonly id: number; readonly name: string }[] {
  if (districtId === null) return [];
  return areas
    .filter((area) => area.districtId === districtId)
    .map((area) => ({ id: area.thanaId, name: area.thanaEn }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A price range for a product card: `৳1,200` or `৳1,200–1,500`, as poisha strings. */
export function priceRange(
  min: string | null,
  max: string | null,
): { readonly min: string; readonly max: string | null } | null {
  if (min === null) return null;
  return { min, max: max !== null && max !== min ? max : null };
}
