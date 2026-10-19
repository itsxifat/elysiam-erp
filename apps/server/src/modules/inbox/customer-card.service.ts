import { Inject, Injectable } from '@nestjs/common';
import type {
  CustomerAddressInput,
  CustomerDetailsInput,
  CustomerPhoneAddInput,
  CustomerPhoneRetireInput,
  CustomerPhoneUpdateInput,
  InboxLinkCustomerInput,
  InboxSaveCustomerInput,
} from '@elysium/contracts/customers';
import { withOrg, type Tx } from '@elysium/db';
import { isNormalizableBdPhone, normalizeBdPhone } from '@elysium/domain';
import { phonesAcrossMessages, reconcileStage } from '@elysium/domain/inbox';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { emit } from '../../platform/events/outbox.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { ConversationsService } from './conversations.service.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';
import * as repo from './inbox.repository.js';
import type { Ownership } from './ownership.js';
import * as profiles from './profiles.repository.js';

/** How many recent inbound messages are read for the numbers the customer gave (as the panel). */
const PHONE_SCAN_MESSAGES = 50;

interface Linked {
  readonly row: repo.ConversationRow;
  readonly ownership: Ownership;
  readonly contact: repo.ContactRow;
}

/**
 * The customer card beside a thread (M49, D-890 to D-895): the buyer a chat is linked to, seen and
 * edited from the inbox the way the buyer page does it (details, every number with the staff's
 * notes, the address book), and the chat saved as a customer or linked to one.
 *
 * Who may is the conversation's rule, not the buyer's reach (D-890): whoever may write in this
 * conversation (`update Conversation`, with the go-ahead on someone else's, D-737) may correct the
 * buyer it is linked to, because the link itself says the person in the chat is that buyer (the
 * number came from the chat, or the agent could open that buyer anyway, D-740). The writes are the
 * orders module's (`OrdersApi`, invariant 12), audited there as the buyer page's own; the inbox adds
 * its own row saying which conversation it came from, and tells the other screens on this chat.
 */
@Injectable()
export class InboxCustomerService {
  constructor(
    private readonly conversations: ConversationsService,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
  ) {}

  // --- the linked buyer's card ----------------------------------------------------------------

  updateDetails(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    patch: CustomerDetailsInput,
    acknowledged: boolean,
  ) {
    return this.onLinked(
      context,
      request,
      conversationId,
      acknowledged,
      'customer.details',
      (tx, id) => this.orders.updateCustomerDetails(tx, context, request, id, patch),
    );
  }

  addPhone(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: CustomerPhoneAddInput,
    acknowledged: boolean,
  ) {
    return this.onLinked(
      context,
      request,
      conversationId,
      acknowledged,
      'customer.phone_added',
      (tx, id) => this.orders.addCustomerPhone(tx, context, request, id, input),
    );
  }

  updatePhone(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    phoneId: string,
    input: CustomerPhoneUpdateInput,
    acknowledged: boolean,
  ) {
    return this.onLinked(
      context,
      request,
      conversationId,
      acknowledged,
      'customer.phone_updated',
      (tx, id) => this.orders.updateCustomerPhone(tx, context, request, id, phoneId, input),
    );
  }

  retirePhone(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    phoneId: string,
    input: CustomerPhoneRetireInput,
    acknowledged: boolean,
  ) {
    return this.onLinked(
      context,
      request,
      conversationId,
      acknowledged,
      'customer.phone_retired',
      (tx, id) => this.orders.retireCustomerPhone(tx, context, request, id, phoneId, input),
    );
  }

  addAddress(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: CustomerAddressInput,
    acknowledged: boolean,
  ) {
    return this.onLinked(
      context,
      request,
      conversationId,
      acknowledged,
      'customer.address_added',
      (tx, id) => this.orders.addCustomerAddress(tx, context, request, id, input),
    );
  }

  replaceAddress(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    addressId: string,
    input: CustomerAddressInput,
    acknowledged: boolean,
  ) {
    return this.onLinked(
      context,
      request,
      conversationId,
      acknowledged,
      'customer.address_updated',
      (tx, id) => this.orders.replaceCustomerAddress(tx, context, request, id, addressId, input),
    );
  }

  removeAddress(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    addressId: string,
    acknowledged: boolean,
  ) {
    return this.onLinked(
      context,
      request,
      conversationId,
      acknowledged,
      'customer.address_removed',
      (tx, id) => this.orders.removeCustomerAddress(tx, context, request, id, addressId),
    );
  }

  // --- saving or linking the chat's person ----------------------------------------------------

