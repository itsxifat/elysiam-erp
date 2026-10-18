import { Inject, Injectable } from '@nestjs/common';
import { scopeFilterFor } from '@elysium/contracts';
import type {
  CallerPanelAnswer,
  CallerPanelCall,
  CallerPanelFull,
  CallerPanelMinimal,
  CallerPanelOrder,
  CallerPanelPhone,
  CallerPanelQuery,
} from '@elysium/contracts/telephony';
import { withOrg, type Tx } from '@elysium/db';
import { customerPhoneFrom } from '@elysium/domain/telephony';

import type { ActiveContext } from '../../platform/http/context.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { INBOX_API, type InboxApi } from '../inbox/inbox.api.js';
import { ORDERS_API, type CustomerOrderFact, type OrdersApi } from '../orders/orders.api.js';
import { STOREFRONT_API, type StorefrontApi } from '../storefront/storefront.api.js';
import * as panelRepo from './caller-panel.repository.js';
import { callScopeSql } from './calls.service.js';
import { mapTelephonyErrors, TelephonyError } from './telephony.errors.js';
import * as repo from './telephony.repository.js';

/** A page of the buyer's orders (D-860). */
const ORDERS_PAGE = 20;

/** How many calls the panel's history lists, newest first. */
const CALLS_LISTED = 50;

/** A call that ended this recently still opens the whole panel to the person who had it. */
const ENDED_WINDOW_MS = 30 * 60_000;

/** A call with no end from longer ago than this is one whose end Envo never sent. */
const LIVE_WINDOW_MS = 2 * 3600_000;

