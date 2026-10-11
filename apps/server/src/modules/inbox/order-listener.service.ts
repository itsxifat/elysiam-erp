import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { stageAfterOrder } from '@elysium/domain/inbox';

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
 * (`OrdersApi.inboxOrigin`, invariant 12). The conversation's contact is linked to the buyer; every
 * contact with that buyer or that saved phone moves to Customer, except one marked Fraud, which
 * stays Fraud. Idempotent: a redelivered event finds them already there.
 */
@Injectable()
export class InboxOrderListener {
  constructor(@Inject(ORDERS_API) private readonly orders: OrdersApi) {}

  async onOrderCreated(event: DeliveredEvent): Promise<void> {
    const orderId = (event.payload as { id?: unknown } | null)?.id;
    if (typeof orderId !== 'string' || !UUID.test(orderId)) return;
    const orgId = event.orgId;
    await withOrg({ orgId, userId: INBOX_SYSTEM_USER }, async (tx) => {
      const origin = await this.orders.inboxOrigin(tx, orgId, orderId);
      if (origin === undefined) return;

      if (origin.inboxConversationId !== null) {
        const conversation = await repo.conversationById(tx, orgId, origin.inboxConversationId);
        if (conversation !== undefined) {
          await repo.linkCustomer(
            tx,
            orgId,
            conversation.contact_id,
            origin.customerId,
            origin.customerPhoneE164,
          );
        }
      }

      const contacts = await repo.contactsForBuyer(
        tx,
        orgId,
        origin.customerId,
        origin.customerPhoneE164,
      );
      for (const contact of contacts) {
        if (contact.customer_id === null) {
          await repo.linkCustomer(
            tx,
            orgId,
            contact.id,
            origin.customerId,
            origin.customerPhoneE164,
          );
        }
        const next = stageAfterOrder(contact.stage);
        if (next !== contact.stage) {
          await repo.setContactStage(tx, orgId, contact.id, next, 'system');
        }
      }
    });
  }
}
