import { Inject, Injectable } from '@nestjs/common';
import type {
  InboxAddressInput,
  InboxInterestInput,
  InboxNoteInput,
  InboxPhoneInput,
  InboxStageInput,
  InboxTagsInput,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { isNormalizableBdPhone, normalizeBdPhone } from '@elysium/domain';
import {
  addressesInTexts,
  areaMatcher,
  chooseStage,
  phoneFromWhatsAppId,
  phonesAcrossMessages,
  reconcileStage,
} from '@elysium/domain/inbox';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { IAM_API, type IamApi } from '../iam/iam.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { ConversationsService } from './conversations.service.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';
import * as repo from './inbox.repository.js';

/** The geography as a matcher, compiled once per process: it is reference data. */
let geography:
  | Promise<{
      readonly matcher: ReturnType<typeof areaMatcher>;
      readonly names: ReadonlyMap<number, { thana: string; district: string }>;
    }>
  | undefined;

function geographyIn(tx: Tx) {
  geography ??= repo.areaNames(tx).then((rows) => ({
    matcher: areaMatcher(
      rows.map((row) => ({
        thanaId: row.thana_id,
        districtId: row.district_id,
        thanaNames: [row.thana_en, row.thana_bn],
        districtNames: [row.district_en, row.district_bn],
      })),
    ),
    names: new Map(
      rows.map((row) => [row.thana_id, { thana: row.thana_en, district: row.district_en }]),
    ),
  }));
  geography.catch(() => {
    geography = undefined;
  });
  return geography;
}

/** How many recent inbound messages are read for phone numbers. */
const PHONE_SCAN_MESSAGES = 50;
/** How many of the customer's orders the panel lists. */
const RECENT_ORDERS = 10;
/** How many of a buyer's chats, and of the notes in them, the buyer page lists (D-895). */
const CUSTOMER_CHATS = 20;
const CUSTOMER_NOTES = 30;

/** Messenger, Instagram and WhatsApp, as §9's order channels name them (`channels.ts`, D-742). */
export const ORDER_CHANNEL_FOR = {
  messenger: 'facebook',
  instagram: 'instagram',
  whatsapp: 'whatsapp',
} as const;

const iso = (value: string | Date | null): string | null =>
  value === null ? null : new Date(value).toISOString();

/**
 * The customer panel beside a thread (M42, D-738 to D-742): phones found in the chat, the address,
 * the matched customer and their orders, notes, product interests, tags and the stage; and the
 * order desk's draft and fraud warning.
 *
 * Buyers and orders are the orders module's (`OrdersApi`), products the catalog's (`CatalogApi`),
 * people identity's (`IamApi`): asked, never read from their tables (invariant 12). Every write
 * goes through the conversation, so the ownership rule (D-737) covers the panel too.
 */
@Injectable()
export class ContactPanelService {
  constructor(
    private readonly conversations: ConversationsService,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(IAM_API) private readonly iam: IamApi,
  ) {}

  private async contactOf(tx: Tx, orgId: string, conversationId: string) {
    const conversation = await repo.conversationById(tx, orgId, conversationId);
    if (conversation === undefined) {
      throw new InboxError('INBOX_NOT_FOUND', 'No such conversation.');
    }
    const contact = await repo.contactById(tx, orgId, conversation.contact_id);
    if (contact === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such contact.');
    return { conversation, contact };
  }

  async panel(context: ActiveContext, conversationId: string) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { conversation, contact } = await this.contactOf(tx, context.orgId, conversationId);

        const texts = await repo.recentInboundTexts(
          tx,
          context.orgId,
          conversationId,
          PHONE_SCAN_MESSAGES,
        );
        const fromWhatsApp =
          conversation.channel_kind === 'whatsapp'
            ? phoneFromWhatsAppId(conversation.external_user_id)
            : null;
        const found = phonesAcrossMessages(texts, fromWhatsApp === null ? [] : [fromWhatsApp]);
        const phonesFound = await Promise.all(
          found.slice(0, 5).map(async (phone) => ({
            phone,
            saved: phone === contact.phone_e164,
            matchesCustomer:
              (await this.orders.buyerIdByPhone(tx, context.orgId, phone)) !== undefined,
          })),
        );

        // Addresses the customer typed (D-739): the thana, the district, the message as the line.
        const places = await geographyIn(tx);
        const addressesFound = addressesInTexts(texts, places.matcher).map((found) => ({
          districtId: found.districtId,
          thanaId: found.thanaId,
          thanaName: places.names.get(found.thanaId)?.thana ?? '',
          districtName: places.names.get(found.thanaId)?.district ?? '',
          line: found.line,
        }));

        const customer =
          contact.customer_id === null
            ? undefined
            : await this.orders.customerPanel(
                tx,
                context.orgId,
                contact.customer_id,
                RECENT_ORDERS,
                context,
              );
        // Shown in step with the orders (D-738). The order listener writes it when an order is
        // placed; this only covers an order it has not heard of yet, and writes nothing.
        const stage = reconcileStage(contact.stage, {
          hasOrdered: customer !== undefined && customer.orders > 0,
        });

        const [notes, interests, names] = await Promise.all([
          repo.notesOf(tx, context.orgId, contact.id),
          repo.interestsOf(tx, context.orgId, contact.id),
          this.iam.nameBook(tx, context.orgId),
        ]);

        // M49 (D-890): the linked buyer's whole card, edited from here through the conversation.
        const card =
          contact.customer_id === null
            ? undefined
            : await this.orders.customerCard(tx, context.orgId, contact.customer_id);
        // Not linked yet: the people already on the saved number, to link one or add a new person
        // (D-892). Names only for a number the customer gave in this chat, or a buyer the agent
        // may open anyway: the panel is not a phone-to-buyer lookup (D-740).
        const candidates =
          contact.customer_id !== null || contact.phone_e164 === null
            ? []
            : await this.candidatesFor(
                tx,
                context,
                contact.phone_e164,
                found.some((phone) => phone === contact.phone_e164),
              );

        return {
          conversationId,
          channel: conversation.channel_kind,
          contact: {
            id: contact.id,
            name: contact.display_name ?? conversation.profile_name,
            stage,
            stageSetAt: iso(contact.stage_set_at),
            phone: contact.phone_e164,
            address:
              contact.district_id === null ||
              contact.thana_id === null ||
              contact.address_line === null
                ? null
                : {
                    districtId: contact.district_id,
                    thanaId: contact.thana_id,
                    area: contact.area,
                    addressLine: contact.address_line,
                  },
            tags: contact.tags,
          },
          phonesFound,
          addressesFound,
          customer:
            customer === undefined
              ? null
              : {
                  id: customer.id,
                  name: customer.name,
                  phone: customer.phoneE164,
                  orders: customer.orders,
                  delivered: customer.delivered,
                  returned: customer.returned,
                  cancelled: customer.cancelled,
                  spentPoisha: customer.spentPoisha.toString(),
                  lastOrderAt: customer.lastOrderAt?.toISOString() ?? null,
                  recentOrders: customer.recentOrders.map((order) => ({
                    id: order.id,
                    orderNo: order.orderNo,
                    status: order.status,
                    channel: order.channel,
                    codAmountPoisha: order.codAmountPoisha,
                    createdAt: order.createdAt.toISOString(),
                  })),
                  card:
                    card === undefined
                      ? null
                      : {
                          ...card,
                          pinnedNote:
                            card.pinnedNote === null
                              ? null
                              : {
                                  body: card.pinnedNote.body,
                                  at: card.pinnedNote.at.toISOString(),
                                  by: {
                                    id: card.pinnedNote.byUserId,
                                    name: names.get(card.pinnedNote.byUserId) ?? null,
                                  },
                                },
                        },
                },
          candidates,
          notes: notes.map((note) => ({
            id: note.id,
            body: note.body,
            at: new Date(note.created_at).toISOString(),
            author: { userId: note.author_user_id, name: names.get(note.author_user_id) ?? null },
          })),
          interests: await this.interestViews(tx, context.orgId, interests),
        };
      }),
    );
  }

  /**
   * The chats a buyer had (M49, D-895), for the buyer page: each linked conversation with its
   * channel, state, who has it and its last message, and the newest notes written in them. Under
   * `read Conversation`, which already lists every conversation of the brand (D-736).
   */
  async customerChats(context: ActiveContext, customerId: string) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const [rows, names] = await Promise.all([
          repo.conversationsOfCustomer(tx, context.orgId, customerId, CUSTOMER_CHATS),
          this.iam.nameBook(tx, context.orgId),
        ]);
        const contactIds = [...new Set(rows.map((row) => row.contact_id))];
        const notes = await repo.notesOfContacts(tx, context.orgId, contactIds, CUSTOMER_NOTES);
        return {
          conversations: rows.map((row) => ({
            id: row.id,
            channel: row.channel_kind,
            status: row.status,
            name: row.display_name ?? row.profile_name,
            lastMessageAt: new Date(row.last_message_at).toISOString(),
            lastPreview: row.last_preview,
            lastDirection: row.last_direction,
            assignedTo:
              row.assigned_to === null
                ? null
                : { userId: row.assigned_to, name: names.get(row.assigned_to) ?? null },
          })),
          notes: notes.map((note) => ({
            id: note.id,
            body: note.body,
            at: new Date(note.created_at).toISOString(),
            author: { userId: note.author_user_id, name: names.get(note.author_user_id) ?? null },
            conversationId: rows.find((row) => row.contact_id === note.contact_id)?.id ?? null,
          })),
        };
      }),
    );
  }

  /**
   * The people on a number, the automatic pick first, for the panel's "Who is this?" (D-892): all
   * of them when the customer gave the number in this chat, else only those the agent may open.
   */
  private async candidatesFor(tx: Tx, context: ActiveContext, phone: string, fromChat: boolean) {
    const people = await this.orders.buyerCandidates(tx, context.orgId, phone);
    const shown = [];
    for (const person of people) {
      if (
        fromChat ||
        (await this.orders.customerReachable(tx, context.orgId, person.customerId, context))
      ) {
        shown.push({
          customerId: person.customerId,
          name: person.name,
          relation: person.relation,
          note: person.note,
          orders: person.orders,
          lastOrderAt: person.lastOrderAt?.toISOString() ?? null,
          suggested: person.suggested,
        });
      }
    }
    return shown;
  }

  /** Each interest with today's catalog: name, photo, and each size's price and stock (D-741). */
  private async interestViews(tx: Tx, orgId: string, interests: readonly repo.InterestRow[]) {
    const productIds = [...new Set(interests.map((interest) => interest.product_id))];
    if (productIds.length === 0) return [];
    const [products, skus] = await Promise.all([
      this.catalog.productSummaries(tx, orgId, productIds),
      this.catalog.webSkus(tx, orgId, productIds),
    ]);
    const available = await this.orders.deskAvailability(
      tx,
      orgId,
      skus.map((sku) => sku.id),
    );
    const byProduct = new Map(products.map((product) => [product.id, product]));
    return interests.map((interest) => {
      const product = byProduct.get(interest.product_id);
      const variants = skus
        .filter((sku) => sku.productId === interest.product_id)
        .map((sku) => ({
          skuId: sku.id,
          code: sku.code,
          label: sku.values.map((value) => value.label).join(' / '),
          pricePoisha: sku.pricePoisha.toString(),
          compareAtPoisha: sku.compareAtPoisha?.toString() ?? null,
          available: available.get(sku.id) ?? 0,
        }));
      const prices = variants.map((variant) => BigInt(variant.pricePoisha));
      return {
        id: interest.id,
        productId: interest.product_id,
        skuId: interest.sku_id,
        addedAt: new Date(interest.created_at).toISOString(),
        product:
          product === undefined
            ? null
            : {
                name: product.name,
                status: product.status,
                imageFileId: product.imageFileId,
                minPricePoisha:
                  prices.length === 0 ? null : prices.reduce((a, b) => (b < a ? b : a)).toString(),
                maxPricePoisha:
                  prices.length === 0 ? null : prices.reduce((a, b) => (b > a ? b : a)).toString(),
                variants,
              },
      };
    });
  }

  // --- writes, each through the conversation's ownership rule ----------------------------------

  async savePhone(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxPhoneInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (!isNormalizableBdPhone(input.phone)) {
          throw new InboxError('INBOX_INVALID', 'That is not a Bangladeshi mobile number.');
        }
        const phone = normalizeBdPhone(input.phone);
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const contact = await repo.contactById(tx, context.orgId, row.contact_id);
        if (contact === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such contact.');
        /*
         * The brand's buyer with this number is linked (D-739, D-740) when the customer gave the
         * number in this chat (an inbound message, or their WhatsApp id), or when the agent may
         * open that buyer anyway. A number typed from elsewhere for a buyer outside the agent's
         * reach is saved without the link: the panel is not a phone-to-buyer lookup. Otherwise
         * the desk creates the buyer with the first order, and the order links them.
         */
        const buyer = (await this.orders.buyerIdByPhone(tx, context.orgId, phone)) ?? null;
        const fromChat = phonesAcrossMessages(
          await repo.recentInboundTexts(tx, context.orgId, conversationId, PHONE_SCAN_MESSAGES),
          row.channel_kind === 'whatsapp' ? [`+${row.external_user_id}`] : [],
        ).includes(phone);
        const customerId =
          buyer !== null &&
          (fromChat || (await this.orders.customerReachable(tx, context.orgId, buyer, context)))
            ? buyer
            : null;
        await repo.setContactPhone(tx, context.orgId, contact.id, phone, customerId);
        // A buyer who has ordered makes the contact a Customer now, not at their next order
        // (D-738), so the list's stage filter and the thread agree with the panel.
        const linked =
          customerId === null
            ? undefined
            : await this.orders.customerPanel(tx, context.orgId, customerId, 0, context);
        // M49 (D-892): a chat with no name takes the linked buyer's.
        if (linked !== undefined) {
          await repo.nameContactIfUnnamed(tx, context.orgId, contact.id, linked.name);
        }
        const ordered = (linked?.orders ?? 0) > 0;
        const stage = reconcileStage(contact.stage, { hasOrdered: ordered });
        if (stage !== contact.stage) {
          await repo.setContactStage(tx, context.orgId, contact.id, stage, 'system');
        }
        await this.conversations.recordWrite(tx, context, request, {
          action: 'contact.phone',
          conversationId,
          ownership,
          entityType: 'inbox_contact',
          entityId: contact.id,
          before: {
            phone: contact.phone_e164,
            customerId: contact.customer_id,
            stage: contact.stage,
          },
          after: { phone, customerId, stage },
        });
        return { phone, customerId };
      }),
    );
  }

  async saveAddress(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxAddressInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const zone = await this.orders.deliveryZoneForArea(
          tx,
          context.orgId,
          input.districtId,
          input.thanaId,
        );
        if (!zone.valid) {
          throw new InboxError('INBOX_INVALID', 'That thana is not in that district.');
        }
        await repo.setContactAddress(tx, context.orgId, row.contact_id, {
          districtId: input.districtId,
          thanaId: input.thanaId,
          area: input.area === undefined || input.area === '' ? null : input.area,
          addressLine: input.addressLine,
        });
        await this.conversations.recordWrite(tx, context, request, {
          action: 'contact.address',
          conversationId,
          ownership,
          entityType: 'inbox_contact',
          entityId: row.contact_id,
          after: { districtId: input.districtId, thanaId: input.thanaId },
        });
        return { saved: true };
      }),
    );
  }

  async setStage(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxStageInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const contact = await repo.contactById(tx, context.orgId, row.contact_id);
        if (contact === undefined) throw new InboxError('INBOX_NOT_FOUND', 'No such contact.');
        const customer =
          contact.customer_id === null
            ? undefined
            : await this.orders.customerPanel(tx, context.orgId, contact.customer_id, 0, context);
        const change = chooseStage(input.stage, {
          hasOrdered: customer !== undefined && customer.orders > 0,
        });
        if (!change.ok) {
          throw new InboxError(
            'INBOX_STAGE_INVALID',
            'This person has ordered, so they are a customer, not a lead.',
            change.reason,
          );
        }
        await repo.setContactStage(tx, context.orgId, contact.id, change.stage, context.userId);
        await this.conversations.recordWrite(tx, context, request, {
          action: 'contact.stage',
          conversationId,
          ownership,
          entityType: 'inbox_contact',
          entityId: contact.id,
          before: { stage: contact.stage },
          after: { stage: change.stage },
        });
        return { stage: change.stage };
      }),
    );
  }

  async setTags(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxTagsInput,
    acknowledged: boolean,
  ) {
    const tags = [...new Set(input.tags.map((tag) => tag.trim()))];
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const contact = await repo.contactById(tx, context.orgId, row.contact_id);
        await repo.setContactTags(tx, context.orgId, row.contact_id, tags);
        await this.conversations.recordWrite(tx, context, request, {
          action: 'contact.tags',
          conversationId,
          ownership,
          entityType: 'inbox_contact',
          entityId: row.contact_id,
          before: { tags: contact?.tags ?? [] },
          after: { tags },
        });
        return { tags };
      }),
    );
  }

  async addNote(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxNoteInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const note = await repo.insertNote(
          tx,
          context.orgId,
          row.contact_id,
          input.body,
          context.userId,
        );
        await this.conversations.recordWrite(tx, context, request, {
          action: 'note',
          conversationId,
          ownership,
          entityType: 'inbox_note',
          entityId: note.id,
          after: { length: input.body.length },
        });
        return { id: note.id, at: new Date(note.created_at).toISOString() };
      }),
    );
  }

  async addInterest(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    input: InboxInterestInput,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const [product] = await this.catalog.productSummaries(tx, context.orgId, [input.productId]);
        if (product === undefined) {
          throw new InboxError('INBOX_INVALID', 'No such product in this brand’s catalog.');
        }
        if (input.skuId !== undefined) {
          const [sku] = await this.catalog.skusByIds(tx, context.orgId, [input.skuId]);
          if (sku?.productId !== input.productId) {
            throw new InboxError('INBOX_INVALID', 'That size is not of that product.');
          }
        }
        const id = await repo.insertInterest(tx, context.orgId, {
          contactId: row.contact_id,
          productId: input.productId,
          skuId: input.skuId ?? null,
          addedBy: context.userId,
        });
        await this.conversations.recordWrite(tx, context, request, {
          action: 'interest.add',
          conversationId,
          ownership,
          entityType: 'inbox_interest',
          entityId: id ?? input.productId,
          after: {
            productId: input.productId,
            skuId: input.skuId ?? null,
            added: id !== undefined,
          },
        });
        return { id: id ?? null, added: id !== undefined };
      }),
    );
  }

  async removeInterest(
    context: ActiveContext,
    request: AuditableRequest,
    conversationId: string,
    interestId: string,
    acknowledged: boolean,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { row, ownership } = await this.conversations.lockForWrite(
          tx,
          context,
          conversationId,
          acknowledged,
        );
        const removed = await repo.deleteInterest(tx, context.orgId, row.contact_id, interestId);
        if (!removed) throw new InboxError('INBOX_NOT_FOUND', 'No such interest.');
        await this.conversations.recordWrite(tx, context, request, {
          action: 'interest.remove',
          conversationId,
          ownership,
          entityType: 'inbox_interest',
          entityId: interestId,
        });
        return { removed: true };
      }),
    );
  }

  // --- the order desk ---------------------------------------------------------------------------

  /**
   * What the order desk's new-order form starts from (D-742): the contact's phone (saved, else
   * the first found in the chat), name, address, the products they asked about (a chosen size,
   * else the product's only size), the order channel, and the conversation id for `source`.
   */
  async orderDraft(context: ActiveContext, conversationId: string) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const { conversation, contact } = await this.contactOf(tx, context.orgId, conversationId);
        const texts = await repo.recentInboundTexts(
          tx,
          context.orgId,
          conversationId,
          PHONE_SCAN_MESSAGES,
        );
        const fromWhatsApp =
          conversation.channel_kind === 'whatsapp'
            ? phoneFromWhatsAppId(conversation.external_user_id)
            : null;
        const phone =
          contact.phone_e164 ??
          phonesAcrossMessages(texts, fromWhatsApp === null ? [] : [fromWhatsApp])[0] ??
          null;

        const interests = await repo.interestsOf(tx, context.orgId, contact.id);
        const productIds = [...new Set(interests.map((interest) => interest.product_id))];
        const skus =
          productIds.length === 0 ? [] : await this.catalog.webSkus(tx, context.orgId, productIds);
        const lines = interests.flatMap((interest) => {
          const ofProduct = skus.filter((sku) => sku.productId === interest.product_id);
          const chosen =
            interest.sku_id !== null
              ? ofProduct.find((sku) => sku.id === interest.sku_id)
              : ofProduct.length === 1
                ? ofProduct[0]
                : undefined;
          return chosen === undefined ? [] : [{ skuId: chosen.id }];
        });

        return {
          conversationId,
          channel: ORDER_CHANNEL_FOR[conversation.channel_kind],
          phone,
          name: contact.display_name ?? conversation.profile_name,
          address:
            contact.district_id === null ||
            contact.thana_id === null ||
            contact.address_line === null
              ? null
              : {
                  districtId: contact.district_id,
                  thanaId: contact.thana_id,
                  area: contact.area,
                  addressLine: contact.address_line,
                },
          lines,
          fraud: contact.stage === 'fraud',
        };
      }),
    );
  }

  /** The desk's warning (D-738): contacts with this phone that an agent marked fraud. */
  async phoneFlags(context: ActiveContext, phoneInput: string) {
    if (!isNormalizableBdPhone(phoneInput)) return { phone: null, fraud: false, contacts: [] };
    const phone = normalizeBdPhone(phoneInput);
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const contacts = await repo.fraudContactsByPhone(tx, context.orgId, phone);
        return {
          phone,
          fraud: contacts.length > 0,
          contacts: contacts.map((contact) => ({
            id: contact.id,
            name: contact.display_name,
            conversationId: contact.conversation_id,
          })),
        };
      }),
    );
  }
}