/** The orders the minimal answer lists: the ones a call could still be about. */
const OPEN_STATUSES = new Set([
  'pending',
  'on_hold',
  'confirmed',
  'packed',
  'shipped',
  'return_in_transit',
  'exchange',
]);

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function orderView(order: CustomerOrderFact): CallerPanelOrder {
  return {
    id: order.id,
    orderNo: order.orderNo,
    status: order.status,
    codAmountPoisha: order.codAmountPoisha,
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * The caller panel (M47, D-860): everything the brand knows of the person on the phone, in one
 * answer: the pinned note, all their orders a page at a time, their addresses, other phones,
 * website emails, inbox profiles and conversations, and every call with them with its wrap-up.
 *
 * The whole panel goes to a supervisor (the brand's calls at `org`), to a person who may open the
 * buyer (`customerReachable`), and to one who is on a call with that number now or had one in the
 * last half hour (an inbound call still ringing on their connection included). Anyone else gets
 * today's screen pop: the buyer's name and open orders, and the name only when asked by a call
 * already in their own call scope, so the route is no phone-to-buyer lookup. The history shows
 * colleagues' calls with their wrap-ups to whoever sees the whole panel ("previously another
 * staff was managing"); who may hear a recording is still D-841's call scope (`canPlay`).
 *
 * Buyers and orders through `ORDERS_API`, the inbox through `INBOX_API`, website accounts through
 * `STOREFRONT_API`, names through `IAM_API` (invariant 12). A read: one transaction, no Envo.
 */
@Injectable()
export class CallerPanelService {
  constructor(
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(INBOX_API) private readonly inbox: InboxApi,
    @Inject(STOREFRONT_API) private readonly storefront: StorefrontApi,
    @Inject(IAM_API) private readonly iam: IamApi,
  ) {}

  async panel(
    context: ActiveContext,
    request: object,
    query: CallerPanelQuery,
  ): Promise<CallerPanelAnswer> {
    // The route's own scope (D-841) decides which calls the viewer may hear, and a call asked
    // about by id must be one of theirs.
    const callScope = callScopeSql(request);
    return mapTelephonyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const orgId = context.orgId;
        let phone: string | null = null;
        let customerId: string | null = null;
        let namedByCall = false;
        if (query.callId !== undefined) {
          const call = await panelRepo.callParty(tx, orgId, query.callId, callScope);
          if (call === undefined) throw new TelephonyError('TELEPHONY_NOT_FOUND', 'No such call.');
          phone =
            call.customer_phone_e164 ??
            customerPhoneFrom(call.direction === 'inbound' ? call.from_number : call.to_number);
          customerId = call.customer_id;
          namedByCall = call.customer_id !== null;
        } else if (query.customerId !== undefined) {
          customerId = query.customerId;
        } else {
          phone = customerPhoneFrom(query.phone);
          if (phone === null) return minimal(null, null, []);
        }
        if (customerId === null && phone !== null) {
          customerId = (await this.orders.buyerIdByPhone(tx, orgId, phone)) ?? null;
        }
        const customer =
          customerId === null ? undefined : await this.orders.callerCustomer(tx, orgId, customerId);
        if (customer === undefined) customerId = null;
        phone = phone ?? customer?.phoneE164 ?? null;
        const party = { customerId, phoneE164: phone };

        if (!(await this.fullPanel(tx, context, party))) {
          if (customer === undefined || !namedByCall) return minimal(phone, null, []);
          const page = await this.orders.customerOrdersPage(tx, orgId, customer.id, context, {
            limit: ORDERS_PAGE,
            cursor: null,
          });
          return minimal(
            phone,
            { id: customer.id, name: customer.name },
            page.items.filter((order) => OPEN_STATUSES.has(order.status)).map(orderView),
          );
        }

        const [names, inbox, calls] = await Promise.all([
          this.iam.activeMembers(tx, orgId),
          this.inbox.contactsOfBuyer(tx, orgId, context, party),
          panelRepo.callsWith(tx, orgId, party, callScope, CALLS_LISTED),
        ]);
        const nameOf = new Map(names.map((member) => [member.userId, member.name]));
        const person = (id: string | null) =>
          id === null ? null : { id, name: nameOf.get(id) ?? null };

        const facts =
          customer === undefined
            ? null
            : await Promise.all([
                this.orders.customerOrdersPage(tx, orgId, customer.id, context, {
                  limit: ORDERS_PAGE,
                  cursor: query.ordersCursor ?? null,
                }),
                this.orders.customerAddresses(tx, orgId, customer.id),
                this.orders.customerOtherPhones(tx, orgId, customer.id),
                this.storefront.accountsOfCustomer(tx, orgId, customer.id),
                this.orders.pinnedNoteAllowed(tx, orgId, customer.id, context),
              ]);

        // The order's recipients first, then the phones saved on their inbox contacts.
        const otherPhones: CallerPanelPhone[] = [];
        const seen = new Set(phone === null ? [] : [phone]);
        for (const other of facts?.[2] ?? []) {
          if (seen.has(other)) continue;
          seen.add(other);
          otherPhones.push({ phone: other, source: 'order' });
        }
        for (const contact of inbox.contacts) {
          if (contact.phoneE164 === null || seen.has(contact.phoneE164)) continue;
          seen.add(contact.phoneE164);
          otherPhones.push({ phone: contact.phoneE164, source: 'inbox' });
        }

        const contactsById = new Map(inbox.contacts.map((contact) => [contact.id, contact]));
        const answer: CallerPanelFull = {
          full: true,
          phone,
          customer:
            customer === undefined || facts === null
              ? null
              : {
                  id: customer.id,
                  name: customer.name,
                  phone: customer.phoneE164,
                  tags: customer.tags,
                  segment: customer.segment,
                  fraud: inbox.fraud,
                  pinnedNote:
                    customer.pinnedNote === null
                      ? null
                      : {
                          body: customer.pinnedNote.body,
                          byUserId: customer.pinnedNote.byUserId,
                          byName: nameOf.get(customer.pinnedNote.byUserId) ?? null,
                          at: customer.pinnedNote.at.toISOString(),
                        },
                  canPin: facts[4],
                  stats: {
                    orders: customer.orders,
                    delivered: customer.delivered,
                    returned: customer.returned,
                    cancelled: customer.cancelled,
                    returnRateBps: customer.returnRateBps,
                    spentPoisha: customer.spentPoisha.toString(),
                    firstOrderAt: iso(customer.firstOrderAt),
                    lastOrderAt: iso(customer.lastOrderAt),
                  },
                },
          orders:
            facts === null
              ? { items: [], nextCursor: null }
              : { items: facts[0].items.map(orderView), nextCursor: facts[0].nextCursor },
          addresses: (facts?.[1] ?? []).map((address) => ({
            source: address.source,
            label: address.label,
            district: address.districtName,
            thana: address.thanaName,
            area: address.area,
            addressLine: address.addressLine,
            isDefault: address.isDefault,
          })),
          otherPhones,
          emails: facts?.[3] ?? [],
          socials: inbox.profiles.map((profile) => {
            const contact = contactsById.get(profile.contactId);
            return {
              contactId: profile.contactId,
              channel: profile.channel,
              displayName: contact?.displayName ?? null,
              profileName: profile.profileName,
              handle: contact?.handle ?? null,
            };
          }),
          conversations: inbox.conversations.map((conversation) => ({
            id: conversation.id,
            channel: conversation.channel,
            status: conversation.status,
            lastMessageAt: conversation.lastMessageAt.toISOString(),
            assignedTo: person(conversation.assignedToUserId),
            preview: conversation.preview,
            canOpen: conversation.canOpen,
          })),
          calls: calls.map((call) => callView(call, person)),
        };
        return answer;
      }),
    );
  }

  /** Whether the viewer sees the whole panel for this buyer or number (D-860). */
  private async fullPanel(
    tx: Tx,
    context: ActiveContext,
    party: panelRepo.Party,
  ): Promise<boolean> {
    // A supervisor: the brand's calls at `org` (org_admin, branch_manager; D-841).
    if (scopeFilterFor(context, 'read', 'PhoneCall').kind === 'all') return true;
    if (
      party.customerId !== null &&
      (await this.orders.customerReachable(tx, context.orgId, party.customerId, context))
    ) {
      return true;
    }
    const assignment = await repo.assignmentOfUser(tx, context.orgId, context.userId);
    const now = Date.now();
    return panelRepo.onCallWith(
      tx,
      context.orgId,
      { userId: context.userId, connectionId: assignment?.connection_id ?? null },
      party,
      { liveSince: new Date(now - LIVE_WINDOW_MS), endedSince: new Date(now - ENDED_WINDOW_MS) },
    );
  }
}

