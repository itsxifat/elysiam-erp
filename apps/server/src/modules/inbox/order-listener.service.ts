import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { stageAfterOrder, type ContactStage } from '@elysium/domain/inbox';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { DeliveredEvent } from '../../platform/events/dispatcher.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import * as repo from './inbox.repository.js';
import { INBOX_SYSTEM_USER } from './webhook.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A contact becomes a Customer when an order is placed for them (M42, D-738, D-742).
 *
 * Hears `order.created` from the outbox in the worker, as the storefront's mail hears status
 * changes, and asks the orders module whose order it is and which conversation it came from
 * (`OrdersApi.inboxOrigin`, invariant 12; only a taker who reads the inbox may name one).
 *
 * - The conversation the order came from: its contact moves to Customer (Fraud stays Fraud), and
 *   is linked to the order's buyer only when it has no buyer yet and no other saved phone, so an
 *   order sent to a friend's number does not rewrite who the contact is.
 * - Every contact already linked to that buyer, or whose saved phone is the buyer's: moves to
 *   Customer, and is linked if it was not.
 *
 * A contact linked to another buyer is never relinked. Each change is audited as the inbox's
 * own system actor, in the same transaction. Idempotent: a redelivered event finds them there.
 */
@Injectable()
export class InboxOrderListener {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly audit: AuditService,
  ) {}

  async onOrderCreated(event: DeliveredEvent): Promise<void> {
    const orderId = (event.payload as { id?: unknown } | null)?.id;
    if (typeof orderId !== 'string' || !UUID.test(orderId)) return;
    const orgId = event.orgId;
    await withOrg({ orgId, userId: INBOX_SYSTEM_USER }, async (tx) => {
      const origin = await this.orders.inboxOrigin(tx, orgId, orderId);
      if (origin === undefined) return;

      if (origin.inboxConversationId !== null) {
        const conversation = await repo.conversationById(tx, orgId, origin.inboxConversationId);
        const contact =
          conversation === undefined
            ? undefined
            : await repo.contactById(tx, orgId, conversation.contact_id);
        if (contact !== undefined) {
          const link =
            contact.customer_id === null &&
            (contact.phone_e164 === null || contact.phone_e164 === origin.customerPhoneE164);
          await this.settle(tx, orgId, orderId, contact, link, origin);
        }
      }

      for (const contact of await repo.contactsForBuyer(
        tx,
        orgId,
        origin.customerId,
        origin.customerPhoneE164,
      )) {
        const link = contact.customer_id === null;
        await this.settle(tx, orgId, orderId, contact, link, origin);
      }
    });
  }

  private async settle(
    tx: Tx,
    orgId: string,
    orderId: string,
    contact: {
      readonly id: string;
      readonly stage: ContactStage;
      readonly customer_id: string | null;
    },
    link: boolean,
    origin: { readonly customerId: string; readonly customerPhoneE164: string },
  ): Promise<void> {
    const next = stageAfterOrder(contact.stage);
    if (!link && next === contact.stage) return;
    if (link) {
      await repo.linkCustomer(tx, orgId, contact.id, origin.customerId, origin.customerPhoneE164);
    }
    if (next !== contact.stage) {
      await repo.setContactStage(tx, orgId, contact.id, next, 'system');
    }
    await this.audit.record(tx, {
      orgId,
      actorUserId: INBOX_SYSTEM_USER,
      operation: 'update',
      action: 'inbox.contact.ordered',
      entityType: 'inbox_contact',
      entityId: contact.id,
      before: { stage: contact.stage, customerId: contact.customer_id },
      after: {
        stage: next,
        customerId: link ? origin.customerId : contact.customer_id,
        orderId,
      },
    });
  }
}
