import { poisha, takaText } from '../money/index.js';

/**
 * Saved replies (M44a, D-763; invariant 11): finding one by what was typed after `/`, and
 * filling its placeholders from the conversation before the agent sends it.
 *
 * The body is the brand's own text in any language, Bangla included; nothing here reads or
 * changes its words, only the four placeholders `{name}`, `{order_number}`, `{total}` and
 * `{phone}`. A placeholder with nothing to fill it is left as typed, so the agent sees what is
 * missing instead of sending a gap.
 */

export interface SavedReplyLike {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
  readonly body: string;
  readonly category: string | null;
  readonly usageCount: number;
}

/** What the conversation knows, as the screen has it. Every field optional. */
export interface PlaceholderValues {
  /** The contact's or the customer's name. */
  readonly name?: string | null;
  /** The customer's latest order number. */
  readonly orderNumber?: string | null;
  /** That order's amount, as a poisha string (the API's money). */
  readonly totalPoisha?: string | null;
  /** E.164, as the inbox stores phones. */
  readonly phoneE164?: string | null;
}

/** `+8801712345678` as a customer writes it back: `01712345678`. Anything else unchanged. */
export function nationalPhone(e164: string): string {
  return /^\+8801\d{9}$/.test(e164) ? `0${e164.slice(4)}` : e164;
}

function present(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The text each placeholder becomes, or null when the conversation has nothing for it. */
export function placeholderTexts(values: PlaceholderValues): Record<string, string | null> {
  const total = present(values.totalPoisha);
  let totalText: string | null = null;
  if (total !== null && /^-?\d+$/.test(total)) totalText = takaText(poisha(total));
  const phone = present(values.phoneE164);
  return {
    name: present(values.name),
    order_number: present(values.orderNumber),
    total: totalText,
    phone: phone === null ? null : nationalPhone(phone),
  };
}

export interface FilledReply {
  readonly text: string;
  /** Placeholders the conversation had nothing for, in the order they appear, each once. */
  readonly missing: readonly string[];
}

/**
 * The body with every known placeholder filled. `{Name}` and `{ name }` are not placeholders:
 * only the exact lower-case names in braces are, so a customer-facing brace in the brand's
 * text is never eaten.
 */
export function fillSavedReply(body: string, values: PlaceholderValues): FilledReply {
  const texts = placeholderTexts(values);
  const missing: string[] = [];
  const text = body.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    if (!(name in texts)) return whole;
    const value = texts[name] ?? null;
    if (value === null) {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    return value;
  });
  return { text, missing };
}

/**
 * The `/` token being typed at the caret: the word that starts with a slash at the start of the
 * text or after white space and runs to the caret. Null when the caret is not in one.
 */
export function slashQueryAt(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(^|\s)\/([^\s/]{0,32})$/u.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  return { start: before.length - query.length - 1, query };
}

/** Replace the `/query` token at `start..caret` with `insert`; the new text and caret. */
export function insertAtSlash(
  text: string,
  start: number,
  caret: number,
  insert: string,
): { readonly text: string; readonly caret: number } {
  const next = `${text.slice(0, start)}${insert}${text.slice(caret)}`;
  return { text: next, caret: start + insert.length };
}

function rank(reply: SavedReplyLike, query: string): number | null {
  if (query === '') return 0;
  const shortcut = reply.shortcut.toLowerCase();
  if (shortcut === query) return 0;
  if (shortcut.startsWith(query)) return 1;
  const title = reply.title.toLowerCase();
  if (title.startsWith(query)) return 2;
  if (shortcut.includes(query)) return 3;
  if (title.split(/\s+/).some((word) => word.startsWith(query))) return 4;
  if ((reply.category ?? '').toLowerCase().startsWith(query)) return 5;
  if (title.includes(query) || reply.body.toLowerCase().includes(query)) return 6;
  return null;
}

/**
 * The saved replies matching what was typed after `/`, best first: the shortcut exactly, then
 * starting with it, then the title, then anywhere in the body; ties go to the most used, then
 * the shortcut's order. Case-insensitive; a Bangla query matches a Bangla title or body.
 */
export function matchSavedReplies<T extends SavedReplyLike>(
  replies: readonly T[],
  query: string,
  limit = 8,
): T[] {
  const needle = query.trim().toLowerCase();
  return replies
    .map((reply) => ({ reply, score: rank(reply, needle) }))
    .filter((entry): entry is { reply: T; score: number } => entry.score !== null)
    .sort(
      (a, b) =>
        a.score - b.score ||
        b.reply.usageCount - a.reply.usageCount ||
        a.reply.shortcut.localeCompare(b.reply.shortcut),
    )
    .slice(0, limit)
    .map((entry) => entry.reply);
}

/** The quick-reply row: the most used, at most `count`, never one nobody has used. */
export function quickReplies<T extends SavedReplyLike>(replies: readonly T[], count = 5): T[] {
  return [...replies]
    .filter((reply) => reply.usageCount > 0)
    .sort((a, b) => b.usageCount - a.usageCount || a.shortcut.localeCompare(b.shortcut))
    .slice(0, count);
}
