import { Injectable } from '@nestjs/common';
import { defineAbilityFor } from '@elysium/contracts';
import type { RequestContext, Tx } from '@elysium/db';
import type { ContactStage, InboxChannelKind } from '@elysium/domain/inbox';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ConversationsService } from './conversations.service.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';
import * as repo from './inbox.repository.js';

/** How many of a buyer's inbox contacts the caller panel reads (D-860). */
const BUYER_CONTACTS = 10;

/** How many of their conversations it lists, the latest message first. */
const BUYER_CONVERSATIONS = 20;

/**
 * The inbox's service interface for other modules (invariant 12; M47). Telephony reads a buyer's
 * contacts, profiles and conversations through it for the caller panel (D-860), and asks the
 * conversation's owner before a Call from the inbox's panel (D-862).
 */
export interface InboxApi {
  /**
   * A buyer's inbox (D-860): the contacts linked to `customerId` or holding `phoneE164` (either
   * may be null), their profiles on each channel, their conversations (previews and `canOpen`
   * only for a viewer who may read Conversation), and whether any of the contacts is marked fraud.
   */
  contactsOfBuyer(
    tx: Tx,
    orgId: string,
    viewer: RequestContext,
    who: { readonly customerId: string | null; readonly phoneE164: string | null },
  ): Promise<BuyerInboxFacts>;

  /**
   * A Call from a conversation (D-862), in the caller's transaction: the inbox's own owner rule
   * (`lockForWrite`, then `recordWrite('call')`: the `inbox.call` audit row, and the owner told
   * when acknowledged). A viewer without `update Conversation` gets `INBOX_NOT_FOUND`, another
   * person's conversation without `acknowledged` `INBOX_OWNER_ACK_REQUIRED` (problem+json, 409);
   * supervisors are not exempt (D-710, D-737). The contact's phone and linked buyer.
   */
  guardCall(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    acknowledged: boolean,
  ): Promise<ConversationCallTarget>;
}

export const INBOX_API = Symbol('InboxApi');

/** M47 (D-860): what the inbox knows of a buyer or a phone. */
export interface BuyerInboxFacts {
  /** One of the contacts is at stage `fraud` (M42). */
  readonly fraud: boolean;
  readonly contacts: readonly BuyerInboxContact[];
  /** Each contact's profile on a channel (D-861: shown with the channel's mark). */
  readonly profiles: readonly BuyerInboxProfile[];
  readonly conversations: readonly BuyerInboxConversation[];
}

export interface BuyerInboxContact {
  readonly id: string;
  readonly displayName: string | null;
  /** Instagram's username, when the contact has one. */
  readonly handle: string | null;
  readonly stage: ContactStage;
  /** The phone saved on the contact (E.164), if any. */
  readonly phoneE164: string | null;
}

export interface BuyerInboxProfile {
  readonly contactId: string;
  readonly channel: InboxChannelKind;
  readonly profileName: string | null;
}

export interface BuyerInboxConversation {
  readonly id: string;
  readonly contactId: string;
  readonly channel: InboxChannelKind;
  readonly status: 'open' | 'closed';
  readonly lastMessageAt: Date;
  /** Who has it (a user id; names come from IAM), or null when nobody does. */
  readonly assignedToUserId: string | null;
  /** The last message's preview, only for a viewer who may read Conversation. */
  readonly preview: string | null;
  /** Whether the viewer may open it in the inbox (`read Conversation`). */
  readonly canOpen: boolean;
}

/** M47 (D-862): whom a Call from a conversation rings, and whose conversation it was. */
export interface ConversationCallTarget {
  readonly conversationId: string;
  /** The contact's saved phone (E.164), or null when the chat has none yet. */
  readonly phoneE164: string | null;
  /** The buyer the contact is linked to (D-739), if any. */
  readonly customerId: string | null;
  readonly ownerUserId: string | null;
}

@Injectable()
export class InboxApiService implements InboxApi {
  constructor(private readonly conversations: ConversationsService) {}

  async contactsOfBuyer(
    tx: Tx,
    orgId: string,
    viewer: RequestContext,
    who: { readonly customerId: string | null; readonly phoneE164: string | null },
  ): Promise<BuyerInboxFacts> {
    const contacts = await repo.contactsOfBuyer(tx, orgId, who, BUYER_CONTACTS);
    const ids = contacts.map((contact) => contact.id);
    const [profiles, conversations] = await Promise.all([
      repo.identitiesOfContacts(tx, orgId, ids),
      repo.conversationsOfContacts(tx, orgId, ids, BUYER_CONVERSATIONS),
    ]);
    const canRead = defineAbilityFor(viewer).can('read', 'Conversation');
    return {
      fraud: contacts.some((contact) => contact.stage === 'fraud'),
      contacts: contacts.map((contact) => ({
        id: contact.id,
        displayName: contact.display_name,
        handle: contact.handle,
        stage: contact.stage,
        phoneE164: contact.phone_e164,
      })),
      profiles: profiles.map((profile) => ({
        contactId: profile.contact_id,
        channel: profile.channel,
        profileName: profile.profile_name,
      })),
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        contactId: conversation.contact_id,
        channel: conversation.channel,
        status: conversation.status,
        lastMessageAt: new Date(conversation.last_message_at),
        assignedToUserId: conversation.assigned_to,
        preview: canRead ? conversation.last_preview : null,
        canOpen: canRead,
      })),
    };
  }

  async guardCall(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    acknowledged: boolean,
  ): Promise<ConversationCallTarget> {
    return mapInboxErrors(async () => {
      // The Call route declares PhoneCall; the inbox's own write ability is checked here.
      if (!defineAbilityFor(context).can('update', 'Conversation')) {
        throw new InboxError('INBOX_NOT_FOUND', 'No such conversation.');
      }
      const { row, ownership } = await this.conversations.lockForWrite(
        tx,
        context,
        conversationId,
        acknowledged,
      );
      const contact = await repo.contactById(tx, context.orgId, row.contact_id);
      if (contact === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such conversation.');
      await this.conversations.recordWrite(tx, context, request, {
        action: 'call',
        conversationId,
        ownership,
        entityType: 'inbox_contact',
        entityId: contact.id,
      });
      return {
        conversationId,
        phoneE164: contact.phone_e164,
        customerId: contact.customer_id,
        ownerUserId: row.assigned_to,
      };
    });
  }
}