  /**
   * Save the chat's person as a new customer (D-892): the name typed, the number given (else the
   * contact's saved one) and the contact's saved address as their first. Always a new record; one
   * of the people already on the number is linked with `link` instead. The contact keeps the number
   * and is linked to the new buyer.
   */
  async save(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxSaveCustomerInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const linked = await this.lock(tx, context, conversationId, acknowledged);
        const { contact } = linked;
        if (contact.customer_id !== null) {
          throw new InboxError('INBOX_NO_CUSTOMER', 'This chat is already linked to a customer.');
        }
        const typed = input.phone ?? contact.phone_e164;
        if (typed === null || !isNormalizableBdPhone(typed)) {
          throw new InboxError('INBOX_INVALID', 'Give a Bangladeshi mobile number first.');
        }
        const phone = normalizeBdPhone(typed);
        const address =
          contact.district_id === null || contact.thana_id === null || contact.address_line === null
            ? undefined
            : {
                districtId: contact.district_id,
                thanaId: contact.thana_id,
                ...(contact.area === null ? {} : { area: contact.area }),
                addressLine: contact.address_line,
              };
        const saved = await this.orders.saveChatCustomer(tx, context, request, {
          name: input.name,
          phoneE164: phone,
          newPerson: true,
          ...(address === undefined ? {} : { address }),
        });
        await repo.setContactPhone(tx, context.orgId, contact.id, phone, saved.id);
        await repo.nameContactIfUnnamed(tx, context.orgId, contact.id, input.name);
        await this.finish(tx, context, request, linked, 'customer.saved', {
          before: { phone: contact.phone_e164, customerId: null },
          after: { phone, customerId: saved.id },
        });
        return { customerId: saved.id };
      }),
    );
  }

  /**
   * This chat is that customer (D-892): one of the people on the contact's saved number, linked
   * only when the customer gave the number in this chat (an inbound message or their WhatsApp id)
   * or when the agent may open that buyer anyway, the rule a saved phone follows (D-740).
   */
  async link(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxLinkCustomerInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const linked = await this.lock(tx, context, conversationId, acknowledged);
        const { contact, row } = linked;
        const phone = contact.phone_e164;
        if (phone === null) {
          throw new InboxError('INBOX_INVALID', 'Save the customer’s number first.');
        }
        if (!(await this.orders.customerUsesPhone(tx, context.orgId, input.customerId, phone))) {
          throw new InboxError('INBOX_INVALID', 'That customer does not use this number.');
        }
        const fromChat = await this.numberFromChat(tx, context.orgId, row, phone);
        if (
          !fromChat &&
          !(await this.orders.customerReachable(tx, context.orgId, input.customerId, context))
        ) {
          throw new InboxError(
            'INBOX_INVALID',
            'Link a customer only when they gave this number in the chat, or when you can open them.',
          );
        }
        await repo.linkCustomer(tx, context.orgId, contact.id, input.customerId, phone);
        // A buyer who has ordered makes the contact a Customer now (D-738), as saving a phone does.
        const buyer = await this.orders.customerPanel(
          tx,
          context.orgId,
          input.customerId,
          0,
          context,
        );
        if (buyer !== undefined) {
          await repo.nameContactIfUnnamed(tx, context.orgId, contact.id, buyer.name);
        }
        const ordered = (buyer?.orders ?? 0) > 0;
        const stage = reconcileStage(contact.stage, { hasOrdered: ordered });
        if (stage !== contact.stage) {
          await repo.setContactStage(tx, context.orgId, contact.id, stage, 'system');
        }
        await this.finish(tx, context, request, linked, 'customer.linked', {
          before: { customerId: contact.customer_id },
          after: { customerId: input.customerId },
        });
        return { customerId: input.customerId };
      }),
    );
  }

  /** The chat is not that customer after all (D-892): the link goes, the number stays. */
  async unlink(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const linked = await this.lock(tx, context, conversationId, acknowledged);
        const before = linked.contact.customer_id;
        if (before === null) {
          throw new InboxError('INBOX_NO_CUSTOMER', 'This chat is not linked to a customer.');
        }
        await repo.unlinkCustomer(tx, context.orgId, linked.contact.id);
        await this.finish(tx, context, request, linked, 'customer.unlinked', {
          before: { customerId: before },
          after: { customerId: null },
        });
        return { customerId: null };
      }),
    );
  }

  /** Whether the customer gave this number in the chat: a recent inbound message or WhatsApp. */
  async numberFromChat(
    tx: Tx,
    orgId: string,
    row: repo.ConversationRow,
    phone: string,
  ): Promise<boolean> {
    const texts = await repo.recentInboundTexts(tx, orgId, row.id, PHONE_SCAN_MESSAGES);
    return phonesAcrossMessages(
      texts,
      row.channel_kind === 'whatsapp' ? [`+${row.external_user_id}`] : [],
    ).some((found) => found === phone);
  }

  // --- the plumbing ----------------------------------------------------------------------------

  /** A write on the linked buyer: locked through the conversation, then audited and announced. */
  private onLinked(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    acknowledged: boolean,
    action: string,
    work: (tx: Tx, customerId: string) => Promise<void>,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const linked = await this.lock(tx, context, conversationId, acknowledged);
        const customerId = linked.contact.customer_id;
        if (customerId === null) {
          throw new InboxError(
            'INBOX_NO_CUSTOMER',
            'This chat is not linked to a customer yet: save them as a customer first.',
          );
        }
        await work(tx, customerId);
        await this.finish(tx, context, request, linked, action, { after: { customerId } });
        return { customerId };
      }),
    );
  }

  private async lock(
    tx: Tx,
    context: ActiveContext,
    conversationId: string,
    acknowledged: boolean,
  ): Promise<Linked> {
    const { row, ownership } = await this.conversations.lockForWrite(
      tx,
      context,
      conversationId,
      acknowledged,
    );
    const contact = await repo.contactById(tx, context.orgId, row.contact_id);
    if (contact === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such contact.');
    return { row, ownership, contact };
  }

  /** The inbox's audit row (which conversation, whose it was) and the other screens told. */
  private async finish(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    linked: Linked,
    action: string,
    change: {
      readonly before?: Record<string, unknown>;
      readonly after?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.conversations.recordWrite(tx, context, request, {
      action,
      conversationId: linked.row.id,
      ownership: linked.ownership,
      entityType: 'inbox_contact',
      entityId: linked.contact.id,
      before: change.before ?? null,
      after: change.after ?? null,
    });
    await emit(
      tx,
      'inbox.contact_updated',
      {
        contactId: linked.contact.id,
        conversationIds: await profiles.conversationIdsOfContact(
          tx,
          context.orgId,
          linked.contact.id,
        ),
      },
      { orgId: context.orgId },
    );
  }
}
