import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * The seam for auto-offer (M42, D-737).
 *
 * M41 builds the engine that offers new work to the least-loaded active person whose work types
 * include it, with a countdown and a decline. When a conversation nobody has takes a new message,
 * the inbox calls `offerNew` inside the transaction that recorded it; M41 binds its engine here
 * after it merges (an offer is a row and an event, so it belongs in that transaction; anything
 * slow is a job it enqueues). Until then the default does nothing and the conversation waits in
 * Unassigned for someone to take it.
 */
export interface ConversationOfferPort {
  offerNew(tx: Tx, orgId: string, conversationId: string): Promise<void>;
}

export const CONVERSATION_OFFER = Symbol('ConversationOffer');

@Injectable()
export class NoAutoOffer implements ConversationOfferPort {
  offerNew(): Promise<void> {
    return Promise.resolve();
  }
}