function minimal(
  phone: string | null,
  customer: CallerPanelMinimal['customer'],
  openOrders: readonly CallerPanelOrder[],
): CallerPanelMinimal {
  return { full: false, phone, customer, openOrders };
}

function callView(
  row: panelRepo.PanelCallRow,
  person: (id: string | null) => { id: string; name: string | null } | null,
): CallerPanelCall {
  const wrapUpAt = iso(row.wrapped_up_at);
  return {
    id: row.id,
    person: person(row.user_id),
    direction: row.direction,
    status: row.status,
    answered: row.answered,
    occurredAt: iso(row.occurred_at) ?? '',
    talkSeconds: row.talk_seconds,
    durationSeconds: row.duration_seconds,
    order: row.order_id === null ? null : { id: row.order_id, orderNo: row.order_no ?? '' },
    wrapUp:
      row.wrap_up_result === null || row.wrapped_up_by_user_id === null || wrapUpAt === null
        ? null
        : {
            result: row.wrap_up_result,
            note: row.wrap_up_note,
            callBackAt: iso(row.wrap_up_call_back_at),
            byUserId: row.wrapped_up_by_user_id,
            byName: person(row.wrapped_up_by_user_id)?.name ?? null,
            at: wrapUpAt,
          },
    hasRecording: row.has_recording,
    canPlay: row.has_recording && row.in_scope,
  };
}
