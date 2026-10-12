/**
 * A reply being written, kept per conversation (M44a, D-767): switching to another chat and
 * back finds the words where they were, and a reload of the tab keeps them too (this tab's
 * session storage, behind try/catch; storage denied keeps them for the visit). Sent or emptied,
 * the draft is gone.
 */

const KEY = 'erp-inbox-drafts';
const LIMIT = 50;

let drafts: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (drafts !== null) return drafts;
  drafts = new Map();
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [id, text] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof text === 'string' && text !== '') drafts.set(id, text);
      }
    }
  } catch {
    // Unreadable or denied: start empty.
  }
  return drafts;
}

export function readDraft(conversationId: string): string {
  return load().get(conversationId) ?? '';
}

export function writeDraft(conversationId: string, text: string): void {
  const all = load();
  all.delete(conversationId);
  if (text.trim() !== '') all.set(conversationId, text);
  // The oldest go first once there are too many.
  while (all.size > LIMIT) {
    const oldest = all.keys().next().value;
    if (oldest === undefined) break;
    all.delete(oldest);
  }
  try {
    sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(all)));
  } catch {
    // Storage denied: the draft lasts for this visit.
  }
}
