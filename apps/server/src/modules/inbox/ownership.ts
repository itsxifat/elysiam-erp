import { InboxError } from './inbox.errors.js';

/**
 * Whose a conversation is, for a write (M42, D-737): its owner, nobody's, or someone else's
 * that the caller acknowledged. Without the acknowledgement a write on someone else's
 * conversation is refused (`INBOX_OWNER_ACK_REQUIRED`); with it the write goes ahead, the audit
 * row says whose it was, and the owner is told.
 */
export type Ownership =
  | { readonly kind: 'owner' }
  | { readonly kind: 'unassigned' }
  | { readonly kind: 'acknowledged'; readonly ownerUserId: string };

export function ownershipFor(
  assignedTo: string | null,
  actorUserId: string,
  acknowledged: boolean,
  ownerName: string | null,
): Ownership {
  if (assignedTo === actorUserId) return { kind: 'owner' };
  if (assignedTo === null) return { kind: 'unassigned' };
  if (!acknowledged) {
    throw new InboxError(
      'INBOX_OWNER_ACK_REQUIRED',
      `${ownerName ?? 'A colleague'} has this conversation. Confirm that you want to act in it anyway; they will be told.`,
      'owned_by_other',
    );
  }
  return { kind: 'acknowledged', ownerUserId: assignedTo };
}

/** The uniform header (`x-acknowledge-owner: 1`), read off a request's headers. */
export function acknowledgedIn(headers: Readonly<Record<string, unknown>>): boolean {
  const value = headers['x-acknowledge-owner'];
  return value === '1' || value === 'true';
}
