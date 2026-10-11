import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * The seam for auto-offer (M42, D-737).
 *
 * M41 builds the engine that offers new work to the least-loaded active person whose work types
 * include it, with a countdown and a decline. When a conversation nobody has takes a new message,
 * the inbox calls `offerNew` inside the transaction that recorded it (an offer is a row and an
 * event, so it belongs in that transaction; anything slow is a job it enqueues). Bound to M41's
 * engine by `ConversationOffersService` (D-748); `NoAutoOffer` stays for a test that wants the
 * conversation to wait in Unassigned whatever the brand's switch says.
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
